import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { watchRunEvents } from "../lib/progress.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the progress tailer reports only events appended after it starts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-progress-"));
  const file = path.join(dir, "run.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ event: "run_started" })}\n`);

  const seen = [];
  const stop = watchRunEvents(file, { onEvent: (event) => seen.push(event.event), intervalMs: 25 });

  fs.appendFileSync(file, `${JSON.stringify({ event: "sandbox_started", command: "npm test" })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ event: "sandbox_finished", command: "npm test", ok: true, status: 0 })}\n`);
  await sleep(120);
  stop();

  assert.ok(seen.includes("sandbox_started"));
  assert.ok(seen.includes("sandbox_finished"));

  const before = seen.length;
  fs.appendFileSync(file, `${JSON.stringify({ event: "run_finished" })}\n`);
  await sleep(80);
  assert.equal(seen.length, before, "a stopped watcher must not keep reading");

  fs.rmSync(dir, { recursive: true, force: true });
});
