import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHATGPT_WEB_PROVIDER,
  CORRECTION_MESSAGE,
  chatGptWebAssessment,
  chatTurn,
  instruction,
  parseAction,
  probeBridge,
  readWebSession,
  toolResultMessage,
  webSessionFile,
  writeWebSession,
} from "../lib/chatgpt-web.js";
import { executeTool, resolveWorkspacePath } from "../lib/chatgpt-web-tools.js";
import { runChatGptWebAgent } from "../lib/chatgpt-web-agent.js";

function workspace(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-web-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return root;
}

function json(value) {
  return JSON.stringify(value);
}

test("a strict JSON action is accepted as-is", () => {
  const parsed = parseAction(json({ action: "read", path: "src/value.js" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action.action, "read");
  assert.equal(parsed.action.path, "src/value.js");
});

test("surrounding prose gets exactly one local extraction attempt", () => {
  const parsed = parseAction('Sure, here it is:\n{"action":"list","path":"src"}\nDone.');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action.path, "src");
});

test("content with braces and escaped quotes survives extraction", () => {
  const content = 'export const value = 2;\nexport const brace = "}";\n';
  const parsed = parseAction(`{"action":"write","path":"src/value.js","content":${JSON.stringify(content)}}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.action.content, content);
});

test("prose without a JSON object and unknown actions are refused", () => {
  assert.equal(parseAction("I would read the file first.").ok, false);
  const shell = parseAction(json({ action: "shell", command: "rm -rf /" }));
  assert.equal(shell.ok, false);
  assert.match(shell.reason, /unknown action/);
  assert.equal(parseAction(json({ action: "read" })).ok, false);
  assert.equal(parseAction(json({ action: "edit", path: "a.js", old: "" , new: "x" })).ok, false);
  assert.equal(parseAction("[1,2]").ok, false);
});

test("read, list and search stay inside the workspace", () => {
  const root = workspace({
    "src/value.js": "export const value = 1;\n",
    "src/other.js": "// nothing\n",
    ".env": "SECRET=1\n",
    "node_modules/dep/index.js": "export const value = 'dependency';\n",
  });
  const outside = workspace({ "secret.txt": "do not read\n" });

  const read = executeTool(root, { action: "read", path: "src/value.js" });
  assert.equal(read.ok, true);
  assert.match(read.body, /export const value = 1/);

  const listing = executeTool(root, { action: "list", path: "src" });
  assert.equal(listing.ok, true);
  assert.match(listing.body, /file value\.js/);
  assert.match(listing.body, /file other\.js/);

  const search = executeTool(root, { action: "search", query: "value" });
  assert.equal(search.ok, true);
  assert.match(search.body, /src\/value\.js:1:/);
  assert.equal(search.body.includes("node_modules"), false, "dependencies are not searched");
  assert.equal(search.body.includes(".env"), false, "sensitive files are never searched");

  assert.equal(executeTool(root, { action: "read", path: "../secret.txt" }).code, "PATH_OUTSIDE_WORKSPACE");
  assert.equal(
    executeTool(root, { action: "read", path: path.join(outside, "secret.txt") }).code,
    "PATH_OUTSIDE_WORKSPACE",
  );
  assert.equal(executeTool(root, { action: "read", path: ".env" }).code, "PATH_SENSITIVE");
  assert.equal(executeTool(root, { action: "write", path: "../escape.txt", content: "x" }).code, "PATH_OUTSIDE_WORKSPACE");
  assert.equal(
    executeTool(root, { action: "write", path: path.join(outside, "escaped.txt"), content: "x" }).code,
    "PATH_OUTSIDE_WORKSPACE",
  );
  assert.equal(fs.existsSync(path.join(outside, "escaped.txt")), false);
});

test("write and edit apply real changes and edit refuses ambiguity", () => {
  const root = workspace({ "src/value.js": "export const value = 1;\n", "src/twice.js": "a\na\n" });

  const written = executeTool(root, { action: "write", path: "src/new/deep.js", content: "export const n = 1;\n" });
  assert.equal(written.ok, true);
  assert.match(fs.readFileSync(path.join(root, "src/new/deep.js"), "utf8"), /export const n = 1/);

  const edited = executeTool(root, {
    action: "edit",
    path: "src/value.js",
    old: "value = 1",
    new: "value = 2",
  });
  assert.equal(edited.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "src/value.js"), "utf8"), "export const value = 2;\n");

  assert.equal(
    executeTool(root, { action: "edit", path: "src/value.js", old: "missing", new: "x" }).code,
    "EDIT_NO_MATCH",
  );
  assert.equal(executeTool(root, { action: "edit", path: "src/twice.js", old: "a", new: "b" }).code, "EDIT_AMBIGUOUS");
  assert.equal(fs.readFileSync(path.join(root, "src/twice.js"), "utf8"), "a\na\n");
});

test("read-only mode refuses writes instead of downgrading them", () => {
  const root = workspace({ "src/value.js": "one\n" });
  const result = executeTool(root, { action: "write", path: "src/value.js", content: "two\n" }, { mode: "read-only" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MODE_REFUSES_WRITE");
  assert.equal(fs.readFileSync(path.join(root, "src/value.js"), "utf8"), "one\n");
});

test("there is no shell action to invoke", () => {
  const root = workspace({});
  const result = executeTool(root, { action: "bash", command: "echo hi" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED_ACTION");
});

test("the loop reads, edits, verifies once and reuses that verification on finish", async () => {
  const root = workspace({ "src/value.js": "export const value = 1;\n" });
  const replies = [
    json({ action: "read", path: "src/value.js" }),
    json({ action: "write", path: "src/value.js", content: "export const value = 2;\n" }),
    json({ action: "verify" }),
    json({ action: "finish", summary: "value is 2" }),
  ];
  const seen = [];
  let verifyCalls = 0;
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "change the value to 2",
    chat: async (message) => {
      seen.push(message);
      return { text: replies.shift(), session: "conv_1" };
    },
    verify: async () => {
      verifyCalls += 1;
      return { command: "node check.js", ok: true, status: 0, output: "ok", durationMs: 5 };
    },
    onEvent: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.turns, 4);
  assert.deepEqual(result.actions.map((entry) => entry.action), ["read", "write", "verify"]);
  assert.equal(verifyCalls, 1);
  assert.equal(result.lastVerification.ok, true);
  assert.equal(result.session, "conv_1");
  assert.equal(fs.readFileSync(path.join(root, "src/value.js"), "utf8"), "export const value = 2;\n");
  assert.equal(seen[0].newSession, true, "a fresh run starts a fresh conversation");
  assert.equal(seen[1].newSession, false);
  assert.match(seen[0].message, /WORKSPACE:/);
  assert.match(seen[0].message, /TASK:\nchange the value to 2/);
});

test("an edit after verification makes that verification unreusable", async () => {
  const root = workspace({ "src/value.js": "1\n" });
  const replies = [
    json({ action: "write", path: "src/value.js", content: "2\n" }),
    json({ action: "verify" }),
    json({ action: "edit", path: "src/value.js", old: "2", new: "3" }),
    json({ action: "finish", summary: "done" }),
  ];
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    chat: async () => ({ text: replies.shift(), session: "conv_2" }),
    verify: async () => ({ command: "check", ok: true, status: 0, output: "ok", durationMs: 1 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.lastVerification, null, "Kodevra must re-verify after the workspace changed");
});

test("a malformed reply gets one correction and then stops", async () => {
  const root = workspace({ "a.txt": "x\n" });
  const seen = [];
  const repaired = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    chat: async (message) => {
      seen.push(message.message);
      if (seen.length === 1) return { text: "I will read a.txt", session: "conv_3" };
      return { text: json({ action: "finish", summary: "ok" }) };
    },
  });
  assert.equal(repaired.ok, true);
  assert.equal(seen[1], CORRECTION_MESSAGE);
  assert.equal(repaired.turns, 2);

  let calls = 0;
  const broken = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    chat: async () => {
      calls += 1;
      return { text: "still prose", session: "conv_4" };
    },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "PROTOCOL_ERROR");
  assert.equal(calls, 2, "one original reply plus one correction");
});

test("a shell request is a protocol error, not an executed command", async () => {
  const root = workspace({});
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    chat: async () => ({ text: json({ action: "shell", command: "echo pwned" }), session: "conv_5" }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROTOCOL_ERROR");
});

test("the turn budget stops a loop that never finishes", async () => {
  const root = workspace({ "a.txt": "x\n" });
  let calls = 0;
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    limits: { maxTurns: 3, maxProtocolRepairs: 1, maxVerifyRepairs: 2, resultChars: 200 },
    chat: async () => {
      calls += 1;
      return { text: json({ action: "list", path: "." }), session: "conv_6" };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TURN_BUDGET_EXHAUSTED");
  assert.equal(calls, 3);
});

test("a failed verification is reported to ChatGPT and its budget is bounded", async () => {
  const root = workspace({ "a.txt": "x\n" });
  const replies = [json({ action: "verify" }), json({ action: "verify" }), json({ action: "verify" })];
  const bodies = [];
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    chat: async (message) => {
      bodies.push(message.message);
      return { text: replies.shift(), session: "conv_7" };
    },
    verify: async () => ({ command: "check", ok: false, status: 2, output: "assertion failed", durationMs: 1 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "VERIFICATION_BUDGET");
  assert.match(bodies[1], /result: FAIL/);
  assert.match(bodies[1], /assertion failed/);
  assert.match(bodies[1], /exit code: 2/);
});

test("a successful verification is returned to ChatGPT as a pass", async () => {
  const root = workspace({ "a.txt": "x\n" });
  const bodies = [];
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "task",
    chat: async (message) => {
      bodies.push(message.message);
      return {
        text: bodies.length === 1 ? json({ action: "verify" }) : json({ action: "finish", summary: "ok" }),
        session: "conv_8",
      };
    },
    verify: async () => ({ command: "check", ok: true, status: 0, output: "all green", durationMs: 1 }),
  });
  assert.equal(result.ok, true);
  assert.match(bodies[1], /result: PASS/);
  assert.match(bodies[1], /all green/);
});

test("continuation reuses the previous conversation instead of opening a new one", async () => {
  const root = workspace({ "a.txt": "x\n" });
  const seen = [];
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "follow-up",
    continueSession: true,
    sessionId: "conv_old",
    chat: async (message) => {
      seen.push(message);
      return { text: json({ action: "finish", summary: "done" }), session: "conv_old" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen[0].newSession, false);
  assert.equal(seen[0].sessionId, "conv_old");

  const fresh = [];
  await runChatGptWebAgent({
    workspace: root,
    task: "fresh",
    continueSession: true,
    sessionId: null,
    chat: async (message) => {
      fresh.push(message);
      return { text: json({ action: "finish", summary: "done" }), session: "conv_new" };
    },
  });
  assert.equal(fresh[0].newSession, true, "no stored conversation means a fresh one, stated plainly");
});

test("the conversation mapping is per workspace and stores only an opaque id", () => {
  const root = workspace({});
  const file = path.join(root, ".kodevra-sessions.json");
  const env = { KODEVRA_CHATGPT_WEB_SESSIONS: file };
  assert.equal(webSessionFile(env), path.resolve(file));

  writeWebSession(root, { session: "https://chatgpt.com/c/abc", env });
  assert.equal(readWebSession(root, { env }), "https://chatgpt.com/c/abc");
  assert.equal(readWebSession(path.join(root, "other"), { env }), null);

  const raw = fs.readFileSync(file, "utf8");
  assert.match(raw, /chatgpt\.com/);
  assert.equal(/cookie|token|authorization|password/i.test(raw), false);
});

test("the initial instruction states the protocol and the task verbatim", () => {
  const text = instruction({ workspace: "C:/work/demo", task: "fix the failing test" });
  assert.match(text, /Return exactly one JSON object and nothing else/);
  assert.match(text, /WORKSPACE:\nC:\/work\/demo/);
  assert.match(text, /TASK:\nfix the failing test/);
  assert.match(text, /read\nsearch\nlist\nwrite\nedit\nverify\nfinish/);
});

test("tool results are bounded and labelled", () => {
  const message = toolResultMessage({
    action: { action: "read", path: "big.txt" },
    ok: true,
    detail: "24 bytes",
    body: "x".repeat(50),
  });
  assert.match(message, /KODEVRA TOOL RESULT/);
  assert.match(message, /status: success/);
  assert.match(message, /path: big\.txt/);
  assert.match(message, /Return exactly one JSON action/);

  const truncated = toolResultMessage({
    action: { action: "read", path: "big.txt" },
    ok: true,
    body: "y".repeat(20_000),
  });
  assert.match(truncated, /\[truncated\]/);
});

test("the synchronous bridge transport posts the message and reads the assistant text", async () => {
  const captured = [];
  const fetchImpl = async (url, options) => {
    captured.push({ url, options, body: JSON.parse(options.body) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: '{"action":"finish","summary":"ok"}' } }],
        chatgpt: { session: "conv_9", url: "https://chatgpt.com/c/conv_9" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  // The synchronous contract is the fallback for a bridge without the durable
  // endpoint; it still has to post the same request and read the same answer.
  const reply = await chatTurn({
    message: "hello",
    newSession: true,
    durable: false,
    settings: { baseURL: "http://127.0.0.1:8080/v1", token: "t0ken" },
    fetchImpl,
  });
  assert.equal(reply.session, "conv_9");
  assert.equal(captured[0].url, "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(captured[0].options.headers.authorization, "Bearer t0ken");
  assert.equal(captured[0].body.newSession, true);
  assert.equal(captured[0].body.messages[0].content, "hello");
  assert.equal(captured[0].body.stream, false);
});

test("a bridge refusal is a named failure, never a silent retry", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ detail: "Unauthorized: missing or invalid API_TOKEN" }), { status: 401 });
  await assert.rejects(
    () =>
      chatTurn({
        message: "hello",
        settings: { baseURL: "http://127.0.0.1:8080/v1", token: "" },
        fetchImpl,
      }),
    (error) => error.code === "BRIDGE_UNAUTHORIZED",
  );

  const probe = await probeBridge({
    baseURL: "http://127.0.0.1:8080/v1",
    token: "wrong",
    fetchImpl,
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, "BRIDGE_UNAUTHORIZED");
  assert.match(probe.detail, /KODEVRA_CHATGPT_BRIDGE_TOKEN/);
});

test("a bridge with no browser tab is not ready", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, clients: 0, error: "No selected browser extension client connected" }), {
      status: 200,
    });
  const probe = await probeBridge({ baseURL: "http://127.0.0.1:8080/v1", token: "t", fetchImpl });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, "BRIDGE_NO_BROWSER");

  const readyFetch = async () =>
    new Response(JSON.stringify({ ok: true, clients: 1 }), { status: 200 });
  const ready = await probeBridge({ baseURL: "http://127.0.0.1:8080/v1", token: "t", fetchImpl: readyFetch });
  assert.equal(ready.ok, true);
  assert.match(ready.detail, /1 browser client/);
});

test("the provider row is explicitly experimental and needs no engine catalog", () => {
  const assessment = chatGptWebAssessment();
  assert.equal(assessment.key, CHATGPT_WEB_PROVIDER);
  assert.equal(assessment.ready, true);
  assert.equal(assessment.kind, "browser");
  assert.equal(assessment.credential.source, "existing Chrome ChatGPT session");
  assert.equal(assessment.plan, null, "no API billing and no engine plan is claimed");
});

test("a path resolution failure names the boundary, not a generic error", () => {
  const root = workspace({});
  assert.throws(() => resolveWorkspacePath(root, "../x"), (error) => error.code === "PATH_OUTSIDE_WORKSPACE");
  assert.throws(() => resolveWorkspacePath(root, "auth.json"), (error) => error.code === "PATH_SENSITIVE");
});
