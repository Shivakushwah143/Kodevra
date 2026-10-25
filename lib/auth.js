import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PROVIDER } from "./config.js";
import { authFile, readAuthProviders } from "./providers.js";

/**
 * Kodevra never runs its own OAuth exchange, token store or key prompt.
 * Every sign-in is delegated to OpenCode, which owns the official flow and
 * writes the credential to its own store. Kodevra only checks *presence*.
 */

export const AUTH_TARGETS = {
  openai: {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    kind: "oauth",
    method: "ChatGPT Pro/Plus (browser)",
    headlessMethod: "ChatGPT Pro/Plus (headless)",
    setup: "https://chatgpt.com/",
    modelHint: null,
    summary: "Sign in with an existing ChatGPT Plus/Pro account. No API key required, and none is billed.",
  },
  "google-api": {
    id: "google",
    label: "Google Gemini API (AI Studio key)",
    kind: "api-key",
    setup: "https://aistudio.google.com/apikey",
    modelHint: "gemini-2.5-pro",
    summary: "Create a Gemini API key in Google AI Studio, then paste it into OpenCode's prompt.",
  },
  "gemini-web": {
    id: "gemini-web",
    label: "Gemini web (session-based)",
    kind: "unsupported",
    setup: "https://gemini.google.com/app",
    reason:
      "Google discontinued consumer Gemini CLI OAuth on 18 June 2026 and prohibits using personal Antigravity sessions in third-party agents, so there is no authorized web-account flow left. The remaining adapters (qutek/gemini-web-api, n0madic/go-gemini-web2api, @orcushq/gemini) replay Google session cookies (__Secure-1PSID / -1PSIDTS) or scrape them from a browser, which is automated access outside Google's terms and would require storing account-level credentials.",
    hint: "kodevra auth login google-api (official key) or a Gemini model through openrouter.",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek (direct API)",
    kind: "api-key",
    setup: "https://platform.deepseek.com/api_keys",
    modelHint: "deepseek-v4-flash",
    summary: "Paste a DeepSeek platform API key into OpenCode's prompt.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "api-key",
    setup: "https://openrouter.ai/keys",
    modelHint: "openai/gpt-5",
    summary: "Paste an OpenRouter API key into OpenCode's prompt.",
  },
  [DEFAULT_PROVIDER]: {
    id: DEFAULT_PROVIDER,
    label: "DeepSeek Web (experimental adapter)",
    kind: "adapter",
    setup: "http://127.0.0.1:9655/v1",
    modelHint: "deepseek-v4-flash",
    summary:
      "EXPERIMENTAL WEB ADAPTER - a DeepSeek Web account behind the local FreeDeepseekAPI proxy. No API key, no official vendor OAuth.",
  },
};

const ALIASES = {
  chatgpt: "openai",
  gemini: "google-api",
  google: "google-api",
  "deepseek-web": DEFAULT_PROVIDER,
  freedeepseek: DEFAULT_PROVIDER,
};

/**
 * The adapter's own sign-in helper. Kodevra runs it; the adapter writes and
 * owns the session file, and Kodevra never reads it.
 */
export function adapterInfo() {
  const root = process.env.KODEVRA_DEEPSEEK_ADAPTER
    ? path.resolve(process.env.KODEVRA_DEEPSEEK_ADAPTER)
    : path.resolve(import.meta.dirname, "..", "integrations", "FreeDeepseekAPI");
  const script = path.join(root, "scripts", "deepseek_chrome_auth.js");
  return {
    root,
    script,
    docs: path.join(root, "docs", "auth.md"),
    present: fs.existsSync(script),
  };
}

export function resolveAuthTarget(name) {
  const key = ALIASES[String(name || "").toLowerCase()] || String(name || "").toLowerCase();
  const target = AUTH_TARGETS[key];
  return target ? { ...target, key } : null;
}

/** Whether the installed engine exposes the delegation flags Kodevra relies on. */
export function loginCapabilities(engine, timeout = 20000) {
  const result = spawnSync(engine.command, ["auth", "login", "--help"], {
    encoding: "utf8",
    timeout,
    shell: engine.shell,
  });
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  return {
    provider: /--provider\b/.test(text),
    method: /--method\b/.test(text),
    detail: text.trim().split("\n")[0] || "",
  };
}

/**
 * Hand the terminal to OpenCode's own login. stdio is inherited so its prompts,
 * browser hand-off and error messages reach the user unchanged.
 */
export function delegateLogin(engine, { providerId, method }) {
  const args = ["auth", "login", "-p", providerId];
  if (method) args.push("-m", method);
  const result = spawnSync(engine.command, args, { stdio: "inherit", shell: engine.shell });
  if (result.error) return { status: 1, error: result.error.message };
  return { status: result.status ?? 1, error: null };
}

/** Presence only - the credential value is never read into Kodevra. */
export function credentialPresent(providerId) {
  return readAuthProviders().includes(providerId);
}

/**
 * Whether a stored OAuth credential is still valid, without reading the secret.
 * Only the entry's type and expiry timestamp are inspected: the engine refreshes
 * tokens itself, so Kodevra reports the state instead of attempting a refresh.
 */
export function oauthStatus(providerId, now = Date.now()) {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(authFile(), "utf8"))?.[providerId];
  } catch {
    entry = undefined;
  }
  if (!entry) return { present: false, type: null, expiresAt: null, expired: false };

  const expiresAt = Number(entry.expires) || null;
  return {
    present: true,
    type: typeof entry.type === "string" ? entry.type : null,
    expiresAt,
    expired: Boolean(expiresAt && expiresAt <= now),
  };
}

/** Human-readable lifetime of a stored OAuth credential. Never the token. */
export function describeOAuthStatus(status, now = Date.now()) {
  if (!status?.present) return "no stored credential";
  if (!status.expiresAt) return "stored credential, no expiry reported";
  const seconds = Math.round((status.expiresAt - now) / 1000);
  if (seconds <= 0) return `expired ${Math.abs(Math.round(seconds / 60))} min ago - the engine refreshes on next use`;
  if (seconds < 3600) return `expires in ${Math.max(1, Math.round(seconds / 60))} min`;
  return `expires in ${Math.max(1, Math.round(seconds / 3600))} h`;
}

export function credentialFile() {
  return authFile();
}
