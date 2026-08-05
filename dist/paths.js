import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
function isHarnessDir(candidate) {
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    return pkg?.name === "@earendil-works/pi-coding-agent";
  } catch {
    return false;
  }
}
function harnessFromExecPath() {
  const candidate = join(dirname(process.execPath), "node_modules", "@earendil-works", "pi-coding-agent");
  return isHarnessDir(candidate) ? candidate : void 0;
}
function harnessFromArgv() {
  const entry = process.argv[1];
  if (!entry) return void 0;
  let current = dirname(resolve(entry));
  for (let depth = 0; depth < 12; depth++) {
    if (isHarnessDir(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return void 0;
}
function harnessFromRuntime() {
  return harnessFromArgv() ?? harnessFromExecPath();
}
const configDirName = memo(() => {
  try {
    const harnessDir = harnessFromRuntime();
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
    }
  }
  return junction;
});
export {
  agentDir,
  agentNodeModules,
  realHarnessDir
};
