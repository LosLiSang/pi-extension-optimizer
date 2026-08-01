import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
function memo(fn) {
  let value;
  let done = false;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}
function harnessFromExecPath() {
  const candidate = join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent");
  return existsSync(join(candidate, "package.json")) ? candidate : void 0;
}
const configDirName = memo(() => {
  try {
    const harnessDir = harnessFromExecPath();
    if (harnessDir) {
      const pkg = JSON.parse(readFileSync(join(harnessDir, "package.json"), "utf8"));
      const configured = pkg?.piConfig?.configDir;
      if (typeof configured === "string" && configured) return configured;
    }
  } catch {
  }
  return ".pi";
});
const agentDir = memo(() => {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env;
  return join(homedir(), configDirName(), "agent");
});
const agentNodeModules = memo(() => join(agentDir(), "npm", "node_modules"));
const realHarnessDir = memo(() => {
  const junction = join(agentNodeModules(), "@earendil-works", "pi-coding-agent");
  if (existsSync(join(junction, "package.json"))) {
    try {
      return realpathSync(junction);
    } catch {
    }
  }
  const fromExec = harnessFromExecPath();
  if (fromExec) return fromExec;
  return junction;
});
export {
  agentDir,
  agentNodeModules,
  realHarnessDir
};
