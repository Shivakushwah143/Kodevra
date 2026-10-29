import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  chatTurn,
  classifyTransportFailure,
  createProgressReporter,
  DURABLE,
  isAmbiguousTransportFailure,
} from "../lib/chatgpt-web.js";
import { runChatGptWebAgent } from "../lib/chatgpt-web-agent.js";

/**
 * Focused, deterministic probes for the durable chatgpt-web transport.
 *
 * These exercise the real path: chatTurn -> fetch -> a real loopback HTTP server
 * that speaks the durable protocol. Nothing here mocks the transport, and every
 * timing is scaled to seconds, so no probe waits on a browser or on Undici's
 * ~300s default. The property under test is structural, not a timeout value: an
 * individual HTTP operation stays short while the model turn lasts much longer.
 */

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-durable-"));
  return root;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A stand-in bridge that behaves like the durable protocol:
 *   POST /kodevra/requests     -> 202 { request_id, status }
 *   GET  /kodevra/requests/:id -> pending | recovering | completed | failed
 *
 * Options:
 *   completionDelayMs  how long the "model" reasons after submit
 *   completeAfterPolls complete after this many status reads instead (deterministic)
 *   statusHoldMs       how long each status response is held open
 *   statusTimeoutFor   optional predicate for injecting status failures
 *   answers            queued assistant answers, one per logical request
 *   recoveringMs       window during which the status is "recovering"
 *   dropFirstSubmit    destroy the socket after accepting the first submit
 *   durable: false     answer /kodevra/requests with 404 (an older bridge)
 */
function startBridge(options = {}) {
  const {
    completionDelayMs = 1_000,
    completeAfterPolls = 0,
    statusHoldMs = 5,
    answers = ['{"action":"finish","summary":"done"}'],
    recoveringMs = 0,
    dropFirstSubmit = false,
    failingStatusPolls = 0,
    durable = true,
  } = options;

  const records = new Map();
  const byKey = new Map();
  const requests = [];
  const polls = [];
  let submits = 0;
  let droppedSubmitDone = false;
  let statusPolls = 0;
  let legacyCompletions = 0;

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const done = (status, body) => {
      requests.push({ url: req.url, method: req.method, durationMs: Date.now() - startedAt, status });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.url === "/health") return done(200, { ok: true, clients: 1 });

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      legacyCompletions += 1;
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        setTimeout(() => {
          done(200, {
            id: "chatcmpl-legacy",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: answers[0] }, finish_reason: "stop" }],
            chatgpt: { session: { id: "legacy_session" }, model: "gpt-test" },
          });
        }, completionDelayMs);
      });
      return undefined;
    }

    if (req.url === "/kodevra/requests" && req.method === "POST") {
      if (!durable) return done(404, { detail: "Not found" });
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        submits += 1;
        const payload = JSON.parse(raw || "{}");
        const key = payload.idempotency_key;
        const existing = byKey.get(key);
        if (existing) {
          return done(200, {
            ok: true,
            protocol: "kodevra-durable-v1",
            request_id: existing.requestId,
            status: existing.status || "waiting_for_model",
            replayed: true,
          });
        }
        const requestId = `req_${records.size + 1}`;
        const record = {
          requestId,
          key,
          prompt: payload.prompt,
          createdAt: Date.now(),
          completesAt: Date.now() + completionDelayMs,
          completeAfterPolls,
          polls: 0,
          answer: answers[records.size % answers.length],
          status: "submitted",
        };
        records.set(requestId, record);
        byKey.set(key, record);

        if (dropFirstSubmit && !droppedSubmitDone) {
          droppedSubmitDone = true;
          // The client sees a reset even though the turn was accepted: the exact
          // ambiguity idempotency exists for.
          return res.socket?.destroy();
        }
        return done(202, {
          ok: true,
          protocol: "kodevra-durable-v1",
          request_id: requestId,
          status: "submitted",
          replayed: false,
        });
      });
      return undefined;
    }

    if (req.url.startsWith("/kodevra/requests/") && req.method === "GET") {
      const requestId = req.url.slice("/kodevra/requests/".length).split("?")[0];
      const record = records.get(requestId);
      if (!record) return done(404, { detail: "Unknown request" });
      statusPolls += 1;
      record.polls += 1;
      polls.push({ requestId, at: Date.now() });
      setTimeout(() => {
        if (statusPolls <= failingStatusPolls) return done(500, { detail: "temporary status failure" });
        const elapsed = Date.now() - record.createdAt;
        const polledEnough = record.completeAfterPolls > 0 && record.polls >= record.completeAfterPolls;
        if (recoveringMs > 0 && elapsed < recoveringMs) {
          return done(200, {
            ok: true,
            request_id: requestId,
            status: "recovering",
            phase: "reattaching",
            terminal: false,
          });
        }
        if (polledEnough || (record.completeAfterPolls === 0 && Date.now() >= record.completesAt)) {
          return done(200, {
            ok: true,
            request_id: requestId,
            status: "completed",
            phase: "completed",
            terminal: true,
            response: { answer: record.answer, session: { id: `conv_${requestId}` }, model: "gpt-test" },
          });
        }
        return done(200, {
          ok: true,
          request_id: requestId,
          status: "waiting_for_model",
          phase: "generating",
          terminal: false,
        });
      }, statusHoldMs);
      return undefined;
    }

    return done(404, { detail: "Not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
      resolve({
        baseURL,
        settings: { baseURL, token: "test-token" },
        records,
        requests,
        polls,
        stats: () => ({ submits, statusPolls, legacyCompletions, logicalTurns: records.size }),
        maxRequestMs: () => Math.max(0, ...requests.map((entry) => entry.durationMs)),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

test("a completion longer than one HTTP operation succeeds and never holds a long connection", async () => {
  const bridge = await startBridge({ completionDelayMs: 1_200, statusHoldMs: 60 });
  try {
    const startedAt = Date.now();
    const reply = await chatTurn({
      message: "long turn",
      idempotencyKey: "probe-1",
      timeoutMs: 4_000,
      pollIntervalMs: 50,
      statusTimeoutMs: 400,
      progressEveryMs: 10_000,
      settings: bridge.settings,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(reply.text, '{"action":"finish","summary":"done"}');
    assert.ok(elapsed >= 1_200, `the turn must outlast one HTTP operation (took ${elapsed}ms)`);
    const longest = bridge.maxRequestMs();
    assert.ok(longest < 1_000, `no single HTTP request may live for the whole turn (longest ${longest}ms)`);
    assert.ok(elapsed > longest * 1.5, `the turn (${elapsed}ms) must be much longer than any request (${longest}ms)`);
    assert.ok(bridge.stats().statusPolls >= 5, "the wait is polling, not one socket");
    assert.equal(bridge.stats().logicalTurns, 1);
  } finally {
    await bridge.close();
  }
});

test("a turn past the configured deadline fails as MODEL_RESPONSE_TIMEOUT, not as a bridge failure", async () => {
  const bridge = await startBridge({ completionDelayMs: 5_000, statusHoldMs: 5 });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () =>
        chatTurn({
          message: "too slow",
          idempotencyKey: "probe-2",
          timeoutMs: 700,
          pollIntervalMs: 50,
          statusTimeoutMs: 300,
          settings: bridge.settings,
        }),
      (error) => {
        assert.equal(error.code, "MODEL_RESPONSE_TIMEOUT");
        assert.match(error.message, /configured 1s deadline|configured 0s deadline|deadline/i);
        assert.equal(error.details.requestId, "req_1");
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 3_000, `the deadline must be honoured promptly (took ${elapsed}ms)`);
  } finally {
    await bridge.close();
  }
});

test("a dropped submit retries with the same key and creates exactly one model turn", async () => {
  const bridge = await startBridge({ completionDelayMs: 300, dropFirstSubmit: true });
  try {
    const reply = await chatTurn({
      message: "retry my submit",
      idempotencyKey: "probe-idempotent",
      timeoutMs: 4_000,
      pollIntervalMs: 50,
      statusTimeoutMs: 300,
      settings: bridge.settings,
    });
    assert.equal(reply.text, '{"action":"finish","summary":"done"}');
    assert.equal(bridge.stats().submits, 2, "the ambiguous submit is retried");
    assert.equal(bridge.stats().logicalTurns, 1, "but it is still one logical model turn");
  } finally {
    await bridge.close();
  }
});

test("failed status polls are retried without resubmitting or consuming a turn", async () => {
  const bridge = await startBridge({ completionDelayMs: 300, failingStatusPolls: 3 });
  try {
    const reply = await chatTurn({
      message: "flaky polls",
      idempotencyKey: "probe-poll-failures",
      timeoutMs: 4_000,
      pollIntervalMs: 40,
      statusTimeoutMs: 300,
      settings: bridge.settings,
    });
    assert.equal(reply.text, '{"action":"finish","summary":"done"}');
    assert.equal(bridge.stats().submits, 1, "a failed poll never submits the prompt again");
    assert.equal(bridge.stats().logicalTurns, 1);
  } finally {
    await bridge.close();
  }
});

test("a recovering browser is a wait, not a failure", async () => {
  const bridge = await startBridge({ completionDelayMs: 900, recoveringMs: 500 });
  try {
    const stages = [];
    const reply = await chatTurn({
      message: "recovering",
      idempotencyKey: "probe-recovering",
      timeoutMs: 4_000,
      pollIntervalMs: 40,
      statusTimeoutMs: 400,
      progressEveryMs: 10_000,
      settings: bridge.settings,
      onProgress: (event) => stages.push(event.stage),
    });
    assert.equal(reply.text, '{"action":"finish","summary":"done"}');
    assert.ok(stages.includes("recovering"), `expected a recovering stage, saw ${stages.join(", ")}`);
    assert.equal(stages.at(-1), "received");
    assert.equal(bridge.stats().submits, 1);
  } finally {
    await bridge.close();
  }
});

test("progress is throttled instead of printing a line per poll", async () => {
  // Completion is gated on the poll count, not the wall clock, so the assertion
  // does not depend on how loaded the machine is.
  const bridge = await startBridge({ completionDelayMs: 60_000, completeAfterPolls: 25 });
  try {
    const progress = [];
    await chatTurn({
      message: "quiet progress",
      idempotencyKey: "probe-progress",
      timeoutMs: 6_000,
      pollIntervalMs: 20,
      statusTimeoutMs: 300,
      progressEveryMs: 60_000,
      settings: bridge.settings,
      onProgress: (event) => progress.push(event),
    });
    assert.ok(bridge.stats().statusPolls >= 25, `the turn really was polled many times (${bridge.stats().statusPolls})`);
    assert.ok(
      progress.length <= 3,
      `expected a handful of lines, saw ${progress.length}: ${progress.map((p) => p.stage).join(", ")}`,
    );
    assert.deepEqual(progress.map((p) => p.stage), ["submitted", "waiting", "received"]);
    assert.equal(progress[0].requestId, "req_1");
  } finally {
    await bridge.close();
  }
});

test("the progress reporter prints on a stage change, then at the cadence", () => {
  let now = 0;
  const events = [];
  const reporter = createProgressReporter({ onProgress: (event) => events.push(event), everyMs: 1_000, now: () => now });
  reporter.report("submitted", { requestId: "r1" });
  now = 100;
  assert.ok(reporter.report("waiting", {}), "a new stage always prints");
  now = 200;
  assert.equal(reporter.report("waiting", {}), null, "the same stage inside the cadence is silent");
  now = 1_200;
  assert.ok(reporter.report("waiting", {}), "the same stage after the cadence prints again");
  now = 1_250;
  assert.ok(reporter.report("received", {}), "completion always prints");
  assert.deepEqual(events.map((event) => event.stage), ["submitted", "waiting", "waiting", "received"]);
});

test("a refused localhost connection is BRIDGE_UNAVAILABLE, immediately", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(() => resolve()));

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      chatTurn({
        message: "nobody is listening",
        idempotencyKey: "probe-refused",
        timeoutMs: 5_000,
        pollIntervalMs: 50,
        settings: { baseURL: `http://127.0.0.1:${port}/v1`, token: "" },
      }),
    (error) => {
      assert.equal(error.code, "BRIDGE_UNAVAILABLE");
      assert.match(error.message, /not reachable/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 2_000, "a definite refusal must not be retried into a slow failure");
});

test("an older bridge falls back to the synchronous path and says so", async () => {
  const bridge = await startBridge({ completionDelayMs: 100, durable: false });
  try {
    const stages = [];
    const reply = await chatTurn({
      message: "legacy bridge",
      idempotencyKey: "probe-legacy",
      timeoutMs: 4_000,
      settings: bridge.settings,
      onProgress: (event) => stages.push(event.stage),
    });
    assert.equal(reply.text, '{"action":"finish","summary":"done"}');
    assert.equal(bridge.stats().legacyCompletions, 1);
    assert.ok(stages.includes("legacy"), `expected a legacy stage, saw ${stages.join(", ")}`);
  } finally {
    await bridge.close();
  }
});

test("several slow agent turns complete through the durable transport", async () => {
  const workspace = tempWorkspace();
  fs.writeFileSync(path.join(workspace, "notes.txt"), "alpha\nbeta\n");
  const bridge = await startBridge({
    // Each turn is slower than one status HTTP operation, like a real browser.
    completionDelayMs: 420,
    statusHoldMs: 20,
    answers: [
      '{"action":"read","path":"notes.txt"}',
      '{"action":"search","query":"beta"}',
      '{"action":"finish","summary":"three slow turns"}',
    ],
  });
  try {
    const stages = [];
    const result = await runChatGptWebAgent({
      workspace,
      task: "look at notes.txt and finish",
      chat: (message) =>
        chatTurn({
          ...message,
          timeoutMs: 6_000,
          pollIntervalMs: 40,
          statusTimeoutMs: 250,
          progressEveryMs: 10_000,
          settings: bridge.settings,
        }),
      onEvent: (event) => {
        if (event.type === "progress") stages.push(event.stage);
      },
    });
    assert.equal(result.failure, null);
    assert.equal(result.summary, "three slow turns");
    assert.equal(result.turns, 3);
    assert.equal(bridge.stats().logicalTurns, 3, "one model turn per action, none spent on polling");
    assert.ok(
      bridge.maxRequestMs() < 1_000,
      `each HTTP operation stays short relative to the run (longest ${bridge.maxRequestMs()}ms)`,
    );
    assert.ok(stages.filter((stage) => stage === "received").length >= 3);
  } finally {
    await bridge.close();
  }
});

test("transport failures keep their real cause", () => {
  // Undici's own headers/body deadline must read as the model's, not the bridge's.
  const headers = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
  const body = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } });
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal(classifyTransportFailure(headers), "MODEL_RESPONSE_TIMEOUT");
  assert.equal(classifyTransportFailure(body), "MODEL_RESPONSE_TIMEOUT");
  assert.equal(classifyTransportFailure(refused), "BRIDGE_UNAVAILABLE");
  // A deadline may have landed after the bridge accepted the turn; a refusal
  // never did, so only the former is retried.
  assert.equal(isAmbiguousTransportFailure(headers), true);
  assert.equal(isAmbiguousTransportFailure(refused), false);
});

test("the durable defaults stay short per operation", () => {
  // The point of the design: the model deadline is long, every HTTP operation is
  // not. If this ever inverts, a socket is carrying a model turn again.
  assert.ok(DURABLE.statusTimeoutMs <= 30_000);
  assert.ok(DURABLE.submitTimeoutMs <= 30_000);
  assert.ok(DURABLE.pollIntervalMs <= 5_000);
});

test("a deep status silence below the poll failure limit is not a failure", async () => {
  // A single missed status response must not end a healthy turn.
  const bridge = await startBridge({ completionDelayMs: 500, failingStatusPolls: 1 });
  try {
    const reply = await chatTurn({
      message: "one flaky poll",
      idempotencyKey: "probe-one-flaky-poll",
      timeoutMs: 4_000,
      pollIntervalMs: 40,
      statusTimeoutMs: 250,
      settings: bridge.settings,
    });
    assert.equal(reply.text, '{"action":"finish","summary":"done"}');
    assert.equal(bridge.stats().submits, 1);
  } finally {
    await sleep(10);
    await bridge.close();
  }
});
