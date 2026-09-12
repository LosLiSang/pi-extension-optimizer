import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { realHarnessDir } from "./paths.js";
import type { OptimizableExtension, PiPackage } from "./scanner.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-opt", ".git", "coverage"]);
const BARE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|export[^;]*from\s+)\s*["']([^"']+)["']/g;

export interface JunctionResult {
	/** 本次新创建/修复的链接名 */
	created: string[];
	/** 创建/修复失败的原因（非致命：静态链仍由 jiti alias 处理，但原生加载的子树里裸导入会失败） */
	warnings: string[];
}

export interface JunctionState {
	name: string;
	ok: boolean;
	/** false 表示当前 harness 布局未安装该包，因此无需 junction。 */
	needed: boolean;
	/** 状态补充说明 */
	reason?: string;
}

/**
 * 解析 harness 相关包目录。npm 可能把依赖放在 pi-coding-agent/node_modules 内，
 * 也可能扁平提升到与 pi-coding-agent 同级的 @earendil-works scope 目录。
 */
function harnessPackageDir(harness: string, packageName: string): string {
	if (packageName === "@earendil-works/pi-coding-agent") return harness;
	const leaf = packageName.slice(packageName.lastIndexOf("/") + 1);
	const nested = join(harness, "node_modules", "@earendil-works", leaf);
	const flat = join(dirname(harness), leaf);
	if (existsSync(join(nested, "package.json"))) return nested;
	if (existsSync(join(flat, "package.json"))) return flat;
	return nested;
}

/** 需要建 junction 的 harness 包及其实际目标（兼容嵌套与扁平 npm 布局）。 */
export function harnessJunctionTargets(harness: string): Array<[string, string]> {
	const names = [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
	];
	return names.map((name) => [name, harnessPackageDir(harness, name)]);
}

/**
 * 在 pi 的 node_modules 根创建 harness 包 junction（@earendil-works/pi-coding-agent 等 → 真实 harness）。
 * 这样产物保留 bare import：静态链由 jiti alias 处理（性能 = 原 .ts 加载），
 * 运行时动态 import()/require() 由 Node 原生解析到 junction（真实 harness）。
 *
 * 修复语义：已存在且可解析的链接保留；损坏的链接（existsSync 跟随目标失败）先删后建；
 * 目标不存在的（如扁平安装下无嵌套 pi-ai）不创建悬空 junction。
 * harness 参数仅测试注入用，默认取 realHarnessDir()。
 */
export function ensureHarnessJunctions(nm: string, harness: string = realHarnessDir()): JunctionResult {
	const created: string[] = [];
	const warnings: string[] = [];
	for (const [name, target] of harnessJunctionTargets(harness)) {
		const link = join(nm, name);
		let hasLink = false;
		try {
			lstatSync(link);
			hasLink = true;
		} catch {
			// 链接不存在
		}
		if (hasLink) {
			if (existsSync(link)) continue; // 健康（真实目录或可解析 junction）
			try {
				// Windows 上 broken junction 必须用 unlinkSync 删链接本身；
				// rmSync 会静默保留链接（且递归删除有跟随 junction 误删目标的风险）。
				unlinkSync(link);
			} catch (error) {
				warnings.push(`${name}: 损坏的链接无法移除（${(error as Error).message}），动态 import() 可能解析失败`);
				continue;
			}
		}
		if (!existsSync(target)) continue; // 目标不存在：不创建悬空 junction（扁平安装属正常布局，不算警告）
		try {
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(target, link, "junction");
			created.push(name);
		} catch (error) {
			// 典型原因：Windows 无管理员权限且未开开发者模式
			warnings.push(`${name}: 创建 junction 失败（${(error as Error).message}），运行时动态 import() 会报 Cannot find package；请以管理员运行或开启开发者模式后重新 build`);
		}
	}
	return { created, warnings };
}

/**
 * 检查三个 harness junction 的当前健康状态（不修改文件系统）。
 * 用于 /ext-opt status 展示与 repair 前的诊断。
 */
export function checkHarnessJunctions(nm: string, harness: string = realHarnessDir()): JunctionState[] {
	const states: JunctionState[] = [];
	for (const [name, target] of harnessJunctionTargets(harness)) {
		const link = join(nm, name);
		let hasLink = false;
		try {
			lstatSync(link);
			hasLink = true;
		} catch {
			// 链接不存在
		}
		if (hasLink) {
			states.push(existsSync(link)
				? { name, ok: true, needed: true }
				: { name, ok: false, needed: true, reason: "损坏的链接（目标不可解析），将在下次扩展加载时自动修复" });
		} else {
			states.push(existsSync(target)
				? { name, ok: false, needed: true, reason: "缺失（npm 重审计会清除锁文件外的链接），将在下次扩展加载时自动修复" }
				: { name, ok: true, needed: false, reason: "当前 harness 未安装此包，无需 junction" });
		}
	}
	return states;
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

		const targetEntry = join(pkgDir, "dist-opt", entryRel.replace(/^\.\//, "").replace(/\.ts$/, ".js"));
		if (existsSync(targetEntry)) {
			visited.set(pkgName, pathToFileURL(targetEntry).href);
			rewriteBareImportInTree(outRoot, pkgName, pathToFileURL(targetEntry).href);
		}
	}
}

/**
 * 把产物中三个 harness 包（pi-coding-agent / pi-ai / pi-agent-core）的裸导入改写成 file URL。
 * 与 pi loader 的 getAliases() 相同的解析逻辑（workspace 优先，否则从 harness 目录 require.resolve），
 * 保证改写后的入口与运行时 jiti alias 完全一致。
 *
 * 为什么要改写：这些包不在 pi 的 node_modules 里，原生加载子树（纯 JS ESM 被 jiti 交给原生 import()
 * 后的整棵子树）的裸导入走 Node ESM 解析，只能依赖 junction；而 npm 重审计会把 junction 当 extraneous 清掉，
 * 导致 /tool-display 等命令在运行时抛 Cannot find package。改写成 file URL 后，
 * 无论 junction 是否存在、npm 是否清理，原生子树都能直接解析到真实 harness，彻底消除这类错误。
 * junction + 启动自愈仍保留，作为旧产物与子路径导入的兜底。
 */
export function rewriteHarnessImports(outRoot: string, harness: string): string[] {
	const warnings: string[] = [];
	const barePackages = collectBarePackageNames(outRoot);
	const packagesRoot = dirname(harness);
	/** 按 import 条件解析嵌套包入口（与 pi loader import.meta.resolve 语义一致） */
	const resolveNestedEntry = (pkgDir: string, subpath?: string): string | undefined => {
		try {
			const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
			const ex = pj?.exports;
			const key = subpath ? `./${subpath}` : ".";
			let entry: unknown;
			if (ex && typeof ex === "object") {
				const target = (ex as any)[key];
				if (typeof target === "string") entry = target;
				else if (target && typeof target === "object") {
					const imp = target.import;
					entry = typeof imp === "string" ? imp
						: imp && typeof imp === "object" && typeof imp.default === "string" ? imp.default
						: typeof target.default === "string" ? target.default
						: undefined;
				}
			} else if (typeof pj?.main === "string") {
				entry = pj.main;
			}
			if (typeof entry === "string") return join(pkgDir, entry.replace(/^\.\//, ""));
		} catch {
			// 解析失败则返回 undefined
		}
		return undefined;
	};
	const workspaceOrImport = (pkgDir: string, workspaceRel: string, subpath?: string): string | undefined => {
		const ws = join(packagesRoot, workspaceRel);
		if (existsSync(ws)) return ws;
		return resolveNestedEntry(pkgDir, subpath);
	};
	const piAiDir = harnessPackageDir(harness, "@earendil-works/pi-ai");
	const piAgentCoreDir = harnessPackageDir(harness, "@earendil-works/pi-agent-core");
	// name → 入口（与 pi getAliases 的 pi-coding-agent/pi-ai/pi-agent-core 三项一致）
	const entries: Array<[string, string | undefined]> = [
		["@earendil-works/pi-coding-agent", join(harness, "dist", "index.js")],
		["@earendil-works/pi-ai", workspaceOrImport(piAiDir, "ai/dist/compat.js", "compat")],
		["@earendil-works/pi-agent-core", workspaceOrImport(piAgentCoreDir, "agent/dist/index.js")],
	];
	for (const [name, entry] of entries) {
		if (!barePackages.has(name)) continue;
		if (!entry) {
			warnings.push(`${name}: 无法解析 harness 入口，产物保留裸导入（依赖 junction 兜底）`);
			continue;
		}
		if (!existsSync(entry)) {
			warnings.push(`${name}: harness 入口不存在（${entry}），产物保留裸导入（依赖 junction 兜底）`);
			continue;
		}
		rewriteBareImportInTree(outRoot, name, pathToFileURL(entry).href);
	}
	return warnings;
}

export interface BuildResult {
	name: string;
	ok: boolean;
	files: number;
	total: number;
	applyMessage: string;
	errors: string[];
	/** junction 创建/修复失败的警告（不影响编译结果，但运行时动态 import() 可能失败） */
	junctionWarnings: string[];
	/** harness 裸导入改写失败/被跳过的警告（产物保留裸导入，依赖 junction 兜底） */
	rewriteWarnings: string[];
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
		return { name: ext.name, ok: false, files: 0, total: 0, applyMessage: `源码目录不存在: ${srcRoot}`, errors, junctionWarnings: [], rewriteWarnings: [] };
	}
	// 确保 harness junction 存在：旧产物/子路径导入仍依赖 junction 解析；新产物已把 harness 裸导入改写为 file URL
	const nm = nodeModulesRootOf(ext.pkgDir);
	const junctions = ensureHarnessJunctions(nm);
	const compiled = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
	// 递归转译产物中 .ts 分发的依赖包（native 动态链需要 .js）
	await transpileDotTsDeps(ext, nm, new Map(), errors);
	// harness 裸导入 → file URL：原生加载子树不再依赖 junction（npm 重审计清掉 junction 也不受影响）
	const rewriteWarnings = rewriteHarnessImports(join(ext.pkgDir, "dist-opt"), realHarnessDir());

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
		junctionWarnings: junctions.warnings,
		rewriteWarnings,
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
