import { build } from "esbuild";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]):)/, "$1:"));
const src = join(root, "src");
const out = join(root, "dist");

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, files);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: walk(src),
  outbase: src,
  outdir: out,
  bundle: false,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external",
  logLevel: "info"
});
