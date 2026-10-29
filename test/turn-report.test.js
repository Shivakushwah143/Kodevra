import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyCall, parseRollout, rollup } from "../benchmarks/codex/turn-report.mjs";

const T0 = Date.parse("2026-10-26T10:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

function record(seconds, payload) {
  return JSON.stringify({ timestamp: at(seconds), type: "response_item", payload });
}

/**
 * A rollout where turn 1 reads two files in ONE response, turn 2 edits after a
 * failed patch attempt, turn 3 verifies. The second read is a batch, not a turn.
 */
function writeFixture({ contract = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-turn-report-"));
  const file = path.join(dir, "rollout-fixture.jsonl");
  const prompt = contract ? "<kodevra_execution_contract> rules </kodevra_execution_contract> fix the tax total" : "fix the tax total";
  const lines = [
    JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { cwd: "C:/ws", cli_version: "0.149.1" } }),
    JSON.stringify({ timestamp: at(0), type: "event_msg", payload: { type: "task_started" } }),
    record(1, { type: "message", role: "user", content: [{ text: prompt }] }),
    // turn 1: two independent reads in one response
    record(10, { type: "function_call", name: "exec_command", arguments: '{"cmd":"Get-Content C:/ws/src/invoice.js"}', call_id: "c1" }),
    record(10, { type: "function_call", name: "exec_command", arguments: '{"cmd":"Get-Content C:/ws/test/invoice.test.js"}', call_id: "c2" }),
    record(12, { type: "function_call_output", call_id: "c1", output: "Process exited with code 0" }),
    record(12, { type: "function_call_output", call_id: "c2", output: "Process exited with code 0" }),
    // turn 2: a patch attempt the environment refuses, in one response
    record(20, { type: "function_call", name: "exec_command", arguments: '{"cmd":"apply_patch <<EOF"}', call_id: "c3" }),
    record(22, {
      type: "function_call_output",
      call_id: "c3",
      output: "Process exited with code 1 Invalid patch: The last line of the patch must be '*** End Patch'",
    }),
    // turn 3: the edit
    record(30, { type: "function_call", name: "exec_command", arguments: '{"cmd":"Set-Content C:/ws/src/invoice.js -Value ..."}', call_id: "c4" }),
    record(31, { type: "function_call_output", call_id: "c4", output: "Process exited with code 0" }),
    // turn 4: verification
    record(40, { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm.cmd --prefix C:/ws test"}', call_id: "c5" }),
    record(44, { type: "function_call_output", call_id: "c5", output: "Process exited with code 0" }),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return { dir, file };
}

test("two calls in one response are one turn, not two", () => {
  const { dir, file } = writeFixture();
  try {
    const parsed = parseRollout(file);
    assert.equal(parsed.turns.length, 4);
    assert.equal(parsed.turns[0].calls.length, 2, "the batch is one turn with two calls");
    assert.equal(parsed.turns[0].classes.join(","), "READ,READ");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the rollup reports turns, first edit, environment failures and the label", () => {
  const { dir, file } = writeFixture();
  try {
    const summary = rollup(parseRollout(file));
    assert.equal(summary.turns, 4);
    assert.equal(summary.calls, 5);
    assert.equal(summary.callsPerTurn, 1.25);
    assert.equal(summary.firstEditTurn, 3, "the failed patch is not the first edit");
    assert.equal(summary.environmentFailures, 1);
    assert.deepEqual(summary.environmentKinds, ["apply_patch quoting"]);
    assert.equal(summary.verificationTurns, 1);
    assert.equal(summary.label, "native");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a prompt carrying the contract is labelled contract, not native", () => {
  const { dir, file } = writeFixture({ contract: true });
  try {
    assert.equal(rollup(parseRollout(file)).label, "contract");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("calls are classified from the call, not from the model's prose", () => {
  assert.equal(classifyCall({ arguments: '{"cmd":"Get-Content src/a.js"}' }), "READ");
  assert.equal(classifyCall({ arguments: '{"cmd":"rg -n invoiceTotal src"}' }), "DISCOVERY");
  assert.equal(classifyCall({ arguments: '{"cmd":"npm.cmd test"}' }), "VERIFICATION");
  assert.equal(classifyCall({ arguments: '{"cmd":"Get-Content package.json"}' }), "DEPENDENCY_LOOKUP");
  assert.equal(classifyCall({ arguments: '{"cmd":"apply_patch x"}' }), "EDIT");
  assert.equal(classifyCall({ arguments: '{"cmd":"update_plan"}' }), "PLANNING");
  assert.equal(
    classifyCall({ arguments: "Get-Content x", failed: true, output: "Access to the path 'C:\\ws' is denied." }),
    "READ",
    "a failed read is still a read; the failure is recorded separately",
  );
});

test("an empty or interrupted rollout is a report, not a crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-turn-report-"));
  try {
    const file = path.join(dir, "empty.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ timestamp: at(0), type: "session_meta", payload: {} })}\n{"truncated":`, "utf8");
    const summary = rollup(parseRollout(file));
    assert.equal(summary.turns, 0);
    assert.equal(summary.firstEditTurn, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
