import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configuredLanguage, currentLocale, LANG_ENV, LANGUAGE_SETTINGS, type LanguageSetting, type Messages, messages, parseLanguageSetting, saveLanguage } from "./i18n.js";
import { agentDir, agentNodeModules } from "./paths.js";
import { type MeasureRow, MeasureSubprocessError, runMeasure } from "./measure.js";
import { enabledNpmPackageNames, scanOptimizableExtensions, scanPiExtensions } from "./scanner.js";
import { type ApplyOutcome, buildOne, extensionNeedsBuild, findHarnessLinks, getPackageStatus, markAllDistOpt, removeHarnessLinks, rollbackOne } from "./transpiler.js";

const PACKAGE_NAME = "pi-extension-optimizer";
const STATUS_KEY = "pi-extension-optimizer";
const COMMANDS = ["build", "status", "rollback", "measure", "repair", "lang", "help"] as const;
type Command = (typeof COMMANDS)[number];

async function showLines(ctx: any, title: string, lines: string[]) {
	if (ctx.hasUI) {
		await ctx.ui.select(title, lines.length > 0 ? lines : [messages().empty]);
	} else {
		console.log(`${title}\n${lines.join("\n")}`);
	}
}

function parseCommand(args: string): Command | undefined {
	const value = args.trim().split(/\s+/)[0]?.toLowerCase();
	return COMMANDS.includes(value as Command) ? value as Command : undefined;
}

async function chooseCommand(ctx: any): Promise<Command | undefined> {
	if (!ctx.hasUI) return "help";
	const m = messages();
	// Every option starts with the command word, so the selection is parsed the same way in any language.
	const selected = await ctx.ui.select("Pi Extension Optimizer", [
		m.menu.build,
		m.menu.status,
		m.menu.measure,
		m.menu.repair,
		m.menu.rollback,
		m.menu.lang,
		m.menu.help,
	]);
	return selected?.split(" ")[0] as Command | undefined;
}

async function confirmMutation(ctx: any, title: string, message: string, args: string): Promise<boolean> {
	if (args.split(/\s+/).includes("--yes")) return true;
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, message);
}

export function formatApply(m: Messages, outcome: ApplyOutcome): string {
	switch (outcome.code) {
		case "applied": return m.apply.applied(outcome.from, outcome.to);
		case "alreadyApplied": return m.apply.alreadyApplied;
		case "noExtensions": return m.apply.noExtensions;
		case "srcMissing": return m.apply.srcMissing(outcome.path);
		case "transpileErrors": return m.apply.transpileErrors;
		case "artifactMissing": return m.apply.artifactMissing(outcome.entry);
	}
}

function formatMeasureError(m: Messages, error: NonNullable<MeasureRow["error"]>): string {
	const detail = error.detail ?? "";
	switch (error.code) {
		case "notInstalled": return m.measureError.notInstalled;
		case "entryMissing": return m.measureError.entryMissing(detail);
		case "dynamicChain": return m.measureError.dynamicChain(detail);
		default: return m.measureError.import(detail);
	}
}

async function handleBuild(args: string, ctx: any) {
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
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	const succeeded = results.filter((result) => result.ok).length;
	const failed = results.length - succeeded;
	await showLines(ctx, m.buildResultTitle(succeeded, failed), results.map((result) => {
		const icon = result.ok ? "✅" : "❌";
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

async function handleStatus(ctx: any) {
	const m = messages();
	const enabled = enabledNpmPackageNames(agentDir());
	const allPkgs = scanPiExtensions(agentNodeModules(), [PACKAGE_NAME]).filter((pkg) => enabled.has(pkg.name));
	const extByName = new Map(
		scanOptimizableExtensions(agentNodeModules(), [PACKAGE_NAME])
			.filter((ext) => enabled.has(ext.name))
			.map((ext) => [ext.name, ext]),
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
		needsBuild: statuses.filter((item) => item.needs).length,
	};
	const links = findHarnessLinks(agentNodeModules());
	await showLines(ctx, m.statusTitle(counts), [
		...statuses.map((item) => {
			const icon = item.state === "optimized" ? "✅" : item.state === "typescript" ? "⏳" : item.state === "broken" ? "❌" : "•";
			const flags = [item.distExists ? "dist" : "", item.hasBackup ? "backup" : "", item.stale ? m.staleFlag : ""].filter(Boolean).join(",");
			return `${icon} ${item.name}: ${item.entry}${flags ? ` [${flags}]` : ""}`;
		}),
		"",
		links.length > 0 ? m.harnessLinksFound(links.join(", ")) : m.harnessLinksNone,
	]);
}

async function handleRollback(args: string, ctx: any) {
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
	const lines = targets.map((pkg) => `↩ ${pkg.name}: ${m.rollback[rollbackOne(pkg)]}`);
	await showLines(ctx, m.rollbackResultTitle(targets.length), lines);
	if (ctx.hasUI && await ctx.ui.confirm(m.rollbackReloadTitle, m.rollbackReloadPrompt)) {
		await ctx.reload();
		return;
	}
	ctx.ui.notify(m.rollbackReloadHint, "info");
}

async function handleMeasure(ctx: any) {
	const m = messages();
	ctx.ui.setStatus(STATUS_KEY, m.measureProgress);
	try {
		const result = await runMeasure();
		const errors = result.rows.filter((row) => row.error).length;
		const note = result.warmMs > 0 ? m.measureWarmNote(result.warmMs) : m.measureColdNote;
		await showLines(ctx, m.measureTitle(result.totalMs, errors, note), result.rows.map((row) =>
			`${row.error ? "❌" : "⏱"} ${String(row.ms).padStart(5)}ms  ${row.name}${row.error ? ` — ${formatMeasureError(m, row.error)}` : ""}`,
		));
		ctx.ui.notify(m.measureDone(result.totalMs), errors ? "warning" : "success");
		if (result.warnings.length > 0) console.warn(result.warnings.join("\n"));
	} catch (error) {
		if (!(error instanceof MeasureSubprocessError)) throw error;
		const detail = error.code === "noResult" ? m.measureSubprocess.noResult : m.measureSubprocess.failed(error.detail);
		ctx.ui.notify(m.measureFailed(detail), "error");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function handleRepair(ctx: any) {
	const m = messages();
	const result = removeHarnessLinks(agentNodeModules());
	const marked = markAllDistOpt(agentNodeModules());
	await showLines(ctx, m.repairTitle, [
		result.removed.length > 0 ? m.repairRemoved(result.removed.join(", ")) : m.repairNoLinks,
		marked.length > 0 ? m.repairMarked(marked.join(", ")) : m.repairMarkersOk,
		...result.failures.map((failure) => `⚠️ ${m.repairLinkFailed(failure.name, failure.message)}`),
	]);
	if (result.failures.length > 0) {
		ctx.ui.notify(m.repairPartial, "error");
	} else if (result.removed.length > 0 || marked.length > 0) {
		ctx.ui.notify(m.repairFixed, "success");
	} else {
		ctx.ui.notify(m.repairNothing, "success");
	}
}

async function handleLang(args: string, ctx: any) {
	const value = args.trim().split(/\s+/)[1];
	let setting: LanguageSetting | undefined;
	if (value) {
		setting = parseLanguageSetting(value);
		if (!setting) {
			ctx.ui.notify(messages().langInvalid(value), "warning");
			return;
		}
	} else if (ctx.hasUI) {
		const m = messages();
		const selected = await ctx.ui.select(m.langTitle(configuredLanguage(), currentLocale()), LANGUAGE_SETTINGS.map((option) => m.langOptions[option]));
		setting = parseLanguageSetting(selected?.split(" ")[0]);
		if (!setting) return;
	} else {
		const m = messages();
		console.log(m.langTitle(configuredLanguage(), currentLocale()));
		return;
	}
	const path = saveLanguage(setting);
	// Re-resolve after saving so the confirmation is already in the new language.
	const m = messages();
	ctx.ui.notify(m.langSaved(setting, currentLocale(), path), "success");
	const override = process.env[LANG_ENV];
	if (parseLanguageSetting(override) && parseLanguageSetting(override) !== "auto") ctx.ui.notify(m.langEnvOverride(override!), "warning");
}

async function handleHelp(ctx: any) {
	await showLines(ctx, "Pi Extension Optimizer", messages().help);
}

export default function extensionOptimizer(pi: ExtensionAPI) {
	// Startup migration (leftovers from v0.1.7 and earlier):
	// 1) Remove links under node_modules/@earendil-works that point at pi itself — with them, subtrees loaded
	//    natively by Node load another, unbundled copy of pi (+~3s startup, instanceof mismatches with the main process).
	// 2) Add "type":"commonjs" to old dist-opt outputs — otherwise native subtrees fail with Cannot find package once the links are gone.
	// Both are cheap (a few readdir/lstat calls) and have no effect on modules already loaded; the current process may
	// still show the old behavior the first time, it takes effect after /reload.
	try {
		const nm = agentNodeModules();
		markAllDistOpt(nm);
		removeHarnessLinks(nm);
	} catch {
		// A failed migration must not break the extension itself (/ext-opt repair shows the reason)
	}
	pi.registerCommand("ext-opt", {
		description: "Precompile TypeScript extensions for faster pi startup",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length === 2 && parts[0] === "lang") {
				const matches = LANGUAGE_SETTINGS.filter((option) => option.startsWith(parts[1]));
				return matches.length ? matches.map((option) => ({ value: `lang ${option}`, label: option })) : null;
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
		},
	});
}
