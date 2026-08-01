import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentDir, realHarnessDir } from "./paths.js";
const execFileAsync = promisify(execFile);
const RESULT_MARKER = "__PI_EXT_OPT_RESULT__";
async function runMeasure() {
  const runner = fileURLToPath(new URL("../measure-runner.mjs", import.meta.url));
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      process.execPath,
      [runner, "--agent-dir", agentDir(), "--harness", realHarnessDir()],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = error?.stdout ?? "";
    stderr = error?.stderr ?? "";
    const message = error instanceof Error ? error.message : String(error);
    if (!stdout.includes(RESULT_MARKER)) throw new Error(`\u6D4B\u91CF\u5B50\u8FDB\u7A0B\u5931\u8D25: ${message}
${stderr}`.trim());
  }
  const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_MARKER));
  if (!markerLine) throw new Error("\u6D4B\u91CF\u5B50\u8FDB\u7A0B\u672A\u8FD4\u56DE\u7ED3\u6784\u5316\u7ED3\u679C");
  const parsed = JSON.parse(markerLine.slice(RESULT_MARKER.length));
  return {
    totalMs: parsed.totalMs,
    warmMs: parsed.warmMs ?? 0,
    rows: parsed.rows,
    warnings: stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  };
}
export {
  runMeasure
};
