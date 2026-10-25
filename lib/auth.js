import { spawnSync } from "node:child_process";

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
    modelHint: "gpt-5",
    summary: "Sign in with an existing ChatGPT Plus/Pro account. No API key required.",
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
      "There is no authorized OAuth or API flow for a Gemini consumer web session. The available adapters (qutek/gemini-web-api, n0madic/go-gemini-web2api, @orcushq/gemini) all replay Google account session cookies (__Secure-1PSID / -1PSIDTS) or scrape them from a browser, which is automated access outside Google's terms and would require Kodevra to store account-level credentials.",
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
    label: "DeepSeek (FreeDeepseekAPI)",
    kind: "local",
    setup: "http://127.0.0.1:9655/v1",
    modelHint: "deepseek-v4-flash",
    summary: "Runs against the local FreeDeepseekAPI proxy. No sign-in and no API key.",
  },
};

const ALIASES = {
  chatgpt: "openai",
  gemini: "google-api",
  google: "google-api",
  freedeepseek: DEFAULT_PROVIDER,
};

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

export function credentialFile() {
  return authFile();
}
