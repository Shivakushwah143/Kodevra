import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";

import { color } from "./brand.js";
import {
  DEFAULT_PROVIDER,
  ensureDefaultProvider,
  ensureModelLimit,
  readConfig,
} from "./config.js";
import { probeDocker } from "./docker-executor.js";
import { findExecutable } from "./doctor.js";
import {
  OPENROUTER_GEMINI_MODEL,
  PRESET_KEYS,
  assessProvider,
  catalogModelContext,
  normalizeProvider,
  writeState,
} from "./providers.js";

/**
 * First-run onboarding (FRD 8.x, developer alpha).
 *
 * It detects, then proposes; it never installs software, never asks for a
 * password or a cookie, and never writes global configuration without either an
 * explicit `kodevra init` (the consent) or an interactive yes. Provider sign-in
 * is still delegated to OpenCode.
 */

function label(text, width = 12) {
  return color.dim(text.padEnd(width));
}

function engineVersion(engine) {
  if (!engine) return null;
  const result = spawnSync(engine.command, ["--version"], {
    encoding: "utf8",
    timeout: 20_000,
    shell: engine.shell,
  });
  return `${result.stdout || result.stderr || ""}`.trim().split("\n")[0] || null;
}

export function detectSetup({ requestedProvider } = {}) {
  const engine = findExecutable("opencode");
  const config = readConfig();
  const providers = PRESET_KEYS.map((key) => assessProvider(key, { config: config.data })).sort((a, b) => {
    const rank = (row) => (row.ready ? (row.kind === "local" ? 0 : 1) : row.available ? 2 : 3);
    return rank(a) - rank(b) || a.key.localeCompare(b.key);
  });
  const docker = process.env.KODEVRA_SKIP_DOCKER_PROBE === "1"
    ? { ok: true, detail: "probe skipped", hint: null }
    : probeDocker();

  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    nodeOk: Number(process.versions.node.split(".")[0]) >= 20,
    engine,
    engineVersion: engineVersion(engine),
    config,
    providers,
    docker,
    requestedProvider: requestedProvider ? normalizeProvider(requestedProvider) : null,
  };
}

export function setupLines(report) {
  const lines = [""];
  lines.push(`  ${color.cyan("◆")} ${color.bold("KODEVRA SETUP")}`);
  lines.push("");
  lines.push(`  ${label("Platform")}${report.platform} ${report.arch} · node v${report.node} ${report.nodeOk ? color.green("ok") : color.red("needs >=20")}`);
  lines.push(
    `  ${label("Engine")}${report.engine ? `opencode ${report.engineVersion ?? "unknown"}` : color.red("not installed")}`,
  );
  lines.push(
    `  ${label("Docker")}${report.docker.ok ? color.green(report.docker.detail) : `${color.yellow("not available")} ${color.dim(`· ${report.docker.detail}`)}`}`,
  );
  lines.push(`  ${label("Config")}${report.config.exists ? report.config.file : color.dim(`${report.config.file} (not created yet)`)}`);
  lines.push("");
  lines.push(`  ${color.dim("Providers")}`);
  for (const provider of report.providers) {
    const state = provider.ready
      ? color.green(provider.state.padEnd(22))
      : color.yellow(provider.state.padEnd(22));
    const detail = provider.ready
      ? provider.credential.source
      : report.engine
        ? `kodevra auth login ${provider.key}`
        : "install OpenCode first";
    lines.push(`  ${provider.key.padEnd(14)}${state}${color.dim(detail)}`);
  }
  lines.push("");
  return lines;
}

async function ask(question, { fallback, input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`  ${question} `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

/** Interactive choice, defaulting to the proven local provider. */
export async function chooseProvider({ report, requested, yes = false, interactive = process.stdin.isTTY }) {
  const known = report.providers.map((provider) => provider.key);
  if (requested) {
    const key = normalizeProvider(requested);
    if (!known.includes(key)) throw new Error(`Unknown provider "${requested}". Known providers: ${known.join(", ")}`);
    return key;
  }
  if (yes || !interactive) return DEFAULT_PROVIDER;

  const answer = await ask(`Provider for future runs [${DEFAULT_PROVIDER}] (${known.join(", ")}):`, {
    fallback: DEFAULT_PROVIDER,
  });
  const key = normalizeProvider(answer);
  if (!known.includes(key)) throw new Error(`Unknown provider "${answer}". Known providers: ${known.join(", ")}`);
  return key;
}

/**
 * Apply the safe defaults. `kodevra init` already is the developer's explicit
 * request, but interactive runs still show exactly what will be written first.
 */
export async function runInit({
  requestedProvider = null,
  yes = false,
  interactive = process.stdin.isTTY,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const report = detectSetup({ requestedProvider });
  for (const line of setupLines(report)) console.log(line);

  if (!report.nodeOk) {
    console.error(`  ${color.red("Node.js 20 or newer is required.")} Install it, then re-run kodevra init.`);
    return { ok: false, report };
  }
  if (!report.engine) {
    console.error(`  ${color.red("OpenCode is not installed.")} Kodevra drives OpenCode; install it with:`);
    console.error(`  ${color.dim("npm i -g opencode-ai")} ${color.dim("(Kodevra will not install it for you)")}`);
    return { ok: false, report };
  }

  const provider = await chooseProvider({ report, requested: requestedProvider, yes, interactive });

  const changes = [];
  changes.push(`add the ${DEFAULT_PROVIDER} provider block to ${report.config.file} when it is missing`);
  changes.push(`cap openrouter/${OPENROUTER_GEMINI_MODEL} at 4096 output tokens`);
  if (provider !== DEFAULT_PROVIDER) changes.push(`select ${provider} for future Kodevra runs (Kodevra state only)`);

  console.log(`  ${color.bold("Plan")}`);
  for (const change of changes) console.log(`  ${color.dim("-")} ${change}`);
  console.log("");

  if (!yes && interactive) {
    const answer = (await ask("Apply these changes? [Y/n]", { fallback: "y", input, output })).toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log(`  ${color.yellow("cancelled")} nothing was written.`);
      return { ok: false, cancelled: true, report };
    }
  }

  const providerResult = ensureDefaultProvider(DEFAULT_PROVIDER);
  const limit = ensureModelLimit({
    providerId: "openrouter",
    modelId: OPENROUTER_GEMINI_MODEL,
    output: 4096,
    context: catalogModelContext("openrouter", OPENROUTER_GEMINI_MODEL) ?? 1048576,
  });

  for (const [what, result] of [
    [DEFAULT_PROVIDER, providerResult],
    ["openrouter limit", limit],
  ]) {
    if (result.changed) {
      console.log(`  ${color.green("written")} ${what} ${color.dim("->")} ${result.file}`);
      if (result.backup) console.log(`  ${label("backup")}${color.dim(result.backup)}`);
    } else {
      console.log(`  ${color.dim(`unchanged ${what}`)} ${color.dim("(existing settings were preserved)")}`);
    }
  }

  let selected = null;
  if (provider !== DEFAULT_PROVIDER) {
    const assessment = report.providers.find((row) => row.key === provider);
    if (assessment?.ready) {
      const model = assessment.defaultModel;
      if (model) {
        writeState({ provider, model: `${provider}/${model}` });
        selected = `${provider}/${model}`;
        console.log(`  ${color.green("selected")} ${selected} ${color.dim("saved to Kodevra state")}`);
      }
    } else {
      console.log(`  ${color.yellow(`${provider} is not ready yet`)} ${color.dim(`-> kodevra auth login ${provider}`)}`);
      console.log(`  ${color.dim("DeepSeek remains the default until that sign-in succeeds.")}`);
    }
  }

  const local = report.providers.find((row) => row.key === DEFAULT_PROVIDER);
  if (!local?.ready) {
    console.log("");
    console.log(`  ${color.yellow("DeepSeek needs its local proxy")} ${color.dim("http://127.0.0.1:9655/v1")}`);
    console.log(`  ${color.dim("Start FreeDeepseekAPI, then:")} kodevra doctor`);
  }

  const workspace = process.cwd();
  console.log("");
  console.log(`  ${label("Next")}kodevra doctor`);
  console.log(`  ${label("")}kodevra ${workerQuote(workspace)}`);
  console.log(`  ${label("")}kodevra run "fix the failing test" --verify "npm test"`);
  console.log("");

  return { ok: true, report, provider, selected };
}

function workerQuote(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}
