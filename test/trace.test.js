import test from "node:test";
import assert from "node:assert/strict";

import { createTrace } from "../lib/trace.js";

/**
 * Real lines captured from `opencode run --format json` on
 * openrouter/openai/gpt-5.6-terra. The trace must report the engine's own
 * numbers, so these payloads are used verbatim.
 */
const stepStart = '{"type":"step-start","sessionID":"ses_1","part":{"id":"prt_1","type":"step-start"}}';
const text = '{"type":"text","timestamp":1,"part":{"id":"prt_2","type":"text","text":"READY"}}';
const stepFinish =
  '{"type":"step_finish","timestamp":2,"part":{"id":"prt_3","reason":"stop","type":"step-finish","tokens":{"total":7738,"input":3,"output":5,"reasoning":0,"cache":{"write":7730,"read":0}},"cost":0.019391}}';

test("a trace keeps the tokens and cost the engine reported", () => {
  const trace = createTrace();
  trace.beginCall();
  for (const line of [stepStart, text, stepFinish]) trace.ingestLine(line);
  const metrics = trace.endCall();

  assert.equal(metrics.steps, 1);
  assert.deepEqual(metrics.tokens, { input: 3, output: 5, reasoning: 0, cache_read: 0, cache_write: 7730 });
  assert.equal(metrics.cost, 0.019391);
  assert.equal(metrics.first_text_ms !== null, true);
});

test("model text is passed through and step events become one line each", () => {
  const trace = createTrace();
  trace.beginCall();
  assert.deepEqual(trace.ingestLine(text), ["READY"]);
  const lines = trace.ingestLine(stepFinish);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /step 1 - 5 output tok - \$0\.01939/);
  trace.endCall();
});

test("tool events are counted, including failures", () => {
  const trace = createTrace();
  trace.beginCall();
  const ok = trace.ingestLine(
    '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed","title":"src/cart.js"}}}',
  );
  trace.ingestLine('{"type":"tool_use","part":{"tool":"bash","state":{"status":"error"}}}');
  const metrics = trace.endCall();

  assert.match(ok[0], /read cart\.js \(completed\)/);
  assert.equal(metrics.tool_calls, 2);
  assert.equal(metrics.tool_failures, 1);
});

test("a provider error becomes one readable line and is counted", () => {
  const trace = createTrace();
  trace.beginCall();
  const lines = trace.ingestLine(
    '{"type":"error","error":{"name":"APIError","data":{"message":"This API key has expired."}}}',
  );
  const metrics = trace.endCall();

  assert.match(lines[0], /engine error: This API key has expired\./);
  assert.equal(metrics.errors, 1);
});

test("unknown events and plain text never break the trace", () => {
  const trace = createTrace();
  trace.beginCall();
  assert.deepEqual(trace.ingestLine('{"type":"session.updated","part":{}}'), []);
  assert.deepEqual(trace.ingestLine("plain engine output"), ["plain engine output"]);
  assert.deepEqual(trace.ingestLine("{not json"), ["{not json"]);
  assert.equal(trace.endCall().steps, 0);
});

test("split lines are buffered until they are complete", () => {
  const trace = createTrace();
  trace.beginCall();
  assert.deepEqual(trace.ingestChunk('{"type":"te'), []);
  const lines = trace.ingestChunk('xt","part":{"text":"hi"}}\n');
  assert.deepEqual(lines, ["hi"]);
  trace.endCall();
});

test("per-call metrics roll up into the run summary", () => {
  const trace = createTrace();
  trace.beginCall();
  trace.ingestLine(stepFinish);
  const first = trace.endCall();

  trace.beginCall();
  trace.ingestLine(stepFinish);
  const second = trace.endCall();

  assert.equal(first.steps, 1);
  assert.equal(second.steps, 1);
  const summary = trace.summary();
  assert.equal(summary.steps, 2);
  assert.equal(summary.tokens.cache_write, 15460);
  assert.equal(Math.round(summary.cost * 1e6) / 1e6, 0.038782);
});
