#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { banner, color, mark, PRODUCT, VERSION } from "../lib/brand.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  ensureDefaultProvider,
  ensureModelLimit,
  readConfig,
} from "../lib/config.js";
import { findExecutable, runDiagnostics } from "../lib/doctor.js";
import {
  credentialFile,
  credentialPresent,
  delegateLogin,
  loginCapabilities,
  resolveAuthTarget,
} from "../lib/auth.js";
import {
  OPENROUTER_GEMINI_MODEL,
  PRESET_KEYS,
  activeSelection,
  assessProvider,
  catalogModelContext,
  defaultModelFor,
  engineModel,
  fullModel,
  normalizeProvider,
  readAuthProviders,
  readCatalog,
  writeState,
} from "../lib/providers.js";

const USAGE = `${color.bold("Usage")}
  kodevra [path]              start the agent in a workspace (default: current directory)
  kodevra run "<task>"        run one task headlessly (tool permissions auto-approved)
  kodevra doctor              check engine, provider, model, auth, proxy and workspace
  kodevra init                apply Kodevra defaults (DeepSeek provider, Gemini output cap)
  kodevra providers           list providers, credentials and default models
  kodevra providers use <p>   select a provider for future runs (Kodevra state only)
  kodevra providers current   show the active provider/model
  kodevra auth login <p>      sign in to a provider through OpenCode's official flow
  kodevra auth status         authentication state and missing-credential guidance
  kodevra <cmd> -- <args>     forward arguments to OpenCode

${color.bold("Options")}
  -w, --workspace <path>      workspace to run in
  -p, --provider <key>        provider for this run (default: ${DEFAULT_PROVIDER})
  -m, --model <provider/model>  default: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}
      --agent <name>          OpenCode agent to use (default: build)
      --auto, --no-auto       auto-approve tool permissions
      --headless              use the headless OAuth method (openai only)
      --no-doctor             skip startup diagnostics
  -h, --help                  show this help
  -v, --version               show version

${color.bold("Provider credentials")}
  Kodevra never asks for passwords or browser cookies. Export the provider API key in your
  environment or authenticate once with OpenCode ("opencode auth login").

${color.bold("Environment")}
  KODEVRA_MODEL               override the selected model
  KODEVRA_SKIP_DOCTOR=1       skip diagnostics
  OPENCODE_BIN                path to the OpenCode executable
  OPENCODE_CONFIG             path to the OpenCode config file
  KODEVRA_STATE               path to Kodevra's provider selection state
`;

const VALUE_FLAGS = new Set(["-w", "--workspace", "-m", "--model", "-p", "--provider", "--agent"]);
const COMMANDS = new Set(["doctor", "init", "run", "help", "version", "launch", "providers", "auth"]);

function parse(argv) {
  const opts = {
    command: "launch",
    workspace: process.cwd(),
    model: null,
    provider: null,
    agent: null,
    auto: false,
    autoExplicit: false,
    doctor: true,
    help: false,
    headless: false,
    passthrough: [],
    message: [],
  };

  // Find the command/directory wherever it appears, so `kodevra -p openai doctor`
  // behaves like `kodevra doctor -p openai`.
  let commandIndex = -1;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;

    const token = arg === "provider" ? "providers" : arg;
    if (COMMANDS.has(token)) {
      opts.command = token;
      commandIndex = index;
      break;
    }
    const resolved = path.resolve(arg);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      opts.workspace = resolved;
      commandIndex = index;
      continue;
    }
    throw new Error(`Unknown command or directory: ${arg}`);
  }

  for (let index = 0; index < argv.length; index += 1) {
    if (index === commandIndex) continue;
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "-v" || arg === "--version") opts.command = "version";
    else if (arg === "-w" || arg === "--workspace") opts.workspace = path.resolve(argv[(index += 1)] || "");
    else if (arg === "-m" || arg === "--model") opts.model = argv[(index += 1)];
    else if (arg === "-p" || arg === "--provider") opts.provider = argv[(index += 1)];
    else if (arg === "--agent") opts.agent = argv[(index += 1)];
    else if (arg === "--auto") {
      opts.auto = true;
      opts.autoExplicit = true;
    } else if (arg === "--no-auto") {
      opts.auto = false;
      opts.autoExplicit = true;
    } else if (arg === "--headless") opts.headless = true;
    else if (arg === "--no-doctor") opts.doctor = false;
    else if (arg === "--") {
      opts.passthrough.push(...argv.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) opts.passthrough.push(arg);
    else opts.message.push(arg);
  }

  return opts;
}

function printChecks(checks) {
  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    console.log(`  ${mark(check.ok)}  ${color.bold(check.label.padEnd(width))}  ${color.dim(check.detail)}`);
  }
  const hints = [...new Set(checks.filter((check) => !check.ok).map((check) => check.hint))].filter(Boolean);
  if (hints.length) {
    console.log("");
    for (const hint of hints) console.log(`  ${color.yellow("->")} ${hint}`);
  }
}

function trim(text, size = 96) {
  return text.length > size ? `${text.slice(0, size - 3)}...` : text;
}

function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function changedFiles(workspace) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

function printSummary({ workspace, model, startedAt, exitCode }) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const files = changedFiles(workspace);
  console.log("");
  console.log(
    `  ${color.dim("done ")} ${exitCode === 0 ? color.green("exit 0") : color.red(`exit ${exitCode}`)} · ${seconds}s`,
  );
  console.log(`  ${color.dim("model")} ${model}`);
  if (files === null) {
    console.log(`  ${color.dim("files")} ${color.dim("workspace is not a git repository")}`);
  } else if (!files.length) {
    console.log(`  ${color.dim("files")} no file changes detected`);
  } else {
    const shown = files.slice(0, 8);
    const more = files.length > shown.length ? ` (+${files.length - shown.length} more)` : "";
    console.log(`  ${color.dim("files")} ${shown.join(", ")}${more}`);
  }
  console.log("");
}

function start(engine, args, workspace, { onExit } = {}) {
  const commandArgs = engine.shell ? [args.map(quoteForShell).join(" ")] : args;
  const child = spawn(engine.command, commandArgs, {
    cwd: workspace,
    stdio: "inherit",
    shell: engine.shell,
    env: process.env,
  });

  child.on("error", (error) => {
    console.error(`\n${color.red("Kodevra could not start the engine:")} ${error.message}`);
    console.error(`  Try: npm i -g opencode-ai`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    const exitCode = signal ? 1 : code ?? 0;
    if (onExit) onExit(exitCode);
    process.exit(exitCode);
  });
}

function buildArgs(opts, model, workspace) {
  const auto = opts.command === "run" ? (opts.autoExplicit ? opts.auto : true) : opts.auto;
  const args = opts.command === "run" ? ["run"] : [];

  if (model) args.push("-m", model);
  if (opts.agent) args.push("--agent", opts.agent);
  if (auto) args.push("--auto");

  if (opts.command === "run") {
    if (opts.message.length) {
      // Keep file work anchored to the selected workspace: models otherwise tend
      // to build absolute paths from the repository root.
      const task = `Workspace: ${workspace}. Use paths relative to this directory.\n\n${opts.message.join(" ")}`;
      args.push(task);
    }
  } else if (opts.message.length) {
    args.push(...opts.message);
  }
  args.push(...opts.passthrough);
  return args;
}

function providerRows(config) {
  const catalog = readCatalog();
  const authProviders = readAuthProviders();
  const keys = [
    ...new Set(
      [...Object.keys(config?.provider ?? {}), ...authProviders, ...PRESET_KEYS].map((key) => normalizeProvider(key)),
    ),
  ];
  const rows = keys.map((key) => assessProvider(key, { config, catalog, authProviders }));
  const rank = (row) => (row.ready ? (row.kind === "local" ? 0 : 1) : row.available ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

function printProviderTable(config, selection) {
  const rows = providerRows(config);
  const header = ["provider", "state", "credential", "default model"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => [row.key, row.state, row.credential.source, row.defaultModel ?? "-"][column].length)),
  );
  const line = (cells) => cells.map((cell, column) => String(cell).padEnd(widths[column])).join("  ");

  console.log(`  ${color.dim(line(header))}`);
  for (const row of rows) {
    const cells = line([row.key, row.state, row.credential.source, row.defaultModel ?? "-"]);
    console.log(`  ${row.ready ? cells : color.yellow(cells)}`);
  }

  const blocked = rows.filter((row) => !row.ready);
  if (blocked.length) {
    console.log("");
    for (const row of blocked) console.log(`  ${color.yellow("->")} ${row.key}: ${row.hint || row.detail}`);
  }

  console.log("");
  console.log(`  ${color.dim("active")}  ${color.green(fullModel(selection))} ${color.dim(`(${selection.source})`)}`);
  console.log(`  ${color.dim("switch")}  kodevra providers use <provider>   ·   one-off: kodevra run -p <provider> "<task>"`);
}

function providerCommand(opts, config, selection) {
  const sub = (opts.message[0] || "list").toLowerCase();

  if (sub === "list") {
    printProviderTable(config, selection);
    return;
  }

  if (sub === "current") {
    console.log(`  ${color.dim("active")}  ${color.green(fullModel(selection))} ${color.dim(`(${selection.source})`)}`);
    return;
  }

  if (sub === "use") {
    const target = opts.message[1];
    if (!target) {
      console.error(`${color.red("kodevra providers use needs a provider:")} kodevra providers use ${PRESET_KEYS.join("|")}`);
      process.exit(2);
    }
    const slash = target.indexOf("/");
    const key = normalizeProvider(slash === -1 ? target : target.slice(0, slash));
    const explicitModel = slash === -1 ? null : target.slice(slash + 1);
    const assessment = assessProvider(key, { config });

    if (!assessment.available) {
      console.error(`${color.red(`Unknown provider "${key}".`)} Known providers: ${PRESET_KEYS.join(", ")}`);
      process.exit(1);
    }
    if (!assessment.ready) {
      console.error(`${color.red(`${assessment.label} is not ready: ${assessment.detail.replace(/\.$/, "")}.`)}`);
      if (assessment.hint) console.error(`  ${color.yellow("->")} ${assessment.hint}`);
      console.error(`  ${color.dim("No provider was selected; the current default is unchanged.")}`);
      process.exit(1);
    }

    const chosen = explicitModel || assessment.defaultModel;
    if (!chosen) {
      console.error(`${color.red(`No model id available for ${key}.`)} Pass one explicitly: kodevra providers use ${key}/<model>`);
      process.exit(1);
    }
    if (assessment.models.length && !assessment.models.includes(chosen)) {
      console.error(`${color.red(`"${chosen}" is not a ${key} model.`)} Try: ${assessment.models.slice(0, 4).join(", ")}`);
      process.exit(1);
    }

    const file = writeState({ provider: key, model: `${key}/${chosen}` });
    console.log(`  ${color.green("selected")} ${fullModel({ provider: key, model: chosen })}`);
    console.log(`  ${color.dim(`saved to ${file}; the OpenCode config was not modified`)}`);
    return;
  }

  console.error(`${color.red(`Unknown providers command: ${sub}`)} (list, use, current)`);
  process.exit(2);
}

function printAuthStatus(config, selection) {
  const rows = providerRows(config);
  const header = ["provider", "status", "model", "guidance"];
  const cellsFor = (row) => [
    row.key,
    row.state,
    row.defaultModel ?? "-",
    row.ready
      ? row.credential.source
      : resolveAuthTarget(row.key)
        ? `kodevra auth login ${row.key}`
        : (row.hint || "-").replace(/^Run: /, ""),
  ];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => cellsFor(row)[column].length)),
  );
  const line = (cells) => cells.map((cell, column) => String(cell).padEnd(widths[column])).join("  ");

  console.log(`  ${color.dim(line(header))}`);
  for (const row of rows) {
    console.log(`  ${row.ready ? line(cellsFor(row)) : color.yellow(line(cellsFor(row)))}`);
  }
  console.log("");
  console.log(`  ${color.dim("active")}  ${color.green(fullModel(selection))} ${color.dim(`(${selection.source})`)}`);
  console.log(`  ${color.dim("store")}   ${credentialFile()} ${color.dim("- values are never read by Kodevra")}`);
}

function authFailure(message, hint) {
  console.error(`${color.red(message)}`);
  if (hint) console.error(`  ${color.yellow("->")} ${hint}`);
  process.exit(1);
}

function runAuth(opts, config, selection) {
  const sub = (opts.message[0] || "status").toLowerCase();

  if (sub === "status") {
    printAuthStatus(config, selection);
    return;
  }

  if (sub !== "login") {
    console.error(`${color.red(`Unknown auth command: ${sub}`)} (login, status)`);
    process.exit(2);
  }

  const requested = opts.message[1];
  if (!requested) {
    console.error(`${color.red("kodevra auth login needs a provider:")} kodevra auth login openai|google|deepseek|openrouter`);
    process.exit(2);
  }

  const target = resolveAuthTarget(requested);
  if (!target) {
    console.error(`${color.red(`Unknown provider "${requested}".`)} Try: openai (alias chatgpt), google-api (alias google/gemini), deepseek, openrouter`);
    process.exit(1);
  }

  console.log(`\n  ${color.bold(`Kodevra auth · ${target.label}`)}\n`);

  if (target.kind === "unsupported") {
    console.error(`${color.red("BLOCKED")} ${target.reason}`);
    console.error(`  ${color.yellow("->")} ${target.hint}`);
    console.error(`  ${color.dim("Kodevra will not collect Google session cookies or automate the Gemini web UI.")}`);
    process.exit(1);
  }

  if (target.kind === "local") {
    const readiness = assessProvider(target.key, { config });
    console.log(`  ${target.summary}`);
    console.log(`  ${color.dim("proxy")} ${target.setup}`);
    console.log(`  ${color.dim("state")} ${readiness.state}${readiness.ready ? "" : " - run: kodevra init"}`);
    process.exit(readiness.ready ? 0 : 1);
  }

  const engine = findExecutable("opencode");
  if (!engine) authFailure("OpenCode is not installed.", "Install it with: npm i -g opencode-ai");

  const capabilities = loginCapabilities(engine);
  if (!capabilities.provider) {
    authFailure(
      `OpenCode ${capabilities.detail || ""} cannot delegate provider login (no --provider flag).`,
      "Kodevra will not implement an unofficial OAuth flow. Upgrade OpenCode: npm i -g opencode-ai",
    );
  }

  if (target.kind === "oauth") {
    const method = capabilities.method ? (opts.headless ? target.headlessMethod : target.method) : null;
    console.log(`  ${target.summary}`);
    console.log(`  ${color.dim("flow")} OpenCode runs the official OpenAI sign-in and opens your browser.`);
    if (method) console.log(`  ${color.dim("method")} ${method}`);
    else console.log(`  ${color.dim("method")} choose the ChatGPT Pro/Plus option in OpenCode's prompt`);
    console.log(`  ${color.dim("note")} Kodevra never asks for your password, cookies or tokens.\n`);
  } else {
    console.log(`  ${target.summary}`);
    console.log(`  ${color.dim("1")} open ${target.setup}`);
    console.log(`  ${color.dim("2")} sign in and create an API key`);
    console.log(`  ${color.dim("3")} paste it into the prompt OpenCode shows next`);
    console.log(`  ${color.dim("note")} Kodevra never reads or stores the key itself.\n`);
  }

  const result = delegateLogin(engine, {
    providerId: target.id,
    method: target.kind === "oauth" && capabilities.method ? (opts.headless ? target.headlessMethod : target.method) : null,
  });

  if (!credentialPresent(target.id)) {
    authFailure(
      `OpenCode did not store ${target.label} credentials (exit ${result.status}).`,
      `Nothing was changed. Retry with: kodevra auth login ${target.key}`,
    );
  }

  if (result.status !== 0) {
    console.log(`  ${color.yellow(`OpenCode exited ${result.status}; existing credentials are unchanged.`)}`);
  }

  const readiness = assessProvider(target.key, { config });
  console.log(`  ${color.green("verified")} credentials present in ${credentialFile()} ${color.dim("(values not read)")}`);
  console.log(`  ${color.dim("state")}   ${readiness.state} · ${readiness.credential.source}`);
  const models = readiness.models.slice(0, 6);
  if (models.length) {
    console.log(`  ${color.dim("models")}  ${models.join(", ")}${readiness.models.length > models.length ? " ..." : ""}`);
  }
  console.log(`\n  ${color.dim("next")}    kodevra providers use ${target.key}   ${color.dim("(DeepSeek stays the default until you do)")}`);
  console.log(`  ${color.dim("verify")}  kodevra doctor -p ${target.key}\n`);
}

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`${color.red(error.message)}\n`);
    console.log(USAGE);
    process.exit(2);
  }

  if (opts.command === "help" || opts.help) {
    console.log(banner({}));
    console.log(USAGE);
    return;
  }

  const config = readConfig();

  if (opts.command === "version") {
    const engine = findExecutable("opencode");
    const selection = activeSelection({ config: config.data });
    const version = engine
      ? `${spawnSync(engine.command, ["--version"], { encoding: "utf8", timeout: 20000, shell: engine.shell }).stdout || ""}`.trim()
      : "not installed";
    console.log(
      `${PRODUCT} ${VERSION} · engine opencode ${version || "unknown"} · model ${fullModel(selection)} (${selection.source})`,
    );
    return;
  }

  if (opts.command === "init") {
    const result = ensureDefaultProvider(DEFAULT_PROVIDER);
    if (result.changed) {
      console.log(`${color.green("Added")} the ${DEFAULT_PROVIDER} provider to ${result.file}`);
      if (result.backup) console.log(`${color.dim(`Backup of the previous config: ${result.backup}`)}`);
      console.log(`${color.dim("Start the FreeDeepseekAPI proxy, then run: kodevra doctor")}`);
    } else {
      console.log(`${color.dim(`${DEFAULT_PROVIDER} is already configured in ${result.file} - left untouched.`)}`);
    }

    // OpenRouter reserves max_tokens up front, so a 65k default output cap can
    // exceed a small balance even for a one-line answer. 4096 keeps the model's
    // real context window and capabilities while staying affordable.
    const limit = ensureModelLimit({
      providerId: "openrouter",
      modelId: OPENROUTER_GEMINI_MODEL,
      output: 4096,
      context: catalogModelContext("openrouter", OPENROUTER_GEMINI_MODEL) ?? 1048576,
    });
    if (limit.changed) {
      console.log(
        `${color.green("Set")} openrouter/${OPENROUTER_GEMINI_MODEL} max output to ${limit.limit.output} tokens ${color.dim(`(context ${limit.limit.context})`)}`,
      );
      if (limit.backup) console.log(`${color.dim(`Backup of the previous config: ${limit.backup}`)}`);
    } else {
      console.log(
        `${color.dim(`openrouter/${OPENROUTER_GEMINI_MODEL} already capped at ${limit.limit.output} output tokens.`)}`,
      );
    }
    return;
  }

  const selection = activeSelection({
    flagModel: opts.model,
    flagProvider: opts.provider,
    config: config.data,
  });
  const assessment = assessProvider(selection.provider, { config: config.data });

  if (assessment.kind === "unsupported") {
    console.error(`${color.red(`${assessment.label} is not supported by Kodevra.`)}`);
    console.error(`  ${assessment.detail}`);
    if (assessment.hint) console.error(`  ${color.yellow("->")} ${assessment.hint}`);
    console.error(`  ${color.dim("No agent run was started and the default provider is unchanged.")}`);
    process.exit(1);
  }

  if (!selection.model || selection.model === "null") {
    console.error(`${color.red(`No model known for provider "${selection.provider}".`)} Use: kodevra providers list`);
    process.exit(2);
  }
  const model = fullModel(selection);
  const workspace = path.resolve(opts.workspace);

  if (opts.command === "run" && !opts.message.length) {
    console.error(`${color.red("kodevra run needs a task:")} kodevra run "fix the failing test"`);
    process.exit(2);
  }

  const authLine = assessment.ready
    ? `${assessment.state} · ${assessment.credential.source}`
    : `${assessment.state} · ${assessment.detail}`;

  if (opts.command === "providers") {
    if ((opts.message[0] || "list").toLowerCase() === "list") {
      console.log(banner({ model, workspace, engine: "opencode", auth: authLine }));
    }
    providerCommand(opts, config.data, selection);
    return;
  }

  if (opts.command === "auth") {
    if ((opts.message[0] || "status").toLowerCase() === "status") {
      console.log(banner({ model, workspace, engine: "opencode", auth: authLine }));
    }
    runAuth(opts, config.data, selection);
    return;
  }

  console.log(banner({ model, workspace, engine: "opencode", auth: authLine }));

  const diagnosticsAlways = opts.command === "doctor";
  let failed = 0;
  if (diagnosticsAlways || (opts.doctor && process.env.KODEVRA_SKIP_DOCTOR !== "1")) {
    const result = await runDiagnostics({ workspace, model });
    printChecks(result.checks);
    console.log("");
    failed = result.failed;
  }

  if (diagnosticsAlways) {
    console.log(failed ? color.red(`${failed} check(s) failed.`) : color.green("All checks passed."));
    process.exit(failed ? 1 : 0);
  }

  if (failed) {
    console.error(`${color.red("Diagnostics failed")} - fix the items marked FAIL (or run with --no-doctor).`);
    process.exit(1);
  }

  const engine = findExecutable("opencode");
  if (!engine) {
    console.error(color.red("OpenCode is not installed. Install it with: npm i -g opencode-ai"));
    process.exit(1);
  }

  const args = buildArgs(opts, engineModel(selection), workspace);
  const shown = args
    .filter((arg, position) => !(arg === "-m" || (position > 0 && args[position - 1] === "-m")))
    .map((arg) => trim(arg));
  console.log(`${color.dim("kodevra")} ${color.dim("->")} opencode ${shown.join(" ")}`);
  console.log("");

  const startedAt = Date.now();
  start(engine, args, workspace, {
    onExit: opts.command === "run" ? (exitCode) => printSummary({ workspace, model, startedAt, exitCode }) : undefined,
  });
}

main().catch((error) => {
  console.error(color.red(error.stack || error.message));
  process.exit(1);
});
