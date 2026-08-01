import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function configDirName() {
  try {
    const harnessPkg = join(realHarnessDir(), "package.json");
    const pkg = JSON.parse(readFileSync(harnessPkg, "utf8"));
    const configured = pkg?.piConfig?.configDir;
    if (typeof configured === "string" && configured) return configured;
  } catch {
  }
  return ".pi";
}
function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env;
  return join(homedir(), configDirName(), "agent");
}
function agentNodeModules() {
  return join(agentDir(), "npm", "node_modules");
}
function realHarnessDir() {
  const junction = join(agentNodeModules(), "@earendil-works", "pi-coding-agent");
  if (existsSync(join(junction, "package.json"))) {
    try {
      return realpathSync(junction);
    } catch {
    }
  }
  const fromExec = join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(join(fromExec, "package.json"))) return fromExec;
  return junction;
}
export {
  agentDir,
  agentNodeModules,
  realHarnessDir
};
