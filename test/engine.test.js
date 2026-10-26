import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("the engine is told the workspace through PWD, not the caller's shell", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-cwd-"));
  const run = await streamEngine(node, ["-e", "process.stdout.write(process.env.PWD || '')"], {
    cwd: dir,
    env: { ...process.env, PWD: "a-stale-shell-directory" },
    forward: false,
  });

  assert.equal(run.status, 0);
  assert.equal(run.output, path.resolve(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("line callbacks consume a machine stream while raw output is still kept", async () => {
  const lines = [];
  const script = 'process.stdout.write(JSON.stringify({type:"a"})+"\\n");process.stdout.write(JSON.stringify({type:"b"}))';
  const run = await streamEngine(node, ["-e", script], {
    cwd: process.cwd(),
    forward: false,
    forwardStdout: false,
    onLine: (line) => lines.push(line),
  });

  assert.equal(run.status, 0);
  assert.deepEqual(lines, ['{"type":"a"}', '{"type":"b"}']);
  assert.match(run.output, /"type":"b"/);
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
