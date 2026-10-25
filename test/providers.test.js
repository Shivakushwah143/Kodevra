import test from "node:test";
import assert from "node:assert/strict";

import {
  assessProvider,
  defaultModelFor,
  liveEngineModels,
  normalizeProvider,
  withoutApiKeyBilling,
} from "../lib/providers.js";

/** A static catalog that must not decide what a ChatGPT plan can run. */
const catalog = {
  openai: {
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    models: { "gpt-4o": {}, "gpt-4o-mini": {} },
  },
};

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("chatgpt is the same provider as openai for the engine", () => {
  assert.equal(normalizeProvider("chatgpt"), "openai");
  assert.equal(normalizeProvider("ChatGPT"), "openai");
});

test("a stored ChatGPT sign-in is reported as the plan, not as an API key", () => {
  const assessment = withEnv("OPENAI_API_KEY", undefined, () =>
    assessProvider("chatgpt", {
      catalog,
      config: null,
      authProviders: ["openai"],
      liveModels: ["gpt-5.5", "gpt-5.4-mini"],
    }),
  );

  assert.equal(assessment.ready, true);
  assert.equal(assessment.plan, "chatgpt");
  assert.equal(assessment.credential.kind, "oauth");
  assert.match(assessment.credential.source, /ChatGPT sign-in/);
  assert.deepEqual(assessment.models, ["gpt-5.5", "gpt-5.4-mini"]);
  assert.equal(assessment.defaultModel, "gpt-5.5");
  assert.equal(assessment.planSource, "engine (authenticated)");
});

test("an exported OPENAI_API_KEY is separate API billing, and says so", () => {
  const assessment = withEnv("OPENAI_API_KEY", "sk-test-not-a-real-key", () =>
    assessProvider("openai", { catalog, config: null, authProviders: [], liveModels: ["gpt-5.5"] }),
  );

  assert.equal(assessment.ready, true);
  assert.equal(assessment.plan, "api-key");
  assert.equal(assessment.credential.kind, "api-key");
  assert.equal(assessment.credential.source, "env OPENAI_API_KEY");
});

test("the ChatGPT plan model list never comes from the static catalog", () => {
  const assessment = withEnv("OPENAI_API_KEY", undefined, () =>
    assessProvider("openai", { catalog, config: null, authProviders: ["openai"], engine: null }),
  );

  assert.equal(assessment.ready, false);
  assert.equal(assessment.state, "no models");
  assert.deepEqual(assessment.models, []);
  assert.equal(assessment.defaultModel, null);
  assert.match(assessment.hint, /opencode models --refresh/);
});

test("no credential means needs auth, not a guessed model", () => {
  const assessment = withEnv("OPENAI_API_KEY", undefined, () =>
    assessProvider("openai", { catalog, config: null, authProviders: [], liveModels: [] }),
  );

  assert.equal(assessment.ready, false);
  assert.equal(assessment.state, "needs auth");
  assert.equal(assessment.plan, null);
  assert.match(assessment.hint, /kodevra auth login openai/);
});

test("a live authenticated list wins over a preset preference", () => {
  assert.equal(defaultModelFor("openai", catalog), "gpt-4o");
  assert.equal(defaultModelFor("openai", catalog, ["gpt-5.4-mini", "gpt-5.5"]), "gpt-5.4-mini");
});

test("liveEngineModels reports no answer when the engine cannot be run", () => {
  assert.equal(liveEngineModels(null, "openai"), null);
});

test("ChatGPT-plan runs drop the API key; every other selection keeps it", () => {
  const env = { OPENAI_API_KEY: "sk-not-printed", PATH: "/bin" };

  const plan = withoutApiKeyBilling(env, { provider: "openai", plan: "chatgpt" });
  assert.equal(plan.stripped, true);
  assert.equal("OPENAI_API_KEY" in plan.env, false);
  assert.equal(plan.env.PATH, "/bin");
  assert.equal(env.OPENAI_API_KEY, "sk-not-printed", "the caller's env is not mutated");

  const key = withoutApiKeyBilling(env, { provider: "openai", plan: "api-key" });
  assert.equal(key.stripped, false);
  assert.equal(key.env.OPENAI_API_KEY, "sk-not-printed");

  const local = withoutApiKeyBilling(env, { provider: "freedeepseek", plan: null });
  assert.equal(local.stripped, false);

  const nothingToStrip = withoutApiKeyBilling({ PATH: "/bin" }, { provider: "openai", plan: "chatgpt" });
  assert.equal(nothingToStrip.stripped, false);
});
