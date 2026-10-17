import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Lazy evaluation + caching: paths don't change during the process lifetime, so resolve them once. */
function memo<T>(fn: () => T): () => T {
	let value: T | undefined;
	let done = false;
	return () => {
		if (!done) {
			value = fn();
			done = true;
		}
		return value as T;
	};
}

/** Check that a directory really is the pi-coding-agent package of the current namespace. */
function isHarnessDir(candidate: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
		return pkg?.name === "@earendil-works/pi-coding-agent";
	} catch {
		return false;
	}
}

/**
 * Derive the harness from process.execPath (for installs where Node and the global npm root share a prefix).
 * Depends only on execPath, not on agentDir — this is what breaks the agentDir ⇄ realHarnessDir cycle.
 */
function harnessFromExecPath(): string | undefined {
	const binDir = dirname(process.execPath);
	const prefixDir = dirname(binDir);
	const candidates = [
		// Windows/npm and some portable Node layouts: node.exe sits next to node_modules.
		join(binDir, "node_modules", "@earendil-works", "pi-coding-agent"),
		// Unix/npm (including WSL + nvm): <prefix>/bin/node + <prefix>/lib/node_modules.
		join(prefixDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
	];
	return candidates.find(isHarnessDir);
}

/**
 * Walk up from the actual launch script to find the harness package root. In some npm/nvm/Volta layouts node.exe
 * and the global node_modules don't share a prefix, but process.argv[1] still lives inside pi-coding-agent.
 * On Unix/WSL npm usually makes `bin/pi` a symlink to the package's cli.js, so realpath it first — otherwise we'd
 * only walk up from `<prefix>/bin` and never reach the real harness package root.
 */
function harnessFromArgv(): string | undefined {
	const entry = process.argv[1];
	if (!entry) return undefined;
	const absoluteEntry = resolve(entry);
	let resolvedEntry = absoluteEntry;
	try {
		resolvedEntry = realpathSync(absoluteEntry);
	} catch {
		// The launch argument may not be an existing file; keep the absolute path and keep probing.
	}
	let current = dirname(resolvedEntry);
	for (let depth = 0; depth < 12; depth++) {
		if (isHarnessDir(current)) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

/**
 * Locate an installed package directory the way Node resolves bare specifiers: walk up from `fromDir` checking
 * `<dir>/node_modules/<name>`. Works for both layouts pi ships with:
 * - nested (npm global): <harness>/node_modules/<name>
 * - hoisted (pi installer, 1.3+): <release>/node_modules/<name>, next to @earendil-works/pi-coding-agent
 */
export function findPackageDir(fromDir: string, name: string): string | undefined {
	let current = resolve(fromDir);
	for (;;) {
		const candidate = join(current, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Harness detection that doesn't depend on agentDir; shared by the config-dir and real-harness-path lookups. */
function harnessFromRuntime(): string | undefined {
	return harnessFromArgv() ?? harnessFromExecPath();
}

/**
 * User-level config directory name (default .pi). To support renamed distributions it is read from
 * piConfig.configDir in the harness package.json found via the runtime (if resolvable); otherwise ".pi".
 * Note: don't locate the harness via realHarnessDir()/agentNodeModules() — that would recurse forever:
 * agentDir → configDirName → realHarnessDir → agentNodeModules → agentDir.
 */
const configDirName = memo((): string => {
	try {
		const harnessDir = harnessFromRuntime();
		if (harnessDir) {
			const pkg = JSON.parse(readFileSync(join(harnessDir, "package.json"), "utf8"));
			const configured = pkg?.piConfig?.configDir;
			if (typeof configured === "string" && configured) return configured;
		}
	} catch {
		// Unresolvable: use the default
	}
	return ".pi";
});

/**
 * Agent config directory (default ~/.pi/agent). Equivalent to the harness's getAgentDir():
 * PI_CODING_AGENT_DIR if set, otherwise homedir/<configDir>/agent.
 */
const agentDir = memo((): string => {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env;
	return join(homedir(), configDirName(), "agent");
});

/** node_modules root where pi installs extensions (default ~/.pi/agent/npm/node_modules). */
const agentNodeModules = memo((): string => join(agentDir(), "npm", "node_modules"));

/**
 * Real harness directory (where pi itself is installed).
 * 1) probe independently from the actual CLI path or process.execPath
 * 2) a link left by old versions under pi's node_modules root → follow it with realpath
 * 3) last resort: return that link path (only used for measure diagnostics)
 */
const realHarnessDir = memo((): string => {
	const fromRuntime = harnessFromRuntime();
	if (fromRuntime) {
		try {
			return realpathSync(fromRuntime);
		} catch {
			return fromRuntime;
		}
	}

	const junction = join(agentNodeModules(), "@earendil-works", "pi-coding-agent");
	if (isHarnessDir(junction)) {
		try {
			return realpathSync(junction);
		} catch {
			// Broken junction: fall through to the diagnostic path
		}
	}
	return junction;
});

export { agentDir, agentNodeModules, realHarnessDir };
