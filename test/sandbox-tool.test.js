import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installSandboxTool, sandboxToolInstalled, sandboxToolPath, TOOL_MARKER } from "../lib/sandbox-tool.js";
import { formatSandboxResult } from "../lib/sandbox-command.js";

function tempConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-tool-"));
}

test("the trusted tool is installed into the global config directory, not the workspace", () => {
  const configDir = tempConfig();
  const installed = installSandboxTool({ configDir });

  assert.equal(installed.file, sandboxToolPath({ configDir }));
  assert.match(installed.file.replace(/\\/g, "/"), /\/tools\/sandbox_exec\.js$/);
  assert.ok(fs.readFileSync(installed.file, "utf8").includes(TOOL_MARKER));
  assert.equal(sandboxToolInstalled({ configDir }), true);

  const again = installSandboxTool({ configDir });
  assert.equal(again.changed, false);
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("a foreign file at the tool path is never overwritten", () => {
  const configDir = tempConfig();
  const target = sandboxToolPath({ configDir });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "// someone else's tool\n");

  assert.throws(() => installSandboxTool({ configDir }), /TOOL_CONFLICT|different tool/);
  assert.equal(sandboxToolInstalled({ configDir }), false);
  fs.rmSync(configDir, { recursive: true, force: true });
});

test("the tool result carries real stdout, stderr, exit code and timeout state", () => {
  const text = formatSandboxResult({
    status: 1,
    ok: false,
    timedOut: true,
    durationMs: 1234,
    stdout: "not ok 1 - slugify",
    stderr: "AssertionError",
    details: { container: "kodevra-abc123", image: "node:22-alpine", staged_files: 12, staged_bytes: 4096, excluded: 3 },
  });

  assert.match(text, /exit code: 1 \(timed out\)/);
  assert.match(text, /duration: 1234 ms/);
  assert.match(text, /sandbox: kodevra-abc123 · node:22-alpine/);
  assert.match(text, /not ok 1 - slugify/);
  assert.match(text, /AssertionError/);
  assert.match(text, /not imported into the workspace/);
});
