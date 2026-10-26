import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGGREGATOR_OUTPUT,
  describeProfile,
  modelConfigBlock,
  modelProfile,
  resolveEffort,
  resolveOutputTokens,
} from "../lib/model-profile.js";

/**
 * A catalog shaped exactly like the engine's own models.json, trimmed to what
 * these settings depend on: reasoning options, tool calling, temperature and
 * real token limits.
 */
const catalog = {
  openrouter: {
    models: {
      "openai/gpt-5.6-terra": {
        name: "GPT-5.6 Terra",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
        tool_call: true,
        temperature: false,
        limit: { context: 1050000, output: 128000 },
        cost: { input: 2, output: 12 },
      },
      "some/no-tools": { name: "No Tools", tool_call: false, limit: { output: 4096 } },
    },
  },
  opencode: {
    models: {
      "gpt-plain": { name: "Plain", reasoning: false, temperature: true, tool_call: true },
    },
  },
};

test("the catalog decides what a model can do, never a guess", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  assert.equal(profile.known, true);
  assert.equal(profile.reasoning, true);
  assert.deepEqual(profile.efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(profile.toolCall, true);
  assert.equal(profile.supportsTemperature, false);
  assert.equal(profile.context, 1050000);
  assert.equal(profile.output, 128000);
});

test("an unknown model reports nothing instead of defaulting to safe-looking values", () => {
  const profile = modelProfile("openrouter", "not-in-the-catalog", { catalog });
  assert.equal(profile.known, false);
  assert.equal(profile.efforts.length, 0);
  assert.equal(profile.toolCall, null);
  assert.equal(profile.context, null);
  assert.equal(profile.output, null);
});

test("no --reasoning leaves the provider default alone", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  const effort = resolveEffort(profile, null);
  assert.equal(effort.effort, null);
  assert.equal(effort.source, "provider default");
});

test("a requested effort must be one the catalog advertises", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  assert.equal(resolveEffort(profile, "High").effort, "high");
  assert.throws(() => resolveEffort(profile, "turbo"), (error) => error.code === "INVALID_REASONING");
  assert.match(String(resolveEffort(profile, "high").source), /requested/);
});

test("an unverified model passes the requested effort through with a warning", () => {
  const profile = modelProfile("openrouter", "unknown-model", { catalog });
  const effort = resolveEffort(profile, "high");
  assert.equal(effort.effort, "high");
  assert.match(effort.warning, /not in the engine catalog/);
});

test("an aggregator gets a bounded output budget instead of the catalog maximum", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  const plan = resolveOutputTokens(profile, { env: {} });
  assert.equal(plan.output, DEFAULT_AGGREGATOR_OUTPUT);
  assert.equal(plan.source, "aggregator cap");
  assert.match(plan.note, /reserves output tokens up front/);
});

test("a hosted model keeps its catalog limit", () => {
  const profile = modelProfile("opencode", "gpt-plain", { catalog });
  assert.equal(resolveOutputTokens(profile, { env: {} }).output, null);
});

test("an explicit output budget is kept, clamped and switchable off", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  assert.equal(resolveOutputTokens(profile, { requested: 4096, env: {} }).output, 4096);

  const clamped = resolveOutputTokens(profile, { requested: 500_000, env: {} });
  assert.equal(clamped.output, 128000);
  assert.match(clamped.note, /catalog output limit/);

  assert.equal(resolveOutputTokens(profile, { requested: 4096, env: { KODEVRA_MODEL_LIMITS: "0" } }).output, null);
  assert.equal(resolveOutputTokens(profile, { env: { KODEVRA_MODEL_LIMITS: "0" } }).output, null);
});

test("the run config carries a model limit only, never provider options", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  const block = modelConfigBlock(profile, { output: 8192 });
  assert.deepEqual(block, {
    provider: { openrouter: { models: { "openai/gpt-5.6-terra": { limit: { output: 8192, context: 1050000 } } } } },
  });
  assert.equal(modelConfigBlock(profile, { output: null }), null);

  // OpenCode rejects a limit without a context window, so no block is written
  // for a model the catalog cannot describe.
  const unknown = modelProfile("openrouter", "not-in-the-catalog", { catalog });
  assert.equal(modelConfigBlock(unknown, { output: 8192 }), null);
  assert.equal(JSON.stringify(block).includes("apiKey"), false);
  assert.equal(JSON.stringify(block).includes("baseURL"), false);
});

test("the model line reports effort, tools and limits for the developer", () => {
  const profile = modelProfile("openrouter", "openai/gpt-5.6-terra", { catalog });
  const line = describeProfile(profile, { effort: "high", output: 8192 });
  assert.match(line, /GPT-5.6 Terra/);
  assert.match(line, /reasoning high/);
  assert.match(line, /1050k context/);
  assert.match(line, /output cap 8192/);
});
