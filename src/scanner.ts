import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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
