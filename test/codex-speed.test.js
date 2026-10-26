import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  catalogSource,
  FAST_SERVICE_TIER,
  findModel,
  isBundledOnly,
  mergeCatalogs,
  normalizeSpeed,
  planFastSpeed,
  serviceTierIds,
  supportsPriority,
  writeCatalogFile,
} from "../lib/codex-catalog.js";
import { buildCodexArgs, readCodexCatalog } from "../lib/codex.js";
import { normalizeOutcome } from "../lib/outcome.js";

const BUNDLED = {
  models: [
    { slug: "gpt-5.6-terra", service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"] },
    { slug: "gpt-5.4-mini", service_tiers: [], additional_speed_tiers: [] },
    { slug: "gpt-5.2", service_tiers: [] },
  ],
};

const USER = {
  models: [
    { slug: "deepseek-v4-flash", display_name: "DeepSeek-V4.1-Flash" },
    { slug: "deepseek-v4-flash-thinking", display_name: "DeepSeek-V4.1-Flash (thinking)" },
  ],
};

const TARGET = { providerId: "openai", model: "gpt-5.6-terra" };

test("only default and fast are accepted, and the CLI default is default", () => {
  assert.equal(normalizeSpeed("default"), "default");
  assert.equal(normalizeSpeed("FAST"), "fast");
  assert.equal(normalizeSpeed("fastest"), null);
  assert.equal(normalizeSpeed(undefined), null, "an unset value is not silently treated as a mode");
});

test("a default run passes no service tier and no catalog at all", () => {
  const args = buildCodexArgs({ mode: "workspace-write", workspace: "/w", target: TARGET, prompt: "task" });

  assert.equal(args.some((arg) => arg.includes("service_tier")), false);
  assert.equal(args.some((arg) => arg.includes("model_catalog_json")), false);
  assert.equal(args[args.length - 1], "task", "the task text stays the last argument");
  assert.deepEqual(args.slice(0, 4), ["exec", "--sandbox", "workspace-write", "-C"]);
});

test("the tier override is placed before the prompt, after the model", () => {
  const config = ["-c", 'service_tier="priority"'];
  const args = buildCodexArgs({ mode: "workspace-write", workspace: "/w", target: TARGET, prompt: "task", config });

  assert.equal(args[args.length - 1], "task");
  assert.equal(args.indexOf('service_tier="priority"'), args.indexOf('model_provider="openai"') + 2);
  assert.ok(args.indexOf('service_tier="priority"') < args.indexOf("task"));
});

test("a fast plan for a model that advertises priority sets the tier and merges the catalog", () => {
  const plan = planFastSpeed({ model: "gpt-5.6-terra", bundled: BUNDLED, user: USER });

  assert.equal(plan.ok, true);
  assert.equal(plan.evidence.requested, "fast");
  assert.equal(plan.evidence.effective_service_tier, FAST_SERVICE_TIER);
  assert.equal(plan.evidence.model_supports_priority, true);
  assert.equal(plan.evidence.catalog_source, "bundled+user");
  assert.equal(plan.evidence.catalog_models, 5);
  assert.deepEqual(plan.config.slice(0, 2), ["-c", 'service_tier="priority"']);
  assert.equal(plan.config[2], "-c");
  assert.match(plan.config[3], /^model_catalog_json=".+models\.json"$/);

  const written = JSON.parse(fs.readFileSync(plan.evidence.catalog_file, "utf8"));
  assert.deepEqual(
    written.models.map((model) => model.slug),
    ["deepseek-v4-flash", "deepseek-v4-flash-thinking", "gpt-5.6-terra", "gpt-5.4-mini", "gpt-5.2"],
  );
  plan.cleanup();
  assert.equal(fs.existsSync(plan.evidence.catalog_file), false, "the temp catalog is removed after the run");
});

test("merging never drops a bundled model and keeps the user's order", () => {
  const merged = mergeCatalogs({ bundled: BUNDLED, user: USER });

  assert.deepEqual(merged.models.slice(0, 2).map((model) => model.slug), ["deepseek-v4-flash", "deepseek-v4-flash-thinking"]);
  for (const model of BUNDLED.models) {
    assert.ok(merged.models.some((entry) => entry.slug === model.slug), `${model.slug} was dropped`);
  }
});

test("a user catalog that only repeats bundled slugs needs no temp file", () => {
  const merged = mergeCatalogs({ bundled: BUNDLED, user: { models: [{ slug: "gpt-5.2" }] } });

  assert.equal(isBundledOnly(merged, BUNDLED), true);
  assert.equal(catalogSource({ bundled: BUNDLED, user: { models: [{ slug: "gpt-5.2" }] }, merged }), "bundled");

  const plan = planFastSpeed({ model: "gpt-5.6-terra", bundled: BUNDLED, user: { models: [{ slug: "gpt-5.2" }] } });
  assert.equal(plan.ok, true);
  assert.equal(plan.evidence.catalog_source, "bundled");
  assert.equal(plan.evidence.catalog_file, null);
  assert.deepEqual(plan.config, ["-c", 'service_tier="priority"']);
  plan.cleanup();
});

test("a model with no priority tier fails honestly instead of pretending", () => {
  const plan = planFastSpeed({ model: "gpt-5.4-mini", bundled: BUNDLED, user: USER });

  assert.equal(plan.ok, false);
  assert.equal(plan.code, "FAST_TIER_UNAVAILABLE");
  assert.match(plan.message, /gpt-5\.4-mini/);
  assert.equal(plan.config, undefined, "no config is produced for a refused fast run");
  assert.equal(plan.cleanup, undefined);
});

test("an unknown model and a missing model id are refused with the same code", () => {
  const unknown = planFastSpeed({ model: "deepseek-v4-flash", bundled: BUNDLED, user: USER });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "FAST_TIER_UNAVAILABLE");

  const missing = planFastSpeed({ model: null, bundled: BUNDLED, user: USER });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "FAST_TIER_UNAVAILABLE");
  assert.match(missing.hint, /-m openai\/gpt-5\.6-terra/);
});

test("tier detection reads Codex's own fields, not a guess", () => {
  assert.deepEqual(serviceTierIds({ service_tiers: [{ id: "priority" }], additional_speed_tiers: ["fast"] }), [
    "priority",
    "fast",
  ]);
  assert.equal(supportsPriority({ service_tiers: [{ id: "priority" }] }), true);
  assert.equal(supportsPriority({ default_service_tier: "priority" }), true);
  assert.equal(supportsPriority({ service_tiers: [{ id: "flex" }] }), false);
  assert.equal(supportsPriority(null), false);
  assert.equal(findModel(BUNDLED, "gpt-5.6-terra").slug, "gpt-5.6-terra");
});

test("the temp catalog holds model metadata only", () => {
  process.env.KODEVRA_SPEED_CANARY = "canary-secret-value";
  const plan = planFastSpeed({
    model: "gpt-5.6-terra",
    bundled: BUNDLED,
    user: { models: [{ slug: "deepseek-v4-flash", display_name: "DeepSeek" }] },
  });

  const text = fs.readFileSync(plan.evidence.catalog_file, "utf8");
  assert.equal(text.includes("canary-secret-value"), false);
  assert.deepEqual(Object.keys(JSON.parse(text)), ["models"]);
  assert.equal(/"(api_?key|token|secret|password|authorization)"/i.test(text), false);

  const mode = fs.statSync(plan.evidence.catalog_file).mode & 0o777;
  if (process.platform !== "win32") assert.equal(mode, 0o600, "the temp catalog is not world-readable");

  plan.cleanup();
  delete process.env.KODEVRA_SPEED_CANARY;
});

test("the codex catalog reader uses the CLI's own JSON output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-catalog-probe-"));
  const script = path.join(dir, "fake-codex.js");
  fs.writeFileSync(
    script,
    [
      'const args = process.argv.slice(2);',
      'if (args[0] !== "debug" || args[1] !== "models") { console.error("unexpected " + args.join(" ")); process.exit(2); }',
      'const bundled = args.includes("--bundled");',
      `process.stdout.write(JSON.stringify({ models: [{ slug: bundled ? "gpt-5.6-terra" : "deepseek-v4-flash" }] }));`,
    ].join("\n"),
    "utf8",
  );
  const probe = { ok: true, command: process.execPath, prefixArgs: [script], shell: false };

  assert.equal(readCodexCatalog(probe).models[0].slug, "deepseek-v4-flash");
  assert.equal(readCodexCatalog(probe, { bundled: true }).models[0].slug, "gpt-5.6-terra");
  assert.equal(readCodexCatalog({ ok: false }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the outcome records the requested and effective tier, and default stays null", () => {
  const fast = normalizeOutcome({
    harness: "codex",
    model: "m",
    run: { status: 0, durationMs: 1 },
    speed: {
      requested: "fast",
      effective_service_tier: "priority",
      model_supports_priority: true,
      catalog_source: "bundled+user",
      catalog_file: "C:/tmp/x/models.json",
    },
  });
  assert.deepEqual(fast.speed, {
    requested: "fast",
    effective_service_tier: "priority",
    model_supports_priority: true,
    catalog_source: "bundled+user",
  });
  assert.equal(JSON.stringify(fast).includes("models.json"), false, "the temp path is not baked into the record");

  assert.deepEqual(normalizeOutcome({ harness: "codex", model: "m", run: { status: 0, durationMs: 1 } }).speed, {
    requested: "default",
    effective_service_tier: null,
    model_supports_priority: null,
    catalog_source: null,
  });
});

test("writeCatalogFile is private, singular and idempotent on cleanup", () => {
  const written = writeCatalogFile({ models: [{ slug: "x" }] });
  assert.ok(written.file.endsWith("models.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(written.file, "utf8")), { models: [{ slug: "x" }] });
  written.cleanup();
  written.cleanup();
  assert.equal(fs.existsSync(written.dir), false);
});

test("a catalog that cannot be written refuses fast mode instead of throwing", () => {
  const previous = process.env.KODEVRA_TMPDIR;
  process.env.KODEVRA_TMPDIR = path.join(os.tmpdir(), "kodevra-not-a-directory");
  fs.writeFileSync(process.env.KODEVRA_TMPDIR, "x", "utf8");
  try {
    const plan = planFastSpeed({ model: "gpt-5.6-terra", bundled: BUNDLED, user: USER });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, "FAST_TIER_UNAVAILABLE");
    assert.match(plan.message, /could not be written/);
  } finally {
    fs.rmSync(process.env.KODEVRA_TMPDIR, { force: true });
    if (previous === undefined) delete process.env.KODEVRA_TMPDIR;
    else process.env.KODEVRA_TMPDIR = previous;
  }
});
