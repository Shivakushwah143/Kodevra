/**
 * Cross-repo probe: real bridge durable service + real Kodevra client.
 *
 * Neither side is mocked. The bridge's DurableRequestService runs behind its real
 * express app, and Kodevra's chatTurn speaks to it over loopback HTTP. This is the
 * check that catches protocol drift (field names, status words, error codes) which
 * a hand-written fake on one side would hide.
 *
 * Run from the bridge checkout so its dependencies resolve:
 *   node "C:/Users/shiva kushwah/Desktop/Kodevra/.probe-durable/cross-repo.mjs"
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const KODEVRA = "C:/Users/shiva kushwah/Desktop/Kodevra";
const BRIDGE = "C:/Users/shiva kushwah/kodevra-provider-research/chatgpt-bridge";
const { createApp } = await import(`file:///${BRIDGE}/src/server.js`);
const { DurableRequestService } = await import(`file:///${BRIDGE}/src/kodevra/durableRequestService.js`);
const { config: bridgeConfig } = await import(`file:///${BRIDGE}/src/config.js`);
const { chatTurn } = await import(`file:///${KODEVRA}/lib/chatgpt-web.js`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ScriptedBridge {
  constructor() {
    this.calls = 0;
    this.plan = [];
  }

  health() {
    return { ok: true, clients: [], activeClient: null, needsSelection: false };
  }

  isLocalRequest() {
    return true;
  }

  cancelRequest() {}

  async sendRequest(request, callbacks = {}) {
    this.calls += 1;
    this.lastRequest = request;
    const step = this.plan.shift() || { kind: "answer", delayMs: 200, answer: "default answer" };
    if (step.kind === "hang") return await new Promise(() => {});
    if (step.kind === "fail") {
      await sleep(step.delayMs || 50);
      const error = new Error(step.message || "browser finished with an error");
      error.code = step.code || "BROWSER_ERROR";
      throw error;
    }
    callbacks.onEvent?.({ type: "prompt.delivered" });
    callbacks.onProgressUpdate?.("generating", { phase: "generating" });
    if (step.recovering) {
      callbacks.onStatus?.("resumed", {});
      await sleep(step.recovering);
    }
    await sleep(step.delayMs ?? 200);
    return {
      answer: step.answer,
      session: { id: "conv_cross" },
      url: "https://chatgpt.com/c/conv_cross",
      model: "gpt-test",
    };
  }
}

async function boot() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "kodevra-cross-"));
  const bridge = new ScriptedBridge();
  const durableRequests = new DurableRequestService({ bridge, dataDir });
  const app = createApp(bridge, null, null, null, null, null, { durableRequests });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    bridge,
    baseURL,
    settings: { baseURL, token: bridgeConfig.apiToken },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const results = [];
async function probe(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt, detail });
    console.log(`PASS  ${name} (${Date.now() - startedAt}ms) ${detail || ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - startedAt, detail: error.message });
    console.log(`FAIL  ${name} (${Date.now() - startedAt}ms)\n      ${error.message}`);
  }
}

// 1. A model turn much longer than one HTTP operation completes.
await probe("cross-repo: 1.2s turn completes while every HTTP operation stays short", async () => {
  const fx = await boot();
  try {
    fx.bridge.plan = [{ kind: "answer", delayMs: 1_200, answer: '{"action":"finish","summary":"cross"}' }];
    const stages = [];
    const startedAt = Date.now();
    const reply = await chatTurn({
      message: "cross-repo long turn",
      idempotencyKey: "cross-1",
      timeoutMs: 5_000,
      pollIntervalMs: 80,
      statusTimeoutMs: 500,
      settings: fx.settings,
      onProgress: (event) => stages.push(event.stage),
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(reply.text, '{"action":"finish","summary":"cross"}');
    assert.equal(reply.session.id, "conv_cross");
    assert.ok(elapsed >= 1_200, `turn ${elapsed}ms should outlast a single request`);
    assert.equal(fx.bridge.calls, 1);
    assert.ok(stages.includes("received"));
    return `${elapsed}ms turn, ${stages.join(">")}`;
  } finally {
    await fx.close();
  }
});

// 2. Configured deadline expires -> MODEL_RESPONSE_TIMEOUT (not BRIDGE_UNAVAILABLE).
await probe("cross-repo: deadline expiry is MODEL_RESPONSE_TIMEOUT", async () => {
  const fx = await boot();
  try {
    fx.bridge.plan = [{ kind: "answer", delayMs: 10_000, answer: "never" }];
    await assert.rejects(
      () =>
        chatTurn({
          message: "cross-repo deadline",
          idempotencyKey: "cross-2",
          timeoutMs: 700,
          pollIntervalMs: 80,
          statusTimeoutMs: 400,
          settings: fx.settings,
        }),
      (error) => {
        assert.equal(error.code, "MODEL_RESPONSE_TIMEOUT");
        assert.equal(typeof error.details.requestId, "string");
        return true;
      },
    );
    return "classified as MODEL_RESPONSE_TIMEOUT";
  } finally {
    await fx.close();
  }
});

// 3. Bridge terminal error -> MODEL_REQUEST_FAILED with the bridge code.
await probe("cross-repo: terminal browser error is MODEL_REQUEST_FAILED", async () => {
  const fx = await boot();
  try {
    fx.bridge.plan = [{ kind: "fail", code: "BROWSER_ERROR", message: "tab closed", delayMs: 100 }];
    await assert.rejects(
      () =>
        chatTurn({
          message: "cross-repo failure",
          idempotencyKey: "cross-3",
          timeoutMs: 3_000,
          pollIntervalMs: 60,
          statusTimeoutMs: 400,
          settings: fx.settings,
        }),
      (error) => {
        assert.equal(error.code, "MODEL_REQUEST_FAILED");
        assert.equal(error.details.bridgeCode, "MODEL_REQUEST_FAILED");
        return true;
      },
    );
    return "classified as MODEL_REQUEST_FAILED";
  } finally {
    await fx.close();
  }
});

// 4. A recovering browser is a wait, not an end.
await probe("cross-repo: recovering status is waited through", async () => {
  const fx = await boot();
  try {
    fx.bridge.plan = [{ kind: "answer", delayMs: 200, recovering: 500, answer: "after recovery" }];
    const stages = [];
    const reply = await chatTurn({
      message: "cross-repo recovering",
      idempotencyKey: "cross-4",
      timeoutMs: 4_000,
      pollIntervalMs: 60,
      statusTimeoutMs: 400,
      settings: fx.settings,
      onProgress: (event) => stages.push(event.stage),
    });
    assert.equal(reply.text, "after recovery");
    assert.ok(stages.includes("recovering"), `stages: ${stages.join(",")}`);
    return stages.join(">");
  } finally {
    await fx.close();
  }
});

// 5. Retried submit with the same key -> one logical turn.
await probe("cross-repo: a replayed submit yields one logical turn", async () => {
  const fx = await boot();
  try {
    fx.bridge.plan = [{ kind: "answer", delayMs: 300, answer: "once" }];
    const replyA = await chatTurn({
      message: "cross-repo replay",
      idempotencyKey: "cross-5",
      timeoutMs: 3_000,
      pollIntervalMs: 60,
      statusTimeoutMs: 400,
      settings: fx.settings,
    });
    const replyB = await chatTurn({
      message: "cross-repo replay",
      idempotencyKey: "cross-5",
      timeoutMs: 3_000,
      pollIntervalMs: 60,
      statusTimeoutMs: 400,
      settings: fx.settings,
    });
    assert.equal(replyA.text, "once");
    assert.equal(replyB.text, "once");
    assert.equal(fx.bridge.calls, 1, "the same key must not reach the browser twice");
    return "one browser turn for two client calls";
  } finally {
    await fx.close();
  }
});

// 6. Real refusal -> BRIDGE_UNAVAILABLE.
await probe("cross-repo: refused port is BRIDGE_UNAVAILABLE", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(() => resolve()));
  await assert.rejects(
    () =>
      chatTurn({
        message: "cross-repo refused",
        idempotencyKey: "cross-6",
        timeoutMs: 2_000,
        settings: { baseURL: `http://127.0.0.1:${port}/v1`, token: "" },
      }),
    (error) => {
      assert.equal(error.code, "BRIDGE_UNAVAILABLE");
      return true;
    },
  );
  return "classified as BRIDGE_UNAVAILABLE";
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} cross-repo probes passed`);
if (failed.length) process.exitCode = 1;
