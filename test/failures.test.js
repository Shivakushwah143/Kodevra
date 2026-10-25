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
