import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OUTCOME_SCHEMA, normalizeOutcome, writeOutcome } from "../lib/outcome.js";

const run = { status: 0, signal: null, durationMs: 1200, timedOut: false, timeoutReason: null };
const verification = { command: "npm test", ok: true, status: 0, durationMs: 400, timedOut: false };
const executor = { name: "host", sandboxed: false };

test("a verified run carries status, timing, verification and changed files", () => {
  const outcome = normalizeOutcome({
    harness: "codex",
    model: "deepseek-v4-flash",
    provider: "freedeepseek",
    run,
    verification,
    executor,
    changes: { files: ["src/a.js"] },
    repairs: 0,
    maxRepairs: 2,
    eventsFile: "C:/runs/events.jsonl",
    startedAt: 1_000,
    endedAt: 3_000,
    codex: {
      threadId: "01abc",
      commands: [{ command: "npm test", exit_code: 0, status: "completed" }],
      failedCommands: [],
      fileChanges: [],
      agentMessages: ["done"],
      tokens: { input: 1, cached_input: 0, output: 1, reasoning_output: 0 },
      turnCompleted: true,
      turnFailed: false,
      errors: [],
    },
  });

  assert.equal(outcome.schema, OUTCOME_SCHEMA);
  assert.equal(outcome.status, "verified");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.timing.duration_ms, 2000);
  assert.equal(outcome.timing.agent_ms, 1200);
  assert.equal(outcome.verification.exit_code, 0);
  assert.equal(outcome.verification.executor, "host");
  assert.deepEqual(outcome.changes.files, ["src/a.js"]);
  assert.deepEqual(outcome.repairs, { attempts: 0, max: 2 });
  assert.equal(outcome.evidence.agent.thread_id, "01abc");
  assert.equal(outcome.evidence.agent.commands.length, 1);
  assert.equal(outcome.evidence.agent.turn_completed, true);
});

test("a failed verification is never upgraded to a pass", () => {
  const outcome = normalizeOutcome({
    harness: "codex",
    model: "m",
    run,
    verification: { ...verification, ok: false, status: 1 },
    executor,
    startedAt: 0,
    endedAt: 10,
  });

  assert.equal(outcome.status, "verification_failed");
  assert.equal(outcome.ok, false);
});

test("a clean agent exit without verification stays unverified", () => {
  const outcome = normalizeOutcome({ harness: "opencode", model: "m", run, startedAt: 0, endedAt: 1 });
  assert.equal(outcome.status, "unverified");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verification, null);
});

test("a timeout and an agent failure are distinct statuses with their error", () => {
  const timeout = normalizeOutcome({
    harness: "codex",
    model: "m",
    run: { ...run, status: 124, timedOut: true, timeoutReason: "wall-clock" },
    startedAt: 0,
    endedAt: 1,
  });
  assert.equal(timeout.status, "timeout");
  assert.equal(timeout.ok, false);
  assert.equal(timeout.exit.timed_out, true);
  assert.equal(timeout.exit.timeout_reason, "wall-clock");

  const failed = normalizeOutcome({
    harness: "codex",
    model: "m",
    run: { ...run, status: 1 },
    failure: { code: "AUTH_EXPIRED", origin: "provider", message: "The provider rejected the stored credentials." },
    startedAt: 0,
    endedAt: 1,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "AUTH_EXPIRED");
});

test("an unapproved verification is reported separately and is not a pass", () => {
  const outcome = normalizeOutcome({
    harness: "codex",
    model: "m",
    run,
    verification,
    approval: { required: true, fingerprint: "abc" },
    startedAt: 0,
    endedAt: 1,
  });
  assert.equal(outcome.status, "approval_required");
  assert.equal(outcome.ok, false);
});

test("the outcome is written as JSON at the requested path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-outcome-"));
  const file = writeOutcome(path.join(dir, "nested", "outcome.json"), normalizeOutcome({ harness: "codex", model: "m", run }));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).harness, "codex");
});

test("phase timings are carried in the outcome when a run measured them", () => {
  const outcome = normalizeOutcome({
    harness: "codex",
    model: "m",
    run,
    startedAt: 0,
    endedAt: 1_000,
    timings: { spawn: 1_200, first_edit: 61_500, total: 296_000 },
  });

  assert.deepEqual(outcome.timing.phases_ms, { spawn: 1_200, first_edit: 61_500, total: 296_000 });
});

test("a run without instrumentation reports null phases instead of zero", () => {
  assert.equal(normalizeOutcome({ harness: "codex", model: "m", run }).timing.phases_ms, null);
});
