import readline from "node:readline/promises";

import { color } from "./brand.js";
import { DEFAULT_PROVIDER, ensureDefaultProvider, readConfig } from "./config.js";
import { findExecutable } from "./executable.js";
import {
  assessProvider,
  normalizeProvider,
  readState,
  writeState,
} from "./providers.js";
import {
  probeBridgeState,
  resolveBridgeInstallation,
} from "./bridge-supervisor.js";

/**
 * One-time setup. It records where the optional ChatGPT bridge lives, makes the
 * shipping DeepSeek provider block available, and saves the default provider.
 * It never prints a token and never runs on a normal launch.
 */

function row(label, value, width = 16) {
  return `  ${color.dim(label.padEnd(width))}${value}`;
}

async function chooseProvider({ provider, requested, yes, interactive, input, output }) {
  if (requested || yes || !interactive) return provider;
  const known = ["chatgpt-web", DEFAULT_PROVIDER, "deepseek", "openai", "google-api", "openrouter", "gemini-web"];
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`  Default provider [${provider}] (${known.join(", ")}): `)
    ).trim();
    return normalizeProvider(answer || provider);
  } finally {
    rl.close();
  }
}

export async function runSetup({
  requestedProvider = null,
  bridgeDir = null,
  yes = false,
  interactive = process.stdin.isTTY,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const state = readState();
  let provider = normalizeProvider(requestedProvider || state?.provider || DEFAULT_PROVIDER);
  provider = await chooseProvider({ provider, requested: requestedProvider, yes, interactive, input, output });

  const engine = findExecutable("opencode");
  const config = readConfig();
  const bridge = resolveBridgeInstallation({ bridgeDir, state });
  const known = new Set([
    "chatgpt-web",
    DEFAULT_PROVIDER,
    "deepseek",
    "openai",
    "google-api",
    "openrouter",
    "gemini-web",
  ]);
  if (!known.has(provider)) {
    console.error(`\n  ${color.red(`Unknown provider "${provider}".`)} Choose: ${[...known].join(", ")}`);
    return 2;
  }

  console.log("");
  console.log(`  ${color.cyan("◆")} ${color.bold("KODEVRA SETUP")}`);
  console.log("");
  console.log(row("Workspace", process.cwd()));
  console.log(
    row(
      "Node",
      `${process.versions.node} ${Number(process.versions.node.split(".")[0]) >= 20 ? color.green("ok") : color.red("needs >=20")}`,
    ),
  );
  console.log(row("Engine", engine ? color.green("OpenCode installed") : color.yellow("OpenCode not found")));

  let configLine = config.exists ? config.file : `${config.file} (not created yet)`;
  if (config.error) configLine = `${config.file} ${color.red("invalid JSON")}`;
  console.log(row("Config", configLine));

  if (provider === "chatgpt-web" && !bridge.valid) {
    console.log("");
    console.error(`  ${color.red("chatgpt-bridge was not found.")}`);
    console.error(`  ${color.yellow("->")} ${bridgeDir ? `The path ${bridgeDir} is not a chatgpt-bridge checkout.` : "Pass it once with kodevra setup --bridge-dir <path>."}`);
    return 1;
  }

  let changedConfig = false;
  if (!config.error) {
    try {
      const ensured = ensureDefaultProvider(DEFAULT_PROVIDER);
      changedConfig = ensured.changed;
    } catch (error) {
      console.log(row("DeepSeek", `${color.yellow("config warning")} ${color.dim(error.message)}`));
    }
  }

  const currentConfig = readConfig();
  const assessment = provider === "chatgpt-web"
    ? null
    : assessProvider(provider, { config: currentConfig.data, engine });
  if (assessment && !assessment.available) {
    console.error(`\n  ${color.red(`Unknown provider "${provider}".`)}`);
    return 2;
  }
  if (assessment && !assessment.ready) {
    console.log(row("Provider", `${color.yellow(assessment.state)} ${color.dim(assessment.detail)}`));
    if (assessment.hint) console.log(row("", `${color.yellow("->")} ${assessment.hint}`));
    return 1;
  }

  const model = provider === "chatgpt-web" ? "chatgpt" : assessment?.defaultModel;
  if (!model) {
    console.error(`\n  ${color.red(`No model is available for ${provider}.`)}`);
    return 1;
  }

  const bridgeProbe = bridge.valid ? await probeBridgeState(bridge.settings) : null;
  if (bridge.valid) {
    const bridgeState = bridgeProbe?.ready
      ? `${color.green("ready")} ${color.dim(`· ${bridgeProbe.clients} browser client(s)`)}`
      : bridgeProbe?.unauthorized
        ? `${color.red("token mismatch")} ${color.dim("· run kodevra doctor")}`
        : bridgeProbe?.server
          ? `${color.yellow("no browser tab")} ${color.dim("· Kodevra opens ChatGPT on first use")}`
          : `${color.dim("not running")} ${color.dim("· Kodevra starts it on first use")}`;
    console.log(row("ChatGPT bridge", `${bridge.dir} ${color.dim("·")} ${bridgeState}`));
    console.log(row("Bridge token", bridge.token ? color.green("configured") : color.dim("generated on first start")));
    if (provider === "chatgpt-web" && bridgeProbe?.unauthorized) {
      console.error(`\n  ${color.red("The running bridge uses a different API token.")}`);
      console.error(`  ${color.yellow("->")} Close the stale bridge process, then run: kodevra doctor`);
      return 1;
    }
  } else {
    console.log(row("ChatGPT bridge", color.dim("not found (optional for DeepSeek)")));
  }

  if (provider !== "chatgpt-web") {
    console.log(
      row(
        "Provider",
        `${color.green(assessment.label)} ${color.dim(`· ${assessment.credential.source}`)}`,
      ),
    );
  }

  const nextState = {
    provider,
    model: `${provider}/${model}`,
  };
  if (bridge.valid) {
    nextState.chatgptBridge = {
      ...(state?.chatgptBridge || {}),
      dir: bridge.dir,
      dataDir: bridge.dataDir,
      envFile: bridge.envFile,
      port: bridge.port,
    };
  }
  writeState(nextState);

  console.log(row("Default", `${color.green(`${provider}/${model}`)} ${color.dim("saved to Kodevra state")}`));
  if (changedConfig) console.log(row("DeepSeek", `${color.green("provider block added")} ${color.dim("only because it was missing")}`));
  console.log("");
  console.log(`  ${color.dim("Next")}  kodevra`);
  if (provider === "chatgpt-web") {
    console.log(`  ${color.dim("")}      Kodevra starts the bridge and waits for ChatGPT on first use.`);
  }
  console.log("");
  return 0;
}
