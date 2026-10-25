import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Structured execution events (developer-alpha milestone).
 *
 * One JSON object per line, written locally. Kodevra is not adding an event
 * bus, a database or an orchestration layer: these entries are built from
 * engine timings, git state and verification results that Kodevra already has.
 *
 * A future branded terminal UI can tail the file or read the streamed stderr
 * lines (`--events-json`) without scraping coloured human output.
 *
 * Event shape:
 *   { "run_id": "run_...", "ts": "2026-...", "event": "verification_finished", ... }
 */

const EVENT_NAMES = [
  "run_started",
  "model_started",
  "model_finished",
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

export function eventNames() {
  return [...EVENT_NAMES];
}

/**
 * Append one event to an existing run (used by the sandbox tool, which runs in
 * OpenCode's process and must not create a second run_id).
 */
export function appendRunEvent({ file, runId, event, data = {}, now = () => new Date() }) {
  const entry = { run_id: runId, ts: now().toISOString(), event, ...data };
  if (file) {
    try {
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // events are best-effort; the tool result is the source of truth
    }
  }
  return entry;
}

function runStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/**
 * @param {object} options
 * @param {boolean} [options.stream] also write each event to stderr as JSON
 * @param {string}   [options.runDir] override the run directory (tests)
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
  now = () => new Date(),
} = {}) {
  const runId = `run_${runStamp(now())}_${randomUUID().slice(0, 6)}`;
  const entries = [];
  let file = null;

  try {
    fs.mkdirSync(runDir, { recursive: true });
    file = path.join(runDir, `${runId}.jsonl`);
  } catch {
    file = null;
  }

  function emit(event, data = {}) {
    const entry = {
      run_id: runId,
      ts: now().toISOString(),
      event,
      ...data,
    };
    entries.push(entry);
    if (file) {
      try {
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
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
