import { configuredLanguage, currentLocale, LANG_ENV, LANGUAGE_SETTINGS, messages, parseLanguageSetting, saveLanguage } from "./i18n.js";
import { agentDir, agentNodeModules } from "./paths.js";
import { MeasureSubprocessError, runMeasure } from "./measure.js";
import { enabledNpmPackageNames, scanOptimizableExtensions, scanPiExtensions } from "./scanner.js";
import { buildOne, extensionNeedsBuild, findHarnessLinks, getPackageStatus, markAllDistOpt, removeHarnessLinks, rollbackOne } from "./transpiler.js";
const PACKAGE_NAME = "pi-extension-optimizer";
const STATUS_KEY = "pi-extension-optimizer";
const COMMANDS = ["build", "status", "rollback", "measure", "repair", "lang", "help"];
async function showLines(ctx, title, lines) {
  if (ctx.hasUI) {
    await ctx.ui.select(title, lines.length > 0 ? lines : [messages().empty]);
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
  const m = messages();
  const selected = await ctx.ui.select("Pi Extension Optimizer", [
    m.menu.build,
    m.menu.status,
    m.menu.measure,
    m.menu.repair,
    m.menu.rollback,
    m.menu.lang,
    m.menu.help
  ]);
  return selected?.split(" ")[0];
}
async function confirmMutation(ctx, title, message, args) {
  if (args.split(/\s+/).includes("--yes")) return true;
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(title, message);
}
function formatApply(m, outcome) {
  switch (outcome.code) {
    case "applied":
      return m.apply.applied(outcome.from, outcome.to);
    case "alreadyApplied":
      return m.apply.alreadyApplied;
    case "noExtensions":
      return m.apply.noExtensions;
    case "srcMissing":
      return m.apply.srcMissing(outcome.path);
    case "transpileErrors":
      return m.apply.transpileErrors;
    case "artifactMissing":
      return m.apply.artifactMissing(outcome.entry);
  }
}
function formatMeasureError(m, error) {
  const detail = error.detail ?? "";
  switch (error.code) {
    case "notInstalled":
      return m.measureError.notInstalled;
    case "entryMissing":
      return m.measureError.entryMissing(detail);
    case "dynamicChain":
      return m.measureError.dynamicChain(detail);
    default:
      return m.measureError.import(detail);
  }
}
async function handleBuild(args, ctx) {
  const m = messages();
  const nm = agentNodeModules();
  const enabled = enabledNpmPackageNames(agentDir());
  const allTargets = scanOptimizableExtensions(nm, [PACKAGE_NAME]).filter((ext) => enabled.has(ext.name));
  const ifNeeded = args.split(/\s+/).includes("--if-needed");
  const targets = ifNeeded ? allTargets.filter((ext) => extensionNeedsBuild(ext)) : allTargets;
  if (targets.length === 0) {
    ctx.ui.notify(ifNeeded ? m.nothingUpToDate : m.nothingToOptimize, ifNeeded ? "success" : "info");
    return;
  }
  const skipCount = ifNeeded ? allTargets.length - targets.length : 0;
  const confirmed = await confirmMutation(ctx, m.buildConfirmTitle, m.buildConfirm(targets.length, skipCount), args);
  if (!confirmed) {
    ctx.ui.notify(m.cancelled("build"), "info");
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, m.buildProgress(0, targets.length));
  const results = [];
  try {
    for (let index = 0; index < targets.length; index++) {
      ctx.ui.setStatus(STATUS_KEY, m.buildProgress(index + 1, targets.length, targets[index].name));
      results.push(await buildOne(targets[index]));
    }
  } finally {
    ctx.ui.setStatus(STATUS_KEY, void 0);
  }
  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  await showLines(ctx, m.buildResultTitle(succeeded, failed), results.map((result) => {
    const icon = result.ok ? "\u2705" : "\u274C";
    const error = result.errors[0] ? `; ${result.errors[0]}` : "";
    return `${icon} ${result.name}: ${result.files}/${result.total} files; ${formatApply(m, result.apply)}${error}`;
  }));
  ctx.ui.notify(m.buildDone(succeeded, failed), failed > 0 ? "warning" : "success");
  if (failed === 0 && ctx.hasUI && await ctx.ui.confirm(m.buildReloadTitle, m.buildReloadPrompt)) {
    await ctx.reload();
    return;
  }
  ctx.ui.notify(m.buildReloadHint, "info");
}
async function handleStatus(ctx) {
  const m = messages();
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
  const links = findHarnessLinks(agentNodeModules());
  await showLines(ctx, m.statusTitle(counts), [
    ...statuses.map((item) => {
      const icon = item.state === "optimized" ? "\u2705" : item.state === "typescript" ? "\u23F3" : item.state === "broken" ? "\u274C" : "\u2022";
      const flags = [item.distExists ? "dist" : "", item.hasBackup ? "backup" : "", item.stale ? m.staleFlag : ""].filter(Boolean).join(",");
      return `${icon} ${item.name}: ${item.entry}${flags ? ` [${flags}]` : ""}`;
    }),
    "",
    links.length > 0 ? m.harnessLinksFound(links.join(", ")) : m.harnessLinksNone
  ]);
}
async function handleRollback(args, ctx) {
  const m = messages();
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
      ctx.ui.notify(m.rollbackNoMatch(nameArg, targets.map((pkg) => pkg.name).join(", ")), "warning");
      return;
    }
    targets = match;
  }
  if (targets.length === 0) {
    ctx.ui.notify(m.rollbackNothing, "info");
    return;
  }
  const confirmed = await confirmMutation(ctx, m.rollbackConfirmTitle, m.rollbackConfirm(targets.length), args);
  if (!confirmed) {
    ctx.ui.notify(m.cancelled("rollback"), "info");
    return;
  }
  const lines = targets.map((pkg) => `\u21A9 ${pkg.name}: ${m.rollback[rollbackOne(pkg)]}`);
  await showLines(ctx, m.rollbackResultTitle(targets.length), lines);
  if (ctx.hasUI && await ctx.ui.confirm(m.rollbackReloadTitle, m.rollbackReloadPrompt)) {
    await ctx.reload();
    return;
  }
  ctx.ui.notify(m.rollbackReloadHint, "info");
}
async function handleMeasure(ctx) {
  const m = messages();
  ctx.ui.setStatus(STATUS_KEY, m.measureProgress);
  try {
    const result = await runMeasure();
    const errors = result.rows.filter((row) => row.error).length;
    const note = result.warmMs > 0 ? m.measureWarmNote(result.warmMs) : m.measureColdNote;
    await showLines(ctx, m.measureTitle(result.totalMs, errors, note), result.rows.map(
      (row) => `${row.error ? "\u274C" : "\u23F1"} ${String(row.ms).padStart(5)}ms  ${row.name}${row.error ? ` \u2014 ${formatMeasureError(m, row.error)}` : ""}`
    ));
    ctx.ui.notify(m.measureDone(result.totalMs), errors ? "warning" : "success");
    if (result.warnings.length > 0) console.warn(result.warnings.join("\n"));
  } catch (error) {
    if (!(error instanceof MeasureSubprocessError)) throw error;
    const detail = error.code === "noResult" ? m.measureSubprocess.noResult : m.measureSubprocess.failed(error.detail);
    ctx.ui.notify(m.measureFailed(detail), "error");
  } finally {
    ctx.ui.setStatus(STATUS_KEY, void 0);
  }
}
async function handleRepair(ctx) {
  const m = messages();
  const result = removeHarnessLinks(agentNodeModules());
  const marked = markAllDistOpt(agentNodeModules());
  await showLines(ctx, m.repairTitle, [
    result.removed.length > 0 ? m.repairRemoved(result.removed.join(", ")) : m.repairNoLinks,
    marked.length > 0 ? m.repairMarked(marked.join(", ")) : m.repairMarkersOk,
    ...result.failures.map((failure) => `\u26A0\uFE0F ${m.repairLinkFailed(failure.name, failure.message)}`)
  ]);
  if (result.failures.length > 0) {
    ctx.ui.notify(m.repairPartial, "error");
  } else if (result.removed.length > 0 || marked.length > 0) {
    ctx.ui.notify(m.repairFixed, "success");
  } else {
    ctx.ui.notify(m.repairNothing, "success");
  }
}
async function handleLang(args, ctx) {
  const value = args.trim().split(/\s+/)[1];
  let setting;
  if (value) {
    setting = parseLanguageSetting(value);
    if (!setting) {
      ctx.ui.notify(messages().langInvalid(value), "warning");
      return;
    }
  } else if (ctx.hasUI) {
    const m2 = messages();
    const selected = await ctx.ui.select(m2.langTitle(configuredLanguage(), currentLocale()), LANGUAGE_SETTINGS.map((option) => m2.langOptions[option]));
    setting = parseLanguageSetting(selected?.split(" ")[0]);
    if (!setting) return;
  } else {
    const m2 = messages();
    console.log(m2.langTitle(configuredLanguage(), currentLocale()));
    return;
  }
  const path = saveLanguage(setting);
  const m = messages();
  ctx.ui.notify(m.langSaved(setting, currentLocale(), path), "success");
  const override = process.env[LANG_ENV];
  if (parseLanguageSetting(override) && parseLanguageSetting(override) !== "auto") ctx.ui.notify(m.langEnvOverride(override), "warning");
}
async function handleHelp(ctx) {
  await showLines(ctx, "Pi Extension Optimizer", messages().help);
}
function extensionOptimizer(pi) {
  try {
    const nm = agentNodeModules();
    markAllDistOpt(nm);
    removeHarnessLinks(nm);
  } catch {
  }
  pi.registerCommand("ext-opt", {
    description: "Precompile TypeScript extensions for faster pi startup",
    getArgumentCompletions: (prefix) => {
      const parts = prefix.trimStart().split(/\s+/);
      if (parts.length === 2 && parts[0] === "lang") {
        const matches2 = LANGUAGE_SETTINGS.filter((option) => option.startsWith(parts[1]));
        return matches2.length ? matches2.map((option) => ({ value: `lang ${option}`, label: option })) : null;
      }
      if (parts.length > 1) return null;
      const matches = COMMANDS.filter((command) => command.startsWith(parts[0]));
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
      if (command === "lang") return handleLang(args, ctx);
      return handleHelp(ctx);
    }
  });
}
export {
  extensionOptimizer as default,
  formatApply
};
