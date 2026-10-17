import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
// Share parsing logic with the extension to avoid diverging copies (the runner ships next to dist/, so it always exists).
// Errors are reported as { code, detail } and translated by the extension's UI layer.
import { findPackageDir } from "./dist/paths.js";
import { parseNpmName, resolveExtensionFiles } from "./dist/scanner.js";

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
// Harness dependencies may be nested (<harness>/node_modules, npm global install) or hoisted next to the harness
// (<release>/node_modules, pi installer 1.3+); resolve them the way Node does instead of assuming one layout.
function harnessDep(name, rel) {
  const dir = findPackageDir(harness, name);
  if (!dir) {
    console.error(`measure-runner: cannot locate ${name} from ${harness}`);
    process.exit(3);
  }
  return join(dir, rel);
}
const { createJiti } = await import(pathToFileURL(harnessDep("jiti", join("lib", "jiti-static.mjs"))).href);

const earendil = (pkg, rel) => harnessDep(`@earendil-works/${pkg}`, rel);
const typeboxBuild = (rel) => harnessDep("typebox", join("build", rel));
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
  typebox: typeboxBuild("index.mjs"),
  "typebox/compile": typeboxBuild("compile/index.mjs"),
  "typebox/value": typeboxBuild("value/index.mjs"),
  "@sinclair/typebox": typeboxBuild("index.mjs"),
  "@sinclair/typebox/compile": typeboxBuild("compile/index.mjs"),
  "@sinclair/typebox/value": typeboxBuild("value/index.mjs")
};

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

const RELATIVE_IMPORT_RE = /(?:from\s*|import\s*)(\(\s*)?["'](\.{1,2}\/[^"']+)["']/g;

function resolveRelative(fromFile, spec) {
  const base = join(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, join(base, "index.js")]) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  }
  return undefined;
}

/**
 * Relative dynamic-import targets reachable from the entry files (modules loaded lazily at runtime, e.g. on first
 * command use). Follows the import graph instead of scanning the whole dist-opt tree, so orphaned files left by an
 * older build layout are not reported.
 */
function reachableDynamicImports(entryFiles) {
  const seen = new Set();
  const dynamic = [];
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !file.endsWith(".js")) continue;
    seen.add(file);
    let code;
    try { code = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of code.matchAll(RELATIVE_IMPORT_RE)) {
      const target = resolveRelative(file, m[2]);
      if (!target) continue;
      if (m[1] && !dynamic.includes(target)) dynamic.push(target);
      queue.push(target);
    }
  }
  return dynamic;
}

/**
 * Dynamic-chain check: load the relative dynamic imports reachable from the entry (simulates user-triggered runtime loads).
 * Loads through the same jiti setup as the entry — that is the real runtime path: dist-opt is marked
 * "type": "commonjs", so Node's native import() of these ESM-syntax files always fails (a false positive),
 * while jiti transpiles them and resolves harness imports through its aliases / virtualModules.
 */
async function verifyDynamicChain(pkgDir, entryFiles, createLoader) {
  const optimized = entryFiles.filter((file) => file.startsWith(join(pkgDir, "dist-opt")));
  for (const target of reachableDynamicImports(optimized)) {
    try {
      await createLoader().import(pathToFileURL(target).href);
    } catch (e) {
      return { code: "dynamicChain", detail: `${target.split(/[\\/]/).pop()}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
    }
  }
  return null;
}

function npmName(value) {
  const source = typeof value === "string" ? value : value?.source;
  if (typeof source !== "string" || !source.startsWith("npm:")) return undefined;
  return parseNpmName(source.slice(4));
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
const createLoader = () => createJiti(loaderUrl, { moduleCache: false, alias });

// Warm up the harness (the real pi main process has it loaded already): shared modules land in Node's registry cache and are reused for free
const warmStart = process.hrtime.bigint();
let warmMs = 0;
try {
  const j0 = createJiti(loaderUrl, { moduleCache: false, alias });
  await j0.import(pathToFileURL(join(harness, "dist", "index.js")).href, { default: true });
  warmMs = Math.round(Number(process.hrtime.bigint() - warmStart) / 1e6);
} catch {
  warmMs = 0; // warm-up failed: fall back to cold-start measurement
}

for (const name of names) {
  const pkgDir = join(nm, name);
  const pkg = readJson(join(pkgDir, "package.json"));
  const entries = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions.filter((entry) => typeof entry === "string") : [];
  if (entries.length === 0) {
    rows.push({ name, ms: 0, error: { code: "notInstalled" } });
    continue;
  }

  let packageMs = 0;
  let error;
  // Directory entries (e.g. "./extensions") expand the same way pi's package manager does.
  const { files, missing } = resolveExtensionFiles(pkgDir, entries);
  if (missing.length > 0) error = { code: "entryMissing", detail: missing.join(", ") };
  for (const entry of error ? [] : files) {
    const jiti = createLoader();
    const started = process.hrtime.bigint();
    try {
      await jiti.import(pathToFileURL(entry).href, { default: true });
    } catch (caught) {
      error = { code: "import", detail: caught instanceof Error ? caught.message.split("\n")[0] : String(caught) };
    }
    packageMs += Number(process.hrtime.bigint() - started) / 1e6;
    if (error) break;
  }
  if (!error && files.length > 0) {
    const dynError = await verifyDynamicChain(pkgDir, files, createLoader);
    if (dynError) error = dynError;
  }
  totalMs += packageMs;
  rows.push({ name, ms: Math.round(packageMs), ...(error ? { error } : {}) });
}

console.log(`__PI_EXT_OPT_RESULT__${JSON.stringify({ totalMs: Math.round(totalMs), warmMs, rows })}`);
