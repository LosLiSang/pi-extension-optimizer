import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const agentDir = arg("--agent-dir");
const harness = arg("--harness");
if (!agentDir || !harness) {
  console.error("usage: measure-runner.mjs --agent-dir <path> --harness <path>");
  process.exit(2);
}

const nm = join(agentDir, "npm", "node_modules");
const loader = join(harness, "dist", "core", "extensions", "loader.js");
const hnm = join(harness, "node_modules");
const { createJiti } = await import(pathToFileURL(join(hnm, "jiti", "lib", "jiti-static.mjs")).href);

const earendil = (pkg, rel) => join(hnm, "@earendil-works", pkg, rel);
const alias = {
  "@earendil-works/pi-coding-agent": join(harness, "dist", "index.js"),
  "@earendil-works/pi-agent-core": earendil("pi-agent-core", "dist/index.js"),
  "@earendil-works/pi-tui": earendil("pi-tui", "dist/index.js"),
  "@earendil-works/pi-ai/providers/all": earendil("pi-ai", "dist/providers/all.js"),
  "@earendil-works/pi-ai/compat": earendil("pi-ai", "dist/compat.js"),
  "@earendil-works/pi-ai/oauth": earendil("pi-ai", "dist/oauth.js"),
  "@earendil-works/pi-ai": earendil("pi-ai", "dist/compat.js"),
  "@mariozechner/pi-coding-agent": join(harness, "dist", "index.js"),
  "@mariozechner/pi-agent-core": earendil("pi-agent-core", "dist/index.js"),
  "@mariozechner/pi-tui": earendil("pi-tui", "dist/index.js"),
  "@mariozechner/pi-ai/providers/all": earendil("pi-ai", "dist/providers/all.js"),
  "@mariozechner/pi-ai/compat": earendil("pi-ai", "dist/compat.js"),
  "@mariozechner/pi-ai/oauth": earendil("pi-ai", "dist/oauth.js"),
  "@mariozechner/pi-ai": earendil("pi-ai", "dist/compat.js"),
  typebox: join(hnm, "typebox", "build", "index.mjs"),
  "typebox/compile": join(hnm, "typebox", "build", "compile", "index.mjs"),
  "typebox/value": join(hnm, "typebox", "build", "value", "index.mjs"),
  "@sinclair/typebox": join(hnm, "typebox", "build", "index.mjs"),
  "@sinclair/typebox/compile": join(hnm, "typebox", "build", "compile", "index.mjs"),
  "@sinclair/typebox/value": join(hnm, "typebox", "build", "value", "index.mjs")
};

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** 收集目录树中相对动态 import 目标（运行时 native 链，jiti alias 不覆盖）。 */
function collectRelativeDynamicImports(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (!["node_modules", "dist", "dist-opt", ".git"].includes(name)) collectRelativeDynamicImports(full, acc);
    } else if (name.endsWith(".js")) {
      const code = readFileSync(full, "utf8");
      for (const m of code.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const target = join(dirname(full), m[1]);
        if (existsSync(target) && !acc.includes(target)) acc.push(target);
      }
    }
  }
  return acc;
}

/** 动态链验证：产物中的相对动态 import 用 Node 原生加载（模拟运行时用户触发）。 */
async function verifyDynamicChain(pkgDir, entryFile) {
  const inDistOpt = entryFile.includes(join(pkgDir, "dist-opt")) || String(entryFile).includes("dist-opt");
  if (!inDistOpt) return null;
  const targets = collectRelativeDynamicImports(join(pkgDir, "dist-opt"));
  for (const target of targets) {
    try {
      await import(pathToFileURL(target).href);
    } catch (e) {
      return `动态链 ${target.split(/[\\/]/).pop()}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
    }
  }
  return null;
}

function npmName(value) {
  const source = typeof value === "string" ? value : value?.source;
  if (typeof source !== "string" || !source.startsWith("npm:")) return undefined;
  const spec = source.slice(4);
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const versionAt = slash >= 0 ? spec.indexOf("@", slash + 1) : -1;
    return versionAt >= 0 ? spec.slice(0, versionAt) : spec;
  }
  const versionAt = spec.indexOf("@");
  return versionAt >= 0 ? spec.slice(0, versionAt) : spec;
}

function installedPiPackages() {
  const out = [];
  const visit = (dir, scope = "") => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const basename of names) {
      const pkgDir = join(dir, basename);
      try { if (!statSync(pkgDir).isDirectory()) continue; } catch { continue; }
      if (!scope && basename.startsWith("@")) { visit(pkgDir, basename); continue; }
      const pkg = readJson(join(pkgDir, "package.json"));
      if (Array.isArray(pkg?.pi?.extensions)) out.push(pkg.name ?? (scope ? `${scope}/${basename}` : basename));
    }
  };
  visit(nm);
  return out;
}

const settings = readJson(join(agentDir, "settings.json"));
let names = Array.isArray(settings?.packages) ? settings.packages.map(npmName).filter(Boolean) : [];
if (names.length === 0) names = installedPiPackages();

const rows = [];
let totalMs = 0;
const loaderUrl = pathToFileURL(loader).href;

// 预热 harness（模拟真实 pi 主进程已加载）：共享模块进 Node registry 缓存，后续扩展免费复用
const warmStart = process.hrtime.bigint();
let warmMs = 0;
try {
  const j0 = createJiti(loaderUrl, { moduleCache: false, alias });
  await j0.import(pathToFileURL(join(harness, "dist", "index.js")).href, { default: true });
  warmMs = Math.round(Number(process.hrtime.bigint() - warmStart) / 1e6);
} catch {
  warmMs = 0; // 预热失败则退化为冷启动测量
}

for (const name of names) {
  const pkgDir = join(nm, name);
  const pkg = readJson(join(pkgDir, "package.json"));
  const entries = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : [];
  if (entries.length === 0) {
    rows.push({ name, ms: 0, error: "无 pi.extensions 或包未安装" });
    continue;
  }

  let packageMs = 0;
  let error;
  for (const rel of entries) {
    const entry = join(pkgDir, String(rel).replace(/^\.\//, ""));
    if (!existsSync(entry)) {
      error = `入口不存在: ${rel}`;
      break;
    }
    const jiti = createJiti(loaderUrl, { moduleCache: false, alias });
    const started = process.hrtime.bigint();
    try {
      await jiti.import(pathToFileURL(entry).href, { default: true });
    } catch (caught) {
      error = caught instanceof Error ? caught.message.split("\n")[0] : String(caught);
    }
    packageMs += Number(process.hrtime.bigint() - started) / 1e6;
    if (error) break;
  }
  if (!error) {
    const firstEntry = join(pkgDir, String(entries[0]).replace(/^\.\//, ""));
    const dynError = await verifyDynamicChain(pkgDir, firstEntry);
    if (dynError) error = dynError;
  }
  totalMs += packageMs;
  rows.push({ name, ms: Math.round(packageMs), ...(error ? { error } : {}) });
}

console.log(`__PI_EXT_OPT_RESULT__${JSON.stringify({ totalMs: Math.round(totalMs), warmMs, rows })}`);
