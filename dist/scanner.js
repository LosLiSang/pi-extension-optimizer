import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
function parseNpmName(spec) {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
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
      optimized: pkg.entry === "./dist-opt/index.js"
    }];
  });
}
export {
  enabledNpmPackageNames,
  parseNpmName,
  scanOptimizableExtensions,
  scanPiExtensions
};
