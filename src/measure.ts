import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentDir, realHarnessDir } from "./paths.js";

const execFileAsync = promisify(execFile);
const RESULT_MARKER = "__PI_EXT_OPT_RESULT__";

export interface MeasureRow {
	name: string;
	ms: number;
	error?: string;
}

export interface MeasureResult {
	totalMs: number;
	warmMs: number;
	rows: MeasureRow[];
	warnings: string[];
}

/** 在独立 Node 进程中复刻 harness loader 的 module import 测量。 */
export async function runMeasure(): Promise<MeasureResult> {
	const runner = fileURLToPath(new URL("../measure-runner.mjs", import.meta.url));
	let stdout = "";
	let stderr = "";
	try {
		const result = await execFileAsync(
			process.execPath,
			[runner, "--agent-dir", agentDir(), "--harness", realHarnessDir()],
			{ windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
		);
		stdout = result.stdout;
		stderr = result.stderr;
	} catch (error: any) {
		stdout = error?.stdout ?? "";
		stderr = error?.stderr ?? "";
		const message = error instanceof Error ? error.message : String(error);
		if (!stdout.includes(RESULT_MARKER)) throw new Error(`测量子进程失败: ${message}\n${stderr}`.trim());
	}

	const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_MARKER));
	if (!markerLine) throw new Error("测量子进程未返回结构化结果");
	const parsed = JSON.parse(markerLine.slice(RESULT_MARKER.length));
	return {
		totalMs: parsed.totalMs,
		warmMs: parsed.warmMs ?? 0,
		rows: parsed.rows,
		warnings: stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
	};
}
