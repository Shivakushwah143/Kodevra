import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDefaultProvider, ensureModelLimit } from "../lib/config.js";

function withConfig(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-config-"));
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, content);
  const previous = process.env.OPENCODE_CONFIG;
  process.env.OPENCODE_CONFIG = file;
  try {
    return fn(file);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("init refuses to overwrite malformed JSON and leaves it untouched", () => {
  const original = "{ this is not json\n";
  withConfig(original, (file) => {
    assert.throws(
      () => ensureDefaultProvider("freedeepseek"),
      (error) => error.code === "CONFIG_INVALID" && /did not modify/.test(error.message),
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.kodevra-backup`), false);
  });
});

test("model limits are not written over a malformed config either", () => {
  const original = "[1, 2, 3]\n";
  withConfig(original, (file) => {
    assert.throws(() => ensureModelLimit({ providerId: "openrouter", modelId: "m", output: 4096 }), /not a JSON object/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
});
