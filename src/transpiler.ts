import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { realHarnessDir } from "./paths.js";
import type { OptimizableExtension, PiPackage } from "./scanner.js";

export const OPTIMIZED_ENTRY = "./dist-opt/index.js";
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-opt", ".git", "coverage"]);
const BARE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|export[^;]*from\s+)\s*["']([^"']+)["']/g;

/**
 * 在 pi 的 node_modules 根创建 harness 包 junction（@earendil-works/pi-coding-agent 等 → 真实 harness）。
 * 这样产物保留 bare import：静态链由 jiti alias 处理（性能 = 原 .ts 加载），
 * 运行时动态 import()/require() 由 Node 原生解析到 junction（真实 harness）。
 */
export function ensureHarnessJunctions(nm: string): string[] {
	const harness = realHarnessDir();
	const nestedRoot = join(harness, "node_modules", "@earendil-works");
	const created: string[] = [];
	// pi-ai / pi-agent-core 是 pi-coding-agent 包内 node_modules 下的嵌套包
	const targets: Array<[string, string]> = [
		["@earendil-works/pi-coding-agent", harness],
		["@earendil-works/pi-ai", join(nestedRoot, "pi-ai")],
		["@earendil-works/pi-agent-core", join(nestedRoot, "pi-agent-core")],
	];
	for (const [name, target] of targets) {
		const link = join(nm, name);
		if (existsSync(link)) continue; // 已有（npm 安装或旧 junction）
		try {
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(target, link, "junction");
			created.push(name);
		} catch {
			// 无权限等场景：降级（静态链仍由 jiti alias 处理）
		}
	}
	return created;
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

/** 把 srcRoot 下的 .ts 树转译为 outRoot/*.js（相对 .ts 后缀改写）。harness 裸导入保留（由 junction 兜底）。 */
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
	return { files: written, total: files.length };
}

export async function transpileOne(ext: OptimizableExtension): Promise<{ files: number; total: number; errors: string[] }> {
	const errors: string[] = [];
	const srcRoot = join(ext.pkgDir, ext.srcDir);
	if (!existsSync(srcRoot)) return { files: 0, total: 0, errors: [`源码目录不存在: ${srcRoot}`] };
	const result = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
	return { ...result, errors };
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

/** 收集目录树中所有 import 语句的裸包名（去 scope/子路径）。 */
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
			if (statSync(full).isDirectory()) {
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
		for (const n of readdirSync(d)) {
			const full = join(d, n);
			if (statSync(full).isDirectory()) {
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
	pkg.pi.extensions = [target];
	writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	return `${previous} → ${target}`;
}

export async function buildOne(ext: OptimizableExtension): Promise<BuildResult> {
	const errors: string[] = [];
	const srcRoot = join(ext.pkgDir, ext.srcDir);
	if (!existsSync(srcRoot)) {
		return { name: ext.name, ok: false, files: 0, total: 0, applyMessage: `源码目录不存在: ${srcRoot}`, errors };
	}
	// 确保 harness junction 存在：产物保留 bare import，动态链依赖 junction 解析
	const nm = nodeModulesRootOf(ext.pkgDir);
	ensureHarnessJunctions(nm);
	const compiled = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
	// 递归转译产物中 .ts 分发的依赖包（native 动态链需要 .js）
	await transpileDotTsDeps(ext, nm, new Map(), errors);

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
	const distExists = existsSync(join(pkg.pkgDir, "dist-opt", "index.js"));
	const hasBackup = existsSync(join(pkg.pkgDir, "package.json.pi-orig"));
	let state: PackageStatus["state"];
	if (pkg.entry.startsWith("./dist-opt/")) state = distExists ? "optimized" : "broken";
	else if (pkg.entry.endsWith(".ts")) state = "typescript";
	else state = "javascript";
	return { name: pkg.name, entry: pkg.entry, state, distExists, hasBackup };
}

/** 源码树中最新的 .ts 修改时间（用于判断产物是否过期）。 */
function latestSourceMtime(dir: string): number {
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
			} else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) {
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
 * - 源码树比产物入口新 → 需要（过期，扩展升级后旧产物还在）
 */
export function extensionNeedsBuild(ext: OptimizableExtension): boolean {
	if (!ext.optimized) return true;
	const targetFile = join(ext.pkgDir, optimizedEntryFor(ext.entry).replace(/^\.\//, ""));
	if (!existsSync(targetFile)) return true;
	const srcRoot = join(ext.pkgDir, ext.srcDir);
	if (!existsSync(srcRoot)) return false;
	try {
		return latestSourceMtime(srcRoot) > statSync(targetFile).mtimeMs + 1000;
	} catch {
		return false;
	}
}
