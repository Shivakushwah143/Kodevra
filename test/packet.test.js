import test from "node:test";
import assert from "node:assert/strict";

import { PACKET_LIMITS, buildWorkspacePacket, clipOutput, referencedFiles, withWorkspacePacket } from "../lib/packet.js";

const FILES = ["package.json", "src/invoice.js", "src/money.js", "test/invoice.test.js"];
const TASK = "invoiceTotal never applies TAX_RATE. Fix it in src/invoice.js and do not edit the tests.";

test("the task text is passed through verbatim after the facts block", () => {
  const packet = buildWorkspacePacket({ workspace: "C:/work/demo", files: FILES, platform: "linux" });
  const prompt = withWorkspacePacket(packet, TASK);

  assert.ok(prompt.endsWith(TASK), "the task must be the last thing the model reads, unchanged");
  assert.equal(prompt.split(TASK).length, 2, "the task must appear exactly once");
});

test("the prompt is a single line, so a Windows .cmd shim cannot truncate it", () => {
  const packet = buildWorkspacePacket({
    workspace: "C:\\work\\demo",
    files: FILES,
    verify: "npm test",
    verification: { ok: false, status: 1, output: "line one\nline two\nline three" },
    platform: "win32",
  });

  assert.equal(packet.includes("\n"), false);
  assert.equal(withWorkspacePacket(packet, TASK).includes("\n"), false);
});

test("the packet names the root, the files and the real pre-flight result", () => {
  const packet = buildWorkspacePacket({
    workspace: "C:/work/demo",
    files: FILES,
    verify: "npm test",
    verification: {
      ok: false,
      status: 1,
      output: "✖ invoice total includes sales tax (test/invoice.test.js:15)\nAssertionError: 19.99 !== 21.64",
    },
    platform: "linux",
  });

  assert.match(packet, /root: C:\/work\/demo\./);
  assert.match(packet, /files: package\.json, src\/invoice\.js, src\/money\.js, test\/invoice\.test\.js\./);
  assert.match(packet, /verify: `npm test` exits 1 before any change; output: ✖ invoice total includes sales tax \(test\/invoice\.test\.js:15\) \|\| AssertionError: 19\.99 !== 21\.64/);
  assert.match(packet, /mentioned by that output: (test\/invoice\.test\.js|src\/invoice\.js)/);
});

test("a passing pre-flight is reported as passing instead of hidden", () => {
  const packet = buildWorkspacePacket({
    workspace: "/work/demo",
    files: FILES,
    verify: "npm test",
    verification: { ok: true, status: 0, output: "✔ 3 tests" },
    platform: "linux",
  });

  assert.match(packet, /`npm test` exits 0 before any change/);
});

test("long pre-flight output keeps the head and tail and counts what it dropped", () => {
  const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
  const clipped = clipOutput(output, { head: 3, tail: 2, maxLine: 200 });

  assert.equal(clipped.omitted, 95);
  assert.match(clipped.text, /^line 1\nline 2\nline 3\n\.\.\. 95 lines omitted \.\.\.\nline 99\nline 100$/);
});

test("short output is not marked as truncated", () => {
  const clipped = clipOutput("a\nb\nc");

  assert.equal(clipped.omitted, 0);
  assert.equal(clipped.text, "a\nb\nc");
});

test("only paths that exist in the workspace are reported as mentioned", () => {
  const mentioned = referencedFiles(
    "Error at src/invoice.js:8\nmissing module ./nope.js\nsee test/invoice.test.js",
    FILES,
  );

  assert.deepEqual(mentioned, ["src/invoice.js", "test/invoice.test.js"]);
});

test("the Windows shell notes appear only on win32", () => {
  const win = buildWorkspacePacket({ workspace: "C:\\work\\demo", files: FILES, platform: "win32" });
  const posix = buildWorkspacePacket({ workspace: "/work/demo", files: FILES, platform: "linux" });

  assert.match(win, /npm\.cmd works/);
  assert.match(win, /git -c safe\.directory="C:\\work\\demo" works/);
  assert.doesNotMatch(posix, /npm\.cmd/);
});

test("the file list is capped and says how many more there are", () => {
  const many = Array.from({ length: PACKET_LIMITS.files + 5 }, (_, index) => `src/f${index}.js`);
  const packet = buildWorkspacePacket({ workspace: "/work/demo", files: many, platform: "linux" });

  assert.match(packet, /\(\+5 more\)/);
});

test("no verify command means no unmeasured verification claim", () => {
  const packet = buildWorkspacePacket({ workspace: "/work/demo", files: FILES, platform: "linux" });

  assert.doesNotMatch(packet, /verify:/);
  assert.match(packet, /files:/);
});

test("no environment variable or credential is copied into the packet", () => {
  process.env.KODEVRA_PACKET_CANARY = "super-secret-value";
  try {
    const packet = buildWorkspacePacket({ workspace: "/work/demo", files: FILES, platform: "linux" });
    assert.doesNotMatch(packet, /super-secret-value/);
  } finally {
    delete process.env.KODEVRA_PACKET_CANARY;
  }
});

test("the same inputs produce the same packet", () => {
  const input = { workspace: "/work/demo", files: FILES, verify: "npm test", platform: "linux" };

  assert.equal(buildWorkspacePacket(input), buildWorkspacePacket(input));
});

test("a missing workspace yields no packet, so the prompt stays exactly the task", () => {
  assert.equal(buildWorkspacePacket({ workspace: null, files: FILES }), null);
  assert.equal(withWorkspacePacket(null, TASK), TASK);
});
