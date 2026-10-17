import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Parse an npm spec (@scope/pkg@1.2.3 -> @scope/pkg; pkg@1 -> pkg). */
export function parseNpmName(spec: string): string {
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		if (slash < 0) return spec; // incomplete spec (no name after scope): return as-is
		const at = spec.indexOf("@", slash + 1);
		return at >= 0 ? spec.slice(0, at) : spec;
	}
	const at = spec.indexOf("@");
	return at >= 0 ? spec.slice(0, at) : spec;
}

/** Read the set of enabled npm package names from ~/.pi/agent/settings.json. */
export function enabledNpmPackageNames(agentDir: string): Set<string> {
	const settings = readJson(join(agentDir, "settings.json"));
	const names = new Set<string>();
	for (const pkg of settings?.packages ?? []) {
		const source = typeof pkg === "string" ? pkg : pkg?.source;
		if (typeof source !== "string" || !source.startsWith("npm:")) continue;
		names.add(parseNpmName(source.slice(4)));
	}
	return names;
}

export interface PiPackage {
	name: string;
	pkgDir: string;
	entry: string;
}

export interface OptimizableExtension extends PiPackage {
	/** Original TypeScript entry, e.g. ./src/index.ts. */
	sourceEntry: string;
	/** Source directory relative to the package root, e.g. src or ".". */
	srcDir: string;
	/** Whether the entry currently points at dist-opt. */
	optimized: boolean;
}

function readJson(path: string): any | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

const isExtensionFile = (name: string) => name.endsWith(".ts") || name.endsWith(".js");

/** Entries of a directory resource, mirroring pi's resolveExtensionEntries: pi.extensions in package.json, else index.ts / index.js. */
function directoryEntryFiles(dir: string): string[] | undefined {
	const declared = readJson(join(dir, "package.json"))?.pi?.extensions;
	if (Array.isArray(declared)) {
		const files = declared.filter((entry): entry is string => typeof entry === "string").map((entry) => resolve(dir, entry)).filter((file) => existsSync(file));
		if (files.length > 0) return files;
	}
	for (const index of ["index.ts", "index.js"]) {
		if (existsSync(join(dir, index))) return [join(dir, index)];
	}
	return undefined;
}

/**
 * Expand a package's pi.extensions entries into the files pi actually loads (mirrors pi's package manager):
 * - a file entry is loaded as-is; a missing entry is reported in `missing`
 * - a directory entry resolves to its own entries (package.json / index), otherwise to the *.ts / *.js files
 *   directly inside it plus subdirectories that have entries (one level, no further recursion).
 * Simplification: .gitignore-style ignore files and glob entries are not evaluated.
 */
export function resolveExtensionFiles(pkgDir: string, entries: string[]): { files: string[]; missing: string[] } {
	const files: string[] = [];
	const missing: string[] = [];
	for (const entry of entries) {
		const full = resolve(pkgDir, entry);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			missing.push(entry);
			continue;
		}
		if (stat.isFile()) {
			files.push(full);
			continue;
		}
		const own = directoryEntryFiles(full);
		if (own) {
			files.push(...own);
			continue;
		}
		let names: string[] = [];
		try {
			names = readdirSync(full).filter((name) => !name.startsWith(".") && name !== "node_modules").sort();
		} catch {
			// unreadable directory: treated as empty
		}
		const before = files.length;
		for (const name of names) {
			const child = join(full, name);
			let childStat;
			try {
				childStat = statSync(child);
			} catch {
				continue;
			}
			if (childStat.isFile() && isExtensionFile(name)) files.push(child);
			else if (childStat.isDirectory()) files.push(...(directoryEntryFiles(child) ?? []));
		}
		if (files.length === before) missing.push(entry);
	}
	return { files, missing };
}

function inferSrcDir(entry: string): string {
	const rel = entry.replace(/^\.\//, "");
	const parts = rel.split("/");
	parts.pop();
	return parts.join("/") || ".";
}

/** Scan node_modules for every package that declares pi.extensions. */
export function scanPiExtensions(nmDir: string, exclude: string[] = []): PiPackage[] {
	const out: PiPackage[] = [];
	const excluded = new Set(exclude);

	const visit = (dir: string, scope = "") => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}

		for (const basename of names) {
			if (basename.startsWith(".")) continue;
			const pkgDir = join(dir, basename);
			let isDirectory = false;
			try {
				isDirectory = statSync(pkgDir).isDirectory();
			} catch {
				continue;
			}
			if (!isDirectory) continue;

			if (!scope && basename.startsWith("@")) {
				visit(pkgDir, basename);
				continue;
			}

			const fallbackName = scope ? `${scope}/${basename}` : basename;
			const pj = readJson(join(pkgDir, "package.json"));
			const entry = pj?.pi?.extensions?.[0];
			const name = typeof pj?.name === "string" ? pj.name : fallbackName;
			if (typeof entry !== "string" || excluded.has(name)) continue;
			out.push({ name, pkgDir, entry });
		}
	};

	visit(nmDir);
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover manageable extensions:
 * 1) the current entry is .ts; or
 * 2) already optimized, with the original .ts entry saved in package.json.pi-orig.
 */
export function scanOptimizableExtensions(nmDir: string, exclude: string[] = []): OptimizableExtension[] {
	return scanPiExtensions(nmDir, exclude).flatMap((pkg) => {
		let sourceEntry: string | undefined;
		if (pkg.entry.endsWith(".ts")) {
			sourceEntry = pkg.entry;
		} else {
			const original = readJson(join(pkg.pkgDir, "package.json.pi-orig"));
			const originalEntry = original?.pi?.extensions?.[0];
			if (typeof originalEntry === "string" && originalEntry.endsWith(".ts")) sourceEntry = originalEntry;
		}
		if (!sourceEntry) return [];
		return [{
			...pkg,
			sourceEntry,
			srcDir: inferSrcDir(sourceEntry),
			// Any dist-opt entry counts as optimized (index.js is not hard-coded; non-index entries work too)
			optimized: pkg.entry.startsWith("./dist-opt/"),
		}];
	});
}
