import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 用户级配置目录名（默认 .pi）。为兼容重命名分发，从真实 harness 的 package.json
 * 的 piConfig.configDir 读取（若能解析到 harness）；否则用默认 ".pi"。
 * 不 import harness 主包——那会让扩展自身启动付出 ~2.4s 的 harness 加载成本。
 */
function configDirName(): string {
	try {
		const harnessPkg = join(realHarnessDir(), "package.json");
		const pkg = JSON.parse(readFileSync(harnessPkg, "utf8"));
		const configured = pkg?.piConfig?.configDir;
		if (typeof configured === "string" && configured) return configured;
	} catch {
		// 无法解析则用默认
	}
	return ".pi";
}

/**
 * agent 配置目录（默认 ~/.pi/agent）。与 harness getAgentDir() 等价：
 * 优先 PI_CODING_AGENT_DIR 环境变量，否则 homedir/<configDir>/agent。
 */
export function agentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env;
	return join(homedir(), configDirName(), "agent");
}

/**
 * pi 安装扩展的 node_modules 根目录（默认 ~/.pi/agent/npm/node_modules）。
 */
export function agentNodeModules(): string {
	return join(agentDir(), "npm", "node_modules");
}

/**
 * 真实 harness 目录（即 pi 本体安装位置）。
 * 1) pi node_modules 根的 junction（ensureHarnessJunctions 创建）→ realpath 解析
 * 2) process.execPath 推导（pi 用 nvm 的 node 运行，harness 在 node 同级 node_modules）
 * 3) 最后手段：join(agentNodeModules(), "@earendil-works", "pi-coding-agent")（junction 或已安装副本）
 */
export function realHarnessDir(): string {
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
	const fromExec = join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent");
	if (existsSync(join(fromExec, "package.json"))) return fromExec;
	// 3) 最后手段
	return junction;
}
