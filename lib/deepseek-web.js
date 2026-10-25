import { DEFAULT_BASE_URL, providerEntry } from "./config.js";

/**
 * FreeDeepseekAPI is a loopback OpenAI-compatible proxy in front of a DeepSeek
 * Web account. Kodevra does not implement the adapter, does not import a
 * session and does not read `deepseek-auth.json`: it only queries the
 * adapter's documented public endpoints and reports what they answer.
 *
 * This is an EXPERIMENTAL WEB ADAPTER, not an official vendor OAuth flow.
 */

export const WEB_ADAPTER_LABEL = "EXPERIMENTAL WEB ADAPTER";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** `http://127.0.0.1:9655/v1` -> `http://127.0.0.1:9655`. */
export function proxyOrigin(baseURL = DEFAULT_BASE_URL) {
  try {
    const url = new URL(baseURL);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** The adapter must stay on this machine; a remote baseURL is refused. */
export function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function proxyBaseURL(config = null) {
  return (
    process.env.KODEVRA_DEEPSEEK_BASE_URL ||
    providerEntry(config, "freedeepseek")?.options?.baseURL ||
    DEFAULT_BASE_URL
  );
}

async function getJSON(url, timeoutMs = 5000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error.message };
  }
}

export async function readHealth(origin, timeoutMs = 5000) {
  return getJSON(`${origin}/health`, timeoutMs);
}

export async function readProxyCatalog(origin, timeoutMs = 5000) {
  const [models, capabilities, ready] = await Promise.all([
    getJSON(`${origin}/v1/models`, timeoutMs),
    getJSON(`${origin}/v1/model-capabilities`, timeoutMs),
    getJSON(`${origin}/readyz`, timeoutMs),
  ]);
  return { models, capabilities, ready };
}

/**
 * `/admin/accounts` reports `status` directly; the public `/health` summary
 * reports `ready`/`cooldown`/`busy`/`token` instead. Normalize both the same
 * way, using the adapter's own precedence:
 * no_credentials > disabled > cooldown > busy > ready.
 */
export function normalizeAccount(account) {
  if (typeof account?.status === "string") return account;
  const cooling = account.cooldown === true || Number(account.cooldown_remaining_sec) > 0;
  let status = "ready";
  if (account.token === false) status = "no_credentials";
  else if (account.enabled === false) status = "disabled";
  else if (cooling) status = "cooldown";
  else if (account.busy === true) status = "busy";
  return {
    ...account,
    status,
    cooldown_reason: account.cooldown_reason ?? null,
    cooldown_remaining_sec: Number(account.cooldown_remaining_sec) || 0,
  };
}

export function accountSummary(health) {
  const accounts = (Array.isArray(health?.accounts) ? health.accounts : []).map(normalizeAccount);
  const pick = (status) => accounts.filter((account) => account.status === status);
  const cooldowns = pick("cooldown");
  const noCredentials = pick("no_credentials");
  const ready = pick("ready");
  const busy = pick("busy");
  const disabled = pick("disabled");

  let state = "unknown";
  if (!accounts.length) state = "no accounts";
  else if (noCredentials.length) state = "session expired";
  else if (ready.length || busy.length) state = "ready";
  else if (cooldowns.length) state = "cooling down";
  else if (disabled.length) state = "paused";

  return {
    state,
    total: accounts.length,
    ready: ready.length,
    busy: busy.length,
    cooling: cooldowns.map((account) => ({
      name: account.name ?? account.id,
      reason: account.cooldown_reason ?? "cooldown",
      remainingSec: Number(account.cooldown_remaining_sec) || 0,
    })),
    noCredentials: noCredentials.map((account) => account.name ?? account.id),
    disabled: disabled.map((account) => account.name ?? account.id),
    accounts,
    modelIds: Array.isArray(health?.models) ? health.models : [],
    unsupported: Array.isArray(health?.unsupported_models) ? health.unsupported_models : [],
  };
}

/**
 * Model rows from `/v1/models` plus `/v1/model-capabilities`. Nothing is
 * inferred: an id the proxy does not list is not offered, and a capability the
 * proxy does not report is shown as unknown.
 */
export function modelRows(modelsBody, capabilitiesBody) {
  const capability = capabilitiesBody?.data && typeof capabilitiesBody.data === "object" ? capabilitiesBody.data : {};
  const models = Array.isArray(modelsBody?.data) ? modelsBody.data : [];

  return models
    .map((model) => {
      const id = String(model?.id ?? "");
      if (!id) return null;
      const entry = capability[id] ?? {};
      const flags = model.capabilities ?? {};
      const reasoning = entry.thinking_enabled ?? flags.reasoning;
      const search = entry.search_enabled ?? flags.web_search;
      const files = entry.capabilities?.files ?? flags.files;
      return {
        id,
        realModel: model.real_model ?? entry.real_model ?? null,
        thinking: typeof reasoning === "boolean" ? reasoning : null,
        search: typeof search === "boolean" ? search : null,
        files: typeof files === "boolean" ? files : null,
        supported: entry.supported === undefined ? null : Boolean(entry.supported),
        reason: entry.unavailable_reason ?? null,
      };
    })
    .filter(Boolean);
}

/** One actionable verdict for a status/catalog read. Null means all good. */
export function proxyVerdict({ origin, health, ready } = {}) {
  if (!origin) {
    return {
      code: "PROXY_UNAVAILABLE",
      message: "the configured DeepSeek Web base URL is not a valid URL",
      action: "Set options.baseURL to http://127.0.0.1:9655/v1 in the freedeepseek provider, or run: kodevra init",
    };
  }
  if (!isLoopbackOrigin(origin)) {
    return {
      code: "PROXY_NOT_LOOPBACK",
      message: `the FreedeepseekAPI proxy is configured off this machine (${origin})`,
      action: "Keep the adapter loopback-only: set options.baseURL to http://127.0.0.1:9655/v1",
    };
  }
  if (!health?.ok) {
    return {
      code: "PROXY_UNAVAILABLE",
      message: `the DeepSeek Web proxy at ${origin} is not answering${health?.error ? ` (${health.error})` : ""}`,
      action: "Start it: cd integrations/FreeDeepseekAPI && npm start   ·   then kodevra auth status deepseek-web",
    };
  }

  const summary = accountSummary(health.body);
  if (summary.state === "session expired") {
    return {
      code: "AUTH_EXPIRED",
      message: `the DeepSeek Web session has no credentials (${summary.noCredentials.join(", ")})`,
      action: "Sign in again: kodevra auth login deepseek-web",
    };
  }
  if (summary.state === "cooling down") {
    const [first] = summary.cooling;
    return {
      code: "RATE_LIMITED",
      message: `${first?.name ?? "the login"} is cooling down (${first?.reason ?? "cooldown"}, ${first?.remainingSec ?? 0}s left)`,
      action: "Wait for the cooldown; Kodevra never clears it. A second login in the adapter's pool avoids the wait.",
    };
  }
  if (ready && ready.status === 503 && summary.state !== "ready") {
    return {
      code: "AUTH_EXPIRED",
      message: "no DeepSeek Web login can serve a request right now",
      action: "Check the accounts: kodevra auth status deepseek-web",
    };
  }
  return null;
}
