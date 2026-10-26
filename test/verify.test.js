import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearWorkspaceChangeCache,
  failureSignature,
  repairPrompt,
  resultLines,
  snapshotTree,
  treeChangedFiles,
  workspaceChanges,
} from "../lib/verify.js";

/** The CLI colours its output on a TTY; assert on the visible text, not the escapes. */
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

test("failure signatures ignore timing and hash noise", () => {
  const a = failureSignature("Error: expected 3 got 2\n finished in 12ms\n deadbeefcafe");
  const b = failureSignature("Error: expected 3 got 2\n finished in 98ms\n 1234abcdef");
  assert.equal(a, b);
  // A different assertion failure is a different failure, not the same one.
  assert.notEqual(failureSignature("Error: expected 1 got 0"), a);
});

test("the repair prompt forbids faking a pass", () => {
  const prompt = repairPrompt({
    command: "npm test",
    result: { ok: false, status: 1, output: "1 failing", timedOut: false },
    attempt: 1,
    maxRepairs: 2,
  });
  assert.match(prompt, /npm test/);
  assert.match(prompt, /exited 1/);
  assert.match(prompt, /Do not edit the verification command/);
  assert.match(prompt, /exit code decides/);
});

test("an unverified run is reported as UNVERIFIED", () => {
  const lines = stripAnsi(
    resultLines({
      model: "freedeepseek/deepseek-v4-flash",
      durationMs: 1000,
      verification: null,
      changes: { isGit: true, files: [], stat: null },
    }).join("\n"),
  );
  assert.match(lines, /UNVERIFIED/);
  assert.match(lines, /--verify/);
  assert.doesNotMatch(lines, /PASS/);
});

test("a verified run reports the real command and exit code", () => {
  const pass = stripAnsi(
    resultLines({
      model: "m",
      durationMs: 10,
      verification: { command: "npm test", ok: true, status: 0, timedOut: false },
      repairs: 1,
      maxRepairs: 2,
      changes: { isGit: true, files: ["src/a.js"], stat: "1 file changed, 2 insertions(+)" },
    }).join("\n"),
  );
  assert.match(pass, /npm test -> PASS \(exit 0\)/);
  assert.match(pass, /1\/2 bounded repair/);
  assert.match(pass, /src\/a\.js/);

  const fail = stripAnsi(
    resultLines({
      model: "m",
      durationMs: 10,
      verification: { command: "npm test", ok: false, status: 1, timedOut: false },
      changes: { isGit: true, files: ["src/a.js"], stat: null },
      failure: { code: "AGENT_FAILED", origin: "agent", message: "opencode exited 1 without a recognised error code.", action: "Run kodevra doctor." },
    }).join("\n"),
  );
  assert.match(fail, /FAIL \(exit 1\)/);
  assert.match(fail, /AGENT_FAILED/);
  assert.doesNotMatch(fail, /PASS/);
});

test("file metadata speaks for workspaces git cannot see", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-tree-"));
  const baselineAt = new Date(Date.now() - 5_000);
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "one\n", "utf8");
  // The snapshot compares size and mtime, so give the rewrite a later timestamp
  // explicitly: two writes inside one system clock tick carry the same mtime on
  // Windows, and a model run is minutes apart, never microseconds.
  fs.utimesSync(path.join(dir, "src", "a.js"), baselineAt, baselineAt);
  const baseline = snapshotTree(dir);

  // The snapshot is size + mtime metadata. Windows records file times in ~15.6ms
  // ticks, so a same-length rewrite inside one tick is invisible to it - wait
  // past a tick, which is what a real agent edit always is.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  fs.writeFileSync(path.join(dir, "src", "a.js"), "two\n", "utf8");
  fs.writeFileSync(path.join(dir, "src", "b.js"), "new\n", "utf8");
  const later = new Date();
  fs.utimesSync(path.join(dir, "src", "a.js"), later, later);

  const changed = treeChangedFiles(baseline, dir);
  assert.deepEqual(changed, ["src/a.js", "src/b.js"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("whether a workspace is a git work tree is asked once per process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-gitprobe-"));
  clearWorkspaceChangeCache();
  const first = workspaceChanges(dir).isGit;

  spawnSync("git", ["init", "-q"], { cwd: dir });
  assert.equal(workspaceChanges(dir).isGit, first, "the answer is memoized for the run");

  clearWorkspaceChangeCache();
  assert.equal(workspaceChanges(dir).isGit, true, "a cleared cache asks git again");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("workspace changes come from git, not from the model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-verify-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  const clean = workspaceChanges(dir);
  assert.equal(clean.isGit, true);

  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  assert.deepEqual(workspaceChanges(dir).files, []);

  fs.writeFileSync(path.join(dir, "a.txt"), "two\n", "utf8");
  const changed = workspaceChanges(dir);
  assert.deepEqual(changed.files, ["a.txt"]);
  assert.match(changed.stat, /a\.txt/);

  fs.rmSync(dir, { recursive: true, force: true });
});
