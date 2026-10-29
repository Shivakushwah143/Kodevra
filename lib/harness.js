import { spawnSync } from "node:child_process";

import { codexAuth, findCodex, readCodexConfig } from "./codex.js";
import { findExecutable } from "./executable.js";
import { readState } from "./providers.js";

/**
 * Harness (execution engine) registry.
 *
 * A harness owns the agent loop, the tools, permissions and sessions. Kodevra
 * only launches it, enforces its own verification gate and records evidence.
 * OpenCode stays the default: Codex is opt-in until benchmarks justify a change.
 */

export const DEFAULT_HARNESS = "opencode";

export const HARNESSES = {
  opencode: {
    name: "opencode",
    label: "OpenCode",
    description: "default · sessions, permission overlay, sandbox_exec tool",
  },
  codex: {
    name: "codex",
    label: "Codex CLI",
    description: "official open-source Codex · codex exec, own sandbox and credentials",
  },
};

export const HARNESS_NAMES = Object.keys(HARNESSES);

const ALIASES = {
  "open-code": "opencode",
  opencode: "opencode",
  codex: "codex",
  "codex-cli": "codex",
};

export function normalizeHarness(value) {
  const key = String(value || "").trim().toLowerCase();
  return ALIASES[key] || key;
}

/**
 * Precedence: explicit --engine > KODEVRA_ENGINE > persisted state > default.
 * OpenCode remains the default, so an existing installation never changes
 * behaviour without an explicit choice.
 */
export function activeHarness({ flag = null, env = process.env, state } = {}) {
  const stored = state === undefined ? readState() : state;
  const requested = flag || env.KODEVRA_ENGINE || stored?.engine || DEFAULT_HARNESS;
  const name = normalizeHarness(requested);
  if (!HARNESSES[name]) {
    const error = new Error(`Unknown engine "${requested}". Use: ${HARNESS_NAMES.join(" | ")}`);
    error.code = "HARNESS_UNKNOWN";
    error.hint = `Choose one with --engine <name> or kodevra engines use <name>.`;
    throw error;
  }
  return name;
}

const versionCache = new Map();

function opencodeVersion(engine) {
  if (!engine?.command) return null;
  const key = `${engine.command}|${engine.shell ? "shell" : "direct"}`;
  if (versionCache.has(key)) return versionCache.get(key);
  const result = spawnSync(engine.command, ["--version"], { encoding: "utf8", timeout: 20_000, shell: engine.shell });
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim().split(/\r?\n/)[0];
  const version = text || null;
  versionCache.set(key, version);
  return version;
}

/**
 * Readiness for one harness. OpenCode reports engine presence (its provider
 * credentials are assessed separately); Codex reports the install, its own auth
 * and the configuration it will actually use.
 */
export function harnessStatus(name, { engine } = {}) {
  const harness = HARNESSES[normalizeHarness(name)];
  if (!harness) return null;

  if (harness.name === "codex") {
    const probe = findCodex();
    const config = readCodexConfig();
    const auth = codexAuth(probe, { config });
    return {
      name: harness.name,
      label: harness.label,
      available: probe.ok,
      version: probe.version ?? null,
      source: probe.source,
      detail: probe.ok ? `${probe.source}${probe.version ? ` · ${probe.version}` : ""}` : probe.detail,
      hint: probe.ok ? (auth.ok ? null : auth.hint) : probe.hint,
      auth,
      config,
      probe,
    };
  }

  const resolved = engine ?? findExecutable("opencode");
  const version = opencodeVersion(resolved);
  return {
    name: harness.name,
    label: harness.label,
    available: Boolean(resolved),
    version,
    source: resolved?.command ?? "PATH",
    detail: resolved ? version || resolved.command : "opencode not found on PATH",
    hint: resolved ? null : "Install OpenCode: npm i -g opencode-ai",
    auth: {
      ok: Boolean(resolved),
      state: "delegated",
      detail: "credentials delegated to OpenCode (kodevra auth status)",
      file: null,
      envNames: [],
    },
    config: null,
    probe: resolved ? { ...resolved, prefixArgs: [] } : null,
  };
}

/** One row per harness for `kodevra engines`. */
export function harnessRows(options = {}) {
  return HARNESS_NAMES.map((name) => harnessStatus(name, options));
}
