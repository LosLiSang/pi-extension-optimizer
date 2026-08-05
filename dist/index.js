import { agentDir, agentNodeModules } from "./paths.js";
import { runMeasure } from "./measure.js";
import { enabledNpmPackageNames, scanOptimizableExtensions, scanPiExtensions } from "./scanner.js";
import { buildOne, checkHarnessJunctions, ensureHarnessJunctions, extensionNeedsBuild, getPackageStatus, rollbackOne } from "./transpiler.js";
const PACKAGE_NAME = "pi-extension-optimizer";
const STATUS_KEY = "pi-extension-optimizer";
const COMMANDS = ["build", "status", "rollback", "measure", "repair", "help"];
async function showLines(ctx, title, lines) {
  if (ctx.hasUI) {
    await ctx.ui.select(title, lines.length > 0 ? lines : ["(\u65E0\u5185\u5BB9)"]);
  } else {
    console.log(`${title}
${lines.join("\n")}`);
  }
}
function parseCommand(args) {
  const value = args.trim().split(/\s+/)[0]?.toLowerCase();
  return COMMANDS.includes(value) ? value : void 0;
}
async function chooseCommand(ctx) {
  if (!ctx.hasUI) return "help";
  const selected = await ctx.ui.select("Pi Extension Optimizer", [
    "build \u2014 \u9884\u7F16\u8BD1\u5E76\u5E94\u7528\u4F18\u5316",
    "status \u2014 \u67E5\u770B\u6240\u6709\u6269\u5C55\u5165\u53E3\u72B6\u6001",
    "measure \u2014 \u5B50\u8FDB\u7A0B\u6D4B\u771F\u5B9E module import \u8017\u65F6",
    "repair \u2014 \u68C0\u67E5\u5E76\u4FEE\u590D harness junction\uFF08npm \u91CD\u5BA1\u8BA1\u6E05\u9664\u540E\u81EA\u52A8\u6062\u590D\uFF09",
    "rollback \u2014 \u6062\u590D\u539F\u59CB TypeScript \u5165\u53E3",
    "help \u2014 \u67E5\u770B\u4F7F\u7528\u8BF4\u660E"
  ]);
  return selected?.split(" ")[0];
}
async function confirmMutation(ctx, title, message, args) {
  if (args.split(/\s+/).includes("--yes")) return true;
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(title, message);
}
async function handleBuild(args, ctx) {
  const nm = agentNodeModules();
  const enabled = enabledNpmPackageNames(agentDir());
  const allTargets = scanOptimizableExtensions(nm, [PACKAGE_NAME]).filter((ext) => enabled.has(ext.name));
  const ifNeeded = args.split(/\s+/).includes("--if-needed");
  const targets = ifNeeded ? allTargets.filter((ext) => extensionNeedsBuild(ext)) : allTargets;
  if (targets.length === 0) {
    if (ifNeeded) {
      ctx.ui.notify("\u6240\u6709\u542F\u7528\u7684\u5305\u90FD\u5DF2\u4F18\u5316\u4E14\u672A\u8FC7\u671F\uFF0C\u65E0\u9700\u91CD\u5EFA\u3002", "success");
    } else {
      ctx.ui.notify("\u542F\u7528\u7684\u6269\u5C55\u4E2D\u6CA1\u6709\u53D1\u73B0\u53EF\u4F18\u5316\u7684 TypeScript \u5305\u3002", "info");
    }
    return;
  }
  const skipCount = allTargets.length - targets.length;
  const confirmed = await confirmMutation(
    ctx,
    "\u6784\u5EFA\u6269\u5C55\u4F18\u5316",
    `\u5C06\u9884\u7F16\u8BD1 ${targets.length} \u4E2A\u6269\u5C55\u5E76\u4FEE\u6539\u5404\u81EA package.json\u3002\u9996\u6B21\u4FEE\u6539\u4F1A\u521B\u5EFA package.json.pi-orig \u5907\u4EFD\u3002${ifNeeded && skipCount > 0 ? `\uFF08\u5DF2\u8DF3\u8FC7 ${skipCount} \u4E2A\u672A\u8FC7\u671F\u7684\u5DF2\u4F18\u5316\u5305\uFF09` : ""}\u7EE7\u7EED\uFF1F`,
    args
  );
  if (!confirmed) {
    ctx.ui.notify("\u5DF2\u53D6\u6D88\u3002\u975E\u4EA4\u4E92\u6A21\u5F0F\u53EF\u4F7F\u7528 /ext-opt build --yes\u3002", "info");
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, `\u6B63\u5728\u4F18\u5316 0/${targets.length}\u2026`);
  const results = [];
  try {
    for (let index = 0; index < targets.length; index++) {
      ctx.ui.setStatus(STATUS_KEY, `\u6B63\u5728\u4F18\u5316 ${index + 1}/${targets.length}: ${targets[index].name}`);
      results.push(await buildOne(targets[index]));
    }
  } finally {
    ctx.ui.setStatus(STATUS_KEY, void 0);
  }
  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  const junctionWarnings = [...new Set(results.flatMap((result) => result.junctionWarnings))];
  const rewriteWarnings = [...new Set(results.flatMap((result) => result.rewriteWarnings))];
  await showLines(ctx, `\u6784\u5EFA\u7ED3\u679C\uFF1A${succeeded} \u6210\u529F / ${failed} \u5931\u8D25`, results.map((result) => {
    const icon = result.ok ? "\u2705" : "\u274C";
    const error = result.errors[0] ? `\uFF1B${result.errors[0]}` : "";
    const junction = result.junctionWarnings.length > 0 ? "\uFF1B\u26A0\uFE0F junction \u8B66\u544A" : "";
    const rewrite = result.rewriteWarnings.length > 0 ? "\uFF1B\u26A0\uFE0F \u6539\u5199\u8B66\u544A" : "";
    return `${icon} ${result.name}: ${result.files}/${result.total} files\uFF1B${result.applyMessage}${error}${junction}${rewrite}`;
  }));
  if (junctionWarnings.length > 0) {
    await showLines(ctx, `\u26A0\uFE0F junction \u8B66\u544A\uFF08${junctionWarnings.length}\uFF09\uFF1A\u9759\u6001\u5BFC\u5165\u4E0D\u53D7\u5F71\u54CD\uFF0C\u4F46\u539F\u751F\u52A0\u8F7D\u5B50\u6811\u53EF\u80FD\u5931\u8D25`, junctionWarnings);
  }
  if (rewriteWarnings.length > 0) {
    await showLines(ctx, `\u26A0\uFE0F harness \u5BFC\u5165\u6539\u5199\u8B66\u544A\uFF08${rewriteWarnings.length}\uFF09\uFF1A\u4EA7\u7269\u4FDD\u7559\u88F8\u5BFC\u5165\uFF0C\u4F9D\u8D56 junction \u515C\u5E95`, rewriteWarnings);
  }
  ctx.ui.notify(`\u4F18\u5316\u5B8C\u6210\uFF1A${succeeded} \u6210\u529F\uFF0C${failed} \u5931\u8D25\u3002`, failed > 0 ? "warning" : "success");
  if (failed === 0 && ctx.hasUI && await ctx.ui.confirm("\u4F18\u5316\u5DF2\u5B8C\u6210", "\u7ACB\u5373 reload\uFF0C\u4F7F\u65B0\u5165\u53E3\u5728\u5F53\u524D\u8FDB\u7A0B\u751F\u6548\uFF1F")) {
    await ctx.reload();
    return;
  }
  ctx.ui.notify("\u8BF7\u6267\u884C /reload \u6216\u91CD\u542F pi \u4F7F\u5165\u53E3\u53D8\u66F4\u751F\u6548\u3002", "info");
}
async function handleStatus(ctx) {
  const enabled = enabledNpmPackageNames(agentDir());
  const allPkgs = scanPiExtensions(agentNodeModules(), [PACKAGE_NAME]).filter((pkg) => enabled.has(pkg.name));
  const extByName = new Map(
    scanOptimizableExtensions(agentNodeModules(), [PACKAGE_NAME]).filter((ext) => enabled.has(ext.name)).map((ext) => [ext.name, ext])
  );
  const statuses = allPkgs.map((pkg) => {
    const st = getPackageStatus(pkg);
    const ext = extByName.get(pkg.name);
    let needs = false;
    let stale = false;
    if (ext) {
      stale = st.state === "optimized" && extensionNeedsBuild(ext);
      needs = st.state === "typescript" || st.state === "broken" || stale;
    }
    return { ...st, needs, stale };
  });
  const counts = {
    optimized: statuses.filter((item) => item.state === "optimized").length,
    typescript: statuses.filter((item) => item.state === "typescript").length,
    javascript: statuses.filter((item) => item.state === "javascript").length,
    broken: statuses.filter((item) => item.state === "broken").length,
    needsBuild: statuses.filter((item) => item.needs).length
  };
  const junctionStates = checkHarnessJunctions(agentNodeModules());
  const unhealthyJunctions = junctionStates.filter((item) => !item.ok);
  await showLines(
    ctx,
    `\u6269\u5C55\u72B6\u6001\uFF1A${counts.optimized} optimized / ${counts.typescript} TypeScript / ${counts.javascript} native JS / ${counts.broken} broken \u2014 \u9700\u8981 rebuild\uFF1A${counts.needsBuild}${counts.needsBuild > 0 ? "\uFF08\u53EF\u8FD0\u884C /ext-opt build --if-needed\uFF09" : ""}`,
    [
      ...statuses.map((item) => {
        const icon = item.state === "optimized" ? "\u2705" : item.state === "typescript" ? "\u23F3" : item.state === "broken" ? "\u274C" : "\u2022";
        const flags = [item.distExists ? "dist" : "", item.hasBackup ? "backup" : "", item.stale ? "\u26A0\uFE0F \u8FC7\u671F" : ""].filter(Boolean).join(",");
        return `${icon} ${item.name}: ${item.entry}${flags ? ` [${flags}]` : ""}`;
      }),
      "",
      `harness junction\uFF1A${junctionStates.length - unhealthyJunctions.length}/${junctionStates.length} \u6B63\u5E38${unhealthyJunctions.length > 0 ? ` \u2014 ${unhealthyJunctions.map((item) => item.name).join(", ")} \u4E0D\u5065\u5EB7\uFF0C\u53EF\u8FD0\u884C /ext-opt repair \u6216 /reload \u81EA\u52A8\u4FEE\u590D` : ""}`
    ]
  );
}
async function handleRollback(args, ctx) {
  const parts = args.split(/\s+/).filter(Boolean);
  const nameArg = parts.slice(1).find((part) => !part.startsWith("--"));
  const enabled = enabledNpmPackageNames(agentDir());
  const packages = scanPiExtensions(agentNodeModules(), [PACKAGE_NAME]).filter((pkg) => enabled.has(pkg.name));
  let targets = packages.filter((pkg) => {
    const status = getPackageStatus(pkg);
    return status.hasBackup && pkg.entry.startsWith("./dist-opt/");
  });
  if (nameArg) {
    const match = targets.filter((pkg) => pkg.name === nameArg);
    if (match.length === 0) {
      ctx.ui.notify(`\u6CA1\u6709\u53EF\u56DE\u6EDA\u7684\u6269\u5C55\uFF1A${nameArg}\uFF08\u9700\u5DF2\u4F18\u5316\u4E14\u5B58\u5728 package.json.pi-orig \u5907\u4EFD\uFF09\u3002\u5F53\u524D\u53EF\u56DE\u6EDA\uFF1A${targets.map((pkg) => pkg.name).join(", ") || "\u65E0"}`, "warning");
      return;
    }
    targets = match;
  }
  if (targets.length === 0) {
    ctx.ui.notify("\u6CA1\u6709\u53D1\u73B0\u53EF\u56DE\u6EDA\u7684\u5DF2\u4F18\u5316\u6269\u5C55\u3002", "info");
    return;
  }
  const confirmed = await confirmMutation(
    ctx,
    "\u56DE\u6EDA\u6269\u5C55\u4F18\u5316",
    `\u5C06\u4ECE package.json.pi-orig \u6062\u590D ${targets.length} \u4E2A\u6269\u5C55\u7684\u539F\u59CB\u5165\u53E3\u3002dist-opt \u6587\u4EF6\u4F1A\u4FDD\u7559\u4F46\u4E0D\u518D\u5F15\u7528\u3002\u7EE7\u7EED\uFF1F`,
    args
  );
  if (!confirmed) {
    ctx.ui.notify("\u5DF2\u53D6\u6D88\u3002\u975E\u4EA4\u4E92\u6A21\u5F0F\u53EF\u4F7F\u7528 /ext-opt rollback --yes\u3002", "info");
    return;
  }
  const lines = targets.map((pkg) => `\u21A9 ${pkg.name}: ${rollbackOne(pkg)}`);
  await showLines(ctx, `\u5DF2\u56DE\u6EDA ${targets.length} \u4E2A\u6269\u5C55`, lines);
  if (ctx.hasUI && await ctx.ui.confirm("\u56DE\u6EDA\u5DF2\u5B8C\u6210", "\u7ACB\u5373 reload\uFF0C\u4F7F\u539F\u59CB\u5165\u53E3\u5728\u5F53\u524D\u8FDB\u7A0B\u751F\u6548\uFF1F")) {
    await ctx.reload();
    return;
  }
  ctx.ui.notify("\u8BF7\u6267\u884C /reload \u6216\u91CD\u542F pi \u4F7F\u56DE\u6EDA\u751F\u6548\u3002", "info");
}
async function handleMeasure(ctx) {
  ctx.ui.setStatus(STATUS_KEY, "\u6B63\u5728\u5B50\u8FDB\u7A0B\u4E2D\u6D4B\u91CF\u6269\u5C55\u52A0\u8F7D\u2026");
  try {
    const result = await runMeasure();
    const errors = result.rows.filter((row) => row.error).length;
    const warmNote = result.warmMs > 0 ? `\uFF08\u5171\u4EAB harness \u9884\u70ED ${result.warmMs}ms\uFF0C\u771F\u5B9E pi \u4E3B\u8FDB\u7A0B\u5DF2\u52A0\u8F7D\uFF0C\u4E0D\u91CD\u590D\u8BA1\u5165\uFF09` : "\uFF08\u9884\u70ED\u5931\u8D25\uFF0C\u4E3A\u51B7\u542F\u52A8\u53E3\u5F84\uFF09";
    await showLines(ctx, `\u771F\u5B9E module import\uFF08\u9884\u70ED\u540E\uFF09\uFF1A${result.totalMs}ms\uFF0C${errors} errors ${warmNote}`, result.rows.map(
      (row) => `${row.error ? "\u274C" : "\u23F1"} ${String(row.ms).padStart(5)}ms  ${row.name}${row.error ? ` \u2014 ${row.error}` : ""}`
    ));
    ctx.ui.notify(`\u6D4B\u91CF\u5B8C\u6210\uFF1A${result.totalMs}ms\uFF08\u9884\u70ED\u540E\u771F\u5B9E\u542F\u52A8\u53E3\u5F84\uFF09\u3002`, errors ? "warning" : "success");
    if (result.warnings.length > 0) console.warn(result.warnings.join("\n"));
  } finally {
    ctx.ui.setStatus(STATUS_KEY, void 0);
  }
}
async function handleRepair(ctx) {
  const result = ensureHarnessJunctions(agentNodeModules());
  const states = checkHarnessJunctions(agentNodeModules());
  const healthy = states.filter((item) => item.ok);
  const missing = states.filter((item) => !item.ok);
  await showLines(
    ctx,
    `junction \u68C0\u67E5\uFF1A${healthy.length}/${states.length} \u6B63\u5E38${result.created.length > 0 ? `\uFF08\u672C\u6B21\u4FEE\u590D ${result.created.join(", ")}\uFF09` : ""}`,
    [
      ...states.map((item) => `${!item.needed ? "\u2796" : item.ok ? "\u2705" : "\u274C"} ${item.name}${item.reason ? ` \u2014 ${item.reason}` : ""}`),
      ...result.warnings.length > 0 ? [`\u26A0\uFE0F ${result.warnings.join("\n\u26A0\uFE0F ")}`] : []
    ]
  );
  if (missing.length === 0 && result.warnings.length === 0) {
    ctx.ui.notify("harness junction \u5168\u90E8\u5065\u5EB7\uFF0C\u65E0\u9700\u4FEE\u590D\u3002", "success");
  } else if (result.warnings.length > 0) {
    ctx.ui.notify("junction \u4FEE\u590D\u5931\u8D25\uFF1A\u8BF7\u4EE5\u7BA1\u7406\u5458\u8FD0\u884C\u6216\u5F00\u542F Windows \u5F00\u53D1\u8005\u6A21\u5F0F\u3002", "error");
  } else {
    ctx.ui.notify(`\u5DF2\u4FEE\u590D ${result.created.length} \u4E2A junction\uFF0C\u52A8\u6001 import() \u73B0\u5728\u53EF\u6B63\u5E38\u89E3\u6790\u3002`, "success");
  }
}
async function handleHelp(ctx) {
  await showLines(ctx, "Pi Extension Optimizer", [
    "/ext-opt build     \u2014 \u81EA\u52A8\u626B\u63CF .ts \u5165\u53E3\uFF0Ctranspile \u5230 dist-opt \u5E76\u5E94\u7528",
    "/ext-opt build --if-needed \u2014 \u53EA\u91CD\u5EFA\u672A\u4F18\u5316/\u4EA7\u7269\u7F3A\u5931/\u6E90\u7801\u8FC7\u671F\u7684\u5305",
    "/ext-opt status    \u2014 \u67E5\u770B optimized / TypeScript / native JS / broken \u72B6\u6001",
    "/ext-opt measure   \u2014 \u5728\u72EC\u7ACB\u5B50\u8FDB\u7A0B\u4E2D\u590D\u523B\u771F\u5B9E loader \u6D4B module import",
    "/ext-opt repair    \u2014 \u68C0\u67E5\u5E76\u4FEE\u590D harness junction\uFF08npm \u91CD\u5BA1\u8BA1\u6E05\u9664\u94FE\u63A5\u540E\u8FD0\u884C\u6B64\u547D\u4EE4\u6216\u76F4\u63A5 /reload\uFF09",
    "/ext-opt rollback  \u2014 \u4ECE package.json.pi-orig \u6062\u590D\u539F\u5165\u53E3\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF09",
    "/ext-opt rollback <name> \u2014 \u53EA\u56DE\u6EDA\u6307\u5B9A\u5305",
    "build/rollback \u53EF\u52A0 --yes \u8DF3\u8FC7\u786E\u8BA4\uFF08\u7528\u4E8E\u975E\u4EA4\u4E92\u6A21\u5F0F\uFF09",
    "\u5347\u7EA7\u6269\u5C55\u540E\u91CD\u65B0\u8FD0\u884C /ext-opt build \u5373\u53EF\u6062\u590D\u4F18\u5316\u3002"
  ]);
}
function extensionOptimizer(pi) {
  try {
    ensureHarnessJunctions(agentNodeModules());
  } catch {
  }
  pi.registerCommand("ext-opt", {
    description: "Precompile TypeScript extensions for faster pi startup",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim();
      if (value.includes(" ")) return null;
      const matches = COMMANDS.filter((command) => command.startsWith(value));
      return matches.length ? matches.map((command) => ({ value: command, label: command })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseCommand(args) ?? await chooseCommand(ctx);
      if (!command) return;
      if (command === "build") return handleBuild(args, ctx);
      if (command === "status") return handleStatus(ctx);
      if (command === "rollback") return handleRollback(args, ctx);
      if (command === "measure") return handleMeasure(ctx);
      if (command === "repair") return handleRepair(ctx);
      return handleHelp(ctx);
    }
  });
}
export {
  extensionOptimizer as default
};
