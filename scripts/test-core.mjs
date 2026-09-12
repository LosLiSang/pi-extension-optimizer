import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { scanOptimizableExtensions, scanPiExtensions } from "../dist/scanner.js";
import { buildOne, checkHarnessJunctions, ensureHarnessJunctions, extensionNeedsBuild, getPackageStatus, rewriteHarnessImports, rollbackOne } from "../dist/transpiler.js";

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
  writeFileSync(join(pkgDir, "src", "index.ts"), 'import { value } from "./helper.ts";\nimport { Type } from "typebox";\nexport const schema = Type.String();\nexport default () => value;\n');
  writeFileSync(join(pkgDir, "src", "helper.ts"), "export const value: number = 42;\n");

  const before = scanOptimizableExtensions(nm);
  assert.equal(before.length, 1);
  assert.equal(before[0].sourceEntry, "./src/index.ts");
  assert.equal(before[0].optimized, false);

  const result = await buildOne(before[0]);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.files, 2);
  assert.equal(existsSync(join(pkgDir, "dist-opt", "index.js")), true);
  assert.equal(existsSync(join(pkgDir, "dist-opt", "prompts", "system.txt")), true, "静态资源文件应被同步复制到 dist-opt");
  assert.equal(readFileSync(join(pkgDir, "dist-opt", "prompts", "system.txt"), "utf8"), "prompt content\n");
  assert.match(readFileSync(join(pkgDir, "dist-opt", "index.js"), "utf8"), /\.\/helper\.js/);
  // 非 harness 的裸导入保持不变。
  assert.match(readFileSync(join(pkgDir, "dist-opt", "index.js"), "utf8"), /from "typebox"/);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).pi.extensions[0], "./dist-opt/index.js");

  const managedAfter = scanOptimizableExtensions(nm);
  assert.equal(managedAfter.length, 1);
  assert.equal(managedAfter[0].optimized, true);
  assert.equal(managedAfter[0].sourceEntry, "./src/index.ts");
  assert.equal(scanPiExtensions(nm).length, 1);

  rollbackOne(scanPiExtensions(nm)[0]);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).pi.extensions[0], "./src/index.ts");

  // 模拟扩展升级后旧 .pi-orig 遗留：下一次 build 必须刷新为新版本备份。
  const upgraded = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  upgraded.version = "2.0.0";
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(upgraded, null, 2));
  const upgradedResult = await buildOne(scanOptimizableExtensions(nm)[0]);
  assert.equal(upgradedResult.ok, true);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json.pi-orig"), "utf8")).version, "2.0.0");
  rollbackOne(scanPiExtensions(nm)[0]);
  assert.equal(JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version, "2.0.0");

  // fixture B：入口文件名非 index.ts，优化后应指向 dist-opt/entry.js 且产物存在。
  const pkgB = join(nm, "fixture-b");
  mkdirSync(join(pkgB, "src"), { recursive: true });
  writeFileSync(join(pkgB, "package.json"), JSON.stringify({ name: "fixture-b", version: "1.0.0", type: "module", pi: { extensions: ["./src/entry.ts"] } }, null, 2));
  writeFileSync(join(pkgB, "src", "entry.ts"), "export default 1;\n");
  const extB = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-b");
  const resB = await buildOne(extB);
  assert.equal(resB.ok, true, resB.errors.join("\n"));
  assert.ok(Array.isArray(resB.junctionWarnings), "buildOne 结果应携带 junctionWarnings");
  assert.equal(existsSync(join(pkgB, "dist-opt", "entry.js")), true);
  assert.equal(JSON.parse(readFileSync(join(pkgB, "package.json"), "utf8")).pi.extensions[0], "./dist-opt/entry.js");

  // fixture C：源入口文件缺失（转译产物无 index.js）→ 不 apply、不创建备份、入口保持 .ts。
  const pkgC = join(nm, "fixture-c");
  mkdirSync(join(pkgC, "src"), { recursive: true });
  writeFileSync(join(pkgC, "package.json"), JSON.stringify({ name: "fixture-c", version: "1.0.0", type: "module", pi: { extensions: ["./src/index.ts"] } }, null, 2));
  writeFileSync(join(pkgC, "src", "other.ts"), "export default 2;\n");
  const extC = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-c");
  const resC = await buildOne(extC);
  assert.equal(resC.ok, false);
  assert.match(resC.applyMessage, /产物缺失/);
  assert.equal(existsSync(join(pkgC, "package.json.pi-orig")), false);
  assert.equal(JSON.parse(readFileSync(join(pkgC, "package.json"), "utf8")).pi.extensions[0], "./src/index.ts");

  // fixture D：.ts 分发的依赖包被自动转译 + import 重写为 file URL（native 动态链场景）。
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
  assert.equal(existsSync(join(depDir, "dist-opt", "index.js")), true, "依赖包应生成 dist-opt");
  const depImport = readFileSync(join(pkgD, "dist-opt", "index.js"), "utf8");
  assert.match(depImport, /file:\/\/\/.*dep-ts\/dist-opt\/index\.js/);
  assert.doesNotMatch(depImport, /from "dep-ts"/);

  // 回归：非 index 入口的状态与 stale 判定（旧版硬编码 dist-opt/index.js 会误判为 broken）。
  const statusB = getPackageStatus(scanPiExtensions(nm).find((p) => p.name === "fixture-b"));
  assert.equal(statusB.state, "optimized");
  assert.equal(statusB.distExists, true);
  const extAfterB = scanOptimizableExtensions(nm).find((e) => e.name === "fixture-b");
  assert.equal(extAfterB.optimized, true);
  assert.equal(extensionNeedsBuild(extAfterB), false);

  // 回归：stale 判定按源码树 vs 产物树（touch 非入口源文件后应需要重建）。
  const future = (Date.now() + 60_000) / 1000;
  utimesSync(join(pkgB, "src", "entry.ts"), future, future);
  assert.equal(extensionNeedsBuild(scanOptimizableExtensions(nm).find((e) => e.name === "fixture-b")), true);

  // 回归：多入口包 apply 只替换第 0 项，保留其余入口。
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

  // 回归：junction —— 不创建悬空链接；损坏链接（lstat 在、existsSync 失败）移除后重建。
  const fakeHarness = join(root, "fake-harness");
  mkdirSync(join(fakeHarness, "node_modules", "@earendil-works"), { recursive: true });
  mkdirSync(join(fakeHarness, "node_modules", "@earendil-works", "pi-ai"), { recursive: true });
  writeFileSync(join(fakeHarness, "marker.txt"), "harness");
  const linkRoot = join(root, "links", "node_modules", "@earendil-works");
  const created = ensureHarnessJunctions(join(root, "links", "node_modules"), fakeHarness);
  assert.ok(Array.isArray(created.warnings) && created.warnings.length === 0, created.warnings.join(";"));
  assert.ok(created.created.includes("@earendil-works/pi-coding-agent"), created.created.join(","));
  assert.ok(created.created.includes("@earendil-works/pi-ai"));
  assert.ok(!created.created.includes("@earendil-works/pi-agent-core"), "目标不存在时不应创建悬空 junction");
  assert.equal(created.warnings.length, 0, "目标不存在属正常布局，不应产生警告");
  assert.equal(existsSync(join(linkRoot, "pi-agent-core")), false);
  const optionalState = checkHarnessJunctions(join(root, "links", "node_modules"), fakeHarness)
    .find((state) => state.name === "@earendil-works/pi-agent-core");
  assert.equal(optionalState.ok, true, "无需 junction 的包不应计为异常");
  assert.equal(optionalState.needed, false);

  // 回归：npm 扁平安装会把 pi-ai / pi-agent-core 提升为 pi-coding-agent 的同级包。
  // junction 与 harness import 改写都必须解析这种布局，而非硬编码 nested node_modules。
  const flatScope = join(root, "flat-global", "node_modules", "@earendil-works");
  const flatHarness = join(flatScope, "pi-coding-agent");
  const flatAi = join(flatScope, "pi-ai");
  const flatCore = join(flatScope, "pi-agent-core");
  mkdirSync(join(flatHarness, "dist"), { recursive: true });
  mkdirSync(join(flatAi, "dist"), { recursive: true });
  mkdirSync(join(flatCore, "dist"), { recursive: true });
  writeFileSync(join(flatHarness, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", exports: { ".": { import: "./dist/index.js" } } }));
  writeFileSync(join(flatHarness, "dist", "index.js"), "export default 1;\n");
  writeFileSync(join(flatAi, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", exports: { "./compat": { import: "./dist/compat.js" } } }));
  writeFileSync(join(flatAi, "dist", "compat.js"), "export default 2;\n");
  writeFileSync(join(flatCore, "package.json"), JSON.stringify({ name: "@earendil-works/pi-agent-core", exports: { ".": { import: "./dist/index.js" } } }));
  writeFileSync(join(flatCore, "dist", "index.js"), "export default 3;\n");

  const flatLinksNm = join(root, "flat-links", "node_modules");
  const flatCreated = ensureHarnessJunctions(flatLinksNm, flatHarness);
  assert.deepEqual(new Set(flatCreated.created), new Set([
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
  ]));
  assert.equal(checkHarnessJunctions(flatLinksNm, flatHarness).every((state) => state.ok), true);

  const flatOut = join(root, "flat-output");
  mkdirSync(flatOut, { recursive: true });
  writeFileSync(join(flatOut, "index.js"), [
    'import agent from "@earendil-works/pi-coding-agent";',
    'import ai from "@earendil-works/pi-ai";',
    'import core from "@earendil-works/pi-agent-core";',
    "export default [agent, ai, core];",
  ].join("\n"));
  assert.deepEqual(rewriteHarnessImports(flatOut, flatHarness), []);
  const flatOutputCode = readFileSync(join(flatOut, "index.js"), "utf8");
  assert.doesNotMatch(flatOutputCode, /from "@earendil-works\//);
  assert.match(flatOutputCode, /pi-coding-agent\/dist\/index\.js/);
  assert.match(flatOutputCode, /pi-ai\/dist\/compat\.js/);
  assert.match(flatOutputCode, /pi-agent-core\/dist\/index\.js/);

  // 回归：node.exe 与全局 npm root 不同前缀时，应从实际 CLI 路径向上定位 harness。
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

  // 回归：Windows/npm 与 nvm-windows 常见布局为 <prefix>/node.exe + <prefix>/node_modules。
  // 该测试只依赖目录层级关系，因此也可在非 Windows CI 上覆盖路径选择逻辑。
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

  // 回归：Unix/WSL 的 npm bin 入口是符号链接（<prefix>/bin/pi -> 包内 cli.js）。
  // Windows 无开发者模式时创建文件 symlink 可能被系统拒绝；该场景只在 Unix 系统执行。
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

  // 回归：WSL+nvm 的 node 位于 <prefix>/bin，global node_modules 位于 <prefix>/lib/node_modules。
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

  // 没有 harness import 的产物不应因 harness 探测失败产生无关的“改写警告”。
  const unrelatedOut = join(root, "unrelated-output");
  mkdirSync(unrelatedOut, { recursive: true });
  writeFileSync(join(unrelatedOut, "index.js"), 'import value from "some-package";\n');
  assert.deepEqual(rewriteHarnessImports(unrelatedOut, join(root, "missing-harness")), []);
  // 模拟 pi 升级后旧 junction 指向已消失的路径：链接 broken（lstat 在、existsSync 失败），
  // 而当前 harness 目标存在 → 应移除坏链接并重建到新目标。
  const oldHarness = join(root, "old-harness");
  mkdirSync(oldHarness, { recursive: true });
  const pcaLink = join(linkRoot, "pi-coding-agent");
  try { unlinkSync(pcaLink); } catch { rmSync(pcaLink, { recursive: true, force: true }); } // 移除健康链接
  symlinkSync(oldHarness, pcaLink, "junction");
  rmSync(oldHarness, { recursive: true, force: true }); // 旧目标消失 → broken（lstat 在、existsSync 失败）
  const repaired = ensureHarnessJunctions(join(root, "links", "node_modules"), fakeHarness);
  assert.ok(repaired.created.includes("@earendil-works/pi-coding-agent"), "损坏 junction 应被移除并重建");
  assert.equal(existsSync(join(linkRoot, "pi-coding-agent", "marker.txt")), true, "重建后应解析到新目标");

  // junction 创建失败时应有警告（而非静默）：把 link 位置预置为一个无法 unlink 的文件模拟失败。
  // 直接验证 API 形状：warnings 为数组且 buildOne 结果携带 junctionWarnings 字段。
  assert.ok(Array.isArray(repaired.warnings));

  console.log("core fixture test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
