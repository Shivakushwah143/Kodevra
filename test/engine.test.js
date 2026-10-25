import test from "node:test";
import assert from "node:assert/strict";

import { streamEngine } from "../lib/engine.js";

const node = { command: process.execPath, shell: false };

test("a wall-clock limit cancels the call and reports 124", async () => {
  const run = await streamEngine(node, ["-e", "setTimeout(() => {}, 60000)"], {
    cwd: process.cwd(),
    timeoutMs: 400,
    idleMs: 0,
    forward: false,
  });

  assert.equal(run.status, 124);
  assert.equal(run.timedOut, true);
  assert.equal(run.timeoutReason, "wall-clock");
  assert.ok(run.durationMs < 10_000, `took ${run.durationMs}ms`);
});

test("silence triggers the idle limit even under the wall clock", async () => {
  const run = await streamEngine(node, ["-e", "console.log('started'); setTimeout(() => {}, 60000)"], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
    idleMs: 500,
    forward: false,
  });

  assert.equal(run.status, 124);
  assert.equal(run.timeoutReason, "idle");
  assert.match(run.output, /started/);
});
