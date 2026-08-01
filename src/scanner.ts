import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 解析 npm spec（npm:@scope/pkg@1.2.3 -> @scope/pkg；npm:pkg@1 -> pkg） */
export function parseNpmName(spec: string): string {
	if (spec.startsWith("@")) {
		const slash = spec.indexOf("/");
		const at = spec.indexOf("@", slash + 1);
		return at >= 0 ? spec.slice(0, at) : spec;
	}
	const at = spec.indexOf("@");
	return at >= 0 ? spec.slice(0, at) : spec;
}

/** 从 ~/.pi/agent/settings.json 读取当前启用的 npm 包名集合。 */
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
	/** 原始 TypeScript 入口，如 ./src/index.ts。 */
	sourceEntry: string;
	/** 源码相对包根目录，如 src 或 .。 */
	srcDir: string;
	/** 当前是否已指向 dist-opt。 */
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

/** 扫描 node_modules 中所有声明 pi.extensions 的包。 */
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
 * 自动发现可管理的扩展：
 * 1) 当前入口为 .ts；或
 * 2) 当前已优化，package.json.pi-orig 中保存了原 .ts 入口。
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
			optimized: pkg.entry === "./dist-opt/index.js",
		}];
	});
}
