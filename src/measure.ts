import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentDir, realHarnessDir } from "./paths.js";

const execFileAsync = promisify(execFile);
const RESULT_MARKER = "__PI_EXT_OPT_RESULT__";

/** Error codes reported by measure-runner.mjs; rendered to text by the UI layer (i18n). */
export type MeasureErrorCode = "notInstalled" | "entryMissing" | "dynamicChain" | "import";

export interface MeasureRow {
	name: string;
	ms: number;
	error?: { code: MeasureErrorCode; detail?: string };
}

/** Thrown when the measure subprocess itself fails (as opposed to per-extension errors). */
export class MeasureSubprocessError extends Error {
	constructor(readonly code: "failed" | "noResult", readonly detail = "") {
		super(detail ? `${code}: ${detail}` : code);
	}
}

export interface MeasureResult {
	totalMs: number;
	warmMs: number;
	rows: MeasureRow[];
	warnings: string[];
}

/** Replicate the harness loader's module-import timing in a separate Node process. */
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
		if (!stdout.includes(RESULT_MARKER)) throw new MeasureSubprocessError("failed", `${message}\n${stderr}`.trim());
	}

	const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_MARKER));
	if (!markerLine) throw new MeasureSubprocessError("noResult");
	const parsed = JSON.parse(markerLine.slice(RESULT_MARKER.length));
	return {
		totalMs: parsed.totalMs,
		warmMs: parsed.warmMs ?? 0,
		rows: parsed.rows,
		warnings: stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
	};
}
