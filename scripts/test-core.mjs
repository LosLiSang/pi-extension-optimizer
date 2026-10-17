import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveExtensionFiles, scanOptimizableExtensions, scanPiExtensions } from "../dist/scanner.js";
import { parseLanguageSetting, resolveLocale } from "../dist/i18n.js";
import { buildOne, ensureCommonjsMarker, extensionNeedsBuild, findHarnessLinks, getPackageStatus, removeHarnessLinks, rollbackOne } from "../dist/transpiler.js";

// Locale resolution (pure, table-driven). Precedence: PI_EXT_OPT_LANG > ext-opt.json > LC_ALL > LC_MESSAGES > LANG > Intl; default en.
for (const [inputs, expected] of [
  [{}, "en"],
  [{ intlLocale: "zh-CN" }, "zh"],
  [{ intlLocale: "zh-Hans-CN" }, "zh"],
  [{ intlLocale: "en-US" }, "en"],
  [{ intlLocale: "es-ES" }, "en"],
  [{ LANG: "zh_CN.UTF-8", intlLocale: "en-US" }, "zh"],
  [{ LANG: "en_US.UTF-8", intlLocale: "zh-CN" }, "en"],
  [{ LANG: "C.UTF-8", intlLocale: "zh-CN" }, "zh"],
  [{ LANG: "POSIX" }, "en"],
  [{ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, "en"],
  [{ LC_MESSAGES: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }, "zh"],
  [{ configured: "en", LANG: "zh_CN.UTF-8" }, "en"],
  [{ configured: "zh", intlLocale: "en-US" }, "zh"],
  [{ configured: "auto", intlLocale: "zh-CN" }, "zh"],
  [{ configured: "klingon", intlLocale: "zh-CN" }, "zh"],
  [{ configured: 42, intlLocale: "en-US" }, "en"],
  [{ override: "EN", configured: "zh" }, "en"],
  [{ override: "zh", configured: "en", LANG: "en_US" }, "zh"],
  [{ override: "auto", configured: "zh", LANG: "en_US" }, "zh"],
  [{ override: "", configured: "en", intlLocale: "zh-CN" }, "en"],
]) {
  assert.equal(resolveLocale(inputs), expected, JSON.stringify(inputs));
}
assert.equal(parseLanguageSetting(" Zh "), "zh");
assert.equal(parseLanguageSetting("fr"), undefined);

const root = mkdtempSync(join(tmpdir(), "pi-ext-opt-test-"));
try {
  const nm = join(root, "node_modules");
  const pkgDir = join(nm, "fixture-extension");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  mkdirSync(join(pkgDir, "src", "prompts"), { recursive: true });
  writeFileSync(join(pkgDir, "src", "prompts", "system.txt"), "prompt content\n");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
    name: "fixture-extension",
    version: "1.0.0",
    type: "module",
    pi: { extensions: ["./src/index.ts"] }
  }, null, 2));
  writeFileSync(join(pkgDir, "src", "index.ts"), [
    'import { value } from "./helper.ts";',
    'import { Type } from "typebox";',
    'import { getAgentDir } from "@earendil-works/pi-coding-agent";',
    'import { getModel } from "@earendil-works/pi-ai";',
    'import { Agent } from "@earendil-works/pi-agent-core";',
    'export const schema = Type.String();',
    'export const harness = [getAgentDir, getModel, Agent];',
    'export default () => value;',
    '',
  ].join("\n"));
  writeFileSync(join(pkgDir, "src", "helper.ts"), "export const value: number = 42;\n");

  const before = scanOptimizableExtensions(nm);
  assert.equal(before.length, 1);
  assert.equal(before[0].sourceEntry, "./src/index.ts");
  assert.equal(before[0].optimized, false);

  const result = await buildOne(before[0]);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.files, 2);
  assert.equal(existsSync(join(pkgDir, "dist-opt", "index.js")), true);
  assert.equal(existsSync(join(pkgDir, "dist-opt", "prompts", "system.txt")), true, "static assets must be copied to dist-opt");
  assert.equal(readFileSync(join(pkgDir, "dist-opt", "prompts", "system.txt"), "utf8"), "prompt content\n");
  assert.match(readFileSync(join(pkgDir, "dist-opt", "index.js"), "utf8"), /\.\/helper\.js/);
  // Non-harness bare imports stay unchanged.
  const fixtureOut = readFileSync(join(pkgDir, "dist-opt", "index.js"), "utf8");
  assert.match(fixtureOut, /from "typebox"/);
  // Bare harness imports must be kept: bundled pi resolves them via virtualModules (same instance, zero overhead);
  // rewriting them to file URLs bypasses the mapping and loads another, unbundled copy of pi (+~3s, instanceof mismatch).
  assert.match(fixtureOut, /from "@earendil-works\/pi-coding-agent"/);
  assert.match(fixtureOut, /from "@earendil-works\/pi-ai"/);
  assert.match(fixtureOut, /from "@earendil-works\/pi-agent-core"/);
  assert.doesNotMatch(fixtureOut, /file:\/\/\/[^"']*@earendil-works/, "output must not rewrite harness imports to file URLs");
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).pi.extensions[0], "./dist-opt/index.js");
  // dist-opt must be marked commonjs: it stops Node from natively loading the output (bare harness imports in a native
  // subtree go through node_modules → Cannot find package, or with a junction a second unbundled pi). With the marker
  // jiti transpiles the whole subtree and harness imports resolve to the running pi via virtualModules.
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "dist-opt", "package.json"), "utf8")).type, "commonjs");

  const managedAfter = scanOptimizableExtensions(nm);
  assert.equal(managedAfter.length, 1);
  assert.equal(managedAfter[0].optimized, true);
  assert.equal(managedAfter[0].sourceEntry, "./src/index.ts");
  assert.equal(scanPiExtensions(nm).length, 1);

  rollbackOne(scanPiExtensions(nm)[0]);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).pi.extensions[0], "./src/index.ts");

  // Simulate a stale .pi-orig after an extension upgrade: the next build must refresh the backup.
  const upgraded = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  upgraded.version = "2.0.0";
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(upgraded, null, 2));
  const upgradedResult = await buildOne(scanOptimizableExtensions(nm)[0]);
  assert.equal(upgradedResult.ok, true);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json.pi-orig"), "utf8")).version, "2.0.0");
  rollbackOne(scanPiExtensions(nm)[0]);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version, "2.0.0");

  // fixture B: entry file isn't index.ts; after optimization it must point at dist-opt/entry.js, which must exist.
  const pkgB = join(nm, "fixture-b");
  mkdirSync(join(pkgB, "src"), { recursive: true });
  writeFileSync(join(pkgB, "package.json"), JSON.stringify({ name: "fixture-b", version: "1.0.0", type: "module", pi: { extensions: ["./src/entry.ts"] } }, null, 2));
  writeFileSync(join(pkgB, "src", "entry.ts"), "export default 1;\n");
  const extB = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-b");
  const resB = await buildOne(extB);
  assert.equal(resB.ok, true, resB.errors.join("\n"));
  assert.equal(existsSync(join(pkgB, "dist-opt", "entry.js")), true);
  assert.equal(JSON.parse(readFileSync(join(pkgB, "package.json"), "utf8")).pi.extensions[0], "./dist-opt/entry.js");

  // fixture C: source entry missing (no index.js in output) → no apply, no backup, entry stays .ts.
  const pkgC = join(nm, "fixture-c");
  mkdirSync(join(pkgC, "src"), { recursive: true });
  writeFileSync(join(pkgC, "package.json"), JSON.stringify({ name: "fixture-c", version: "1.0.0", type: "module", pi: { extensions: ["./src/index.ts"] } }, null, 2));
  writeFileSync(join(pkgC, "src", "other.ts"), "export default 2;\n");
  const extC = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-c");
  const resC = await buildOne(extC);
  assert.equal(resC.ok, false);
  assert.deepEqual(resC.apply, { code: "artifactMissing", entry: "./dist-opt/index.js" });
  assert.equal(existsSync(join(pkgC, "package.json.pi-orig")), false);
  assert.equal(JSON.parse(readFileSync(join(pkgC, "package.json"), "utf8")).pi.extensions[0], "./src/index.ts");

  // fixture D: a .ts-distributed dependency is transpiled and its import rewritten to a file URL (native dynamic chain).
  const depDir = join(nm, "dep-ts");
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: "dep-ts", version: "1.0.0", type: "module", main: "./index.ts" }, null, 2));
  writeFileSync(join(depDir, "index.ts"), "export const depValue: number = 7;\n");
  const pkgD = join(nm, "fixture-d");
  mkdirSync(pkgD, { recursive: true });
  writeFileSync(join(pkgD, "package.json"), JSON.stringify({ name: "fixture-d", version: "1.0.0", type: "module", pi: { extensions: ["./index.ts"] } }, null, 2));
  writeFileSync(join(pkgD, "index.ts"), 'import { depValue } from "dep-ts";\nexport default depValue;\n');
  const extD = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-d");
  const resD = await buildOne(extD);
  assert.equal(resD.ok, true, resD.errors.join("\n"));
  assert.equal(existsSync(join(depDir, "dist-opt", "index.js")), true, "dependency must get a dist-opt");
  const depImport = readFileSync(join(pkgD, "dist-opt", "index.js"), "utf8");
  assert.match(depImport, /file:\/\/\/.*dep-ts\/dist-opt\/index\.js/);
  assert.doesNotMatch(depImport, /from "dep-ts"/);
  const pkgDOut = JSON.parse(readFileSync(join(pkgD, "dist-opt", "package.json"), "utf8"));
  assert.equal(pkgDOut.type, "commonjs", "package.json copied into dist-opt must also become commonjs");
  assert.equal(pkgDOut.name, "fixture-d", "merge keeps existing fields");
  assert.equal(JSON.parse(readFileSync(join(depDir, "dist-opt", "package.json"), "utf8")).type, "commonjs", ".ts dependency output needs the marker too");

  // Regression: status and staleness for non-index entries (old versions hard-coded dist-opt/index.js and reported broken).
  const statusB = getPackageStatus(scanPiExtensions(nm).find((p) => p.name === "fixture-b"));
  assert.equal(statusB.state, "optimized");
  assert.equal(statusB.distExists, true);
  const extAfterB = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-b");
  assert.equal(extAfterB.optimized, true);
  assert.equal(extensionNeedsBuild(extAfterB), false);
  // Old outputs without the commonjs marker need a rebuild; ensureCommonjsMarker adds it in place (startup migration).
  rmSync(join(pkgB, "dist-opt", "package.json"));
  assert.equal(extensionNeedsBuild(extAfterB), true, "old output without commonjs marker must need a rebuild");
  assert.equal(ensureCommonjsMarker(join(pkgB, "dist-opt")), true, "adding the marker returns true");
  assert.equal(ensureCommonjsMarker(join(pkgB, "dist-opt")), false, "idempotent: returns false when already marked");
  assert.equal(extensionNeedsBuild(extAfterB), false);

  // Regression: staleness compares source tree vs output tree (touching a non-entry source needs a rebuild).
  const future = (Date.now() + 60_000) / 1000;
  utimesSync(join(pkgB, "src", "entry.ts"), future, future);
  assert.equal(extensionNeedsBuild(scanOptimizableExtensions(nm).find((e) => e.name === "fixture-b")), true);

  // Regression: apply on multi-entry packages replaces only item 0 and keeps the rest.
  const pkgE = join(nm, "fixture-multi");
  mkdirSync(join(pkgE, "src"), { recursive: true });
  writeFileSync(join(pkgE, "package.json"), JSON.stringify({ name: "fixture-multi", version: "1.0.0", type: "module", pi: { extensions: ["./src/index.ts", "./src/second.js"] } }, null, 2));
  writeFileSync(join(pkgE, "src", "index.ts"), "export default 1;\n");
  const resE = await buildOne(scanOptimizableExtensions(nm).find((e) => e.name === "fixture-multi"));
  assert.equal(resE.ok, true, resE.errors.join("\n"));
  const pkgEJson = JSON.parse(readFileSync(join(pkgE, "package.json"), "utf8"));
  assert.deepEqual(pkgEJson.pi.extensions, ["./dist-opt/index.js", "./src/second.js"]);
  rollbackOne(scanPiExtensions(nm).find((p) => p.name === "fixture-multi"));
  assert.deepEqual(JSON.parse(readFileSync(join(pkgE, "package.json"), "utf8")).pi.extensions, ["./src/index.ts", "./src/second.js"]);

  // Regression: directory entries expand like pi's package manager (e.g. @monotykamary/pi-tps declares "./extensions").
  const pkgF = join(nm, "fixture-dir");
  mkdirSync(join(pkgF, "extensions", "tps"), { recursive: true });
  mkdirSync(join(pkgF, "extensions", "empty"), { recursive: true });
  mkdirSync(join(pkgF, "extensions", "nested", "inner"), { recursive: true });
  writeFileSync(join(pkgF, "extensions", "tps", "index.ts"), "export default 1;\n");
  writeFileSync(join(pkgF, "extensions", "top.js"), "export default 2;\n");
  writeFileSync(join(pkgF, "extensions", "notes.md"), "ignored\n");
  writeFileSync(join(pkgF, "extensions", "nested", "inner", "index.ts"), "export default 3;\n"); // deeper than one level: not loaded
  mkdirSync(join(pkgF, "single"), { recursive: true });
  writeFileSync(join(pkgF, "single", "index.js"), "export default 4;\n");
  mkdirSync(join(pkgF, "manifest", "lib"), { recursive: true });
  writeFileSync(join(pkgF, "manifest", "package.json"), JSON.stringify({ pi: { extensions: ["./lib/main.ts", "./lib/gone.ts"] } }));
  writeFileSync(join(pkgF, "manifest", "lib", "main.ts"), "export default 5;\n");
  writeFileSync(join(pkgF, "manifest", "index.ts"), "export default 6;\n"); // shadowed by the manifest
  const resolvedF = resolveExtensionFiles(pkgF, ["./extensions", "./single", "./manifest", "./missing.ts", "./extensions/empty"]);
  assert.deepEqual(resolvedF.files, [
    join(pkgF, "extensions", "top.js"),
    join(pkgF, "extensions", "tps", "index.ts"),
    join(pkgF, "single", "index.js"),
    join(pkgF, "manifest", "lib", "main.ts"),
  ]);
  assert.deepEqual(resolvedF.missing, ["./missing.ts", "./extensions/empty"]);
  assert.deepEqual(resolveExtensionFiles(pkgF, ["./single/index.js"]).files, [join(pkgF, "single", "index.js")]);

  // Regression: harness link cleanup — junctions old versions created under node_modules/@earendil-works make native
  // subtrees load a second unbundled pi (+~3s) and must go; but only the link itself, never real dirs or link targets.
  const linkNm = join(root, "links", "node_modules");
  const linkScope = join(linkNm, "@earendil-works");
  const fakeHarness = join(root, "fake-harness");
  mkdirSync(fakeHarness, { recursive: true });
  writeFileSync(join(fakeHarness, "marker.txt"), "harness");
  mkdirSync(linkScope, { recursive: true });
  symlinkSync(fakeHarness, join(linkScope, "pi-coding-agent"), "junction");
  symlinkSync(join(root, "gone"), join(linkScope, "pi-ai"), "junction"); // dangling links are cleaned up too
  mkdirSync(join(linkScope, "pi-tui"), { recursive: true }); // real package installed by npm: leave alone
  mkdirSync(join(linkScope, "pi-agent-core"), { recursive: true }); // real directory: leave alone
  assert.deepEqual(new Set(findHarnessLinks(linkNm)), new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]));
  const removed = removeHarnessLinks(linkNm);
  assert.deepEqual(new Set(removed.removed), new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]));
  assert.deepEqual(removed.failures, []);
  assert.deepEqual(findHarnessLinks(linkNm), []);
  assert.equal(existsSync(join(fakeHarness, "marker.txt")), true, "removing a link must not delete the target's contents");
  assert.equal(existsSync(join(linkScope, "pi-tui")), true);
  assert.equal(existsSync(join(linkScope, "pi-agent-core")), true);
  assert.deepEqual(removeHarnessLinks(join(root, "no-such-nm")).removed, [], "safe when the directory doesn't exist");

  // Regression: when node.exe and the global npm root have different prefixes, locate the harness from the actual CLI path.
  const flatHarness = join(root, "flat-global", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(flatHarness, "dist"), { recursive: true });
  writeFileSync(join(flatHarness, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  const pathsModuleUrl = pathToFileURL(resolve("dist/paths.js")).href;
  const argvProbe = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(root, "missing-node", "node.exe"))} });`,
    `process.argv[1] = ${JSON.stringify(join(flatHarness, "dist", "cli.js"))};`,
    `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(root, "probe-agent"))};`,
    `const { realHarnessDir } = await import(${JSON.stringify(`${pathsModuleUrl}?argv-probe`)});`,
    "console.log(realHarnessDir());",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(argvProbe.status, 0, argvProbe.stderr);
  assert.equal(argvProbe.stdout.trim(), flatHarness);

  // Regression: the common Windows/npm and nvm-windows layout is <prefix>/node.exe + <prefix>/node_modules.
  // It only depends on directory structure, so it also covers path selection on non-Windows CI.
  const windowsPrefix = join(root, "windows-prefix");
  const windowsHarness = join(windowsPrefix, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(windowsHarness, { recursive: true });
  writeFileSync(join(windowsHarness, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  const windowsExecProbe = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(windowsPrefix, "node.exe"))} });`,
    `process.argv[1] = ${JSON.stringify(join(root, "missing-windows-cli.js"))};`,
    `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(root, "windows-probe-agent"))};`,
    `const { realHarnessDir } = await import(${JSON.stringify(`${pathsModuleUrl}?windows-exec-probe`)});`,
    "console.log(realHarnessDir());",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(windowsExecProbe.status, 0, windowsExecProbe.stderr);
  assert.equal(windowsExecProbe.stdout.trim(), windowsHarness);

  // Regression: on Unix/WSL the npm bin entry is a symlink (<prefix>/bin/pi -> the package's cli.js).
  // Windows may refuse file symlinks without developer mode, so this case only runs on Unix.
  if (process.platform !== "win32") {
    const linkedBin = join(root, "linked-prefix", "bin");
    mkdirSync(linkedBin, { recursive: true });
    writeFileSync(join(flatHarness, "dist", "cli.js"), "// fixture cli\n");
    const linkedPi = join(linkedBin, "pi");
    symlinkSync(join(flatHarness, "dist", "cli.js"), linkedPi);
    const linkedArgvProbe = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(root, "missing-node", "node"))} });`,
      `process.argv[1] = ${JSON.stringify(linkedPi)};`,
      `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(root, "linked-probe-agent"))};`,
      `const { realHarnessDir } = await import(${JSON.stringify(`${pathsModuleUrl}?linked-argv-probe`)});`,
      "console.log(realHarnessDir());",
    ].join("\n")], { encoding: "utf8" });
    assert.equal(linkedArgvProbe.status, 0, linkedArgvProbe.stderr);
    assert.equal(linkedArgvProbe.stdout.trim(), flatHarness);
  }

  // Regression: with WSL+nvm node is in <prefix>/bin and the global node_modules in <prefix>/lib/node_modules.
  const nvmPrefix = join(root, "nvm-prefix");
  const nvmHarness = join(nvmPrefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(nvmHarness, { recursive: true });
  writeFileSync(join(nvmHarness, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
  const nvmExecProbe = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(join(nvmPrefix, "bin", "node"))} });`,
    `process.argv[1] = ${JSON.stringify(join(root, "missing-cli.js"))};`,
    `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(root, "nvm-probe-agent"))};`,
    `const { realHarnessDir } = await import(${JSON.stringify(`${pathsModuleUrl}?nvm-exec-probe`)});`,
    "console.log(realHarnessDir());",
  ].join("\n")], { encoding: "utf8" });
  assert.equal(nvmExecProbe.status, 0, nvmExecProbe.stderr);
  assert.equal(nvmExecProbe.stdout.trim(), nvmHarness);

  console.log("core fixture test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
