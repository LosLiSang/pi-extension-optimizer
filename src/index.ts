import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, agentNodeModules } from "./paths.js";
import { runMeasure } from "./measure.js";
import { enabledNpmPackageNames, scanOptimizableExtensions, scanPiExtensions } from "./scanner.js";
import { buildOne, extensionNeedsBuild, findHarnessLinks, getPackageStatus, markAllDistOpt, removeHarnessLinks, rollbackOne } from "./transpiler.js";

const PACKAGE_NAME = "pi-extension-optimizer";
const STATUS_KEY = "pi-extension-optimizer";
const COMMANDS = ["build", "status", "rollback", "measure", "repair", "help"] as const;
type Command = (typeof COMMANDS)[number];

async function showLines(ctx: any, title: string, lines: string[]) {
	if (ctx.hasUI) {
		await ctx.ui.select(title, lines.length > 0 ? lines : ["(无内容)"]);
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
	const selected = await ctx.ui.select("Pi Extension Optimizer", [
		"build — 预编译并应用优化",
		"status — 查看所有扩展入口状态",
		"measure — 子进程测真实 module import 耗时",
		"repair — 清理旧版本留下的 harness 链接并补齐 dist-opt 的 commonjs 标记",
		"rollback — 恢复原始 TypeScript 入口",
		"help — 查看使用说明",
	]);
	return selected?.split(" ")[0] as Command | undefined;
}

async function confirmMutation(ctx: any, title: string, message: string, args: string): Promise<boolean> {
	if (args.split(/\s+/).includes("--yes")) return true;
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, message);
}

async function handleBuild(args: string, ctx: any) {
	const nm = agentNodeModules();
	const enabled = enabledNpmPackageNames(agentDir());
	const allTargets = scanOptimizableExtensions(nm, [PACKAGE_NAME]).filter((ext) => enabled.has(ext.name));
	const ifNeeded = args.split(/\s+/).includes("--if-needed");
	const targets = ifNeeded ? allTargets.filter((ext) => extensionNeedsBuild(ext)) : allTargets;
	if (targets.length === 0) {
		if (ifNeeded) {
			ctx.ui.notify("所有启用的包都已优化且未过期，无需重建。", "success");
		} else {
			ctx.ui.notify("启用的扩展中没有发现可优化的 TypeScript 包。", "info");
		}
		return;
	}
	const skipCount = allTargets.length - targets.length;
	const confirmed = await confirmMutation(
		ctx,
		"构建扩展优化",
		`将预编译 ${targets.length} 个扩展并修改各自 package.json。首次修改会创建 package.json.pi-orig 备份。${ifNeeded && skipCount > 0 ? `（已跳过 ${skipCount} 个未过期的已优化包）` : ""}继续？`,
		args,
	);
	if (!confirmed) {
		ctx.ui.notify("已取消。非交互模式可使用 /ext-opt build --yes。", "info");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, `正在优化 0/${targets.length}…`);
	const results = [];
	try {
		for (let index = 0; index < targets.length; index++) {
			ctx.ui.setStatus(STATUS_KEY, `正在优化 ${index + 1}/${targets.length}: ${targets[index].name}`);
			results.push(await buildOne(targets[index]));
		}
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	const succeeded = results.filter((result) => result.ok).length;
	const failed = results.length - succeeded;
	await showLines(ctx, `构建结果：${succeeded} 成功 / ${failed} 失败`, results.map((result) => {
		const icon = result.ok ? "✅" : "❌";
		const error = result.errors[0] ? `；${result.errors[0]}` : "";
		return `${icon} ${result.name}: ${result.files}/${result.total} files；${result.applyMessage}${error}`;
	}));
	ctx.ui.notify(`优化完成：${succeeded} 成功，${failed} 失败。`, failed > 0 ? "warning" : "success");
	if (failed === 0 && ctx.hasUI && await ctx.ui.confirm("优化已完成", "立即 reload，使新入口在当前进程生效？")) {
		await ctx.reload();
		return;
	}
	ctx.ui.notify("请执行 /reload 或重启 pi 使入口变更生效。", "info");
}

async function handleStatus(ctx: any) {
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
	await showLines(
		ctx,
		`扩展状态：${counts.optimized} optimized / ${counts.typescript} TypeScript / ${counts.javascript} native JS / ${counts.broken} broken — 需要 rebuild：${counts.needsBuild}${counts.needsBuild > 0 ? "（可运行 /ext-opt build --if-needed）" : ""}`,
		[
			...statuses.map((item) => {
				const icon = item.state === "optimized" ? "✅" : item.state === "typescript" ? "⏳" : item.state === "broken" ? "❌" : "•";
				const flags = [item.distExists ? "dist" : "", item.hasBackup ? "backup" : "", item.stale ? "⚠️ 过期" : ""].filter(Boolean).join(",");
				return `${icon} ${item.name}: ${item.entry}${flags ? ` [${flags}]` : ""}`;
			}),
			"",
			links.length > 0
				? `⚠️ 残留 harness 链接：${links.join(", ")}（会让原生子树加载第二份 pi），运行 /ext-opt repair 或 /reload 清理`
				: "harness 链接：无（正常）",
		],
	);
}

async function handleRollback(args: string, ctx: any) {
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
			ctx.ui.notify(`没有可回滚的扩展：${nameArg}（需已优化且存在 package.json.pi-orig 备份）。当前可回滚：${targets.map((pkg) => pkg.name).join(", ") || "无"}`, "warning");
			return;
		}
		targets = match;
	}
	if (targets.length === 0) {
		ctx.ui.notify("没有发现可回滚的已优化扩展。", "info");
		return;
	}
	const confirmed = await confirmMutation(
		ctx,
		"回滚扩展优化",
		`将从 package.json.pi-orig 恢复 ${targets.length} 个扩展的原始入口。dist-opt 文件会保留但不再引用。继续？`,
		args,
	);
	if (!confirmed) {
		ctx.ui.notify("已取消。非交互模式可使用 /ext-opt rollback --yes。", "info");
		return;
	}
	const lines = targets.map((pkg) => `↩ ${pkg.name}: ${rollbackOne(pkg)}`);
	await showLines(ctx, `已回滚 ${targets.length} 个扩展`, lines);
	if (ctx.hasUI && await ctx.ui.confirm("回滚已完成", "立即 reload，使原始入口在当前进程生效？")) {
		await ctx.reload();
		return;
	}
	ctx.ui.notify("请执行 /reload 或重启 pi 使回滚生效。", "info");
}

async function handleMeasure(ctx: any) {
	ctx.ui.setStatus(STATUS_KEY, "正在子进程中测量扩展加载…");
	try {
		const result = await runMeasure();
		const errors = result.rows.filter((row) => row.error).length;
		const warmNote = result.warmMs > 0
			? `（共享 harness 预热 ${result.warmMs}ms，真实 pi 主进程已加载，不重复计入）`
			: "（预热失败，为冷启动口径）";
		await showLines(ctx, `真实 module import（预热后）：${result.totalMs}ms，${errors} errors ${warmNote}`, result.rows.map((row) =>
			`${row.error ? "❌" : "⏱"} ${String(row.ms).padStart(5)}ms  ${row.name}${row.error ? ` — ${row.error}` : ""}`,
		));
		ctx.ui.notify(`测量完成：${result.totalMs}ms（预热后真实启动口径）。`, errors ? "warning" : "success");
		if (result.warnings.length > 0) console.warn(result.warnings.join("\n"));
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

async function handleRepair(ctx: any) {
	const result = removeHarnessLinks(agentNodeModules());
	const marked = markAllDistOpt(agentNodeModules());
	await showLines(ctx, "repair 结果", [
		result.removed.length > 0 ? `🧹 已移除 harness 链接：${result.removed.join(", ")}` : "✅ 无残留 harness 链接",
		marked.length > 0 ? `🏷️ 已补齐 commonjs 标记：${marked.join(", ")}` : "✅ dist-opt 标记齐全",
		...result.warnings.map((warning) => `⚠️ ${warning}`),
	]);
	if (result.warnings.length > 0) {
		ctx.ui.notify("部分链接无法移除，请关闭占用这些目录的进程后重试。", "error");
	} else if (result.removed.length > 0 || marked.length > 0) {
		ctx.ui.notify("已修复，请 /reload 使其在当前进程生效。", "success");
	} else {
		ctx.ui.notify("无需修复。", "success");
	}
}

async function handleHelp(ctx: any) {
	await showLines(ctx, "Pi Extension Optimizer", [
		"/ext-opt build     — 自动扫描 .ts 入口，transpile 到 dist-opt 并应用",
		"/ext-opt build --if-needed — 只重建未优化/产物缺失/源码过期的包",
		"/ext-opt status    — 查看 optimized / TypeScript / native JS / broken 状态",
		"/ext-opt measure   — 在独立子进程中复刻真实 loader 测 module import",
		"/ext-opt repair    — 清理旧版本留下的 harness 链接、补齐 dist-opt commonjs 标记（启动时也会自动执行）",
		"/ext-opt rollback  — 从 package.json.pi-orig 恢复原入口（默认全部）",
		"/ext-opt rollback <name> — 只回滚指定包",
		"build/rollback 可加 --yes 跳过确认（用于非交互模式）",
		"升级扩展后重新运行 /ext-opt build 即可恢复优化。",
	]);
}

export default function extensionOptimizer(pi: ExtensionAPI) {
	// 启动迁移（v0.1.7 及更早的残留）：
	// 1) 移除 node_modules/@earendil-works 下指向 pi 本体的链接 —— 有它们时 Node 原生加载的子树会
	//    再加载一份未打包的 pi（启动 +~3s，instanceof 与主进程失配）。
	// 2) 给旧 dist-opt 补 "type":"commonjs" —— 否则删掉链接后原生子树会报 Cannot find package。
	// 两步都很便宜（几次 readdir/lstat），且对本次已加载的模块无副作用；当前进程首次可能仍有旧行为，/reload 后生效。
	try {
		const nm = agentNodeModules();
		markAllDistOpt(nm);
		removeHarnessLinks(nm);
	} catch {
		// 迁移失败不阻断扩展自身（/ext-opt repair 可查看原因）
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
		},
	});
}
