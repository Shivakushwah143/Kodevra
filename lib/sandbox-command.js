import { appendRunEvent } from "./events.js";
import { runInDocker } from "./docker-executor.js";
import { redactCommand } from "./redact.js";

/**
 * Runs one model-requested command inside the disposable Docker sandbox.
 *
 * This module is loaded by Kodevra's OpenCode tool, which runs inside the
 * OpenCode process. It does not create a second agent loop: it is a thin
 * wrapper over the same docker executor `--verify` uses, with the same
 * snapshot staging and isolation limits.
 *
 * The container's filesystem is discarded after the call. There is no import
 * mechanism: a generated file cannot be trusted back into the workspace.
 */

export const TOOL_TIMEOUT_DEFAULT = 120_000;
export const TOOL_TIMEOUT_MAX = 300_000;
const OUTPUT_LIMIT = 16_000;

function boundTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return TOOL_TIMEOUT_DEFAULT;
  return Math.min(Math.max(Math.floor(parsed), 1_000), TOOL_TIMEOUT_MAX);
}

function clip(text) {
  const value = `${text ?? ""}`;
  if (value.length <= OUTPUT_LIMIT) return value;
  return `...(${value.length - OUTPUT_LIMIT} chars truncated)\n${value.slice(-OUTPUT_LIMIT)}`;
}

/** Human/model readable result: real stdout, stderr, exit code and timeout state. */
export function formatSandboxResult(result) {
  const lines = [];
  lines.push(`exit code: ${result.status}${result.timedOut ? " (timed out)" : ""}`);
  lines.push(`duration: ${result.durationMs} ms`);
  if (result.details) {
    lines.push(
      `sandbox: ${result.details.container} · ${result.details.image} · staged ${result.details.staged_files} file(s) (${result.details.staged_bytes} bytes, ${result.details.excluded} excluded)`,
    );
    lines.push("network: none · capabilities: dropped · user: 1000:1000 · root filesystem: read-only");
    for (const warning of result.details.warnings ?? []) lines.push(`warning: ${warning}`);
  }
  if (result.error) lines.push(`error: ${result.error}`);
  if (!result.stdout && !result.stderr && result.output) lines.push(`message: ${result.output}`);
  lines.push("");
  lines.push("stdout:");
  lines.push(clip(result.stdout).trim() || "(empty)");
  lines.push("");
  lines.push("stderr:");
  lines.push(clip(result.stderr).trim() || "(empty)");
  lines.push("");
  lines.push("note: the sandbox is discarded after this command; files it created are not imported into the workspace.");
  return lines.join("\n");
}

export async function runSandboxCommand({
  command,
  workspace,
  timeoutMs,
  runId,
  runFile,
  forward = false,
}) {
  const timeout = boundTimeout(timeoutMs);
  const startedAt = Date.now();

  appendRunEvent({
    file: runFile,
    runId,
    event: "sandbox_started",
    data: { command: redactCommand(command), timeout_ms: timeout, workspace },
  });

  const result = await runInDocker(command, { cwd: workspace, timeoutMs: timeout, forward });

  appendRunEvent({
    file: runFile,
    runId,
    event: "sandbox_finished",
    data: {
      command: redactCommand(command),
      status: result.status,
      ok: result.ok,
      timed_out: Boolean(result.timedOut),
      duration_ms: result.durationMs,
      container: result.details?.container ?? null,
      image: result.details?.image ?? null,
      staged_files: result.details?.staged_files ?? null,
      error: result.error ?? null,
    },
  });

  return {
    output: formatSandboxResult(result),
    metadata: {
      exit_code: result.status,
      ok: result.ok,
      timed_out: Boolean(result.timedOut),
      duration_ms: result.durationMs,
      error: result.error ?? null,
      container: result.details?.container ?? null,
      image: result.details?.image ?? null,
      staged_files: result.details?.staged_files ?? null,
      warnings: result.details?.warnings ?? [],
      sandbox_discarded: true,
      started_at_ms: startedAt,
    },
  };
}
