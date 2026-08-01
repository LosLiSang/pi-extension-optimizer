import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * 由 process.execPath 推导的 harness 位置（如 nvm 全局安装、npm 全局安装）。
 * 只依赖 execPath，不依赖 agentDir —— 这是打破 agentDir ⇄ realHarnessDir 循环的关键。
 */
function harnessFromExecPath(): string | undefined {
	const candidate = join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent");
	return existsSync(join(candidate, "package.json")) ? candidate : undefined;
}

/**
 * 用户级配置目录名（默认 .pi）。为兼容重命名分发，从 execPath 推导出的
 * harness package.json 的 piConfig.configDir 读取（若能解析到 harness）；否则用默认 ".pi"。
 * 注意：不能通过 realHarnessDir()/agentNodeModules() 来找 harness —— 那会形成
 * agentDir → configDirName → realHarnessDir → agentNodeModules → agentDir 的无限递归。
 */
const configDirName = memo((): string => {
	try {
		const harnessDir = harnessFromExecPath();
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
 * 1) pi node_modules 根的 junction（ensureHarnessJunctions 创建）→ realpath 穿透
 * 2) process.execPath 推导（pi 用 nvm 的 node 运行，harness 在 node 同级 node_modules）
 * 3) 最后手段：join(agentNodeModules(), "@earendil-works", "pi-coding-agent")（junction 或已安装副本）
 */
const realHarnessDir = memo((): string => {
	// 1) junction 已指向真实 harness → realpath 穿透
	const junction = join(agentNodeModules(), "@earendil-works", "pi-coding-agent");
	if (existsSync(join(junction, "package.json"))) {
		try {
			return realpathSync(junction);
		} catch {
			// junction 损坏则继续探测
		}
	}
	// 2) execPath 推导
	const fromExec = harnessFromExecPath();
	if (fromExec) return fromExec;
	// 3) 最后手段
	return junction;
});

export { agentDir, agentNodeModules, realHarnessDir };
