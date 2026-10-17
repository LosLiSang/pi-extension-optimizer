import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./paths.js";
const LANGUAGE_SETTINGS = ["auto", "en", "zh"];
const LANG_ENV = "PI_EXT_OPT_LANG";
const CONFIG_FILE = "ext-opt.json";
function parseLanguageSetting(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim().toLowerCase();
  return LANGUAGE_SETTINGS.includes(normalized) ? normalized : void 0;
}
function localeFromSystem(value) {
  if (!value) return void 0;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "c" || normalized === "posix" || normalized.startsWith("c.")) return void 0;
  return normalized.startsWith("zh") ? "zh" : "en";
}
function resolveLocale(inputs) {
  for (const explicit of [inputs.override, inputs.configured]) {
    const setting = parseLanguageSetting(explicit);
    if (setting && setting !== "auto") return setting;
  }
  return localeFromSystem(inputs.LC_ALL) ?? localeFromSystem(inputs.LC_MESSAGES) ?? localeFromSystem(inputs.LANG) ?? localeFromSystem(inputs.intlLocale) ?? "en";
}
function configPath() {
  return join(agentDir(), CONFIG_FILE);
}
function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function configuredLanguage() {
  return parseLanguageSetting(readConfig().language) ?? "auto";
}
function saveLanguage(setting) {
  const config = readConfig();
  config.language = setting;
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}
`);
  cached = void 0;
  return configPath();
}
function systemIntlLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return void 0;
  }
}
let cached;
function currentLocale() {
  cached ??= resolveLocale({
    override: process.env[LANG_ENV],
    configured: readConfig().language,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES,
    LANG: process.env.LANG,
    intlLocale: systemIntlLocale()
  });
  return cached;
}
const en = {
  empty: "(empty)",
  menu: {
    build: "build \u2014 precompile and apply optimizations",
    status: "status \u2014 show entry status of all extensions",
    measure: "measure \u2014 time real module import in a child process",
    repair: "repair \u2014 remove leftover harness links and add missing dist-opt commonjs markers",
    rollback: "rollback \u2014 restore original TypeScript entries",
    lang: "lang \u2014 switch UI language (auto / en / zh)",
    help: "help \u2014 show usage"
  },
  cancelled: (command) => `Cancelled. In non-interactive mode use /ext-opt ${command} --yes.`,
  nothingUpToDate: "All enabled packages are optimized and up to date; nothing to rebuild.",
  nothingToOptimize: "No optimizable TypeScript packages found among enabled extensions.",
  buildConfirmTitle: "Build extension optimizations",
  buildConfirm: (count, skipped) => `Precompile ${count} extension(s) and rewrite their package.json. A package.json.pi-orig backup is created on first change.${skipped > 0 ? ` (Skipped ${skipped} up-to-date optimized package(s).)` : ""} Continue?`,
  buildProgress: (index, total, name) => `Optimizing ${index}/${total}${name ? `: ${name}` : "\u2026"}`,
  buildResultTitle: (ok, failed) => `Build result: ${ok} succeeded / ${failed} failed`,
  buildDone: (ok, failed) => `Optimization finished: ${ok} succeeded, ${failed} failed.`,
  buildReloadTitle: "Optimization complete",
  buildReloadPrompt: "Reload now so the new entries take effect in this process?",
  buildReloadHint: "Run /reload or restart pi for the entry changes to take effect.",
  apply: {
    noExtensions: "no pi.extensions, skipped",
    alreadyApplied: "already applied",
    applied: (from, to) => `${from} \u2192 ${to}`,
    srcMissing: (path) => `source directory not found: ${path}`,
    transpileErrors: "transpile errors, original entry kept",
    artifactMissing: (entry) => `output missing (${entry}), original entry kept`
  },
  statusTitle: (c) => `Extension status: ${c.optimized} optimized / ${c.typescript} TypeScript / ${c.javascript} native JS / ${c.broken} broken \u2014 need rebuild: ${c.needsBuild}${c.needsBuild > 0 ? " (run /ext-opt build --if-needed)" : ""}`,
  staleFlag: "\u26A0\uFE0F stale",
  harnessLinksFound: (links) => `\u26A0\uFE0F Leftover harness links: ${links} (they make native subtrees load a second copy of pi). Run /ext-opt repair or /reload to clean up`,
  harnessLinksNone: "Harness links: none (OK)",
  rollbackNoMatch: (name, available) => `No rollback-able extension named ${name} (it must be optimized and have a package.json.pi-orig backup). Available: ${available || "none"}`,
  rollbackNothing: "No optimized extensions to roll back.",
  rollbackConfirmTitle: "Roll back extension optimizations",
  rollbackConfirm: (count) => `Restore the original entries of ${count} extension(s) from package.json.pi-orig. dist-opt files are kept but no longer referenced. Continue?`,
  rollbackResultTitle: (count) => `Rolled back ${count} extension(s)`,
  rollback: {
    noBackup: "no backup, unchanged",
    restored: "restored from package.json.pi-orig"
  },
  rollbackReloadTitle: "Rollback complete",
  rollbackReloadPrompt: "Reload now so the original entries take effect in this process?",
  rollbackReloadHint: "Run /reload or restart pi for the rollback to take effect.",
  measureProgress: "Measuring extension loading in a child process\u2026",
  measureWarmNote: (warmMs) => `(shared harness warm-up ${warmMs}ms \u2014 already loaded by the real pi process, not counted)`,
  measureColdNote: "(warm-up failed; cold-start numbers)",
  measureTitle: (totalMs, errors, note) => `Real module import (after warm-up): ${totalMs}ms, ${errors} errors ${note}`,
  measureDone: (totalMs) => `Measurement finished: ${totalMs}ms (warm, real-startup equivalent).`,
  measureFailed: (detail) => `Measurement failed: ${detail}`,
  measureError: {
    notInstalled: "no pi.extensions or package not installed",
    entryMissing: (detail) => `entry not found: ${detail}`,
    dynamicChain: (detail) => `dynamic import chain ${detail}`,
    import: (detail) => detail
  },
  measureSubprocess: {
    failed: (detail) => `measure subprocess failed: ${detail}`,
    noResult: "measure subprocess returned no structured result"
  },
  repairTitle: "Repair result",
  repairRemoved: (links) => `\u{1F9F9} Removed harness links: ${links}`,
  repairNoLinks: "\u2705 No leftover harness links",
  repairMarked: (names) => `\u{1F3F7}\uFE0F Added commonjs markers: ${names}`,
  repairMarkersOk: "\u2705 All dist-opt markers present",
  repairLinkFailed: (name, message) => `${name}: could not remove link (${message})`,
  repairPartial: "Some links could not be removed. Close processes using those directories and try again.",
  repairFixed: "Repaired. Run /reload for it to take effect in this process.",
  repairNothing: "Nothing to repair.",
  langTitle: (current, effective) => `UI language (current: ${current}, in effect: ${effective})`,
  langOptions: {
    auto: "auto \u2014 follow system locale",
    en: "en \u2014 English",
    zh: "zh \u2014 \u7B80\u4F53\u4E2D\u6587"
  },
  langSaved: (setting, effective, path) => `Language set to ${setting} (in effect: ${effective}). Saved to ${path}.`,
  langEnvOverride: (value) => `Note: ${LANG_ENV}=${value} is set and overrides this setting.`,
  langInvalid: (value) => `Unknown language: ${value}. Use auto, en or zh.`,
  help: [
    "/ext-opt build     \u2014 scan .ts entries, transpile to dist-opt and apply",
    "/ext-opt build --if-needed \u2014 only rebuild unoptimized / missing-output / stale packages",
    "/ext-opt status    \u2014 show optimized / TypeScript / native JS / broken status",
    "/ext-opt measure   \u2014 replicate the real loader in a child process and time module import",
    "/ext-opt repair    \u2014 remove harness links left by old versions and add dist-opt commonjs markers (also runs on startup)",
    "/ext-opt rollback  \u2014 restore original entries from package.json.pi-orig (all by default)",
    "/ext-opt rollback <name> \u2014 roll back a single package",
    "/ext-opt lang [auto|en|zh] \u2014 switch UI language (saved to ~/.pi/agent/ext-opt.json; env PI_EXT_OPT_LANG overrides)",
    "build/rollback accept --yes to skip confirmation (non-interactive mode)",
    "After upgrading extensions, run /ext-opt build again to re-apply optimizations."
  ]
};
const zh = {
  empty: "(\u65E0\u5185\u5BB9)",
  menu: {
    build: "build \u2014 \u9884\u7F16\u8BD1\u5E76\u5E94\u7528\u4F18\u5316",
    status: "status \u2014 \u67E5\u770B\u6240\u6709\u6269\u5C55\u5165\u53E3\u72B6\u6001",
    measure: "measure \u2014 \u5B50\u8FDB\u7A0B\u6D4B\u771F\u5B9E module import \u8017\u65F6",
    repair: "repair \u2014 \u6E05\u7406\u65E7\u7248\u672C\u7559\u4E0B\u7684 harness \u94FE\u63A5\u5E76\u8865\u9F50 dist-opt \u7684 commonjs \u6807\u8BB0",
    rollback: "rollback \u2014 \u6062\u590D\u539F\u59CB TypeScript \u5165\u53E3",
    lang: "lang \u2014 \u5207\u6362\u754C\u9762\u8BED\u8A00\uFF08auto / en / zh\uFF09",
    help: "help \u2014 \u67E5\u770B\u4F7F\u7528\u8BF4\u660E"
  },
  cancelled: (command) => `\u5DF2\u53D6\u6D88\u3002\u975E\u4EA4\u4E92\u6A21\u5F0F\u53EF\u4F7F\u7528 /ext-opt ${command} --yes\u3002`,
  nothingUpToDate: "\u6240\u6709\u542F\u7528\u7684\u5305\u90FD\u5DF2\u4F18\u5316\u4E14\u672A\u8FC7\u671F\uFF0C\u65E0\u9700\u91CD\u5EFA\u3002",
  nothingToOptimize: "\u542F\u7528\u7684\u6269\u5C55\u4E2D\u6CA1\u6709\u53D1\u73B0\u53EF\u4F18\u5316\u7684 TypeScript \u5305\u3002",
  buildConfirmTitle: "\u6784\u5EFA\u6269\u5C55\u4F18\u5316",
  buildConfirm: (count, skipped) => `\u5C06\u9884\u7F16\u8BD1 ${count} \u4E2A\u6269\u5C55\u5E76\u4FEE\u6539\u5404\u81EA package.json\u3002\u9996\u6B21\u4FEE\u6539\u4F1A\u521B\u5EFA package.json.pi-orig \u5907\u4EFD\u3002${skipped > 0 ? `\uFF08\u5DF2\u8DF3\u8FC7 ${skipped} \u4E2A\u672A\u8FC7\u671F\u7684\u5DF2\u4F18\u5316\u5305\uFF09` : ""}\u7EE7\u7EED\uFF1F`,
  buildProgress: (index, total, name) => `\u6B63\u5728\u4F18\u5316 ${index}/${total}${name ? `: ${name}` : "\u2026"}`,
  buildResultTitle: (ok, failed) => `\u6784\u5EFA\u7ED3\u679C\uFF1A${ok} \u6210\u529F / ${failed} \u5931\u8D25`,
  buildDone: (ok, failed) => `\u4F18\u5316\u5B8C\u6210\uFF1A${ok} \u6210\u529F\uFF0C${failed} \u5931\u8D25\u3002`,
  buildReloadTitle: "\u4F18\u5316\u5DF2\u5B8C\u6210",
  buildReloadPrompt: "\u7ACB\u5373 reload\uFF0C\u4F7F\u65B0\u5165\u53E3\u5728\u5F53\u524D\u8FDB\u7A0B\u751F\u6548\uFF1F",
  buildReloadHint: "\u8BF7\u6267\u884C /reload \u6216\u91CD\u542F pi \u4F7F\u5165\u53E3\u53D8\u66F4\u751F\u6548\u3002",
  apply: {
    noExtensions: "\u65E0 pi.extensions\uFF0C\u8DF3\u8FC7",
    alreadyApplied: "\u5DF2\u5E94\u7528",
    applied: (from, to) => `${from} \u2192 ${to}`,
    srcMissing: (path) => `\u6E90\u7801\u76EE\u5F55\u4E0D\u5B58\u5728: ${path}`,
    transpileErrors: "\u8F6C\u8BD1\u6709\u9519\u8BEF\uFF0C\u4FDD\u7559\u539F\u5165\u53E3",
    artifactMissing: (entry) => `\u4EA7\u7269\u7F3A\u5931\uFF08${entry}\uFF09\uFF0C\u4FDD\u7559\u539F\u5165\u53E3`
  },
  statusTitle: (c) => `\u6269\u5C55\u72B6\u6001\uFF1A${c.optimized} optimized / ${c.typescript} TypeScript / ${c.javascript} native JS / ${c.broken} broken \u2014 \u9700\u8981 rebuild\uFF1A${c.needsBuild}${c.needsBuild > 0 ? "\uFF08\u53EF\u8FD0\u884C /ext-opt build --if-needed\uFF09" : ""}`,
  staleFlag: "\u26A0\uFE0F \u8FC7\u671F",
  harnessLinksFound: (links) => `\u26A0\uFE0F \u6B8B\u7559 harness \u94FE\u63A5\uFF1A${links}\uFF08\u4F1A\u8BA9\u539F\u751F\u5B50\u6811\u52A0\u8F7D\u7B2C\u4E8C\u4EFD pi\uFF09\uFF0C\u8FD0\u884C /ext-opt repair \u6216 /reload \u6E05\u7406`,
  harnessLinksNone: "harness \u94FE\u63A5\uFF1A\u65E0\uFF08\u6B63\u5E38\uFF09",
  rollbackNoMatch: (name, available) => `\u6CA1\u6709\u53EF\u56DE\u6EDA\u7684\u6269\u5C55\uFF1A${name}\uFF08\u9700\u5DF2\u4F18\u5316\u4E14\u5B58\u5728 package.json.pi-orig \u5907\u4EFD\uFF09\u3002\u5F53\u524D\u53EF\u56DE\u6EDA\uFF1A${available || "\u65E0"}`,
  rollbackNothing: "\u6CA1\u6709\u53D1\u73B0\u53EF\u56DE\u6EDA\u7684\u5DF2\u4F18\u5316\u6269\u5C55\u3002",
  rollbackConfirmTitle: "\u56DE\u6EDA\u6269\u5C55\u4F18\u5316",
  rollbackConfirm: (count) => `\u5C06\u4ECE package.json.pi-orig \u6062\u590D ${count} \u4E2A\u6269\u5C55\u7684\u539F\u59CB\u5165\u53E3\u3002dist-opt \u6587\u4EF6\u4F1A\u4FDD\u7559\u4F46\u4E0D\u518D\u5F15\u7528\u3002\u7EE7\u7EED\uFF1F`,
  rollbackResultTitle: (count) => `\u5DF2\u56DE\u6EDA ${count} \u4E2A\u6269\u5C55`,
  rollback: {
    noBackup: "\u65E0\u5907\u4EFD\uFF0C\u672A\u6539\u52A8",
    restored: "\u5DF2\u4ECE package.json.pi-orig \u6062\u590D"
  },
  rollbackReloadTitle: "\u56DE\u6EDA\u5DF2\u5B8C\u6210",
  rollbackReloadPrompt: "\u7ACB\u5373 reload\uFF0C\u4F7F\u539F\u59CB\u5165\u53E3\u5728\u5F53\u524D\u8FDB\u7A0B\u751F\u6548\uFF1F",
  rollbackReloadHint: "\u8BF7\u6267\u884C /reload \u6216\u91CD\u542F pi \u4F7F\u56DE\u6EDA\u751F\u6548\u3002",
  measureProgress: "\u6B63\u5728\u5B50\u8FDB\u7A0B\u4E2D\u6D4B\u91CF\u6269\u5C55\u52A0\u8F7D\u2026",
  measureWarmNote: (warmMs) => `\uFF08\u5171\u4EAB harness \u9884\u70ED ${warmMs}ms\uFF0C\u771F\u5B9E pi \u4E3B\u8FDB\u7A0B\u5DF2\u52A0\u8F7D\uFF0C\u4E0D\u91CD\u590D\u8BA1\u5165\uFF09`,
  measureColdNote: "\uFF08\u9884\u70ED\u5931\u8D25\uFF0C\u4E3A\u51B7\u542F\u52A8\u53E3\u5F84\uFF09",
  measureTitle: (totalMs, errors, note) => `\u771F\u5B9E module import\uFF08\u9884\u70ED\u540E\uFF09\uFF1A${totalMs}ms\uFF0C${errors} errors ${note}`,
  measureDone: (totalMs) => `\u6D4B\u91CF\u5B8C\u6210\uFF1A${totalMs}ms\uFF08\u9884\u70ED\u540E\u771F\u5B9E\u542F\u52A8\u53E3\u5F84\uFF09\u3002`,
  measureFailed: (detail) => `\u6D4B\u91CF\u5931\u8D25\uFF1A${detail}`,
  measureError: {
    notInstalled: "\u65E0 pi.extensions \u6216\u5305\u672A\u5B89\u88C5",
    entryMissing: (detail) => `\u5165\u53E3\u4E0D\u5B58\u5728: ${detail}`,
    dynamicChain: (detail) => `\u52A8\u6001\u94FE ${detail}`,
    import: (detail) => detail
  },
  measureSubprocess: {
    failed: (detail) => `\u6D4B\u91CF\u5B50\u8FDB\u7A0B\u5931\u8D25: ${detail}`,
    noResult: "\u6D4B\u91CF\u5B50\u8FDB\u7A0B\u672A\u8FD4\u56DE\u7ED3\u6784\u5316\u7ED3\u679C"
  },
  repairTitle: "repair \u7ED3\u679C",
  repairRemoved: (links) => `\u{1F9F9} \u5DF2\u79FB\u9664 harness \u94FE\u63A5\uFF1A${links}`,
  repairNoLinks: "\u2705 \u65E0\u6B8B\u7559 harness \u94FE\u63A5",
  repairMarked: (names) => `\u{1F3F7}\uFE0F \u5DF2\u8865\u9F50 commonjs \u6807\u8BB0\uFF1A${names}`,
  repairMarkersOk: "\u2705 dist-opt \u6807\u8BB0\u9F50\u5168",
  repairLinkFailed: (name, message) => `${name}: \u65E0\u6CD5\u79FB\u9664\u94FE\u63A5\uFF08${message}\uFF09`,
  repairPartial: "\u90E8\u5206\u94FE\u63A5\u65E0\u6CD5\u79FB\u9664\uFF0C\u8BF7\u5173\u95ED\u5360\u7528\u8FD9\u4E9B\u76EE\u5F55\u7684\u8FDB\u7A0B\u540E\u91CD\u8BD5\u3002",
  repairFixed: "\u5DF2\u4FEE\u590D\uFF0C\u8BF7 /reload \u4F7F\u5176\u5728\u5F53\u524D\u8FDB\u7A0B\u751F\u6548\u3002",
  repairNothing: "\u65E0\u9700\u4FEE\u590D\u3002",
  langTitle: (current, effective) => `\u754C\u9762\u8BED\u8A00\uFF08\u5F53\u524D\u8BBE\u7F6E\uFF1A${current}\uFF0C\u5B9E\u9645\u751F\u6548\uFF1A${effective}\uFF09`,
  langOptions: {
    auto: "auto \u2014 \u8DDF\u968F\u7CFB\u7EDF\u8BED\u8A00",
    en: "en \u2014 English",
    zh: "zh \u2014 \u7B80\u4F53\u4E2D\u6587"
  },
  langSaved: (setting, effective, path) => `\u754C\u9762\u8BED\u8A00\u5DF2\u8BBE\u4E3A ${setting}\uFF08\u5B9E\u9645\u751F\u6548\uFF1A${effective}\uFF09\uFF0C\u5DF2\u4FDD\u5B58\u5230 ${path}\u3002`,
  langEnvOverride: (value) => `\u6CE8\u610F\uFF1A\u5DF2\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF ${LANG_ENV}=${value}\uFF0C\u5B83\u4F1A\u8986\u76D6\u6B64\u8BBE\u7F6E\u3002`,
  langInvalid: (value) => `\u672A\u77E5\u8BED\u8A00\uFF1A${value}\u3002\u53EF\u9009 auto\u3001en\u3001zh\u3002`,
  help: [
    "/ext-opt build     \u2014 \u81EA\u52A8\u626B\u63CF .ts \u5165\u53E3\uFF0Ctranspile \u5230 dist-opt \u5E76\u5E94\u7528",
    "/ext-opt build --if-needed \u2014 \u53EA\u91CD\u5EFA\u672A\u4F18\u5316/\u4EA7\u7269\u7F3A\u5931/\u6E90\u7801\u8FC7\u671F\u7684\u5305",
    "/ext-opt status    \u2014 \u67E5\u770B optimized / TypeScript / native JS / broken \u72B6\u6001",
    "/ext-opt measure   \u2014 \u5728\u72EC\u7ACB\u5B50\u8FDB\u7A0B\u4E2D\u590D\u523B\u771F\u5B9E loader \u6D4B module import",
    "/ext-opt repair    \u2014 \u6E05\u7406\u65E7\u7248\u672C\u7559\u4E0B\u7684 harness \u94FE\u63A5\u3001\u8865\u9F50 dist-opt commonjs \u6807\u8BB0\uFF08\u542F\u52A8\u65F6\u4E5F\u4F1A\u81EA\u52A8\u6267\u884C\uFF09",
    "/ext-opt rollback  \u2014 \u4ECE package.json.pi-orig \u6062\u590D\u539F\u5165\u53E3\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF09",
    "/ext-opt rollback <name> \u2014 \u53EA\u56DE\u6EDA\u6307\u5B9A\u5305",
    "/ext-opt lang [auto|en|zh] \u2014 \u5207\u6362\u754C\u9762\u8BED\u8A00\uFF08\u4FDD\u5B58\u5230 ~/.pi/agent/ext-opt.json\uFF1B\u73AF\u5883\u53D8\u91CF PI_EXT_OPT_LANG \u4F18\u5148\uFF09",
    "build/rollback \u53EF\u52A0 --yes \u8DF3\u8FC7\u786E\u8BA4\uFF08\u7528\u4E8E\u975E\u4EA4\u4E92\u6A21\u5F0F\uFF09",
    "\u5347\u7EA7\u6269\u5C55\u540E\u91CD\u65B0\u8FD0\u884C /ext-opt build \u5373\u53EF\u6062\u590D\u4F18\u5316\u3002"
  ]
};
const DICTIONARIES = { en, zh };
function messagesFor(locale) {
  return DICTIONARIES[locale];
}
function messages() {
  return messagesFor(currentLocale());
}
export {
  CONFIG_FILE,
  LANGUAGE_SETTINGS,
  LANG_ENV,
  configuredLanguage,
  currentLocale,
  messages,
  messagesFor,
  parseLanguageSetting,
  resolveLocale,
  saveLanguage
};
