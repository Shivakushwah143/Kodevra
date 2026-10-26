import test from "node:test";
import assert from "node:assert/strict";

import { classifyFailure, describeFailure } from "../lib/failures.js";

test("a dead local proxy is classified from the fact, not the log text", () => {
  const failure = classifyFailure({ output: "", status: 1, proxyReachable: false });
  assert.equal(failure.code, "PROXY_UNAVAILABLE");
  assert.equal(failure.origin, "adapter");
  assert.match(failure.action, /FreeDeepseekAPI/);
});

test("provider auth failures are classified and name the selected provider", () => {
  const failure = classifyFailure({ output: "Error: 401 Unauthorized - invalid api key", status: 1, provider: "openai" });
  assert.equal(failure.code, "AUTH_EXPIRED");
  assert.match(failure.action, /kodevra auth login openai/);
});

test("rate limits, unknown models and context exhaustion are distinct", () => {
  assert.equal(classifyFailure({ output: "429 Too Many Requests" }).code, "RATE_LIMITED");
  assert.equal(classifyFailure({ output: "ProviderModelNotFoundError: model not found" }).code, "MODEL_UNAVAILABLE");
  assert.equal(classifyFailure({ output: "maximum context length exceeded" }).code, "CONTEXT_EXHAUSTED");
});

test("a plan refusal is not mistaken for an expired credential", () => {
  const failure = classifyFailure({
    output: '403 {"error":{"message":"This model is not available with your plan"}}',
    status: 1,
    provider: "openai",
  });
  assert.equal(failure.code, "PLAN_RESTRICTED");
  assert.match(failure.action, /kodevra providers list/);
});

test("a model the ChatGPT plan does not serve is a plan limit, not a bad login", () => {
  const failure = classifyFailure({
    output: "Error: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    status: 1,
    provider: "openai",
  });
  assert.equal(failure.code, "PLAN_RESTRICTED");
  assert.match(failure.action, /Current provider: openai/);
});

test("an expired ChatGPT session names the sign-in again", () => {
  const failure = classifyFailure({ output: "Error: Token refresh failed: 401", status: 1, provider: "openai" });
  assert.equal(failure.code, "AUTH_EXPIRED");
  assert.match(failure.action, /kodevra auth login openai/);
});

test('an expired key is not answered with "sign in again"', () => {
  const failure = classifyFailure({
    output:
      '{"type":"error","error":{"name":"APIError","data":{"message":"This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key.","statusCode":401}}}',
    status: 1,
    provider: "opencode",
  });
  assert.equal(failure.code, "AUTH_EXPIRED");
  assert.match(failure.action, /Create a new key/);
  assert.match(failure.action, /does not renew an expired key/);
});

test("a rejected run config is named as an engine config failure", () => {
  const failure = classifyFailure({
    output:
      "Error: Configuration is invalid at C:\\Users\\dev\\.kodevra\\run\\opencode-1.json\n↳ Missing key provider.openrouter.models.x.limit.context",
    status: 1,
  });
  assert.equal(failure.code, "CONFIG_INVALID");
  assert.equal(failure.origin, "engine");
});

test("a balance that cannot reserve max_tokens names the output budget", () => {
  const failure = classifyFailure({
    output:
      '{"type":"error","error":{"data":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 2619.","statusCode":402}}}}',
    status: 1,
    provider: "openrouter",
  });
  assert.equal(failure.code, "RATE_LIMITED");
  assert.match(failure.action, /--output-tokens 2095/);
  assert.match(failure.message, /reserve the output budget/);
});

test("a ChatGPT usage limit stays a rate limit, not a code failure", () => {
  assert.equal(classifyFailure({ output: "usage_limit_reached", status: 1 }).code, "RATE_LIMITED");
});

test("a permission denial is reported as an unexecuted tool", () => {
  const failure = classifyFailure({ output: "permission denied by user" });
  assert.equal(failure.code, "TOOL_DENIED");
  assert.equal(failure.origin, "permission");
  assert.match(failure.message, /not executed/);
});

test("cancellation wins over any log text", () => {
  const failure = classifyFailure({ output: "some panic", status: 1, signal: "SIGINT" });
  assert.equal(failure.code, "CANCELLED");
  assert.equal(failure.origin, "user");
});

test("unrecognised output stays generic and never claims success", () => {
  const failure = classifyFailure({ output: "weird", status: 3 });
  assert.equal(failure.code, "AGENT_FAILED");
  assert.match(describeFailure(failure), /exited 3/);
});
