import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { OptimizableExtension, PiPackage } from "./scanner.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-opt", ".git", "coverage"]);
const BARE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|export[^;]*from\s+)\s*["']([^"']+)["']/g;

/** 旧版本可能建过链接的 scope（@mariozechner 为 pi 旧命名空间）。 */
const HARNESS_SCOPES = ["@earendil-works", "@mariozechner"];

export interface LinkCleanupResult {
	/** 本次移除的链接名（如 @earendil-works/pi-coding-agent） */
	removed: string[];
	/** 移除失败的原因 */
	warnings: string[];
}

/**
 * 列出 nm/@earendil-works（及旧命名空间）下的符号链接 / junction（含悬空链接）。
 * 这些链接由 v0.1.7 及更早版本创建，指向 pi 本体安装目录。
 * 真实目录（npm 正常安装的包，如 pi-tui）不算在内。
 */
export function findHarnessLinks(nm: string): string[] {
	const links: string[] = [];
	for (const scope of HARNESS_SCOPES) {
		let names: string[];
		try {
			names = readdirSync(join(nm, scope));
		} catch {
			continue;
		}
		for (const name of names) {
			try {
				if (lstatSync(join(nm, scope, name)).isSymbolicLink()) links.push(`${scope}/${name}`);
			} catch {
				// 读不到就跳过
			}
		}
	}
	return links;
}

/**
 * 移除 harness 链接。为什么要删：打包版 pi 通过 virtualModules 把 @earendil-works/* 解析到运行中的实例；
 * 但 Node 原生加载的子树会按 node_modules 解析，有链接时就会顺着链接再加载一份未打包的 pi
 * （实测启动 +~3s，且 instanceof / 单例与主进程不一致）。
 * 只删链接本身（unlinkSync），绝不递归删除，避免跟随 junction 误删 pi 本体。
 */
export function removeHarnessLinks(nm: string): LinkCleanupResult {
	const removed: string[] = [];
	const warnings: string[] = [];
	for (const name of findHarnessLinks(nm)) {
		try {
			unlinkSync(join(nm, name));
			removed.push(name);
		} catch (error) {
			warnings.push(`${name}: 无法移除链接（${(error as Error).message}）`);
		}
	}
	return { removed, warnings };
}

/**
 * 确保 outRoot/package.json 声明 "type": "commonjs"（已有 package.json 时合并，只改 type）。
 *
 * 为什么：扩展包通常是 "type": "module"，jiti 会把其中的 .js 交给 Node 原生 import()，
 * 之后整棵子树（含动态 import()）都由 Node 原生解析，@earendil-works/* 只能去 node_modules 里找：
 * 没有链接 → Cannot find package；有链接 → 加载第二份未打包的 pi。
 * 标记为 commonjs 后 Node 无法原生加载这些 ESM 语法的 .js，jiti 会回退为自己转译，
 * harness 导入因此经 virtualModules 解析到运行中的 pi。
 *
 * 返回是否写入了文件；outRoot 不存在时返回 false。
 */
export function ensureCommonjsMarker(outRoot: string): boolean {
	if (!existsSync(outRoot)) return false;
	const pjPath = join(outRoot, "package.json");
	let pj: Record<string, unknown> = {};
	if (existsSync(pjPath)) {
		try {
			const parsed = JSON.parse(readFileSync(pjPath, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pj = parsed;
		} catch {
			// 损坏的 package.json：用最小标记覆盖
		}
	}
	if (pj.type === "commonjs") return false;
	pj.type = "commonjs";
	writeFileSync(pjPath, `${JSON.stringify(pj, null, 2)}
`);
	return true;
}

function hasCommonjsMarker(outRoot: string): boolean {
	try {
		return JSON.parse(readFileSync(join(outRoot, "package.json"), "utf8"))?.type === "commonjs";
	} catch {
		return false;
	}
}

/** 给 nm 下所有包（含 scope 包）的 dist-opt 补齐 commonjs 标记，返回补齐的包名。用于启动迁移旧产物。 */
export function markAllDistOpt(nm: string): string[] {
	const marked: string[] = [];
	const visit = (pkgDir: string, name: string) => {
		if (ensureCommonjsMarker(join(pkgDir, "dist-opt"))) marked.push(name);
	};
	let names: string[];
	try {
		names = readdirSync(nm);
	} catch {
		return marked;
	}
	for (const name of names) {
		if (name.startsWith(".")) continue;
		if (name.startsWith("@")) {
			let scoped: string[];
			try {
				scoped = readdirSync(join(nm, name));
			} catch {
				continue;
			}
			for (const child of scoped) visit(join(nm, name, child), `${name}/${child}`);
		} else {
			visit(join(nm, name), name);
		}
	}
	return marked;
}

/** 由原始入口推导优化后入口：./src/index.ts -> ./dist-opt/index.js；x.ts -> ./dist-opt/x.js */
export function optimizedEntryFor(entry: string): string {
	const rel = entry.replace(/^\.\//, "");
	const file = rel.split("/").pop() ?? "index.ts";
	return `./dist-opt/${file.replace(/\.ts$/, ".js")}`;
}

function rewriteRelativeTsImports(code: string): string {
	return code.replace(/(from|import)(\s*\(?)(["'])(\.\.?\/[^"']*?)\.ts\3/g, "$1$2$3$4.js$3");
}

function walkTypeScript(dir: string, out: string[] = []): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			if (!SKIP_DIRS.has(name)) walkTypeScript(full, out);
		} else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

const SKIP_ASSET_NAMES = new Set([
	"package.json.pi-orig",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
]);

function walkAssets(dir: string, out: string[] = []): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			if (!SKIP_DIRS.has(name)) walkAssets(full, out);
		} else {
			if (SKIP_ASSET_NAMES.has(name) || name.endsWith(".pi-orig")) continue;
			// Skip TypeScript source, declaration and build files (handled by esbuild)
			if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".map") || name.endsWith(".tsbuildinfo")) continue;
			out.push(full);
		}
	}
	return out;
}

/** 把 srcRoot 下的 .ts 树转译为 outRoot/*.js（相对 .ts 后缀改写）。harness 裸导入原样保留。 */
async function transpileTree(
	srcRoot: string,
	outRoot: string,
	errors: string[],
): Promise<{ files: number; total: number }> {
	// esbuild 懒加载：只在 build 时引入，避免扩展自身启动被 esbuild 编译拖慢（~2.5s）
	const { transform } = await import("esbuild");
	const files = walkTypeScript(srcRoot);
	let written = 0;
	for (const file of files) {
		try {
			const result = await transform(readFileSync(file, "utf8"), {
				loader: "ts",
				format: "esm",
				target: "node20",
				sourcefile: file,
			});
			const output = join(outRoot, relative(srcRoot, file).replace(/\.ts$/, ".js"));
			mkdirSync(dirname(output), { recursive: true });
			writeFileSync(output, rewriteRelativeTsImports(result.code));
			written++;
		} catch (error) {
			const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
			errors.push(`${relative(srcRoot, file)}: ${message}`);
		}
	}

	// Copy static assets and non-TS resources (prompts, templates, schemas, etc.)
	const assets = walkAssets(srcRoot);
	for (const asset of assets) {
		try {
			const output = join(outRoot, relative(srcRoot, asset));
			mkdirSync(dirname(output), { recursive: true });
			copyFileSync(asset, output);
		} catch (error) {
			const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
			errors.push(`asset ${relative(srcRoot, asset)}: ${message}`);
		}
	}

	return { files: written, total: files.length };
}

function nodeModulesRootOf(pkgDir: string): string {
	const parent = dirname(pkgDir);
	return basename(parent) === "node_modules" ? parent : dirname(parent);
}

/** 解析包入口相对路径（exports -> main），返回 undefined 表示无法解析。 */
function resolvePackageEntry(pj: any): string | undefined {
	const ex = pj?.exports;
	if (ex && typeof ex === "object") {
		const dot = ex["."];
		if (typeof dot === "string") return dot;
		if (dot && typeof dot === "object") {
			const imp = dot.import;
			if (typeof imp === "string") return imp;
			if (imp && typeof imp === "object" && typeof imp.default === "string") return imp.default;
			if (typeof dot.default === "string") return dot.default;
		}
	}
	return typeof pj?.main === "string" ? pj.main : undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 收集目录树中所有 import 语句的裸包名（去 scope/子路径）。不识别 require()：产物为 esm，出现 CJS 依赖属例外场景。 */
function collectBarePackageNames(dir: string): Set<string> {
	const out = new Set<string>();
	const walk = (d: string) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const n of names) {
			const full = join(d, n);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue; // broken symlink 等：跳过而不是中断整个 build
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(n)) walk(full);
			} else if (n.endsWith(".js")) {
				const code = readFileSync(full, "utf8");
				for (const m of code.matchAll(BARE_IMPORT_RE)) {
					const spec = m[1];
					if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("file:") || spec.startsWith("/")) continue;
					const parts = spec.split("/");
					out.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
				}
			}
		}
	};
	walk(dir);
	return out;
}

/** 把目录树中所有对该包名的 import 重写为 file URL。 */
function rewriteBareImportInTree(root: string, pkgName: string, fileUrl: string) {
	const re = new RegExp(`(from\\s+|import\\s*\\(\\s*|import\\s+|export[^;]*from\\s+)\\s*["']${escapeRegExp(pkgName)}["']`, "g");
	const walk = (d: string) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const n of names) {
			const full = join(d, n);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(n)) walk(full);
			} else if (n.endsWith(".js")) {
				const code = readFileSync(full, "utf8");
				const next = code.replace(re, `$1"${fileUrl}"`);
				if (next !== code) writeFileSync(full, next);
			}
		}
	};
	walk(root);
}

/**
 * 递归处理优化包产物中的 .ts 分发依赖包（如 @juicesharp/rpiv-config）：
 * 转译到其 dist-opt，并把产物中的 bare import 重写为 file URL。
 * 不改依赖包的 package.json，对未优化的使用者无影响。
 */
async function transpileDotTsDeps(
	ext: OptimizableExtension,
	nm: string,
	visited: Map<string, string | null>,
	errors: string[],
): Promise<void> {
	const outRoot = join(ext.pkgDir, "dist-opt");
	const bare = collectBarePackageNames(outRoot);
	for (const pkgName of bare) {
		if (visited.has(pkgName)) continue;
		visited.set(pkgName, null); // 占位防环
		const pkgDir = join(nm, pkgName);
		const pjPath = join(pkgDir, "package.json");
		if (!existsSync(pjPath)) continue;
		let pj: any;
		try {
			pj = JSON.parse(readFileSync(pjPath, "utf8"));
		} catch {
			continue;
		}
		const entryRel = resolvePackageEntry(pj);
		if (!entryRel || !entryRel.endsWith(".ts")) continue; // 非 .ts 分发无需处理

		const t = await transpileTree(pkgDir, join(pkgDir, "dist-opt"), errors);
		// transpileTree 已把错误按相对路径写入 errors（共享数组），无需二次包装。
		// 递归该依赖包产物中的 .ts 依赖
		await transpileDotTsDeps({ name: pkgName, pkgDir, srcDir: "." } as OptimizableExtension, nm, visited, errors);

		ensureCommonjsMarker(join(pkgDir, "dist-opt"));
		const targetEntry = join(pkgDir, "dist-opt", entryRel.replace(/^\.\//, "").replace(/\.ts$/, ".js"));
		if (existsSync(targetEntry)) {
			visited.set(pkgName, pathToFileURL(targetEntry).href);
			rewriteBareImportInTree(outRoot, pkgName, pathToFileURL(targetEntry).href);
		}
	}
}

export interface BuildResult {
	name: string;
	ok: boolean;
	files: number;
	total: number;
	applyMessage: string;
	errors: string[];
}

export interface PackageStatus {
	name: string;
	entry: string;
	state: "optimized" | "typescript" | "javascript" | "broken";
	distExists: boolean;
	hasBackup: boolean;
}

/**
 * 应用入口修改；只在完整转译成功后调用。
 * 入口目标由原始入口文件名推导（不硬编码 index.js）。
 * 当当前入口仍是原始 .ts 时，始终用当前 package.json 刷新备份，避免扩展升级后遗留旧版本备份。
 * 当当前入口已是优化入口时，绝不覆盖备份。
 */
export function applyOne(ext: OptimizableExtension): string {
	const packageJsonPath = join(ext.pkgDir, "package.json");
	const backupPath = `${packageJsonPath}.pi-orig`;
	const raw = readFileSync(packageJsonPath);
	const pkg = JSON.parse(raw.toString("utf8"));
	if (!pkg.pi?.extensions?.length) return "无 pi.extensions，跳过";
	const target = optimizedEntryFor(ext.entry);
	const previous = pkg.pi.extensions[0];
	if (previous === target) return "已应用";
	// 此时 package.json 是当前版本的原始入口，覆盖旧备份是安全且必要的。
	writeFileSync(backupPath, raw);
	// 只替换第 0 项，保留多入口包的其余入口。
	const extensions = [...pkg.pi.extensions];
	extensions[0] = target;
	pkg.pi.extensions = extensions;
	writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	return `${previous} → ${target}`;
}

export async function buildOne(ext: OptimizableExtension): Promise<BuildResult> {
	const errors: string[] = [];
	const srcRoot = join(ext.pkgDir, ext.srcDir);
	if (!existsSync(srcRoot)) {
		return { name: ext.name, ok: false, files: 0, total: 0, applyMessage: `源码目录不存在: ${srcRoot}`, errors };
	}
	const nm = nodeModulesRootOf(ext.pkgDir);
	const compiled = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
	// 递归转译产物中 .ts 分发的依赖包（native 动态链需要 .js）
	await transpileDotTsDeps(ext, nm, new Map(), errors);
	// harness 裸导入（@earendil-works/*）原样保留，并把 dist-opt 标记为 commonjs，
	// 让 jiti 转译整棵子树、经 virtualModules 解析到运行中的 pi（见 ensureCommonjsMarker）。
	ensureCommonjsMarker(join(ext.pkgDir, "dist-opt"));

	const targetEntry = optimizedEntryFor(ext.entry);
	const targetFile = join(ext.pkgDir, targetEntry.replace(/^\.\//, ""));
	const productOk = errors.length === 0 && existsSync(targetFile);
	let applyMessage: string;
	if (errors.length > 0) {
		applyMessage = "转译有错误，保留原入口";
	} else if (!existsSync(targetFile)) {
		applyMessage = `产物缺失（${targetEntry}），保留原入口`;
	} else {
		applyMessage = applyOne(ext);
	}
	return {
		name: ext.name,
		ok: productOk,
		files: compiled.files,
		total: compiled.total,
		applyMessage,
		errors,
	};
}

export function rollbackOne(pkg: PiPackage): string {
	const packageJsonPath = join(pkg.pkgDir, "package.json");
	const backupPath = `${packageJsonPath}.pi-orig`;
	if (!existsSync(backupPath)) return "无备份，未改动";
	writeFileSync(packageJsonPath, readFileSync(backupPath));
	return "已从 package.json.pi-orig 恢复";
}

export function getPackageStatus(pkg: PiPackage): PackageStatus {
	// 优化入口按实际入口文件判定（非 index 入口同样适用）；其余情况保持旧语义（index.js）
	const distExists = pkg.entry.startsWith("./dist-opt/")
		? existsSync(join(pkg.pkgDir, pkg.entry.replace(/^\.\//, "")))
		: existsSync(join(pkg.pkgDir, "dist-opt", "index.js"));
	const hasBackup = existsSync(join(pkg.pkgDir, "package.json.pi-orig"));
	let state: PackageStatus["state"];
	if (pkg.entry.startsWith("./dist-opt/")) state = distExists ? "optimized" : "broken";
	else if (pkg.entry.endsWith(".ts")) state = "typescript";
	else state = "javascript";
	return { name: pkg.name, entry: pkg.entry, state, distExists, hasBackup };
}

/** 目录树中满足谓词文件的最新 mtime（用于判断产物是否过期）。 */
function latestMtime(dir: string, match: (name: string) => boolean): number {
	let latest = 0;
	const walk = (d: string) => {
		let names: string[];
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const n of names) {
			const full = join(d, n);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (!SKIP_DIRS.has(n)) walk(full);
			} else if (match(n)) {
				latest = Math.max(latest, st.mtimeMs);
			}
		}
	};
	walk(dir);
	return latest;
}

/**
 * 判断扩展是否需要（重新）build：
 * - 入口仍是 .ts → 需要（未优化）
 * - 入口是 dist-opt 但产物缺失 → 需要（broken）
 * - 源码树比产物树（全部 .js，而非仅入口文件）新 → 需要（过期，扩展升级后旧产物还在）
 */
export function extensionNeedsBuild(ext: OptimizableExtension): boolean {
	if (!ext.optimized) return true;
	const targetFile = join(ext.pkgDir, optimizedEntryFor(ext.entry).replace(/^\.\//, ""));
	if (!existsSync(targetFile)) return true;
	if (!hasCommonjsMarker(join(ext.pkgDir, "dist-opt"))) return true; // v0.1.7 及更早的产物
	const srcRoot = join(ext.pkgDir, ext.srcDir);
	if (!existsSync(srcRoot)) return false;
	try {
		const srcMtime = latestMtime(srcRoot, (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
		const outMtime = latestMtime(join(ext.pkgDir, "dist-opt"), (name) => name.endsWith(".js"));
		return srcMtime > outMtime + 1000;
	} catch {
		return false;
	}
}
