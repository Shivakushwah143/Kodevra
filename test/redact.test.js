import test from "node:test";
import assert from "node:assert/strict";

import { redactCommand, redactText, redactValue } from "../lib/redact.js";

test("tokens are masked in commands and messages", () => {
  assert.equal(redactText("curl -H 'Authorization: Bearer abcdef123456789'"), "curl -H 'Authorization: Bearer ***'");
  assert.equal(redactText("OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop"), "OPENROUTER_API_KEY=***");
  assert.equal(redactText("gh auth login --token ghp_abcdefghijklmnopqrstuvwxyz012345"), "gh auth login --token ***");
  assert.equal(redactText("mysql --password hunter2"), "mysql --password ***");
  assert.equal(redactText("https://user:pass@example.com/repo"), "https://***:***@example.com/repo");
});

test("ordinary output is left alone", () => {
  const text = "npm test -> PASS (exit 0) in 1200ms";
  assert.equal(redactText(text), text);
  assert.equal(redactCommand("npm test -- --grep slug"), "npm test -- --grep slug");
});

test("event payloads are redacted recursively", () => {
  const payload = redactValue({
    command: "deploy --api-key sk-live-abcdefghijkl",
    nested: [{ note: "token=abc12345" }],
    count: 2,
  });

  assert.equal(payload.command, "deploy --api-key ***");
  assert.equal(payload.nested[0].note, "token=***");
  assert.equal(payload.count, 2);
});
