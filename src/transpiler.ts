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

/** Scopes under which older versions may have created links (@mariozechner is pi's former namespace). */
const HARNESS_SCOPES = ["@earendil-works", "@mariozechner"];

export interface LinkCleanupResult {
	/** Links removed in this run (e.g. @earendil-works/pi-coding-agent). */
	removed: string[];
	/** Links that could not be removed, with the OS error message. */
	failures: { name: string; message: string }[];
}

/**
 * List symlinks / junctions (including dangling ones) under nm/@earendil-works (and the former namespace).
 * These were created by v0.1.7 and earlier and point at the pi installation.
 * Real directories (packages npm installed normally, e.g. pi-tui) are not included.
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
				// Unreadable: skip
			}
		}
	}
	return links;
}

/**
 * Remove harness links. Why: bundled pi resolves @earendil-works/* to the running instance via virtualModules,
 * but subtrees loaded natively by Node resolve through node_modules; with a link present they follow it and
 * load a second, unbundled copy of pi (measured +~3s startup, and instanceof / singletons diverge from the main process).
 * Only the link itself is removed (unlinkSync) — never recursively, so a junction can't make us delete pi itself.
 */
export function removeHarnessLinks(nm: string): LinkCleanupResult {
	const removed: string[] = [];
	const failures: LinkCleanupResult["failures"] = [];
	for (const name of findHarnessLinks(nm)) {
		try {
			unlinkSync(join(nm, name));
			removed.push(name);
		} catch (error) {
			failures.push({ name, message: (error as Error).message });
		}
	}
	return { removed, failures };
}

/**
 * Ensure outRoot/package.json declares "type": "commonjs" (merged into an existing package.json; only `type` changes).
 *
 * Why: extension packages are usually "type": "module", so jiti hands their .js to Node's native import();
 * from then on the whole subtree (including dynamic import()) is resolved natively and @earendil-works/* can only
 * be found in node_modules: no link → Cannot find package; link → a second, unbundled copy of pi.
 * With the commonjs marker Node can't natively load these ESM-syntax .js files, so jiti falls back to transpiling
 * them itself, and harness imports resolve to the running pi through virtualModules.
 *
 * Returns whether the file was written; false when outRoot does not exist.
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
			// Corrupt package.json: overwrite with the minimal marker
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

/** Add the commonjs marker to every package's dist-opt under nm (scoped included); returns the names marked. Used to migrate old outputs at startup. */
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

/** Derive the optimized entry from the original: ./src/index.ts -> ./dist-opt/index.js; x.ts -> ./dist-opt/x.js */
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

/** Transpile the .ts tree under srcRoot into outRoot/*.js (relative .ts specifiers rewritten). Bare harness imports are kept as-is. */
async function transpileTree(
	srcRoot: string,
	outRoot: string,
	errors: string[],
): Promise<{ files: number; total: number }> {
	// Lazy-load esbuild only at build time so it doesn't slow down this extension's own startup (~2.5s)
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

/** Resolve a package's relative entry path (exports -> main); undefined when it can't be resolved. */
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

/** Collect bare package names (scope-aware, subpath stripped) from all import statements in a tree. require() is ignored: outputs are ESM, CJS deps are an edge case. */
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
				continue; // e.g. broken symlink: skip instead of aborting the whole build
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

/** Rewrite every import of pkgName in the tree to a file URL. */
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
 * Recursively handle dependency packages distributed as .ts (e.g. @juicesharp/rpiv-config) used by the optimized output:
 * transpile them into their own dist-opt and rewrite the bare imports in our output to file URLs.
 * The dependency's package.json is left untouched, so unoptimized consumers are unaffected.
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
		visited.set(pkgName, null); // placeholder to break cycles
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
		if (!entryRel || !entryRel.endsWith(".ts")) continue; // not distributed as .ts: nothing to do

		const t = await transpileTree(pkgDir, join(pkgDir, "dist-opt"), errors);
		// transpileTree already pushed errors (by relative path) into the shared array; no extra wrapping needed.
		// Recurse into .ts dependencies of this dependency's output
		await transpileDotTsDeps({ name: pkgName, pkgDir, srcDir: "." } as OptimizableExtension, nm, visited, errors);

		ensureCommonjsMarker(join(pkgDir, "dist-opt"));
		const targetEntry = join(pkgDir, "dist-opt", entryRel.replace(/^\.\//, "").replace(/\.ts$/, ".js"));
		if (existsSync(targetEntry)) {
			visited.set(pkgName, pathToFileURL(targetEntry).href);
			rewriteBareImportInTree(outRoot, pkgName, pathToFileURL(targetEntry).href);
		}
	}
}

/** Outcome of applying (or refusing to apply) the optimized entry. Rendered to text by the UI layer (i18n). */
export type ApplyOutcome =
	| { code: "applied"; from: string; to: string }
	| { code: "alreadyApplied" }
	| { code: "noExtensions" }
	| { code: "srcMissing"; path: string }
	| { code: "transpileErrors" }
	| { code: "artifactMissing"; entry: string };

export type RollbackOutcome = "restored" | "noBackup";

export interface BuildResult {
	name: string;
	ok: boolean;
	files: number;
	total: number;
	apply: ApplyOutcome;
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
 * Apply the entry rewrite; only called after a fully successful transpile.
 * The target is derived from the original entry file name (index.js is not hard-coded).
 * While the current entry is still the original .ts, the backup is always refreshed from the current package.json
 * so an upgraded extension never keeps a stale backup. Once the entry is optimized, the backup is never overwritten.
 */
export function applyOne(ext: OptimizableExtension): ApplyOutcome {
	const packageJsonPath = join(ext.pkgDir, "package.json");
	const backupPath = `${packageJsonPath}.pi-orig`;
	const raw = readFileSync(packageJsonPath);
	const pkg = JSON.parse(raw.toString("utf8"));
	if (!pkg.pi?.extensions?.length) return { code: "noExtensions" };
	const target = optimizedEntryFor(ext.entry);
	const previous = pkg.pi.extensions[0];
	if (previous === target) return { code: "alreadyApplied" };
	// package.json now holds the current version's original entry, so overwriting an old backup is safe and necessary.
	writeFileSync(backupPath, raw);
	// Replace only item 0 and keep the remaining entries of multi-entry packages.
	const extensions = [...pkg.pi.extensions];
	extensions[0] = target;
	pkg.pi.extensions = extensions;
	writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
	return { code: "applied", from: previous, to: target };
}

export async function buildOne(ext: OptimizableExtension): Promise<BuildResult> {
	const errors: string[] = [];
	const srcRoot = join(ext.pkgDir, ext.srcDir);
	if (!existsSync(srcRoot)) {
		return { name: ext.name, ok: false, files: 0, total: 0, apply: { code: "srcMissing", path: srcRoot }, errors };
	}
	const nm = nodeModulesRootOf(ext.pkgDir);
	const compiled = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
	// Recursively transpile .ts-distributed dependencies of the output (native dynamic chains need .js)
	await transpileDotTsDeps(ext, nm, new Map(), errors);
	// Bare harness imports (@earendil-works/*) are kept and dist-opt is marked commonjs, so jiti transpiles
	// the whole subtree and resolves them to the running pi via virtualModules (see ensureCommonjsMarker).
	ensureCommonjsMarker(join(ext.pkgDir, "dist-opt"));

	const targetEntry = optimizedEntryFor(ext.entry);
	const targetFile = join(ext.pkgDir, targetEntry.replace(/^\.\//, ""));
	const productOk = errors.length === 0 && existsSync(targetFile);
	let apply: ApplyOutcome;
	if (errors.length > 0) {
		apply = { code: "transpileErrors" };
	} else if (!existsSync(targetFile)) {
		apply = { code: "artifactMissing", entry: targetEntry };
	} else {
		apply = applyOne(ext);
	}
	return {
		name: ext.name,
		ok: productOk,
		files: compiled.files,
		total: compiled.total,
		apply,
		errors,
	};
}

export function rollbackOne(pkg: PiPackage): RollbackOutcome {
	const packageJsonPath = join(pkg.pkgDir, "package.json");
	const backupPath = `${packageJsonPath}.pi-orig`;
	if (!existsSync(backupPath)) return "noBackup";
	writeFileSync(packageJsonPath, readFileSync(backupPath));
	return "restored";
}

export function getPackageStatus(pkg: PiPackage): PackageStatus {
	// Optimized entries are checked by their actual file (works for non-index entries); otherwise keep the old index.js semantics
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

/** Latest mtime of files matching the predicate in a tree (used for staleness checks). */
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
 * Whether an extension needs a (re)build:
 * - entry is still .ts → yes (not optimized)
 * - entry points at dist-opt but the output is missing → yes (broken)
 * - source tree is newer than the output tree (all .js, not just the entry) → yes (stale: extension upgraded, old output remains)
 */
export function extensionNeedsBuild(ext: OptimizableExtension): boolean {
	if (!ext.optimized) return true;
	const targetFile = join(ext.pkgDir, optimizedEntryFor(ext.entry).replace(/^\.\//, ""));
	if (!existsSync(targetFile)) return true;
	if (!hasCommonjsMarker(join(ext.pkgDir, "dist-opt"))) return true; // output from v0.1.7 or earlier
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
