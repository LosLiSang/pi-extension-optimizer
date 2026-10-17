import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./paths.js";

export type Locale = "en" | "zh";
export type LanguageSetting = Locale | "auto";
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "en", "zh"];

/** Environment variable that overrides both the config file and auto-detection. */
export const LANG_ENV = "PI_EXT_OPT_LANG";
/** Config file (inside the agent dir, default ~/.pi/agent) that stores the language preference. */
export const CONFIG_FILE = "ext-opt.json";

export interface LocaleInputs {
	/** Value of PI_EXT_OPT_LANG. */
	override?: string;
	/** `language` field from ext-opt.json. */
	configured?: unknown;
	/** POSIX locale variables, checked in precedence order. */
	LC_ALL?: string;
	LC_MESSAGES?: string;
	LANG?: string;
	/** Intl.DateTimeFormat().resolvedOptions().locale — the only signal on Windows. */
	intlLocale?: string;
}

/** Parse an explicit preference ("en" | "zh" | "auto", case-insensitive). Anything else is ignored. */
export function parseLanguageSetting(value: unknown): LanguageSetting | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return (LANGUAGE_SETTINGS as readonly string[]).includes(normalized) ? normalized as LanguageSetting : undefined;
}

/** Map a system locale string (zh_CN.UTF-8, zh-Hans, en-US, fr_FR …) to a supported locale; Chinese → zh, else en. */
function localeFromSystem(value: string | undefined): Locale | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	// "C" / "POSIX" carry no language information; keep looking at the next source.
	if (!normalized || normalized === "c" || normalized === "posix" || normalized.startsWith("c.")) return undefined;
	return normalized.startsWith("zh") ? "zh" : "en";
}

/**
 * Pure locale resolution. Precedence: PI_EXT_OPT_LANG > ext-opt.json > system locale.
 * "auto" (or an invalid value) at a level falls through to the next one. Default: English.
 */
export function resolveLocale(inputs: LocaleInputs): Locale {
	for (const explicit of [inputs.override, inputs.configured]) {
		const setting = parseLanguageSetting(explicit);
		if (setting && setting !== "auto") return setting;
	}
	return localeFromSystem(inputs.LC_ALL)
		?? localeFromSystem(inputs.LC_MESSAGES)
		?? localeFromSystem(inputs.LANG)
		?? localeFromSystem(inputs.intlLocale)
		?? "en";
}

function configPath(): string {
	return join(agentDir(), CONFIG_FILE);
}

function readConfig(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** The preference stored in ext-opt.json (defaults to "auto"). */
export function configuredLanguage(): LanguageSetting {
	return parseLanguageSetting(readConfig().language) ?? "auto";
}

/** Persist the preference to ext-opt.json, preserving other fields. Returns the file path. */
export function saveLanguage(setting: LanguageSetting): string {
	const config = readConfig();
	config.language = setting;
	writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
	cached = undefined;
	return configPath();
}

function systemIntlLocale(): string | undefined {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {
		return undefined;
	}
}

let cached: Locale | undefined;

export function currentLocale(): Locale {
	cached ??= resolveLocale({
		override: process.env[LANG_ENV],
		configured: readConfig().language,
		LC_ALL: process.env.LC_ALL,
		LC_MESSAGES: process.env.LC_MESSAGES,
		LANG: process.env.LANG,
		intlLocale: systemIntlLocale(),
	});
	return cached;
}

const en = {
	empty: "(empty)",
	menu: {
		build: "build — precompile and apply optimizations",
		status: "status — show entry status of all extensions",
		measure: "measure — time real module import in a child process",
		repair: "repair — remove leftover harness links and add missing dist-opt commonjs markers",
		rollback: "rollback — restore original TypeScript entries",
		lang: "lang — switch UI language (auto / en / zh)",
		help: "help — show usage",
	},
	cancelled: (command: string) => `Cancelled. In non-interactive mode use /ext-opt ${command} --yes.`,
	nothingUpToDate: "All enabled packages are optimized and up to date; nothing to rebuild.",
	nothingToOptimize: "No optimizable TypeScript packages found among enabled extensions.",
	buildConfirmTitle: "Build extension optimizations",
	buildConfirm: (count: number, skipped: number) =>
		`Precompile ${count} extension(s) and rewrite their package.json. A package.json.pi-orig backup is created on first change.${skipped > 0 ? ` (Skipped ${skipped} up-to-date optimized package(s).)` : ""} Continue?`,
	buildProgress: (index: number, total: number, name?: string) => `Optimizing ${index}/${total}${name ? `: ${name}` : "…"}`,
	buildResultTitle: (ok: number, failed: number) => `Build result: ${ok} succeeded / ${failed} failed`,
	buildDone: (ok: number, failed: number) => `Optimization finished: ${ok} succeeded, ${failed} failed.`,
	buildReloadTitle: "Optimization complete",
	buildReloadPrompt: "Reload now so the new entries take effect in this process?",
	buildReloadHint: "Run /reload or restart pi for the entry changes to take effect.",
	apply: {
		noExtensions: "no pi.extensions, skipped",
		alreadyApplied: "already applied",
		applied: (from: string, to: string) => `${from} → ${to}`,
		srcMissing: (path: string) => `source directory not found: ${path}`,
		transpileErrors: "transpile errors, original entry kept",
		artifactMissing: (entry: string) => `output missing (${entry}), original entry kept`,
	},
	statusTitle: (c: { optimized: number; typescript: number; javascript: number; broken: number; needsBuild: number }) =>
		`Extension status: ${c.optimized} optimized / ${c.typescript} TypeScript / ${c.javascript} native JS / ${c.broken} broken — need rebuild: ${c.needsBuild}${c.needsBuild > 0 ? " (run /ext-opt build --if-needed)" : ""}`,
	staleFlag: "⚠️ stale",
	harnessLinksFound: (links: string) =>
		`⚠️ Leftover harness links: ${links} (they make native subtrees load a second copy of pi). Run /ext-opt repair or /reload to clean up`,
	harnessLinksNone: "Harness links: none (OK)",
	rollbackNoMatch: (name: string, available: string) =>
		`No rollback-able extension named ${name} (it must be optimized and have a package.json.pi-orig backup). Available: ${available || "none"}`,
	rollbackNothing: "No optimized extensions to roll back.",
	rollbackConfirmTitle: "Roll back extension optimizations",
	rollbackConfirm: (count: number) =>
		`Restore the original entries of ${count} extension(s) from package.json.pi-orig. dist-opt files are kept but no longer referenced. Continue?`,
	rollbackResultTitle: (count: number) => `Rolled back ${count} extension(s)`,
	rollback: {
		noBackup: "no backup, unchanged",
		restored: "restored from package.json.pi-orig",
	},
	rollbackReloadTitle: "Rollback complete",
	rollbackReloadPrompt: "Reload now so the original entries take effect in this process?",
	rollbackReloadHint: "Run /reload or restart pi for the rollback to take effect.",
	measureProgress: "Measuring extension loading in a child process…",
	measureWarmNote: (warmMs: number) => `(shared harness warm-up ${warmMs}ms — already loaded by the real pi process, not counted)`,
	measureColdNote: "(warm-up failed; cold-start numbers)",
	measureTitle: (totalMs: number, errors: number, note: string) => `Real module import (after warm-up): ${totalMs}ms, ${errors} errors ${note}`,
	measureDone: (totalMs: number) => `Measurement finished: ${totalMs}ms (warm, real-startup equivalent).`,
	measureFailed: (detail: string) => `Measurement failed: ${detail}`,
	measureError: {
		notInstalled: "no pi.extensions or package not installed",
		entryMissing: (detail: string) => `entry not found: ${detail}`,
		dynamicChain: (detail: string) => `dynamic import chain ${detail}`,
		import: (detail: string) => detail,
	},
	measureSubprocess: {
		failed: (detail: string) => `measure subprocess failed: ${detail}`,
		noResult: "measure subprocess returned no structured result",
	},
	repairTitle: "Repair result",
	repairRemoved: (links: string) => `🧹 Removed harness links: ${links}`,
	repairNoLinks: "✅ No leftover harness links",
	repairMarked: (names: string) => `🏷️ Added commonjs markers: ${names}`,
	repairMarkersOk: "✅ All dist-opt markers present",
	repairLinkFailed: (name: string, message: string) => `${name}: could not remove link (${message})`,
	repairPartial: "Some links could not be removed. Close processes using those directories and try again.",
	repairFixed: "Repaired. Run /reload for it to take effect in this process.",
	repairNothing: "Nothing to repair.",
	langTitle: (current: LanguageSetting, effective: Locale) => `UI language (current: ${current}, in effect: ${effective})`,
	langOptions: {
		auto: "auto — follow system locale",
		en: "en — English",
		zh: "zh — 简体中文",
	},
	langSaved: (setting: LanguageSetting, effective: Locale, path: string) => `Language set to ${setting} (in effect: ${effective}). Saved to ${path}.`,
	langEnvOverride: (value: string) => `Note: ${LANG_ENV}=${value} is set and overrides this setting.`,
	langInvalid: (value: string) => `Unknown language: ${value}. Use auto, en or zh.`,
	help: [
		"/ext-opt build     — scan .ts entries, transpile to dist-opt and apply",
		"/ext-opt build --if-needed — only rebuild unoptimized / missing-output / stale packages",
		"/ext-opt status    — show optimized / TypeScript / native JS / broken status",
		"/ext-opt measure   — replicate the real loader in a child process and time module import",
		"/ext-opt repair    — remove harness links left by old versions and add dist-opt commonjs markers (also runs on startup)",
		"/ext-opt rollback  — restore original entries from package.json.pi-orig (all by default)",
		"/ext-opt rollback <name> — roll back a single package",
		"/ext-opt lang [auto|en|zh] — switch UI language (saved to ~/.pi/agent/ext-opt.json; env PI_EXT_OPT_LANG overrides)",
		"build/rollback accept --yes to skip confirmation (non-interactive mode)",
		"After upgrading extensions, run /ext-opt build again to re-apply optimizations.",
	],
};

export type Messages = typeof en;

const zh: Messages = {
	empty: "(无内容)",
	menu: {
		build: "build — 预编译并应用优化",
		status: "status — 查看所有扩展入口状态",
		measure: "measure — 子进程测真实 module import 耗时",
		repair: "repair — 清理旧版本留下的 harness 链接并补齐 dist-opt 的 commonjs 标记",
		rollback: "rollback — 恢复原始 TypeScript 入口",
		lang: "lang — 切换界面语言（auto / en / zh）",
		help: "help — 查看使用说明",
	},
	cancelled: (command) => `已取消。非交互模式可使用 /ext-opt ${command} --yes。`,
	nothingUpToDate: "所有启用的包都已优化且未过期，无需重建。",
	nothingToOptimize: "启用的扩展中没有发现可优化的 TypeScript 包。",
	buildConfirmTitle: "构建扩展优化",
	buildConfirm: (count, skipped) =>
		`将预编译 ${count} 个扩展并修改各自 package.json。首次修改会创建 package.json.pi-orig 备份。${skipped > 0 ? `（已跳过 ${skipped} 个未过期的已优化包）` : ""}继续？`,
	buildProgress: (index, total, name) => `正在优化 ${index}/${total}${name ? `: ${name}` : "…"}`,
	buildResultTitle: (ok, failed) => `构建结果：${ok} 成功 / ${failed} 失败`,
	buildDone: (ok, failed) => `优化完成：${ok} 成功，${failed} 失败。`,
	buildReloadTitle: "优化已完成",
	buildReloadPrompt: "立即 reload，使新入口在当前进程生效？",
	buildReloadHint: "请执行 /reload 或重启 pi 使入口变更生效。",
	apply: {
		noExtensions: "无 pi.extensions，跳过",
		alreadyApplied: "已应用",
		applied: (from, to) => `${from} → ${to}`,
		srcMissing: (path) => `源码目录不存在: ${path}`,
		transpileErrors: "转译有错误，保留原入口",
		artifactMissing: (entry) => `产物缺失（${entry}），保留原入口`,
	},
	statusTitle: (c) =>
		`扩展状态：${c.optimized} optimized / ${c.typescript} TypeScript / ${c.javascript} native JS / ${c.broken} broken — 需要 rebuild：${c.needsBuild}${c.needsBuild > 0 ? "（可运行 /ext-opt build --if-needed）" : ""}`,
	staleFlag: "⚠️ 过期",
	harnessLinksFound: (links) => `⚠️ 残留 harness 链接：${links}（会让原生子树加载第二份 pi），运行 /ext-opt repair 或 /reload 清理`,
	harnessLinksNone: "harness 链接：无（正常）",
	rollbackNoMatch: (name, available) =>
		`没有可回滚的扩展：${name}（需已优化且存在 package.json.pi-orig 备份）。当前可回滚：${available || "无"}`,
	rollbackNothing: "没有发现可回滚的已优化扩展。",
	rollbackConfirmTitle: "回滚扩展优化",
	rollbackConfirm: (count) => `将从 package.json.pi-orig 恢复 ${count} 个扩展的原始入口。dist-opt 文件会保留但不再引用。继续？`,
	rollbackResultTitle: (count) => `已回滚 ${count} 个扩展`,
	rollback: {
		noBackup: "无备份，未改动",
		restored: "已从 package.json.pi-orig 恢复",
	},
	rollbackReloadTitle: "回滚已完成",
	rollbackReloadPrompt: "立即 reload，使原始入口在当前进程生效？",
	rollbackReloadHint: "请执行 /reload 或重启 pi 使回滚生效。",
	measureProgress: "正在子进程中测量扩展加载…",
	measureWarmNote: (warmMs) => `（共享 harness 预热 ${warmMs}ms，真实 pi 主进程已加载，不重复计入）`,
	measureColdNote: "（预热失败，为冷启动口径）",
	measureTitle: (totalMs, errors, note) => `真实 module import（预热后）：${totalMs}ms，${errors} errors ${note}`,
	measureDone: (totalMs) => `测量完成：${totalMs}ms（预热后真实启动口径）。`,
	measureFailed: (detail) => `测量失败：${detail}`,
	measureError: {
		notInstalled: "无 pi.extensions 或包未安装",
		entryMissing: (detail) => `入口不存在: ${detail}`,
		dynamicChain: (detail) => `动态链 ${detail}`,
		import: (detail) => detail,
	},
	measureSubprocess: {
		failed: (detail) => `测量子进程失败: ${detail}`,
		noResult: "测量子进程未返回结构化结果",
	},
	repairTitle: "repair 结果",
	repairRemoved: (links) => `🧹 已移除 harness 链接：${links}`,
	repairNoLinks: "✅ 无残留 harness 链接",
	repairMarked: (names) => `🏷️ 已补齐 commonjs 标记：${names}`,
	repairMarkersOk: "✅ dist-opt 标记齐全",
	repairLinkFailed: (name, message) => `${name}: 无法移除链接（${message}）`,
	repairPartial: "部分链接无法移除，请关闭占用这些目录的进程后重试。",
	repairFixed: "已修复，请 /reload 使其在当前进程生效。",
	repairNothing: "无需修复。",
	langTitle: (current, effective) => `界面语言（当前设置：${current}，实际生效：${effective}）`,
	langOptions: {
		auto: "auto — 跟随系统语言",
		en: "en — English",
		zh: "zh — 简体中文",
	},
	langSaved: (setting, effective, path) => `界面语言已设为 ${setting}（实际生效：${effective}），已保存到 ${path}。`,
	langEnvOverride: (value) => `注意：已设置环境变量 ${LANG_ENV}=${value}，它会覆盖此设置。`,
	langInvalid: (value) => `未知语言：${value}。可选 auto、en、zh。`,
	help: [
		"/ext-opt build     — 自动扫描 .ts 入口，transpile 到 dist-opt 并应用",
		"/ext-opt build --if-needed — 只重建未优化/产物缺失/源码过期的包",
		"/ext-opt status    — 查看 optimized / TypeScript / native JS / broken 状态",
		"/ext-opt measure   — 在独立子进程中复刻真实 loader 测 module import",
		"/ext-opt repair    — 清理旧版本留下的 harness 链接、补齐 dist-opt commonjs 标记（启动时也会自动执行）",
		"/ext-opt rollback  — 从 package.json.pi-orig 恢复原入口（默认全部）",
		"/ext-opt rollback <name> — 只回滚指定包",
		"/ext-opt lang [auto|en|zh] — 切换界面语言（保存到 ~/.pi/agent/ext-opt.json；环境变量 PI_EXT_OPT_LANG 优先）",
		"build/rollback 可加 --yes 跳过确认（用于非交互模式）",
		"升级扩展后重新运行 /ext-opt build 即可恢复优化。",
	],
};

const DICTIONARIES: Record<Locale, Messages> = { en, zh };

export function messagesFor(locale: Locale): Messages {
	return DICTIONARIES[locale];
}

/** Messages for the current locale. Call per command invocation so `/ext-opt lang` takes effect immediately. */
export function messages(): Messages {
	return messagesFor(currentLocale());
}
