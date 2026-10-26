import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCodexArgs,
  codexAuth,
  codexFailureText,
  findCodex,
  parseCodexEvents,
  readCodexConfig,
  resolveCodexRun,
} from "../lib/codex.js";

const SAMPLE = [
  '{"type":"thread.started","thread_id":"01abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Looking at the test."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","aggregated_output":"fail","exit_code":1,"status":"failed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"npm test","aggregated_output":"pass","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"file_change","changes":[{"path":"src/a.js"}],"status":"completed"}}',
  "2026-10-26T05:00:00Z ERROR codex_core::tools::router: blocked by policy",
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2,"reasoning_output_tokens":1}}',
].join("\n");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-codex-test-"));
}

test("codex JSONL becomes commands, messages, usage and separate log lines", () => {
  const events = parseCodexEvents(SAMPLE);

  assert.equal(events.threadId, "01abc");
  assert.equal(events.turnCompleted, true);
  assert.equal(events.turnFailed, false);
  assert.equal(events.agentMessages.length, 1);
  assert.equal(events.lastMessage, "Looking at the test.");
  assert.equal(events.commands.length, 2);
  assert.deepEqual(events.commands[0], {
    command: "npm test",
    exit_code: 1,
    status: "failed",
    output: "fail",
  });
  assert.equal(events.failedCommands.length, 1);
  assert.equal(events.fileChanges.length, 1);
  assert.equal(events.fileChanges[0].changes[0].path, "src/a.js");
  assert.deepEqual(events.tokens, { input: 10, cached_input: 4, output: 2, reasoning_output: 1 });
  assert.equal(events.logLines.length, 1, "non-JSON logging is kept apart, not parsed as an event");
});

test("a failed turn is reported as a failed turn with its error text", () => {
  const events = parseCodexEvents(
    [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"error","message":"{\\"error\\":{\\"message\\":\\"The model is not supported\\"}}"}',
      '{"type":"turn.failed","error":{"message":"The model is not supported"}}',
    ].join("\n"),
  );

  assert.equal(events.turnFailed, true);
  assert.equal(events.turnCompleted, false);
  assert.equal(events.errors.length, 2);
  assert.match(codexFailureText({ output: "raw" }, events), /model is not supported/);
});

test("an exit-0 turn with no tool calls is visible instead of assumed successful", () => {
  const events = parseCodexEvents(
    ['{"type":"turn.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"I am blocked."}}', '{"type":"turn.completed","usage":{}}'].join(
      "\n",
    ),
  );

  assert.equal(events.turnCompleted, true);
  assert.equal(events.commands.length, 0, "the outcome carries no command evidence");
  assert.equal(events.logLines.length, 0);
});

test("only the non-secret Codex settings are read from config.toml", () => {
  const dir = tempDir();
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(
    file,
    [
      'model = "deepseek-v4-flash"',
      'model_provider = "freedeepseek"',
      'model_reasoning_effort = "low"',
      "",
      "[windows]",
      'sandbox = "elevated"',
      "",
      "[mcp_servers.node_repl.env]",
      'OPENAI_API_KEY = "sk-should-never-appear"',
      "",
      "[profiles.fast]",
      'model = "ignored-profile-model"',
    ].join("\n"),
  );

  const config = readCodexConfig(file);
  assert.equal(config.exists, true);
  assert.equal(config.model, "deepseek-v4-flash");
  assert.equal(config.provider, "freedeepseek");
  assert.equal(config.reasoningEffort, "low");
  assert.equal(config.windowsSandbox, "elevated");
  assert.equal(JSON.stringify(config).includes("sk-should-never-appear"), false);
  assert.equal(config.model, "deepseek-v4-flash", "a profile model does not override the top-level model");
});

test("a missing Codex config is a report, not a crash", () => {
  const config = readCodexConfig(path.join(tempDir(), "absent.toml"));
  assert.equal(config.exists, false);
  assert.equal(config.provider, null);
});

test("Codex authentication is reported by presence and never returns the secret", () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "sk-auth-secret-value" }, OPENAI_API_KEY: "sk-auth-secret-value" }),
  );

  const auth = codexAuth(null, {
    env: { CODEX_HOME: dir },
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });

  assert.equal(auth.ok, true);
  assert.equal(auth.stored, true);
  assert.equal(auth.state, "provider");
  assert.match(auth.detail, /freedeepseek/);
  assert.equal(JSON.stringify(auth).includes("sk-auth-secret-value"), false);
});

test("an env API key is named but its value is never copied into the report", () => {
  const dir = tempDir();
  const auth = codexAuth(null, {
    env: { CODEX_HOME: dir, OPENAI_API_KEY: "sk-env-secret-value" },
    config: { provider: null },
  });

  assert.equal(auth.ok, true);
  assert.equal(auth.state, "api-key");
  assert.match(auth.detail, /env OPENAI_API_KEY/);
  assert.equal(JSON.stringify(auth).includes("sk-env-secret-value"), false);
});

test("no Codex credential at all points at the official sign-in", () => {
  const auth = codexAuth(null, { env: { CODEX_HOME: tempDir() }, config: { provider: null } });
  assert.equal(auth.ok, false);
  assert.equal(auth.state, "none");
  assert.match(auth.hint, /codex login/);
});

test("a bad KODEVRA_CODEX_BIN is named instead of silently falling back", () => {
  const probe = findCodex({ env: { KODEVRA_CODEX_BIN: path.join(tempDir(), "missing-codex") }, refresh: true });
  assert.equal(probe.ok, false);
  assert.equal(probe.reason, "override-missing");
  assert.match(probe.detail, /does not exist/);
});

test("Codex exec arguments carry the sandbox, workspace, model and provider", () => {
  const args = buildCodexArgs({
    mode: "workspace-write",
    workspace: "/work/demo",
    target: { model: "gpt-5.6-terra", providerId: "openai" },
    prompt: "fix the bug",
  });

  assert.equal(args[0], "exec");
  assert.deepEqual(args.slice(1, 3), ["--sandbox", "workspace-write"]);
  assert.deepEqual(args.slice(3, 5), ["-C", "/work/demo"]);
  assert.ok(args.includes("--json"));
  assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.6-terra"]);
  assert.ok(args.includes('model_provider="openai"'));
  assert.equal(args[args.length - 1], "fix the bug", "the prompt is one argument, not split");
});

test("interactive Codex gets no exec subcommand and no JSON stream", () => {
  const args = buildCodexArgs({
    mode: "ask",
    workspace: "/work/demo",
    target: { model: null, providerId: null },
    interactive: true,
  });

  assert.equal(args.includes("exec"), false);
  assert.equal(args.includes("--json"), false);
  assert.equal(args.includes("--sandbox"), false, "ask mode leaves Codex's own approvals in place");
  assert.deepEqual(args.slice(0, 2), ["-C", "/work/demo"]);
});

test("non-interactive Codex refuses ask mode instead of over-granting", () => {
  assert.throws(
    () => buildCodexArgs({ mode: "ask", workspace: "/work/demo", prompt: "x" }),
    (error) => error.code === "HARNESS_MODE_UNSUPPORTED" && /per-tool approval/.test(error.message),
  );
});

test("the effective Codex model is only the selection when Codex can honour it", () => {
  const matching = resolveCodexRun({
    selection: { provider: "freedeepseek", model: "deepseek-v4-flash" },
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(matching.model, "deepseek-v4-flash");
  assert.equal(matching.providerId, null);

  const mismatched = resolveCodexRun({
    selection: { provider: "openrouter", model: "openai/gpt-5" },
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(mismatched.model, null);
  assert.match(mismatched.note, /not applied/);

  const openai = resolveCodexRun({
    selection: { provider: "openai", model: "gpt-5.6-terra" },
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(openai.providerId, "openai");
  assert.equal(openai.model, null, "without an explicit -m, Codex's default is reported instead of guessed");

  const pinned = resolveCodexRun({
    selection: { provider: "openai", model: "gpt-5.6-terra" },
    explicitModel: true,
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(pinned.model, "gpt-5.6-terra");
});

test("timed lines carry at_ms evidence for the first command, edit and event", () => {
  const lines = [
    { line: '{"type":"thread.started","thread_id":"01abc"}', at: 900 },
    {
      line: '{"type":"item.completed","item":{"type":"command_execution","command":"Get-ChildItem","aggregated_output":"denied","exit_code":1,"status":"failed"}}',
      at: 1_850,
    },
    {
      line: '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"src/invoice.js"}],"status":"completed"}}',
      at: 61_400,
    },
    { line: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}', at: 120_000 },
  ];

  const events = parseCodexEvents(lines);

  assert.equal(events.firstEventAt, 900);
  assert.equal(events.commands[0].at_ms, 1_850);
  assert.equal(events.fileChanges[0].at_ms, 61_400);
  assert.equal(events.turnCompletedAt, 120_000);
  assert.equal(events.turnCompleted, true);
});

test("an untimed parse stays exactly as it was, with no at_ms keys", () => {
  const events = parseCodexEvents('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}');

  assert.equal("at_ms" in events.commands[0], false);
  assert.equal(events.firstEventAt, null);
  assert.equal(events.turnCompletedAt, null);
});

test("the catalog settings that make two CLI calls unnecessary are reported", () => {
  const dir = tempDir();
  const custom = path.join(dir, "custom.toml");
  fs.writeFileSync(
    custom,
    [
      'model = "gpt-5.6-terra"',
      'model_catalog_json = "C:/Users/dev/.codex/freedeepseek-models.json"',
      "profile = \"fast\"",
    ].join("\n"),
    "utf8",
  );
  const config = readCodexConfig(custom);
  assert.equal(config.modelCatalogJson, "C:/Users/dev/.codex/freedeepseek-models.json");
  assert.equal(config.profile, "fast");

  const plain = path.join(dir, "plain.toml");
  fs.writeFileSync(plain, 'model = "gpt-5.6-terra"\n', "utf8");
  const bare = readCodexConfig(plain);
  assert.equal(bare.modelCatalogJson, null, "no custom catalog means the bundled one is effective");
  assert.equal(bare.profile, null);
});
