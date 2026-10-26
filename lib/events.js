import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactValue } from "./redact.js";

/**
 * Structured execution events (developer-alpha milestone).
 *
 * One JSON object per line, written locally. Kodevra is not adding an event
 * bus, a database or an orchestration layer: these entries are built from
 * engine timings, git state and verification results that Kodevra already has.
 *
 * Logs are evidence, not a credential store: every payload passes through the
 * redactor, the directory is private (0700) and each file is 0600. Run files
 * older than the retention window are pruned when a new run starts, so the
 * evidence does not accumulate forever.
 *
 * Event shape:
 *   { "run_id": "run_...", "ts": "2026-...", "event": "verification_finished", ... }
 */

const EVENT_NAMES = [
  "run_started",
  "model_started",
  "model_finished",
  "model_cancelled",
  "model_metrics",
  "file_changes",
  "verification_authorized",
  "verification_reapproved",
  "approval_required",
  "verification_started",
  "verification_finished",
  "verification_skipped",
  "repair_started",
  "sandbox_started",
  "sandbox_finished",
  "failure",
  "run_finished",
];

export const DEFAULT_RETENTION_DAYS = Number(process.env.KODEVRA_EVENT_RETENTION_DAYS || 14);

export function eventNames() {
  return [...EVENT_NAMES];
}

function safeEntry(runId, event, data, now) {
  return {
    run_id: runId,
    ts: now().toISOString(),
    event,
    ...redactValue(data),
  };
}

/**
 * Append one event to an existing run (used by the sandbox tool, which runs in
 * OpenCode's process and must not create a second run_id).
 */
export function appendRunEvent({ file, runId, event, data = {}, now = () => new Date() }) {
  const entry = safeEntry(runId, event, data, now);
  if (file) {
    try {
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // events are best-effort; the tool result is the source of truth
    }
  }
  return entry;
}

function runStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/** Delete run files older than the retention window. Failures are ignored. */
export function pruneRunLogs({ runDir, maxAgeDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  if (!runDir || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return { removed: 0 };
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(runDir, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^run_.+\.jsonl$/.test(entry.name)) continue;
    const file = path.join(runDir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      // a file that vanished is already gone
    }
  }
  return { removed };
}

/**
 * @param {object} options
 * @param {boolean} [options.stream] also write each event to stderr as JSON
 * @param {string}   [options.runDir] override the run directory (tests)
 * @param {number}   [options.retentionDays] override the retention window (tests)
 */
export function createRunLog({
  workspace,
  model,
  provider,
  mode,
  executor,
  verify,
  stream = false,
  runDir = path.join(os.homedir(), ".kodevra", "runs"),
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = () => new Date(),
} = {}) {
  const runId = `run_${runStamp(now())}_${randomUUID().slice(0, 6)}`;
  const entries = [];
  let file = null;

  try {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    pruneRunLogs({ runDir, maxAgeDays: retentionDays, now: now() });
    file = path.join(runDir, `${runId}.jsonl`);
  } catch {
    file = null;
  }

  function emit(event, data = {}) {
    const entry = safeEntry(runId, event, data, now);
    entries.push(entry);
    if (file) {
      try {
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        file = null;
      }
    }
    if (stream) process.stderr.write(`${JSON.stringify(entry)}\n`);
    return entry;
  }

  const context = { workspace, model, provider, mode, executor, verify: verify ?? null };
  return { runId, file, entries, emit, context };
}
