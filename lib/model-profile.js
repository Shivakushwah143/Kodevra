import { readCatalog } from "./providers.js";

/**
 * Per-model settings, read from the engine's own model catalog.
 *
 * Kodevra does not guess what a model can do. The catalog already states it:
 * whether the model reasons, which reasoning-effort levels its provider accepts,
 * whether it supports tool calls (a coding agent without tools cannot edit a
 * file), whether `temperature` is accepted at all, and its real token limits.
 *
 * Two settings are derived from that:
 *
 * - **reasoning effort** is passed with OpenCode's native `--variant` flag, so
 *   the engine - not Kodevra - decides how the provider spends it. Only levels
 *   the catalog advertises are accepted.
 * - **output budget** is applied through OpenCode's model-level `limit` config.
 *   Aggregators (OpenRouter) reserve `max_tokens` up front: the catalog default
 *   for GPT-5.6 Terra is 128000 output tokens, which a small balance cannot
 *   cover, and the request is rejected before the model sees it.
 */

export const EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];

/** Providers that reserve the requested output budget up front. */
export const AGGREGATOR_PROVIDERS = new Set(["openrouter"]);

// Matches the output cap Kodevra already writes for OpenRouter's Gemini model in
// `kodevra init`, for the same reason: the reservation, not the answer, is what
// the balance has to cover.
export const DEFAULT_AGGREGATOR_OUTPUT = 4096;

/**
 * What the catalog says about one model. `known: false` means the engine has no
 * entry for it - Kodevra then refuses to invent limits or capabilities.
 */
export function modelProfile(providerId, modelId, { catalog = readCatalog() } = {}) {
  const entry = catalog?.[providerId]?.models?.[modelId] ?? null;
  if (!entry) {
    return {
      known: false,
      provider: providerId,
      model: modelId,
      name: modelId,
      reasoning: null,
      efforts: [],
      toolCall: null,
      supportsTemperature: null,
      context: null,
      output: null,
      cost: null,
    };
  }
  const efforts = (entry.reasoning_options ?? [])
    .filter((option) => option && option.type === "effort")
    .flatMap((option) => option.values ?? []);

  return {
    known: true,
    provider: providerId,
    model: modelId,
    name: entry.name ?? modelId,
    reasoning: Boolean(entry.reasoning),
    efforts: [...new Set(efforts)],
    toolCall: entry.tool_call === undefined ? null : Boolean(entry.tool_call),
    supportsTemperature: entry.temperature === undefined ? true : Boolean(entry.temperature),
    context: entry.limit?.context ?? null,
    output: entry.limit?.output ?? null,
    cost: entry.cost ?? null,
  };
}

function invalidReasoning(requested, profile) {
  const error = new Error(
    `"${requested}" is not a reasoning effort ${profile.name} accepts. Use: ${profile.efforts.join(" | ")}.`,
  );
  error.code = "INVALID_REASONING";
  error.hint = profile.efforts.length
    ? `Pick one of ${profile.efforts.join(", ")}, or drop --reasoning to use the provider default.`
    : "This model declares no reasoning effort levels; drop --reasoning.";
  return error;
}

/**
 * Resolve the reasoning effort for one run.
 *
 * With nothing requested, nothing is passed and the provider default applies -
 * Kodevra does not silently change how a model thinks. An explicit level is
 * validated against the catalog so a typo cannot quietly cost a run.
 */
export function resolveEffort(profile, requested = null) {
  const value = requested === null || requested === undefined || requested === "" ? null : String(requested).toLowerCase();
  if (value === null || value === "default") return { effort: null, source: "provider default", warning: null };

  if (!profile.known) {
    return {
      effort: value,
      source: "requested (unverified model)",
      warning: `${profile.provider}/${profile.model} is not in the engine catalog, so "${value}" was not validated.`,
    };
  }
  if (!profile.efforts.length) {
    return { effort: value, source: "requested (model declares no effort levels)", warning: null };
  }
  if (!profile.efforts.includes(value)) throw invalidReasoning(value, profile);
  return { effort: value, source: "requested", warning: null };
}

/**
 * Resolve the output-token budget for one run.
 *
 * Precedence: explicit `--output-tokens` > aggregator safety cap > no override.
 * `KODEVRA_MODEL_LIMITS=0` disables the automatic cap in one place.
 */
export function resolveOutputTokens(profile, { requested = null, env = process.env } = {}) {
  if (env.KODEVRA_MODEL_LIMITS === "0") return { output: null, source: "disabled (KODEVRA_MODEL_LIMITS=0)", note: null };

  const asked = Number(requested);
  if (Number.isFinite(asked) && asked > 0) {
    const ceiling = profile.output;
    if (ceiling && asked > ceiling) {
      return {
        output: ceiling,
        source: "requested, clamped to the catalog limit",
        note: `--output-tokens ${asked} exceeds ${profile.name}'s catalog output limit of ${ceiling}; using ${ceiling}.`,
      };
    }
    return { output: Math.round(asked), source: "requested", note: null };
  }

  if (!AGGREGATOR_PROVIDERS.has(profile.provider)) {
    return { output: null, source: "model catalog", note: null };
  }
  if (profile.output && profile.output <= DEFAULT_AGGREGATOR_OUTPUT) {
    return { output: null, source: "model catalog", note: null };
  }
  const capped = profile.output ? Math.min(DEFAULT_AGGREGATOR_OUTPUT, profile.output) : DEFAULT_AGGREGATOR_OUTPUT;
  return {
    output: capped,
    source: "aggregator cap",
    note: `${profile.provider} reserves output tokens up front; capping ${profile.model} at ${capped} so a small balance can still run it.`,
  };
}

/**
 * The smallest OpenCode config block that carries a model limit, for the
 * run-scoped overlay. Provider options, endpoints and credentials are never
 * included - `lib/permissions.js` refuses them.
 */
export function modelConfigBlock(profile, { output = null } = {}) {
  if (!output) return null;
  // OpenCode's model `limit` requires context and output together: a block with
  // only one is rejected before the model runs. Without the catalog's context
  // window there is nothing safe to write, so no block is written at all.
  if (!profile.context) return null;
  return { provider: { [profile.provider]: { models: { [profile.model]: { limit: { output, context: profile.context } } } } } };
}

/** One line of model truth for the launch panel. */
export function describeProfile(profile, { effort = null, output = null } = {}) {
  const parts = [profile.name];
  if (profile.reasoning) parts.push(effort ? `reasoning ${effort}` : "reasoning provider default");
  if (profile.toolCall === false) parts.push("no tool calls");
  if (profile.context) parts.push(`${Math.round(profile.context / 1000)}k context`);
  if (output) parts.push(`output cap ${output}`);
  return parts.join(" - ");
}
