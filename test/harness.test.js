import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_HARNESS, activeHarness, harnessStatus, normalizeHarness } from "../lib/harness.js";
import { readState, writeState } from "../lib/providers.js";

function withStateFile(run) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-state-")), "state.json");
  const previous = process.env.KODEVRA_STATE;
  process.env.KODEVRA_STATE = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) delete process.env.KODEVRA_STATE;
    else process.env.KODEVRA_STATE = previous;
  }
}

test("the default engine is OpenCode", () => {
  assert.equal(DEFAULT_HARNESS, "opencode");
  assert.equal(activeHarness({ env: {}, state: null }), "opencode");
});

test("engine aliases resolve to the two supported harnesses", () => {
  assert.equal(normalizeHarness("Codex"), "codex");
  assert.equal(normalizeHarness("codex-cli"), "codex");
  assert.equal(normalizeHarness("open-code"), "opencode");
  assert.equal(normalizeHarness("opencode"), "opencode");
});

test("selection precedence is flag, then environment, then state, then default", () => {
  assert.equal(activeHarness({ flag: "codex", env: { KODEVRA_ENGINE: "opencode" }, state: { engine: "opencode" } }), "codex");
  assert.equal(activeHarness({ env: { KODEVRA_ENGINE: "opencode" }, state: { engine: "codex" } }), "opencode");
  assert.equal(activeHarness({ env: {}, state: { engine: "codex" } }), "codex");
});

test("an unknown engine fails with the supported names instead of falling back", () => {
  assert.throws(
    () => activeHarness({ flag: "gpt-shell", env: {}, state: null }),
    (error) => error.code === "HARNESS_UNKNOWN" && /opencode \| codex/.test(error.message),
  );
});

test("selecting a provider and selecting an engine do not overwrite each other", () => {
  withStateFile((file) => {
    writeState({ engine: "codex" });
    writeState({ provider: "freedeepseek", model: "freedeepseek/deepseek-v4-flash" });

    const state = readState();
    assert.equal(state.engine, "codex");
    assert.equal(state.provider, "freedeepseek");
    assert.match(fs.readFileSync(file, "utf8"), /"engine": "codex"/);
  });
});

test("OpenCode readiness reports the engine that was found", () => {
  const status = harnessStatus("opencode", { engine: { command: process.execPath, shell: false } });
  assert.equal(status.name, "opencode");
  assert.equal(status.available, true);
  assert.match(status.version, /^v?\d+\./);
});

test("an unknown harness has no status", () => {
  assert.equal(harnessStatus("not-a-harness"), null);
});
