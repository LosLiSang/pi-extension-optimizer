import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOptimizableExtensions, scanPiExtensions } from "../dist/scanner.js";
import { buildOne, ensureHarnessJunctions, extensionNeedsBuild, getPackageStatus, rollbackOne } from "../dist/transpiler.js";

const root = mkdtempSync(join(tmpdir(), "pi-ext-opt-test-"));
try {
  const nm = join(root, "node_modules");
  const pkgDir = join(nm, "fixture-extension");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
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
  assert.match(readFileSync(join(pkgDir, "dist-opt", "index.js"), "utf8"), /\.\/helper\.js/);
  // harness 裸导入保留为 bare（junction 方案：静态链 jiti alias、动态链 Node 原生解析到 junction）
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
  assert.ok(created.includes("@earendil-works/pi-coding-agent"), created.join(","));
  assert.ok(created.includes("@earendil-works/pi-ai"));
  assert.ok(!created.includes("@earendil-works/pi-agent-core"), "目标不存在时不应创建悬空 junction");
  assert.equal(existsSync(join(linkRoot, "pi-agent-core")), false);
  // 模拟 pi 升级后旧 junction 指向已消失的路径：链接 broken（lstat 在、existsSync 失败），
  // 而当前 harness 目标存在 → 应移除坏链接并重建到新目标。
  const oldHarness = join(root, "old-harness");
  mkdirSync(oldHarness, { recursive: true });
  const pcaLink = join(linkRoot, "pi-coding-agent");
  try { unlinkSync(pcaLink); } catch { rmSync(pcaLink, { recursive: true, force: true }); } // 移除健康链接
  symlinkSync(oldHarness, pcaLink, "junction");
  rmSync(oldHarness, { recursive: true, force: true }); // 旧目标消失 → broken（lstat 在、existsSync 失败）
  const repaired = ensureHarnessJunctions(join(root, "links", "node_modules"), fakeHarness);
  assert.ok(repaired.includes("@earendil-works/pi-coding-agent"), "损坏 junction 应被移除并重建");
  assert.equal(existsSync(join(linkRoot, "pi-coding-agent", "marker.txt")), true, "重建后应解析到新目标");

  console.log("core fixture test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
