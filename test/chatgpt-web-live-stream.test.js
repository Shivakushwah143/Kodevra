import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { chatTurn, followLiveResponse, parseAction } from "../lib/chatgpt-web.js";
import { runChatGptWebAgent } from "../lib/chatgpt-web-agent.js";

/**
 * Focused, deterministic probes for the display-only live response channel.
 *
 * These use a real loopback HTTP server that speaks the durable protocol and the
 * optional SSE stream. No browser, no Chrome and no long timings are involved:
 * the properties under test are ordering, isolation from the durable answer, and
 * that streamed text is never executed.
 */

const FULL_ACTION = '{"action":"batch","operations":[{"action":"list","path":"."}]}';
const CHUNKS = ['{"action":', '"batch",', '"operations":[{"action":"list","path":"."}]}'];
const PARTIAL_STEPS = CHUNKS.map((_, index) => CHUNKS.slice(0, index + 1).join(""));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-live-"));
}

/**
 * A stand-in bridge. The durable status completes after `completeAfterPolls` reads
 * so the answer never races the stream, and the SSE endpoint plays a fixed script.
 *
 * scenarios:
 *   normal    started + deltas + completed in order
 *   drop      one delta, then the socket is destroyed
 *   reconnect first connection closes after one delta; the next one resumes
 */
function startBridge({ scenario = "normal", completeAfterPolls = 3 } = {}) {
  const records = new Map();
  let submits = 0;
  let statusPolls = 0;
  const eventConnections = [];

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, clients: 1 }));
      return;
    }

    if (req.url === "/kodevra/requests" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        submits += 1;
        const requestId = `req_${records.size + 1}`;
        records.set(requestId, { polls: 0, answer: FULL_ACTION });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocol: "kodevra-durable-v1", request_id: requestId, status: "submitted" }));
      });
      return;
    }

    const eventsMatch = req.url.match(/^\/kodevra\/requests\/([^/?]+)\/events(?:\?after=(\d+))?/);
    if (eventsMatch) {
      const requestId = eventsMatch[1];
      const after = Math.max(0, Number(eventsMatch[2]) || 0);
      eventConnections.push({ requestId, after });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      const write = (seq, type, extra = {}) => {
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ requestId, seq, type, ...extra })}\n\n`);
      };
      if (scenario === "drop") {
        write(1, "response.delta", { delta: CHUNKS[0], answerLength: CHUNKS[0].length });
        setTimeout(() => res.destroy(), 10);
        return;
      }
      if (scenario === "reconnect" && after === 0) {
        write(1, "response.delta", { delta: CHUNKS[0], answerLength: CHUNKS[0].length });
        setTimeout(() => res.end(), 10);
        return;
      }
      const from = scenario === "reconnect" ? 1 : 0;
      const emitted = CHUNKS.slice(from);
      let length = CHUNKS.slice(0, from).join("").length;
      if (after === 0) write(1, "response.started");
      emitted.forEach((delta, index) => {
        length += delta.length;
        write(after + index + 2, "response.delta", { delta, answerLength: length });
      });
      write(after + emitted.length + 2, "response.completed", { answerLength: length });
      setTimeout(() => res.end(), 10);
      return;
    }

    const statusMatch = req.url.match(/^\/kodevra\/requests\/([^/?]+)$/);
    if (statusMatch && req.method === "GET") {
      const requestId = statusMatch[1];
      const record = records.get(requestId);
      if (!record) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "Unknown request" }));
        return;
      }
      statusPolls += 1;
      record.polls += 1;
      const complete = record.polls >= completeAfterPolls;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(
        complete
          ? {
              ok: true,
              request_id: requestId,
              status: "completed",
              phase: "completed",
              terminal: true,
              response: { answer: record.answer, session: { id: "conv_live" }, model: "gpt-test" },
            }
          : { ok: true, request_id: requestId, status: "waiting_for_model", phase: "generating", terminal: false },
      ));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Not found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", async () => {
      const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
      // Let the fire-and-forget stream settle before the test tears down.
      resolve({
        baseURL,
        settings: { baseURL, token: "test-token" },
        eventConnections,
        stats: () => ({ submits, statusPolls }),
        close: async () => {
          await sleep(25);
          server.closeAllConnections?.();
          await new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

test("live deltas arrive in order while the complete durable action stays authoritative", async () => {
  const bridge = await startBridge({ scenario: "normal" });
  const events = [];
  try {
    const reply = await chatTurn({
      message: "list the workspace",
      newSession: true,
      settings: bridge.settings,
      pollIntervalMs: 20,
      statusTimeoutMs: 1_000,
      submitTimeoutMs: 1_000,
      timeoutMs: 10_000,
      onLiveEvent: (event) => events.push(event),
    });

    assert.equal(reply.text, FULL_ACTION);
    const deltas = events.filter((event) => event.type === "response.delta");
    assert.ok(deltas.length >= 3, `expected streamed deltas, got ${deltas.length}`);
    assert.deepEqual(deltas.map((event) => event.seq), [...deltas.map((event) => event.seq)].sort((a, b) => a - b));
    assert.equal(deltas.map((event) => event.delta).join(""), FULL_ACTION);
    assert.ok(events.some((event) => event.type === "response.started"));

    // Streaming is display only: the action is parsed from the complete durable
    // response and never from a partial frame.
    assert.equal(parseAction(deltas[0].delta).ok, false);
    assert.equal(parseAction(deltas.slice(0, 2).map((event) => event.delta).join("")).ok, false);
    assert.equal(parseAction(reply.text).ok, true);
    assert.equal(parseAction(reply.text).action.action, "batch");
  } finally {
    await bridge.close();
  }
});

test("a dropped live stream never fails the durable turn", async () => {
  const bridge = await startBridge({ scenario: "drop" });
  const events = [];
  try {
    const reply = await chatTurn({
      message: "list the workspace",
      newSession: true,
      settings: bridge.settings,
      pollIntervalMs: 20,
      statusTimeoutMs: 1_000,
      submitTimeoutMs: 1_000,
      timeoutMs: 10_000,
      onLiveEvent: (event) => events.push(event),
    });
    assert.equal(reply.text, FULL_ACTION);
    assert.ok(events.some((event) => event.type === "response.delta"));
  } finally {
    await bridge.close();
  }
});

test("a reconnect resumes after the last sequence without duplicating output or the turn", async () => {
  const bridge = await startBridge({ scenario: "reconnect", completeAfterPolls: 60 });
  const events = [];
  try {
    const reply = await chatTurn({
      message: "list the workspace",
      newSession: true,
      settings: bridge.settings,
      pollIntervalMs: 30,
      statusTimeoutMs: 1_000,
      submitTimeoutMs: 1_000,
      timeoutMs: 15_000,
      onLiveEvent: (event) => events.push(event),
    });

    assert.equal(reply.text, FULL_ACTION);
    assert.equal(bridge.stats().submits, 1, "streaming must never resubmit the prompt");
    assert.ok(bridge.eventConnections.length >= 2, "expected the display stream to reconnect");
    assert.equal(bridge.eventConnections[0].after, 0);
    assert.equal(bridge.eventConnections[1].after, 1);

    const seqs = events.filter((event) => event.type === "response.delta").map((event) => event.seq);
    assert.equal(new Set(seqs).size, seqs.length, `duplicate sequence numbers: ${seqs.join(",")}`);
    assert.equal(events.filter((event) => event.type === "response.delta").map((event) => event.delta).join(""), FULL_ACTION);
  } finally {
    await bridge.close();
  }
});

test("followLiveResponse stops cleanly when its signal is aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  const startedAt = Date.now();
  const task = followLiveResponse({
    origin: "http://127.0.0.1:1",
    requestId: "req_abort",
    signal: controller.signal,
    reconnectDelayMs: 1_000,
    maxReconnects: 5,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  await sleep(20);
  controller.abort();
  await task;
  assert.ok(calls <= 1);
  assert.ok(Date.now() - startedAt < 900, "abort must not wait out the reconnect delay");
});

test("streamed text is never parsed into an action by the agent loop", async () => {
  const root = tempWorkspace();
  const streamed = [];
  const actions = [];
  const replies = [FULL_ACTION, '{"action":"finish","summary":"done"}'];
  let calls = 0;
  const result = await runChatGptWebAgent({
    workspace: root,
    task: "list the workspace",
    chat: async ({ onLiveEvent }) => {
      calls += 1;
      for (const step of calls === 1 ? PARTIAL_STEPS.slice(0, 2) : []) {
        onLiveEvent?.({ type: "response.delta", seq: streamed.length + 1, delta: step, answerLength: step.length });
        streamed.push(step);
      }
      return { text: replies.shift(), session: "conv_1" };
    },
    onEvent: (event) => {
      if (event.type === "action") actions.push(event.action);
      if (event.type === "tool") actions.push(`tool:${event.action}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.turns, 2, "streamed frames never became a model turn");
  assert.deepEqual(actions, ["batch", "tool:batch", "finish"], "only the complete durable actions are executed");
  assert.equal(streamed.join(""), '{"action":{"action":"batch",');
  assert.ok(!streamed.join("").includes('"operations"'), "the stream stopped before the partial JSON was complete");
});
