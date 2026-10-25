import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  providerEntry,
  readConfig,
  splitModel,
} from "./config.js";

const isWindows = process.platform === "win32";

/** Resolve a CLI binary on PATH without spawning a shell. */
export function findExecutable(name) {
  const override = process.env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`];
  if (override && fs.existsSync(override)) return { command: override, shell: false };

  const pathValue = process.env.PATH || process.env.Path || "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = isWindows
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          const shell = isWindows && /\.(cmd|bat)$/i.test(candidate);
          return { command: candidate, shell };
        }
      } catch {
        // not in this directory
      }
    }
  }
  return null;
}

async function checkProxy(baseURL, modelId, timeoutMs = 4000) {
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, detail: `${url} returned HTTP ${response.status}` };
    const body = await response.json();
    const ids = Array.isArray(body.data) ? body.data.map((entry) => entry.id) : [];
    if (!ids.includes(modelId)) {
      return { ok: false, detail: `${url} does not list "${modelId}" (has: ${ids.join(", ") || "none"})` };
    }
    return { ok: true, detail: `${modelId} served by ${baseURL}` };
  } catch (error) {
    return { ok: false, detail: `${url} unreachable (${error.message})` };
  }
}

function checkWorkspace(workspace) {
  if (!fs.existsSync(workspace)) return { ok: false, detail: `workspace does not exist: ${workspace}` };
  if (!fs.statSync(workspace).isDirectory()) return { ok: false, detail: `not a directory: ${workspace}` };
  try {
    fs.accessSync(workspace, fs.constants.W_OK);
  } catch {
    return { ok: false, detail: `workspace is not writable: ${workspace}` };
  }
  return { ok: true, detail: workspace };
}

/**
 * Startup diagnostics: enough to tell the difference between "the agent is
 * broken" and "the proxy or model configuration is missing".
 */
export async function runDiagnostics({ workspace, model }) {
  const checks = [];
  const add = (label, result, hint, fatal = true) =>
    checks.push({ label, ok: result.ok, detail: result.detail, hint, fatal });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", { ok: major >= 20, detail: `v${process.versions.node}` }, "Install Node.js 20 or newer.");

  const engine = findExecutable("opencode");
  if (!engine) {
    add("engine", { ok: false, detail: "opencode not found on PATH" }, "Install OpenCode: npm i -g opencode-ai");
  } else {
    const version = spawnSync(engine.command, ["--version"], {
      encoding: "utf8",
      timeout: 20000,
      shell: engine.shell,
    });
    const out = `${version.stdout || ""}${version.stderr || ""}`.trim().split("\n")[0];
    add(
      "engine",
      { ok: Boolean(out), detail: out || "opencode did not report a version" },
      "Reinstall OpenCode: npm i -g opencode-ai",
    );
  }

  const config = readConfig();
  if (!config.exists) {
    add("config", { ok: false, detail: `missing ${config.file}` }, "Run: kodevra init");
  } else if (config.error) {
    add("config", { ok: false, detail: `invalid JSON in ${config.file}: ${config.error}` }, "Fix the JSON or re-run kodevra init");
  } else {
    add("config", { ok: true, detail: config.file }, "");
  }

  const { provider, model: modelId } = splitModel(model);
  const entry = providerEntry(config.data, provider);
  if (!entry) {
    add(
      "provider",
      { ok: false, detail: `provider "${provider}" is not configured` },
      `Run: kodevra init (adds the ${DEFAULT_PROVIDER} preset)`,
    );
    add("proxy", { ok: false, detail: "skipped: no provider configured" }, "");
  } else {
    const baseURL = entry.options?.baseURL;
    add(
      "provider",
      baseURL ? { ok: true, detail: `${provider} -> ${baseURL}` } : { ok: false, detail: `provider "${provider}" has no baseURL` },
      "Set provider.options.baseURL in the OpenCode config.",
    );
    const declared = entry.models ? Object.keys(entry.models) : [];
    add(
      "model",
      { ok: declared.includes(modelId), detail: declared.includes(modelId) ? modelId : `"${modelId}" not in ${provider}.models` },
      `Use a configured model: ${provider}/${declared[0] || DEFAULT_MODEL_ID}`,
    );
    add("proxy", baseURL ? await checkProxy(baseURL, modelId) : { ok: false, detail: "skipped: no baseURL" }, "Start the FreeDeepseekAPI proxy, then re-run kodevra doctor.");
  }

  add("workspace", checkWorkspace(workspace), `Choose an existing writable directory: kodevra <path>`);

  return { checks, config, engine, model, failed: checks.filter((check) => !check.ok && check.fatal).length };
}
