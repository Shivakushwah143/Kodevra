import test from "node:test";
import assert from "node:assert/strict";

import {
  accountSummary,
  isLoopbackOrigin,
  modelRows,
  normalizeAccount,
  proxyOrigin,
  proxyVerdict,
} from "../lib/deepseek-web.js";

test("the adapter proxy is only accepted on this machine", () => {
  assert.equal(proxyOrigin("http://127.0.0.1:9655/v1"), "http://127.0.0.1:9655");
  assert.equal(isLoopbackOrigin("http://127.0.0.1:9655"), true);
  assert.equal(isLoopbackOrigin("http://localhost:9655"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:9655"), true);
  assert.equal(isLoopbackOrigin("https://proxy.example.com"), false);
  assert.equal(isLoopbackOrigin("not a url"), false);
  assert.equal(proxyOrigin("not a url"), null);
});

test("a /health account is normalized with the adapter's own precedence", () => {
  assert.equal(normalizeAccount({ token: true, enabled: true, cooldown: false, busy: false }).status, "ready");
  assert.equal(normalizeAccount({ token: true, cooldown: true, cooldown_remaining_sec: 42 }).status, "cooldown");
  assert.equal(normalizeAccount({ token: false, cooldown: false }).status, "no_credentials");
  assert.equal(normalizeAccount({ token: true, enabled: false }).status, "disabled");
  assert.equal(normalizeAccount({ token: true, busy: true, busy_agent: "worker" }).status, "busy");
  assert.equal(normalizeAccount({ status: "cooldown" }).status, "cooldown", "an explicit status wins");
});

test("session readiness is summarized from the adapter's health payload", () => {
  const ready = accountSummary({ accounts: [{ id: "a", token: true, ready: true, cooldown: false }], models: ["deepseek-v4-flash"] });
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.modelIds, ["deepseek-v4-flash"]);

  const cooling = accountSummary({
    accounts: [{ id: "a", token: true, cooldown: true, cooldown_reason: "rate_limit", cooldown_remaining_sec: 90 }],
  });
  assert.equal(cooling.state, "cooling down");
  assert.deepEqual(cooling.cooling, [{ name: "a", reason: "rate_limit", remainingSec: 90 }]);

  const expired = accountSummary({ accounts: [{ id: "a", token: false, cooldown: false }] });
  assert.equal(expired.state, "session expired");
  assert.deepEqual(expired.noCredentials, ["a"]);

  assert.equal(accountSummary({}).state, "no accounts");
});

test("model rows come from the proxy payload and never invent ids", () => {
  const models = {
    data: [
      { id: "deepseek-v4-flash", real_model: "DeepSeek-V4.1-Flash (web search)", capabilities: { reasoning: false, web_search: true, files: true } },
      { id: "deepseek-v4-flash-thinking", real_model: "x", capabilities: { reasoning: true, web_search: true, files: true } },
    ],
  };
  const capabilities = {
    data: {
      "deepseek-v4-flash": { thinking_enabled: false, search_enabled: true, capabilities: { files: true }, supported: true },
      "deepseek-v4-flash-thinking": {
        thinking_enabled: true,
        search_enabled: false,
        capabilities: { files: true },
        supported: false,
        unavailable_reason: "temporarily unavailable",
      },
    },
  };

  const rows = modelRows(models, capabilities);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "deepseek-v4-flash",
    realModel: "DeepSeek-V4.1-Flash (web search)",
    thinking: false,
    search: true,
    files: true,
    supported: true,
    reason: null,
  });
  assert.equal(rows[1].supported, false);
  assert.equal(rows[1].reason, "temporarily unavailable");

  assert.deepEqual(modelRows({ data: [] }, null), []);
  assert.deepEqual(modelRows(null, null), []);
});

test("a stopped proxy, an off-machine proxy and a cooldown get distinct guidance", () => {
  const down = proxyVerdict({ origin: "http://127.0.0.1:9655", health: { ok: false, error: "fetch failed" } });
  assert.equal(down.code, "PROXY_UNAVAILABLE");
  assert.match(down.action, /FreeDeepseekAPI && npm start/);

  const remote = proxyVerdict({ origin: "https://proxy.example.com" });
  assert.equal(remote.code, "PROXY_NOT_LOOPBACK");
  assert.match(remote.action, /loopback/);

  const cooling = proxyVerdict({
    origin: "http://127.0.0.1:9655",
    health: {
      ok: true,
      body: { accounts: [{ id: "a", token: true, cooldown: true, cooldown_reason: "rate_limit", cooldown_remaining_sec: 120 }] },
    },
  });
  assert.equal(cooling.code, "RATE_LIMITED");
  assert.match(cooling.message, /120s left/);
  assert.match(cooling.action, /never clears it/);

  const expired = proxyVerdict({
    origin: "http://127.0.0.1:9655",
    health: { ok: true, body: { accounts: [{ id: "a", token: false, cooldown: false }] } },
  });
  assert.equal(expired.code, "AUTH_EXPIRED");
  assert.match(expired.action, /kodevra auth login deepseek-web/);

  const healthy = proxyVerdict({
    origin: "http://127.0.0.1:9655",
    health: { ok: true, body: { accounts: [{ id: "a", token: true, ready: true, cooldown: false }] } },
    ready: { ok: true },
  });
  assert.equal(healthy, null);
});
