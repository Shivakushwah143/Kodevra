import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileIdentity, readCache, writeCache } from "./cache.js";
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
    label: "DeepSeek Web (experimental adapter)",
    kind: "local",
    preferred: [DEFAULT_MODEL_ID],
  },
  openai: {
    label: "OpenAI / ChatGPT",
    kind: "remote",
    env: ["OPENAI_API_KEY"],
    // ChatGPT plan access is an OAuth credential, not a key: the models an
    // account may run come from the engine's authenticated list, never from a
    // static catalog.
    oauth: true,
    liveModels: true,
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
      "Google discontinued consumer Gemini CLI OAuth on 18 June 2026 and prohibits personal Antigravity sessions in third-party agents, and no authorized consumer web surface remains. The surviving web-to-API adapters replay Google session cookies (__Secure-1PSID / -1PSIDTS or scraped browser cookies), which is automated access outside Google's terms and hands over account-level credentials.",
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
const ALIASES = {
  google: "google-api",
  gemini: "google-api",
  chatgpt: "openai",
  "deepseek-web": DEFAULT_PROVIDER,
};

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

/**
 * The engine's authenticated model list for one provider (`opencode models <id>`).
 *
 * OpenCode only lists models for providers that hold a credential, so this is
 * the honest answer to "what can this account actually run" - and it is the
 * only source Kodevra uses for the OpenAI/ChatGPT plan models. Returns null
 * when the engine cannot answer, and [] when it answered with nothing.
 */
const liveModelCache = new Map();
/** Ten minutes: long enough to make F2-free repeat commands fast, short enough
 * that a newly signed-in model shows up without anyone asking twice. */
export const DEFAULT_MODELS_TTL_MS = Number(process.env.KODEVRA_MODELS_TTL_MS || 600_000);

export function clearLiveModelCache() {
  liveModelCache.clear();
}

/**
 * The authenticated model list for one provider.
 *
 * `opencode models <provider>` boots the engine and takes seconds, which is the
 * single most expensive thing Kodevra asks for outside a run. The answer only
 * changes when the engine or the credential store changes, so it is cached
 * against both identities for a short window.
 */
export function liveEngineModels(engine, providerId, timeout = 20000, { ttlMs = DEFAULT_MODELS_TTL_MS } = {}) {
  if (!engine?.command) return null;
  const cacheKey = `${engine.command}::${providerId}`;
  if (liveModelCache.has(cacheKey)) return liveModelCache.get(cacheKey);

  const identity = `${engine.command}|${fileIdentity(engine.command) ?? "?"}|${fileIdentity(authFile()) ?? "?"}`;
  const cached = ttlMs > 0 ? readCache(`models-${providerId}`, { key: identity, maxAgeMs: ttlMs }) : null;
  if (Array.isArray(cached)) {
    liveModelCache.set(cacheKey, cached);
    return cached;
  }

  const result = spawnSync(engine.command, ["models", providerId], {
    encoding: "utf8",
    timeout,
    shell: engine.shell,
  });
  if (result.error || result.status !== 0) {
    liveModelCache.set(cacheKey, null);
    return null;
  }
  const prefix = `${providerId}/`;
  const ids = `${result.stdout || ""}${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  const models = [...new Set(ids)];
  liveModelCache.set(cacheKey, models);
  if (ttlMs > 0) writeCache(`models-${providerId}`, { key: identity, value: models });
  return models;
}

/** The model's real context window, straight from the engine catalog. */
export function catalogModelContext(providerId, modelId, catalog = readCatalog()) {
  return catalog?.[providerId]?.models?.[modelId]?.limit?.context ?? null;
}

export function catalogFile() {
  return path.join(os.homedir(), ".cache", "opencode", "models.json");
}

// The engine's catalog is several megabytes on a real install, so parsing it is
// not free (~120 ms here). Callers within one CLI invocation ask for the same
// file, often more than once; keep the parsed object while the file is the same
// file and still the same size and modification time.
let catalogCache = null;

/** Drop the parsed catalog; used by tests that rewrite the file. */
export function clearCatalogCache() {
  catalogCache = null;
}

/** The engine's provider catalog. Null when it is unavailable - never fatal. */
export function readCatalog() {
  const file = catalogFile();
  try {
    const stat = fs.statSync(file);
    if (catalogCache && catalogCache.file === file && catalogCache.size === stat.size && catalogCache.mtimeMs === stat.mtimeMs) {
      return catalogCache.value;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const value = parsed && typeof parsed === "object" ? parsed : null;
    catalogCache = { file, size: stat.size, mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    catalogCache = null;
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
  // Merge, so selecting a provider never drops the selected harness (and the
  // other way around). Kodevra state is additive for exactly this reason.
  const current = readState();
  const merged = { ...(current && typeof current === "object" ? current : {}), ...next };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Best available model id for a provider, taken from the engine catalog.
 * An authenticated engine list, when supplied, wins over any preset guess.
 */
export function defaultModelFor(key, catalog = readCatalog(), liveModels = null) {
  const normalized = normalizeProvider(key);
  if (normalized === LOCAL_PROVIDER) return DEFAULT_MODEL_ID;
  if (PRESETS[normalized]?.kind === "unsupported") return null;
  if (Array.isArray(liveModels)) return liveModels[0] ?? null;

  const engine = engineProviderId(normalized);
  const models = catalog?.[engine]?.models ? Object.keys(catalog[engine].models) : [];
  for (const candidate of PRESETS[normalized]?.preferred ?? []) {
    if (models.includes(candidate)) return candidate;
  }
  if (models.length) return models[0];
  return PRESETS[normalized]?.preferred?.[0] ?? null;
}

/**
 * ChatGPT-plan runs must spend the subscription, not a separately billed API
 * key. The engine prefers an exported OPENAI_API_KEY over its OAuth credential,
 * so Kodevra removes it from the engine's environment for that one run and
 * reports that it did. An API-key selection keeps its key untouched.
 */
export function withoutApiKeyBilling(env, { provider, plan } = {}) {
  if (normalizeProvider(provider) !== "openai" || plan !== "chatgpt") return { env, stripped: false };
  if (!env || !env.OPENAI_API_KEY) return { env, stripped: false };
  const next = { ...env };
  delete next.OPENAI_API_KEY;
  return { env: next, stripped: true };
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
      credential: { ok: false, kind: "none", source: "none", envNames: [] },
      plan: null,
      planSource: "static catalog",
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
  // A provider whose access is an account sign-in (ChatGPT) is described by the
  // engine's authenticated list only; a static catalog would advertise models
  // the plan cannot run.
  const live = preset?.liveModels
    ? (options.liveModels !== undefined ? options.liveModels : (liveEngineModels(options.engine, engine) ?? []))
    : null;

  let models;
  let modelSource = "static catalog";
  if (Array.isArray(live)) {
    models = live;
    modelSource = "engine (authenticated)";
  } else if (catalogEntry?.models) {
    // A provider block in the OpenCode config is a partial override (Kodevra's
    // own `init` adds exactly one capped model). Treating it as the whole
    // catalog would hide every other model the provider actually serves.
    models = [...new Set([...configModels, ...Object.keys(catalogEntry.models)])];
    modelSource = configModels.length ? "engine catalog + opencode config" : "static catalog";
  } else if (configModels.length) {
    models = configModels;
    modelSource = "opencode config";
  } else {
    models = preset?.preferred ?? [];
  }

  const envHit = envNames.find((name) => Boolean(process.env[name]));
  const authHit = authProviders.includes(engine);

  // Prefer the account sign-in for a provider that supports it: that is the
  // plan-backed path, while the env key is separate billing.
  const credentialKind = isLocal
    ? "local"
    : preset?.oauth && authHit
      ? "oauth"
      : envHit
        ? "api-key"
        : authHit
          ? "oauth"
          : "none";

  const credential = {
    ok: isLocal || credentialKind !== "none",
    kind: credentialKind,
    source:
      credentialKind === "local"
        ? "local proxy"
        : credentialKind === "oauth"
          ? preset?.oauth
            ? "ChatGPT sign-in (opencode auth)"
            : "opencode auth"
          : credentialKind === "api-key"
            ? `env ${envHit}`
            : "none",
    envNames,
  };
  const plan = key === "openai" ? (credentialKind === "oauth" ? "chatgpt" : credentialKind === "api-key" ? "api-key" : null) : null;

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
  } else if (preset?.liveModels && models.length === 0) {
    state = "no models";
    detail = `the engine lists no ${engine} models for this account`;
    hint = `Confirm the signed-in plan, then refresh: opencode models --refresh`;
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
    plan,
    planSource: modelSource,
    models,
    defaultModel: defaultModelFor(key, catalog, Array.isArray(live) ? live : null),
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
export function activeSelection({ flagModel, flagProvider, config, engine } = {}) {
  // A provider whose access is an account sign-in has no preset model list:
  // the engine's authenticated catalog decides.
  const liveFor = (provider) => {
    const normalized = normalizeProvider(provider);
    return PRESETS[normalized]?.liveModels ? liveEngineModels(engine, engineProviderId(normalized)) : null;
  };

  if (flagModel) {
    const parsed = splitModel(flagModel);
    return { provider: normalizeProvider(parsed.provider), model: parsed.model, source: "flag" };
  }
  if (flagProvider) {
    const provider = normalizeProvider(flagProvider);
    return { provider, model: defaultModelFor(provider, undefined, liveFor(provider)), source: "flag" };
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
    return { provider, model: defaultModelFor(provider, undefined, liveFor(provider)), source: "kodevra state" };
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
