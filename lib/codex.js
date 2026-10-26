import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findExecutable } from "./executable.js";
import { engineProviderId } from "./providers.js";

/**
 * Native adapter for the official open-source Codex CLI.
 *
 * Kodevra does not wrap Codex in another agent loop: `codex exec` owns planning,
 * tools, sandboxing and approvals. This module only
 *
 *   - finds the installed CLI and reports a broken install honestly,
 *   - checks authentication by *presence* (`codex login status` plus the auth
 *     file's existence), never by reading a token,
 *   - translates Kodevra's mode/model selection into Codex's own flags,
 *   - parses Codex's official JSONL stream into a normalised evidence record.
 *
 * Codex has its own provider configuration (`$CODEX_HOME/config.toml`) and its
 * own credential store. Kodevra never rewrites either and never translates an
 * OpenCode credential into a Codex one.
 */

const PROBE_TIMEOUT = 20_000;
const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");

let probeCache = null;
let npmRootCache;

export function clearCodexCache() {
  probeCache = null;
  npmRootCache = undefined;
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : DEFAULT_CODEX_HOME;
}

export function codexConfigFile(env = process.env) {
  return path.join(codexHome(env), "config.toml");
}

export function codexAuthFile(env = process.env) {
  return path.join(codexHome(env), "auth.json");
}

function shellQuote(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function run(command, args, { shell = false, timeout = PROBE_TIMEOUT, env } = {}) {
  // Windows CLIs are .cmd shims: Node requires a shell for them, and passing an
  // args array with shell:true is deprecated, so join the command explicitly.
  if (shell) {
    return spawnSync([command, ...args].map(shellQuote).join(" "), {
      encoding: "utf8",
      timeout,
      shell: true,
      env: env ?? process.env,
      windowsHide: true,
    });
  }
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    env: env ?? process.env,
    windowsHide: true,
  });
}

function platformPackage(platform = process.platform, arch = process.arch) {
  return `codex-${platform}-${arch}`;
}

function npmGlobalRoot() {
  if (npmRootCache !== undefined) return npmRootCache;
  // A shell string avoids Node's "args with shell" deprecation warning while
  // still finding npm.cmd on Windows.
  const result = spawnSync("npm root -g", { encoding: "utf8", timeout: 15_000, shell: true, windowsHide: true });
  const root = `${result.stdout || ""}`.trim().split(/\r?\n/).pop();
  npmRootCache = result.status === 0 && root ? root : null;
  return npmRootCache;
}

function versionOf(probe) {
  const result = run(probe.command, [...probe.prefixArgs, "--version"], { shell: probe.shell });
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const match = text.match(/codex-cli\s+([0-9][^\s]*)/i) || text.match(/\b([0-9]+\.[0-9]+\.[0-9][^\s]*)/);
  return { ok: Boolean(match) && result.status === 0, version: match ? match[1] : null, text };
}

function firstLine(text) {
  return `${text || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || "";
}

/**
 * Locate a runnable Codex CLI.
 *
 * Order: KODEVRA_CODEX_BIN / CODEX_BIN (findExecutable honours both) -> PATH ->
 * the npm global package. The npm package is exec'd through Node, so an install
 * whose platform binary is missing is reported as broken instead of surfacing a
 * confusing stack trace at run time.
 */
export function findCodex({ env = process.env, refresh = false } = {}) {
  if (!refresh && probeCache) return probeCache;

  const override = env.KODEVRA_CODEX_BIN || env.CODEX_BIN;
  if (override) {
    if (!fs.existsSync(override)) {
      probeCache = {
        ok: false,
        reason: "override-missing",
        command: null,
        prefixArgs: [],
        shell: false,
        source: "KODEVRA_CODEX_BIN",
        detail: `KODEVRA_CODEX_BIN points at ${override}, which does not exist`,
        hint: "Point KODEVRA_CODEX_BIN at a runnable codex binary, or unset it to use PATH.",
      };
      return probeCache;
    }
    const probe = { command: override, prefixArgs: [], shell: /\.(cmd|bat)$/i.test(override), source: "KODEVRA_CODEX_BIN" };
    probeCache = finishProbe(probe);
    return probeCache;
  }

  const onPath = findExecutable("codex");
  if (onPath) {
    probeCache = finishProbe({ ...onPath, prefixArgs: [], source: "PATH" });
    return probeCache;
  }

  const root = npmGlobalRoot();
  const script = root ? path.join(root, "@openai", "codex", "bin", "codex.js") : null;
  if (script && fs.existsSync(script)) {
    const vendor = path.join(root, "@openai", platformPackage());
    if (!fs.existsSync(vendor)) {
      probeCache = {
        ok: false,
        reason: "install-broken",
        command: null,
        prefixArgs: [],
        shell: false,
        source: `npm global (${script})`,
        detail: `@openai/codex is installed at ${root} but ${platformPackage()} is missing, so the CLI cannot start`,
        hint: `Reinstall Codex: npm i -g @openai/codex@latest (or point KODEVRA_CODEX_BIN at a working binary).`,
      };
      return probeCache;
    }
    probeCache = finishProbe({ command: process.execPath, prefixArgs: [script], shell: false, source: `npm global (${script})` });
    return probeCache;
  }

  probeCache = {
    ok: false,
    reason: "not-installed",
    command: null,
    prefixArgs: [],
    shell: false,
    source: "none",
    detail: "codex was not found on PATH, in KODEVRA_CODEX_BIN, or in the npm global package root",
    hint: "Install Codex CLI (npm i -g @openai/codex, or the installer from developers.openai.com/codex), then re-run.",
  };
  return probeCache;
}

function finishProbe(probe) {
  const version = versionOf(probe);
  if (version.ok) return { ...probe, ok: true, version: version.version, detail: version.text.split(/\r?\n/)[0] };
  const text = version.text;
  const broken = /Missing optional dependency/i.test(text);
  return {
    ...probe,
    ok: false,
    reason: broken ? "install-broken" : "not-runnable",
    version: null,
    detail: firstLine(text) || `${probe.command} did not report a version`,
    hint: broken
      ? "Reinstall Codex: npm i -g @openai/codex@latest (the platform binary is missing)."
      : "Check that the Codex CLI runs directly, then retry or set KODEVRA_CODEX_BIN.",
  };
}

function parseScalar(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const bare = value.split("#")[0].trim();
  return bare || null;
}

/**
 * Read only the three non-secret top-level settings Kodevra needs. The raw file
 * never leaves this function, so provider API keys in `config.toml` cannot leak
 * into a report.
 */
export function readCodexConfig(file = codexConfigFile()) {
  const out = { file, exists: false, provider: null, model: null, reasoningEffort: null, windowsSandbox: null, error: null };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  out.exists = true;

  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const nextSection = line.match(/^\[([^\]]+)\]$/);
    if (nextSection) {
      section = nextSection[1].trim();
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (section === null) {
      if (key === "model") out.model = parseScalar(value);
      else if (key === "model_provider") out.provider = parseScalar(value);
      else if (key === "model_reasoning_effort") out.reasoningEffort = parseScalar(value);
    } else if (section === "windows" && key === "sandbox") {
      out.windowsSandbox = parseScalar(value);
    }
  }
  return out;
}

/**
 * Authentication by presence and by Codex's own status command.
 *
 * `codex login status` is the supported way to ask; it prints "Logged in using
 * ChatGPT", never the credential. `auth.json` is only stat'ed - its contents are
 * never read by Kodevra.
 */
export function codexAuth(probe, { config = readCodexConfig(), env = process.env } = {}) {
  const file = codexAuthFile(env);
  let stored = false;
  try {
    stored = fs.statSync(file).isFile();
  } catch {
    stored = false;
  }
  const envNames = ["CODEX_API_KEY", "OPENAI_API_KEY"].filter((name) => Boolean(env[name]));

  let login = null;
  if (probe?.ok) {
    const args = [...(probe.prefixArgs || []), "login", "status"];
    const result = run(probe.command, args, { shell: probe.shell });
    const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (/logged in using chatgpt|signed in with chatgpt|chatgpt account/i.test(text)) {
      login = { state: "chatgpt", detail: "ChatGPT sign-in (codex login)" };
    } else if (/logged in using an api key|logged in with an api key/i.test(text)) {
      login = { state: "api-key", detail: "API key stored by codex login" };
    } else if (/not logged in|logged out|no credentials|not signed in/i.test(text)) {
      login = { state: "none", detail: "Codex reports no signed-in account" };
    } else if (text) {
      login = { state: "unknown", detail: firstLine(text) };
    }
  }

  const customProvider = config.provider && config.provider !== "openai" ? config.provider : null;

  if (login?.state === "chatgpt" || login?.state === "api-key") {
    const detail = customProvider ? `${login.detail} · codex config provider "${customProvider}"` : login.detail;
    return { ok: true, state: login.state, detail, stored, envNames, file, provider: customProvider };
  }
  if (customProvider) {
    return {
      ok: true,
      state: "provider",
      detail: `Codex config provider "${customProvider}"${login ? ` · ${login.detail}` : ""}`,
      stored,
      envNames,
      file,
      provider: customProvider,
    };
  }
  if (login?.state === "none") {
    return { ok: false, state: "none", detail: login.detail, hint: "Sign in to Codex once: codex login", stored, envNames, file };
  }
  if (stored) {
    return { ok: true, state: "stored", detail: "auth.json is present (contents were not read)", stored, envNames, file };
  }
  if (envNames.length) {
    return { ok: true, state: "api-key", detail: `env ${envNames[0]}`, stored, envNames, file };
  }
  return {
    ok: false,
    state: "none",
    detail: "no Codex credential found",
    hint: "Sign in to Codex once: codex login   (Kodevra never handles the credential)",
    stored,
    envNames,
    file,
  };
}

/**
 * The model catalog Codex itself reports, as JSON.
 *
 * `debug models --bundled` renders the catalog compiled into the installed
 * binary (version-accurate, no config, no network); plain `debug models`
 * renders the catalog that is effective for this configuration. Both are the
 * CLI's own read-only views - Kodevra never parses `config.toml` for it and
 * never writes the user's catalog.
 */
export function readCodexCatalog(probe, { bundled = false, env = process.env, timeout = PROBE_TIMEOUT } = {}) {
  if (!probe?.ok) return null;
  const args = [...(probe.prefixArgs || []), "debug", "models", ...(bundled ? ["--bundled"] : [])];
  const result = run(probe.command, args, { shell: probe.shell, env, timeout });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(`${result.stdout || ""}`);
    return Array.isArray(parsed?.models) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Which model and provider Codex will actually use.
 *
 * Codex owns `config.toml`. A Kodevra selection is applied only when it names
 * the same provider Codex is configured for; otherwise the run is honest about
 * using the Codex configuration instead of silently ignoring the flag.
 */
export function resolveCodexRun({ selection, explicitModel = false, config = readCodexConfig() } = {}) {
  const selectedProvider = selection?.provider ?? null;
  const selectedModel = selection?.model ?? null;

  if (selectedProvider === "openai") {
    return {
      providerId: "openai",
      model: explicitModel ? selectedModel : null,
      modelLabel: explicitModel ? selectedModel : "codex default",
      source: "codex ChatGPT sign-in",
      note: explicitModel ? null : "Codex picks its own default ChatGPT model; pass -m <id> to pin one.",
    };
  }

  if (config.provider && config.provider === engineProviderId(selectedProvider)) {
    const model = selectedModel || config.model;
    return {
      providerId: null,
      model,
      modelLabel: model || "codex default",
      source: "codex config",
      note: null,
    };
  }

  return {
    providerId: null,
    model: null,
    modelLabel: config.model || "codex default",
    source: "codex config",
    note: `Codex uses its own provider config (${config.provider || "openai"}${
      config.model ? `/${config.model}` : ""
    }); the selection ${selectedProvider}/${selectedModel} is not applied.`,
  };
}

/** Codex's sandbox flags mirror Kodevra's modes; `ask` has no non-interactive form. */
export function codexSandbox(mode, { interactive = false } = {}) {
  if (mode === "read-only") return "read-only";
  if (mode === "workspace-write") return "workspace-write";
  if (mode === "ask") {
    if (interactive) return null;
    const error = new Error(
      "Codex has no per-tool approval prompt in non-interactive mode, so --mode ask cannot be honoured.",
    );
    error.code = "HARNESS_MODE_UNSUPPORTED";
    error.hint = "Use --mode read-only for inspection, or --mode workspace-write to let Codex edit inside its sandbox.";
    throw error;
  }
  const error = new Error(`Unknown mode "${mode}" for Codex. Use: read-only | workspace-write`);
  error.code = "HARNESS_MODE_UNSUPPORTED";
  throw error;
}

export function buildCodexArgs({
  mode,
  workspace,
  target = {},
  prompt = null,
  interactive = false,
  json = true,
  lastMessageFile = null,
  config = [],
  extra = [],
} = {}) {
  const sandbox = codexSandbox(mode, { interactive });
  const args = interactive ? [] : ["exec"];
  if (sandbox) args.push("--sandbox", sandbox);
  if (workspace) args.push("-C", workspace);
  if (!interactive) args.push("--skip-git-repo-check");
  if (target.model) args.push("-m", target.model);
  if (target.providerId) args.push("-c", `model_provider="${target.providerId}"`);
  // Codex config overrides (`-c key=value`), e.g. the service tier. Kept before
  // the prompt so the task text stays the last argument.
  if (config.length) args.push(...config);
  if (!interactive) {
    if (json) args.push("--json");
    args.push("--color", "never");
    if (lastMessageFile) args.push("-o", lastMessageFile);
  }
  if (prompt) args.push(prompt);
  args.push(...extra);
  return args;
}

/**
 * Parse `codex exec --json` (JSONL on stdout). Non-JSON lines are Codex's own
 * logging and are kept separately so nothing is invented from them.
 *
 * `output` may also be `[{ line, at }]`, where `at` is milliseconds since the
 * process started. Those timestamps are attached to the evidence (`at_ms`) so a
 * report can say when the first command and the first edit happened without
 * inferring it from the total duration.
 */
export function parseCodexEvents(output) {
  const result = {
    threadId: null,
    agentMessages: [],
    commands: [],
    fileChanges: [],
    errors: [],
    usage: null,
    firstEventAt: null,
    turnCompleted: false,
    turnCompletedAt: null,
    turnFailed: false,
    logLines: [],
    eventCount: 0,
  };

  const rows = Array.isArray(output)
    ? output.map((row) => ({ line: String(row?.line ?? ""), at: Number.isFinite(row?.at) ? row.at : null }))
    : String(output || "")
        .split(/\r?\n/)
        .map((line) => ({ line, at: null }));

  for (const row of rows) {
    const line = row.line.trim();
    if (!line) continue;
    if (!line.startsWith("{")) {
      result.logLines.push(line);
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      result.logLines.push(line);
      continue;
    }
    result.eventCount += 1;
    if (result.firstEventAt === null) result.firstEventAt = row.at;
    const item = event.item;

    if (event.type === "thread.started") result.threadId = event.thread_id ?? null;
    else if (event.type === "turn.completed") {
      result.turnCompleted = true;
      if (Number.isFinite(row.at)) result.turnCompletedAt = row.at;
      result.usage = event.usage ?? null;
    } else if (event.type === "turn.failed") {
      result.turnFailed = true;
      const message = event.error?.message ?? event.message;
      if (message) result.errors.push(String(message));
    } else if (event.type === "error") {
      if (event.message) result.errors.push(String(event.message));
    } else if (event.type === "item.completed" && item) {
      if (item.type === "agent_message" && item.text) result.agentMessages.push(item.text);
      else if (item.type === "command_execution") {
        result.commands.push({
          command: item.command ?? null,
          exit_code: typeof item.exit_code === "number" ? item.exit_code : null,
          status: item.status ?? null,
          output: typeof item.aggregated_output === "string" ? item.aggregated_output : null,
          ...(Number.isFinite(row.at) ? { at_ms: row.at } : {}),
        });
      } else if (item.type === "file_change") {
        result.fileChanges.push({
          changes: Array.isArray(item.changes) ? item.changes : [],
          status: item.status ?? null,
          ...(Number.isFinite(row.at) ? { at_ms: row.at } : {}),
        });
      }
    }
  }

  result.lastMessage = result.agentMessages.length ? result.agentMessages[result.agentMessages.length - 1] : null;
  result.failedCommands = result.commands.filter((command) => command.exit_code !== null && command.exit_code !== 0);
  result.tokens = result.usage
    ? {
        input: result.usage.input_tokens ?? null,
        cached_input: result.usage.cached_input_tokens ?? null,
        output: result.usage.output_tokens ?? null,
        reasoning_output: result.usage.reasoning_output_tokens ?? null,
      }
    : null;
  return result;
}

/** Split a run's captured output into JSONL events and the error text to classify. */
export function codexFailureText(run, events) {
  const errors = events?.errors?.length ? events.errors.join("\n") : "";
  return [errors, run?.error, run?.output].filter(Boolean).join("\n");
}

/** Compact transcript for the terminal; the raw JSONL stays in the run log. */
export function renderCodexRun(events) {
  const lines = [];
  if (events.threadId) lines.push(`  thread  ${events.threadId}`);
  for (const command of events.commands) {
    const exit = command.exit_code === null ? "running" : `${command.exit_code}`;
    const state = command.exit_code === 0 ? `${exit}` : `${exit} failed`;
    lines.push(`  command ${state}  ${String(command.command || "").replace(/\s+/g, " ").slice(0, 120)}`);
  }
  for (const change of events.fileChanges) {
    const files = change.changes.map((entry) => entry.path || entry.file || "?").join(", ");
    lines.push(`  edit    ${files || "(no path reported)"}`);
  }
  if (events.lastMessage) {
    lines.push(`  result  ${events.lastMessage.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  for (const error of events.errors) {
    lines.push(`  error   ${error.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  if (events.tokens) {
    lines.push(
      `  tokens  in ${events.tokens.input ?? "?"} · out ${events.tokens.output ?? "?"} · reasoning ${
        events.tokens.reasoning_output ?? "?"
      }`,
    );
  }
  return lines;
}
