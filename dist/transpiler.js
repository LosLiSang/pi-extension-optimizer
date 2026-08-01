import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { realHarnessDir } from "./paths.js";
const OPTIMIZED_ENTRY = "./dist-opt/index.js";
const SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "dist", "dist-opt", ".git", "coverage"]);
const BARE_IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+|export[^;]*from\s+)\s*["']([^"']+)["']/g;
function ensureHarnessJunctions(nm) {
  const harness = realHarnessDir();
  const nestedRoot = join(harness, "node_modules", "@earendil-works");
  const created = [];
  const targets = [
    ["@earendil-works/pi-coding-agent", harness],
    ["@earendil-works/pi-ai", join(nestedRoot, "pi-ai")],
    ["@earendil-works/pi-agent-core", join(nestedRoot, "pi-agent-core")]
  ];
  for (const [name, target] of targets) {
    const link = join(nm, name);
    if (existsSync(link)) continue;
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, "junction");
      created.push(name);
    } catch {
    }
  }
  return created;
}
function optimizedEntryFor(entry) {
  const rel = entry.replace(/^\.\//, "");
  const file = rel.split("/").pop() ?? "index.ts";
  return `./dist-opt/${file.replace(/\.ts$/, ".js")}`;
}
function rewriteRelativeTsImports(code) {
  return code.replace(/(from|import)(\s*\(?)(["'])(\.\.?\/[^"']*?)\.ts\3/g, "$1$2$3$4.js$3");
}
function walkTypeScript(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walkTypeScript(full, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}
async function transpileTree(srcRoot, outRoot, errors) {
  const { transform } = await import("esbuild");
  const files = walkTypeScript(srcRoot);
  let written = 0;
  for (const file of files) {
    try {
      const result = await transform(readFileSync(file, "utf8"), {
        loader: "ts",
        format: "esm",
        target: "node20",
        sourcefile: file
      });
      const output = join(outRoot, relative(srcRoot, file).replace(/\.ts$/, ".js"));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, rewriteRelativeTsImports(result.code));
      written++;
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      errors.push(`${relative(srcRoot, file)}: ${message}`);
    }
  }
  return { files: written, total: files.length };
}
async function transpileOne(ext) {
  const errors = [];
  const srcRoot = join(ext.pkgDir, ext.srcDir);
  if (!existsSync(srcRoot)) return { files: 0, total: 0, errors: [`\u6E90\u7801\u76EE\u5F55\u4E0D\u5B58\u5728: ${srcRoot}`] };
  const result = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
  return { ...result, errors };
}
function nodeModulesRootOf(pkgDir) {
  const parent = dirname(pkgDir);
  return basename(parent) === "node_modules" ? parent : dirname(parent);
}
function resolvePackageEntry(pj) {
  const ex = pj?.exports;
  if (ex && typeof ex === "object") {
    const dot = ex["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const imp = dot.import;
      if (typeof imp === "string") return imp;
      if (imp && typeof imp === "object" && typeof imp.default === "string") return imp.default;
      if (typeof dot.default === "string") return dot.default;
    }
  }
  return typeof pj?.main === "string" ? pj.main : void 0;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function collectBarePackageNames(dir) {
  const out = /* @__PURE__ */ new Set();
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(full);
      } else if (n.endsWith(".js")) {
        const code = readFileSync(full, "utf8");
        for (const m of code.matchAll(BARE_IMPORT_RE)) {
          const spec = m[1];
          if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("file:") || spec.startsWith("/")) continue;
          const parts = spec.split("/");
          out.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
        }
      }
    }
  };
  walk(dir);
  return out;
}
function rewriteBareImportInTree(root, pkgName, fileUrl) {
  const re = new RegExp(`(from\\s+|import\\s*\\(\\s*|import\\s+|export[^;]*from\\s+)\\s*["']${escapeRegExp(pkgName)}["']`, "g");
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(full);
      } else if (n.endsWith(".js")) {
        const code = readFileSync(full, "utf8");
        const next = code.replace(re, `$1"${fileUrl}"`);
        if (next !== code) writeFileSync(full, next);
      }
    }
  };
  walk(root);
}
async function transpileDotTsDeps(ext, nm, visited, errors) {
  const outRoot = join(ext.pkgDir, "dist-opt");
  const bare = collectBarePackageNames(outRoot);
  for (const pkgName of bare) {
    if (visited.has(pkgName)) continue;
    visited.set(pkgName, null);
    const pkgDir = join(nm, pkgName);
    const pjPath = join(pkgDir, "package.json");
    if (!existsSync(pjPath)) continue;
    let pj;
    try {
      pj = JSON.parse(readFileSync(pjPath, "utf8"));
    } catch {
      continue;
    }
    const entryRel = resolvePackageEntry(pj);
    if (!entryRel || !entryRel.endsWith(".ts")) continue;
    const t = await transpileTree(pkgDir, join(pkgDir, "dist-opt"), errors);
    await transpileDotTsDeps({ name: pkgName, pkgDir, srcDir: "." }, nm, visited, errors);
    const targetEntry = join(pkgDir, "dist-opt", entryRel.replace(/^\.\//, "").replace(/\.ts$/, ".js"));
    if (existsSync(targetEntry)) {
      visited.set(pkgName, pathToFileURL(targetEntry).href);
      rewriteBareImportInTree(outRoot, pkgName, pathToFileURL(targetEntry).href);
    }
  }
}
function applyOne(ext) {
  const packageJsonPath = join(ext.pkgDir, "package.json");
  const backupPath = `${packageJsonPath}.pi-orig`;
  const raw = readFileSync(packageJsonPath);
  const pkg = JSON.parse(raw.toString("utf8"));
  if (!pkg.pi?.extensions?.length) return "\u65E0 pi.extensions\uFF0C\u8DF3\u8FC7";
  const target = optimizedEntryFor(ext.entry);
  const previous = pkg.pi.extensions[0];
  if (previous === target) return "\u5DF2\u5E94\u7528";
  writeFileSync(backupPath, raw);
  pkg.pi.extensions = [target];
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}
`);
  return `${previous} \u2192 ${target}`;
}
async function buildOne(ext) {
  const errors = [];
  const srcRoot = join(ext.pkgDir, ext.srcDir);
  if (!existsSync(srcRoot)) {
    return { name: ext.name, ok: false, files: 0, total: 0, applyMessage: `\u6E90\u7801\u76EE\u5F55\u4E0D\u5B58\u5728: ${srcRoot}`, errors };
  }
  const nm = nodeModulesRootOf(ext.pkgDir);
  ensureHarnessJunctions(nm);
  const compiled = await transpileTree(srcRoot, join(ext.pkgDir, "dist-opt"), errors);
  await transpileDotTsDeps(ext, nm, /* @__PURE__ */ new Map(), errors);
  const targetEntry = optimizedEntryFor(ext.entry);
  const targetFile = join(ext.pkgDir, targetEntry.replace(/^\.\//, ""));
  const productOk = errors.length === 0 && existsSync(targetFile);
  let applyMessage;
  if (errors.length > 0) {
    applyMessage = "\u8F6C\u8BD1\u6709\u9519\u8BEF\uFF0C\u4FDD\u7559\u539F\u5165\u53E3";
  } else if (!existsSync(targetFile)) {
    applyMessage = `\u4EA7\u7269\u7F3A\u5931\uFF08${targetEntry}\uFF09\uFF0C\u4FDD\u7559\u539F\u5165\u53E3`;
  } else {
    applyMessage = applyOne(ext);
  }
  return {
    name: ext.name,
    ok: productOk,
    files: compiled.files,
    total: compiled.total,
    applyMessage,
    errors
  };
}
function rollbackOne(pkg) {
  const packageJsonPath = join(pkg.pkgDir, "package.json");
  const backupPath = `${packageJsonPath}.pi-orig`;
  if (!existsSync(backupPath)) return "\u65E0\u5907\u4EFD\uFF0C\u672A\u6539\u52A8";
  writeFileSync(packageJsonPath, readFileSync(backupPath));
  return "\u5DF2\u4ECE package.json.pi-orig \u6062\u590D";
}
function getPackageStatus(pkg) {
  const distExists = existsSync(join(pkg.pkgDir, "dist-opt", "index.js"));
  const hasBackup = existsSync(join(pkg.pkgDir, "package.json.pi-orig"));
  let state;
  if (pkg.entry.startsWith("./dist-opt/")) state = distExists ? "optimized" : "broken";
  else if (pkg.entry.endsWith(".ts")) state = "typescript";
  else state = "javascript";
  return { name: pkg.name, entry: pkg.entry, state, distExists, hasBackup };
}
function latestSourceMtime(dir) {
  let latest = 0;
  const walk = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const full = join(d, n);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n)) walk(full);
      } else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) {
        latest = Math.max(latest, st.mtimeMs);
      }
    }
  };
  walk(dir);
  return latest;
}
function extensionNeedsBuild(ext) {
  if (!ext.optimized) return true;
  const targetFile = join(ext.pkgDir, optimizedEntryFor(ext.entry).replace(/^\.\//, ""));
  if (!existsSync(targetFile)) return true;
  const srcRoot = join(ext.pkgDir, ext.srcDir);
  if (!existsSync(srcRoot)) return false;
  try {
    return latestSourceMtime(srcRoot) > statSync(targetFile).mtimeMs + 1e3;
  } catch {
    return false;
  }
}
export {
  OPTIMIZED_ENTRY,
  applyOne,
  buildOne,
  ensureHarnessJunctions,
  extensionNeedsBuild,
  getPackageStatus,
  optimizedEntryFor,
  rollbackOne,
  transpileOne
};
