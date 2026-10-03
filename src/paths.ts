import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** 惰性求值 + 缓存：路径在进程生命周期内不变，避免重复解析。 */
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

/** 验证目录确实是当前命名空间的 pi-coding-agent 包。 */
function isHarnessDir(candidate: string): boolean {
	try {
		const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
		return pkg?.name === "@earendil-works/pi-coding-agent";
	} catch {
		return false;
	}
}

/**
 * 由 process.execPath 推导 harness（适用于 Node 与全局 npm root 同目录的安装）。
 * 只依赖 execPath，不依赖 agentDir —— 这是打破 agentDir ⇄ realHarnessDir 循环的关键。
 */
function harnessFromExecPath(): string | undefined {
	const binDir = dirname(process.execPath);
	const prefixDir = dirname(binDir);
	const candidates = [
		// Windows/npm 及部分便携式 Node 布局：node.exe 与 node_modules 同目录层级。
		join(binDir, "node_modules", "@earendil-works", "pi-coding-agent"),
		// Unix/npm（包括 WSL + nvm）：<prefix>/bin/node + <prefix>/lib/node_modules。
		join(prefixDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
	];
	return candidates.find(isHarnessDir);
}

/**
 * 由实际启动脚本向上寻找 harness 包根。某些 npm/nvm/Volta 布局中 node.exe 与
 * 全局 node_modules 不在同一前缀，但 process.argv[1] 仍位于 pi-coding-agent 内。
 * npm 在 Unix/WSL 中通常把 `bin/pi` 做成指向包内 cli.js 的符号链接，必须先
 * realpath，否则只会沿 `<prefix>/bin` 向上找，永远看不到真实 harness 包根。
 */
function harnessFromArgv(): string | undefined {
	const entry = process.argv[1];
	if (!entry) return undefined;
	const absoluteEntry = resolve(entry);
	let resolvedEntry = absoluteEntry;
	try {
		resolvedEntry = realpathSync(absoluteEntry);
	} catch {
		// 启动参数可能不是现存文件；保留绝对路径继续做兼容探测。
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

/** 不依赖 agentDir 的 harness 探测，供配置目录与真实 harness 路径共同使用。 */
function harnessFromRuntime(): string | undefined {
	return harnessFromArgv() ?? harnessFromExecPath();
}

/**
 * 用户级配置目录名（默认 .pi）。为兼容重命名分发，从 execPath 推导出的
 * harness package.json 的 piConfig.configDir 读取（若能解析到 harness）；否则用默认 ".pi"。
 * 注意：不能通过 realHarnessDir()/agentNodeModules() 来找 harness —— 那会形成
 * agentDir → configDirName → realHarnessDir → agentNodeModules → agentDir 的无限递归。
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
		// 无法解析则用默认
	}
	return ".pi";
});

/**
 * agent 配置目录（默认 ~/.pi/agent）。与 harness getAgentDir() 等价：
 * 优先 PI_CODING_AGENT_DIR 环境变量，否则 homedir/<configDir>/agent。
 */
const agentDir = memo((): string => {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env;
	return join(homedir(), configDirName(), "agent");
});

/** pi 安装扩展的 node_modules 根目录（默认 ~/.pi/agent/npm/node_modules）。 */
const agentNodeModules = memo((): string => join(agentDir(), "npm", "node_modules"));

/**
 * 真实 harness 目录（即 pi 本体安装位置）。
 * 1) 从实际 CLI 路径或 process.execPath 独立探测
 * 2) pi node_modules 根下旧版本留下的链接 → realpath 穿透
 * 3) 最后手段：返回该链接路径（仅用于 measure 诊断）
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
			// junction 损坏则落到诊断路径
		}
	}
	return junction;
});

export { agentDir, agentNodeModules, realHarnessDir };
