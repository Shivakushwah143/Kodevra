import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRunLog, eventNames, pruneRunLogs } from "../lib/events.js";

test("events carry run_id, timestamp and event type", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-events-"));
  const log = createRunLog({
    workspace: "C:/projects/demo",
    model: "freedeepseek/deepseek-v4-flash",
    provider: "freedeepseek",
    mode: "workspace-write",
    executor: "host",
    verify: "npm test",
    runDir,
  });

  const started = log.emit("run_started", { workspace: "C:/projects/demo", sandboxed: false });
  log.emit("verification_finished", { command: "npm test", ok: true, status: 0, duration_ms: 12 });

  assert.match(started.run_id, /^run_[0-9T-]+_[0-9a-f]{6}$/);
  assert.ok(!Number.isNaN(Date.parse(started.ts)));
  assert.equal(started.event, "run_started");
  assert.equal(started.sandboxed, false);
  assert.equal(log.entries.length, 2);

  const lines = fs.readFileSync(log.file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].run_id, lines[1].run_id);
  assert.equal(lines[1].event, "verification_finished");
  assert.equal(lines[1].ok, true);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("secrets never reach the event file", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-events-"));
  const log = createRunLog({ runDir, workspace: "w", model: "m", provider: "p", mode: "workspace-write", executor: "host" });
  log.emit("sandbox_started", { command: "deploy --token ghp_abcdefghijklmnopqrstuvwxyz012345" });
  log.emit("failure", { message: "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop" });

  const raw = fs.readFileSync(log.file, "utf8");
  assert.equal(raw.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.equal(raw.includes("sk-or-v1-abcdefghijklmnop"), false);
  assert.match(raw, /--token \*\*\*/);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("old run files are pruned by the retention window", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-retention-"));
  const old = path.join(runDir, "run_old.jsonl");
  fs.writeFileSync(old, "{}\n");
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, oldTime, oldTime);
  fs.writeFileSync(path.join(runDir, "keep.txt"), "not a run log");

  const removed = pruneRunLogs({ runDir, maxAgeDays: 14 });
  assert.equal(removed.removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(runDir, "keep.txt")), true);

  fs.rmSync(runDir, { recursive: true, force: true });
});

test("the event vocabulary covers the execution lifecycle", () => {
  const names = eventNames();
  for (const required of [
    "run_started",
    "model_started",
    "model_finished",
    "file_changes",
    "verification_authorized",
    "verification_started",
    "verification_finished",
    "repair_started",
    "approval_required",
    "failure",
    "run_finished",
  ]) {
    assert.ok(names.includes(required), `missing event ${required}`);
  }
});
