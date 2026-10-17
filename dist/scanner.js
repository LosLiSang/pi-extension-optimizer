import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
function parseNpmName(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash < 0) return spec;
    const at2 = spec.indexOf("@", slash + 1);
    return at2 >= 0 ? spec.slice(0, at2) : spec;
  }
  const at = spec.indexOf("@");
  return at >= 0 ? spec.slice(0, at) : spec;
}
function enabledNpmPackageNames(agentDir) {
  const settings = readJson(join(agentDir, "settings.json"));
  const names = /* @__PURE__ */ new Set();
  for (const pkg of settings?.packages ?? []) {
    const source = typeof pkg === "string" ? pkg : pkg?.source;
    if (typeof source !== "string" || !source.startsWith("npm:")) continue;
    names.add(parseNpmName(source.slice(4)));
  }
  return names;
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
const isExtensionFile = (name) => name.endsWith(".ts") || name.endsWith(".js");
function directoryEntryFiles(dir) {
  const declared = readJson(join(dir, "package.json"))?.pi?.extensions;
  if (Array.isArray(declared)) {
    const files = declared.filter((entry) => typeof entry === "string").map((entry) => resolve(dir, entry)).filter((file) => existsSync(file));
    if (files.length > 0) return files;
  }
  for (const index of ["index.ts", "index.js"]) {
    if (existsSync(join(dir, index))) return [join(dir, index)];
  }
  return void 0;
}
function resolveExtensionFiles(pkgDir, entries) {
  const files = [];
  const missing = [];
  for (const entry of entries) {
    const full = resolve(pkgDir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      missing.push(entry);
      continue;
    }
    if (stat.isFile()) {
      files.push(full);
      continue;
    }
    const own = directoryEntryFiles(full);
    if (own) {
      files.push(...own);
      continue;
    }
    let names = [];
    try {
      names = readdirSync(full).filter((name) => !name.startsWith(".") && name !== "node_modules").sort();
    } catch {
    }
    const before = files.length;
    for (const name of names) {
      const child = join(full, name);
      let childStat;
      try {
        childStat = statSync(child);
      } catch {
        continue;
      }
      if (childStat.isFile() && isExtensionFile(name)) files.push(child);
      else if (childStat.isDirectory()) files.push(...directoryEntryFiles(child) ?? []);
    }
    if (files.length === before) missing.push(entry);
  }
  return { files, missing };
}
function inferSrcDir(entry) {
  const rel = entry.replace(/^\.\//, "");
  const parts = rel.split("/");
  parts.pop();
  return parts.join("/") || ".";
}
function scanPiExtensions(nmDir, exclude = []) {
  const out = [];
  const excluded = new Set(exclude);
  const visit = (dir, scope = "") => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const basename of names) {
      if (basename.startsWith(".")) continue;
      const pkgDir = join(dir, basename);
      let isDirectory = false;
      try {
        isDirectory = statSync(pkgDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      if (!scope && basename.startsWith("@")) {
        visit(pkgDir, basename);
        continue;
      }
      const fallbackName = scope ? `${scope}/${basename}` : basename;
      const pj = readJson(join(pkgDir, "package.json"));
      const entry = pj?.pi?.extensions?.[0];
      const name = typeof pj?.name === "string" ? pj.name : fallbackName;
      if (typeof entry !== "string" || excluded.has(name)) continue;
      out.push({ name, pkgDir, entry });
    }
  };
  visit(nmDir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function scanOptimizableExtensions(nmDir, exclude = []) {
  return scanPiExtensions(nmDir, exclude).flatMap((pkg) => {
    let sourceEntry;
    if (pkg.entry.endsWith(".ts")) {
      sourceEntry = pkg.entry;
    } else {
      const original = readJson(join(pkg.pkgDir, "package.json.pi-orig"));
      const originalEntry = original?.pi?.extensions?.[0];
      if (typeof originalEntry === "string" && originalEntry.endsWith(".ts")) sourceEntry = originalEntry;
    }
    if (!sourceEntry) return [];
    return [{
      ...pkg,
      sourceEntry,
      srcDir: inferSrcDir(sourceEntry),
      // Any dist-opt entry counts as optimized (index.js is not hard-coded; non-index entries work too)
      optimized: pkg.entry.startsWith("./dist-opt/")
    }];
  });
}
export {
  enabledNpmPackageNames,
  parseNpmName,
  resolveExtensionFiles,
  scanOptimizableExtensions,
  scanPiExtensions
};
