import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { providerEntry, readConfig, splitModel } from "./config.js";
import { probeDocker } from "./docker-executor.js";
import { findExecutable } from "./executable.js";
import { harnessStatus, normalizeHarness } from "./harness.js";
import { PRESET_KEYS, assessProvider } from "./providers.js";

// Re-exported for the callers that already import it from diagnostics.
export { findExecutable };

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

function providerLabel(provider) {
  return provider === "openai" ? "OpenAI" : provider;
}

/**
 * The Codex configuration Codex itself would use. Only reached when a caller
 * did not already pass the adapter's resolved target.
 */
function configuredCodexTarget(config) {
  return {
    providerId: null,
    provider: config?.provider || "openai",
    model: config?.model || null,
    modelLabel: config?.model || "codex default",
    source: "codex config",
    note: null,
  };
}

/**
 * Startup diagnostics for the *selected* configuration.
 *
 * `purpose: "run"` keeps only the checks needed to launch safely, and reuses the
 * Codex status the run path already resolved. `purpose: "doctor"` is the
 * comprehensive report. Provider and sandbox routing always follow the
 * effective execution: an explicit OpenAI run never probes the proxy named in
 * Codex's config, and a native Codex run never requires Docker.
 *
 * `probes` is a test seam; production callers use the real network and Docker
 * probes.
 */
export async function runDiagnostics({
  workspace,
  model,
  harness = "opencode",
  codexStatus = null,
  codexTarget = null,
  executor = "host",
  config: configOverride = null,
  engine: engineOverride = null,
  purpose = "doctor",
  probes = {},
} = {}) {
  const checks = [];
  const add = (label, result, hint, fatal = true) =>
    checks.push({ label, ok: result.ok, detail: result.detail, hint, fatal });

  const probeProxy = probes.proxy ?? checkProxy;
  const probeDockerFn = probes.docker ?? probeDocker;
  const config = configOverride ?? readConfig();
  const selected = normalizeHarness(harness);
  const isRun = purpose === "run";
  const dockerProbe = () =>
    process.env.KODEVRA_SKIP_DOCKER_PROBE === "1" ? { ok: true, detail: "probe skipped", hint: null } : probeDockerFn();

  if (!isRun) {
    const major = Number(process.versions.node.split(".")[0]);
    add("node", { ok: major >= 20, detail: `v${process.versions.node}` }, "Install Node.js 20 or newer.");
  }

  // Codex has its own install, credentials and provider configuration. Checking
  // OpenCode's provider store here would report the wrong system as ready.
  if (selected === "codex") {
    // The run path resolved this already; a second probe would spawn
    // `codex --version` and `codex login status` again for no new information.
    const status = codexStatus ?? harnessStatus("codex");
    add(
      "engine",
      {
        ok: status.available,
        detail: status.available ? `codex ${status.version || "unknown"} · ${status.source}` : status.detail,
      },
      status.hint,
    );

    // One source of truth: the target the adapter will pass to `codex exec`.
    const target = codexTarget ?? configuredCodexTarget(status.config);
    const providerId = target.provider ?? status.config?.provider ?? "openai";
    const modelId = target.model ?? status.config?.model ?? null;
    const openai = providerId === "openai";

    // A custom Codex provider can satisfy codexAuth while an explicit OpenAI
    // run still has no ChatGPT credential; report the credential that run uses.
    const auth = status.auth;
    const authOk = openai
      ? ["chatgpt", "api-key", "stored"].includes(auth.state)
      : Boolean(auth.ok);
    const authDetail = openai
      ? auth.state === "chatgpt"
        ? "ChatGPT sign-in"
        : auth.state === "api-key"
          ? "API key stored by codex login"
          : auth.state === "stored"
            ? "auth.json present (contents were not read)"
            : `no ChatGPT sign-in (${auth.detail})`
      : auth.detail;
    add("auth", { ok: authOk, detail: authDetail }, auth.hint || "Sign in to Codex once: codex login");

    add(
      "model/provider",
      { ok: Boolean(providerId), detail: `${providerLabel(providerId)} / ${modelId || "codex default"}` },
      target.note || "",
    );

    if (!isRun) {
      add(
        "codex config",
        {
          ok: !status.config.error,
          detail: status.config.exists
            ? `${status.config.file} · ${status.config.provider || "openai"}/${status.config.model || "default"}`
            : `${status.config.file} not present · Codex built-in defaults`,
        },
        "Codex reads its own config.toml; Kodevra never rewrites it.",
        false,
      );
    }

    // Only a provider whose endpoint Kodevra knows can be probed, and only the
    // effective provider counts. OpenAI has no local baseURL, so an explicit
    // OpenAI run never touches the proxy named in Codex's config.
    const baseURL = providerEntry(config.data, providerId)?.options?.baseURL;
    if (baseURL) {
      add(
        "proxy",
        await probeProxy(baseURL, modelId || ""),
        "Start the local model proxy that backs this Codex provider, then re-run kodevra doctor.",
      );
    }

    if (process.platform === "win32") {
      const elevated = String(status.config.windowsSandbox || "").toLowerCase() === "elevated";
      add(
        "codex sandbox",
        {
          ok: elevated,
          detail: elevated
            ? "[windows] sandbox = elevated"
            : `[windows] sandbox = ${status.config.windowsSandbox || "unset"} · shell tools are blocked by the default policy`,
        },
        'Set [windows] sandbox = "elevated" in codex config.toml, then re-run. This is Codex\'s own setting.',
        false,
      );
    }

    // Docker is a verification executor, not a requirement of Codex's sandbox.
    // It is checked only when this invocation will actually run project code in
    // it; otherwise the native Codex sandbox is the whole story.
    let docker = null;
    if (String(executor).toLowerCase() === "docker") {
      docker = dockerProbe();
      add("docker", docker, docker.hint || "", true);
    }

    if (!isRun) add("workspace", checkWorkspace(workspace), "Choose an existing writable directory: kodevra <path>");

    return {
      checks,
      config: null,
      engine: null,
      model,
      harness: selected,
      assessment: null,
      docker,
      failed: checks.filter((check) => !check.ok && check.fatal).length,
    };
  }

  const engine = engineOverride ?? findExecutable("opencode");
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

  if (!config.exists) {
    add("config", { ok: false, detail: `missing ${config.file}` }, "Run: kodevra init");
  } else if (config.error) {
    add("config", { ok: false, detail: `invalid JSON in ${config.file}: ${config.error}` }, "Fix the JSON or re-run kodevra init");
  } else {
    add("config", { ok: true, detail: config.file }, "");
  }

  const { provider, model: modelId } = splitModel(model);
  // The engine answers which models this account may actually run; a provider
  // with no credential has no entry there.
  const assessment = assessProvider(provider, { config: config.data, engine });
  const known = assessment.available;

  add(
    "provider",
    known
      ? { ok: true, detail: `${assessment.label}${assessment.configured ? "" : " (engine built-in)"}` }
      : { ok: false, detail: `unknown provider "${provider}"` },
    `Choose a provider: ${PRESET_KEYS.join(", ")}`,
  );

  if (assessment.models.length) {
    const inList = assessment.models.includes(modelId);
    add(
      "model",
      { ok: inList, detail: inList ? modelId : `"${modelId}" is not a ${provider} model` },
      `Use ${provider}/${assessment.models[0]}`,
    );
  } else {
    add(
      "model",
      { ok: true, detail: `${modelId} (runtime)` },
      "",
      false,
    );
  }

  if (!known) {
    add("auth", { ok: false, detail: `no credentials for "${provider}"` }, assessment.hint);
  } else if (assessment.kind === "local") {
    const baseURL = providerEntry(config.data, provider)?.options?.baseURL;
    add(
      "auth",
      assessment.configured
        ? { ok: true, detail: "local proxy, no credentials required" }
        : { ok: false, detail: `provider "${provider}" is not configured` },
      "Run: kodevra init",
    );
    add(
      "proxy",
      baseURL ? await probeProxy(baseURL, modelId) : { ok: false, detail: "skipped: no baseURL" },
      "Start the FreeDeepseekAPI proxy, then re-run kodevra doctor.",
    );
  } else {
    add(
      "auth",
      {
        ok: assessment.credentialed,
        detail: assessment.credentialed
          ? `${assessment.credential.source}${assessment.plan ? ` (${assessment.plan} plan)` : ""}`
          : assessment.detail,
      },
      assessment.hint,
    );
  }

  // Docker is optional for OpenCode: it powers `--executor docker` and the
  // agent's sandbox_exec terminal, but Kodevra still works on the host without
  // it. OpenCode behaviour is deliberately unchanged here.
  const docker = dockerProbe();
  add("sandbox", docker, docker.hint || "", false);

  if (!isRun) add("workspace", checkWorkspace(workspace), "Choose an existing writable directory: kodevra <path>");

  return {
    checks,
    config,
    engine,
    model,
    harness: selected,
    assessment,
    docker,
    failed: checks.filter((check) => !check.ok && check.fatal).length,
  };
}
