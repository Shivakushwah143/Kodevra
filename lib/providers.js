import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, providerEntry, splitModel } from "./config.js";

/**
 * Provider discovery for Kodevra.
 *
 * The source of truth is the engine's own OpenCode catalog plus its credential
 * store. Kodevra never invents capabilities: a provider is only "ready" when the
 * engine knows it AND credentials exist. Nothing in this module writes OpenCode
 * configuration, and no secret value is ever read into output - only presence.
 */

const PRESETS = {
  [DEFAULT_PROVIDER]: {
    label: "DeepSeek (FreeDeepseekAPI)",
    kind: "local",
    preferred: [DEFAULT_MODEL_ID],
  },
  openai: {
    label: "OpenAI / ChatGPT",
    kind: "remote",
    env: ["OPENAI_API_KEY"],
    preferred: ["gpt-5", "gpt-5-mini", "gpt-4o"],
  },
  "google-api": {
    label: "Google Gemini API (AI Studio key)",
    kind: "remote",
    engineId: "google",
    env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    preferred: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  "gemini-web": {
    label: "Gemini web (session-based)",
    kind: "unsupported",
    engineId: "gemini-web",
    reason:
      "Gemini's consumer web session has no authorized API surface. Every web-to-API adapter replays Google account session cookies (__Secure-1PSID / -1PSIDTS or scraped browser cookies), which is automated access outside Google's terms and hands over account-level credentials.",
    hint: "Use kodevra auth login google-api for an official Gemini API key, or select a Gemini model through the openrouter provider.",
  },
  deepseek: {
    label: "DeepSeek (direct API)",
    kind: "remote",
    env: ["DEEPSEEK_API_KEY"],
    preferred: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  openrouter: {
    label: "OpenRouter (aggregator)",
    kind: "aggregator",
    env: ["OPENROUTER_API_KEY"],
    preferred: ["openai/gpt-5", "google/gemini-3.6-flash", "openai/gpt-5-mini"],
  },
};

export const PRESET_KEYS = Object.keys(PRESETS);
export const LOCAL_PROVIDER = DEFAULT_PROVIDER;

/** Providers Kodevra can walk a user through (see lib/auth.js). */
const KODEVRA_AUTH = new Set([DEFAULT_PROVIDER, "openai", "google-api", "gemini-web", "deepseek", "openrouter"]);

/** Kodevra naming -> Kodevra provider key. Engine ids stay untouched. */
const ALIASES = { google: "google-api", gemini: "google-api", chatgpt: "openai" };

export function normalizeProvider(key) {
  const value = String(key || "").toLowerCase();
  return ALIASES[value] || value;
}

/** Kodevra provider key -> the provider id OpenCode expects. */
export function engineProviderId(key) {
  const normalized = normalizeProvider(key);
  return PRESETS[normalized]?.engineId || normalized;
}

/** The exact `provider/model` string handed to OpenCode. */
export function engineModel(selection) {
  return `${engineProviderId(selection.provider)}/${selection.model}`;
}

/** The Gemini model Kodevra documents for the OpenRouter path. */
export const OPENROUTER_GEMINI_MODEL = "google/gemini-3.6-flash";

/** The model's real context window, straight from the engine catalog. */
export function catalogModelContext(providerId, modelId, catalog = readCatalog()) {
  return catalog?.[providerId]?.models?.[modelId]?.limit?.context ?? null;
}

export function catalogFile() {
  return path.join(os.homedir(), ".cache", "opencode", "models.json");
}

/** The engine's provider catalog. Null when it is unavailable - never fatal. */
export function readCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function authFile() {
  const base = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "opencode")
    : path.join(os.homedir(), ".local", "share", "opencode");
  return path.join(base, "auth.json");
}

/** Provider keys that hold credentials. Values are never exposed. */
export function readAuthProviders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile(), "utf8"));
    return Object.keys(parsed || {});
  } catch {
    return [];
  }
}

export function stateFile() {
  if (process.env.KODEVRA_STATE) return path.resolve(process.env.KODEVRA_STATE);
  return path.join(os.homedir(), ".kodevra", "state.json");
}

export function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeState(next) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}

/** Best available model id for a provider, taken from the engine catalog. */
export function defaultModelFor(key, catalog = readCatalog()) {
  const normalized = normalizeProvider(key);
  if (normalized === LOCAL_PROVIDER) return DEFAULT_MODEL_ID;
  if (PRESETS[normalized]?.kind === "unsupported") return null;

  const engine = engineProviderId(normalized);
  const models = catalog?.[engine]?.models ? Object.keys(catalog[engine].models) : [];
  for (const candidate of PRESETS[normalized]?.preferred ?? []) {
    if (models.includes(candidate)) return candidate;
  }
  if (models.length) return models[0];
  return PRESETS[normalized]?.preferred?.[0] ?? null;
}

/**
 * Status of one provider: whether the engine knows it, whether credentials are
 * present, and how the user should supply them if they are not.
 */
export function assessProvider(requestedKey, options = {}) {
  const key = normalizeProvider(requestedKey);
  const catalog = options.catalog === undefined ? readCatalog() : options.catalog;
  const authProviders = options.authProviders ?? readAuthProviders();
  const config = options.config ?? null;

  const engine = engineProviderId(key);
  const entry = providerEntry(config, engine);
  const catalogEntry = catalog?.[engine];
  const preset = PRESETS[key];
  const isLocal = key === LOCAL_PROVIDER;

  const label = catalogEntry?.name && key === engine ? catalogEntry.name : preset?.label || entry?.name || key;
  const configured = Boolean(entry);

  if (preset?.kind === "unsupported") {
    return {
      key,
      label: preset.label,
      kind: "unsupported",
      engineId: engine,
      configured,
      available: true,
      credentialed: false,
      credential: { ok: false, source: "none", envNames: [] },
      models: preset.preferred ?? [],
      defaultModel: null,
      ready: false,
      state: "unsupported",
      detail: preset.reason,
      hint: preset.hint,
    };
  }

  const kind = isLocal ? "local" : preset?.kind || (entry ? "custom" : catalogEntry ? "remote" : "unknown");
  const envNames = [...new Set([...(catalogEntry?.env ?? []), ...(preset?.env ?? [])])];

  const configModels = entry?.models ? Object.keys(entry.models) : [];
  const models = configModels.length
    ? configModels
    : catalogEntry?.models
      ? Object.keys(catalogEntry.models)
      : (preset?.preferred ?? []);

  const envHit = envNames.find((name) => Boolean(process.env[name]));
  const authHit = authProviders.includes(engine);

  const credential = {
    ok: isLocal || Boolean(envHit) || authHit,
    source: isLocal
      ? "local proxy"
      : envHit
        ? `env ${envHit}`
        : authHit
          ? "opencode auth"
          : "none",
    envNames,
  };

  const available = Boolean(catalogEntry) || Boolean(preset) || configured;

  let ready = false;
  let state = "unknown";
  let detail = "";
  let hint = "";

  if (!available) {
    state = "unknown";
    detail = `provider "${key}" is not known to this engine`;
    hint = `Choose a provider: ${PRESET_KEYS.join(", ")}`;
  } else if (isLocal) {
    ready = configured;
    state = configured ? "ready" : "not configured";
    detail = configured
      ? `${entry.options?.baseURL || "local proxy"}`
      : "missing from the OpenCode config";
    hint = configured ? "" : "Run: kodevra init";
  } else if (!credential.ok) {
    state = "needs auth";
    detail = envNames.length ? `no credentials (${envNames.join(" / ")})` : "no credentials";
    hint = KODEVRA_AUTH.has(key)
      ? `Run: kodevra auth login ${key}   or set ${envNames[0] || "the provider API key"}`
      : `Run: opencode auth login ${key}   or set ${envNames[0] || "the provider API key"}`;
  } else {
    ready = true;
    state = "ready";
    detail = credential.source;
  }

  return {
    key,
    label,
    kind,
    engineId: engine,
    configured,
    available,
    credentialed: credential.ok,
    credential,
    models,
    defaultModel: defaultModelFor(key, catalog),
    ready,
    state,
    detail,
    hint,
  };
}

/**
 * Which model this run uses.
 * Precedence: explicit -m > --provider > KODEVRA_MODEL > Kodevra state > OpenCode config > default.
 * Kodevra state lives in its own file, so selecting a provider never rewrites
 * OpenCode's configuration.
 */
export function activeSelection({ flagModel, flagProvider, config } = {}) {
  if (flagModel) {
    const parsed = splitModel(flagModel);
    return { provider: normalizeProvider(parsed.provider), model: parsed.model, source: "flag" };
  }
  if (flagProvider) {
    const provider = normalizeProvider(flagProvider);
    return { provider, model: defaultModelFor(provider), source: "flag" };
  }
  if (process.env.KODEVRA_MODEL) {
    const parsed = splitModel(process.env.KODEVRA_MODEL);
    return { provider: normalizeProvider(parsed.provider), model: parsed.model, source: "KODEVRA_MODEL" };
  }
  const state = readState();
  if (state?.model) {
    const value = state.model.includes("/")
      ? state.model
      : `${state.provider || DEFAULT_PROVIDER}/${state.model}`;
    const parsed = splitModel(value);
    return { provider: normalizeProvider(parsed.provider), model: parsed.model, source: "kodevra state" };
  }
  if (state?.provider) {
    const provider = normalizeProvider(state.provider);
    return { provider, model: defaultModelFor(provider), source: "kodevra state" };
  }
  if (config?.model) {
    const parsed = splitModel(config.model);
    return { provider: normalizeProvider(parsed.provider), model: parsed.model, source: "opencode config" };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL_ID, source: "kodevra default" };
}

export function fullModel(selection) {
  return `${selection.provider}/${selection.model}`;
}
