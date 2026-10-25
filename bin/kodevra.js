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
  readConfig,
  resolveModel,
} from "../lib/config.js";
import { findExecutable, runDiagnostics } from "../lib/doctor.js";

const USAGE = `${color.bold("Usage")}
  kodevra [path]              start the agent in a workspace (default: current directory)
  kodevra run "<task>"        run one task headlessly (tool permissions auto-approved)
  kodevra doctor              check engine, provider, model, proxy and workspace
  kodevra init                add the default DeepSeek provider if it is missing
  kodevra <cmd> -- <args>     forward arguments to OpenCode

${color.bold("Options")}
  -w, --workspace <path>      workspace to run in
  -m, --model <provider/model>  default: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}
      --agent <name>          OpenCode agent to use (default: build)
      --auto, --no-auto       auto-approve tool permissions
      --no-doctor             skip startup diagnostics
  -h, --help                  show this help
  -v, --version               show version

${color.bold("Environment")}
  KODEVRA_MODEL               override the default model
  KODEVRA_SKIP_DOCTOR=1       skip diagnostics
  OPENCODE_BIN                path to the OpenCode executable
  OPENCODE_CONFIG             path to the OpenCode config file
`;

function parse(argv) {
  const opts = {
    command: "launch",
    workspace: process.cwd(),
    model: null,
    agent: null,
    auto: false,
    autoExplicit: false,
    doctor: true,
    help: false,
    passthrough: [],
    message: [],
  };

  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    const first = argv[0];
    if (["doctor", "init", "run", "help", "version", "launch"].includes(first)) {
      opts.command = first;
      index = 1;
    } else {
      const resolved = path.resolve(first);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        opts.workspace = resolved;
        index = 1;
      } else {
        throw new Error(`Unknown command or directory: ${first}`);
      }
    }
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "-v" || arg === "--version") opts.command = "version";
    else if (arg === "-w" || arg === "--workspace") opts.workspace = path.resolve(argv[(index += 1)] || "");
    else if (arg === "-m" || arg === "--model") opts.model = argv[(index += 1)];
    else if (arg === "--agent") opts.agent = argv[(index += 1)];
    else if (arg === "--auto") {
      opts.auto = true;
      opts.autoExplicit = true;
    } else if (arg === "--no-auto") {
      opts.auto = false;
      opts.autoExplicit = true;
    } else if (arg === "--no-doctor") opts.doctor = false;
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

function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function start(engine, args, workspace) {
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
    process.exit(signal ? 1 : code ?? 0);
  });
}

function buildArgs(opts, model) {
  const auto = opts.command === "run" ? (opts.autoExplicit ? opts.auto : true) : opts.auto;
  const args = opts.command === "run" ? ["run"] : [];

  if (model) args.push("-m", model);
  if (opts.agent) args.push("--agent", opts.agent);
  if (auto) args.push("--auto");

  if (opts.command === "run") {
    if (opts.message.length) args.push(opts.message.join(" "));
  } else if (opts.message.length) {
    args.push(...opts.message);
  }
  args.push(...opts.passthrough);
  return args;
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
  const model = opts.model || resolveModel(config.data);
  const workspace = path.resolve(opts.workspace);

  if (opts.command === "version") {
    const engine = findExecutable("opencode");
    const version = engine
      ? `${spawnSync(engine.command, ["--version"], { encoding: "utf8", timeout: 20000, shell: engine.shell }).stdout || ""}`.trim()
      : "not installed";
    console.log(`${PRODUCT} ${VERSION} · engine opencode ${version || "unknown"} · model ${model}`);
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
    return;
  }

  if (opts.command === "run" && !opts.message.length) {
    console.error(`${color.red("kodevra run needs a task:")} kodevra run "fix the failing test"`);
    process.exit(2);
  }

  console.log(banner({ model, workspace, engine: "opencode" }));

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

  const args = buildArgs(opts, model);
  const shown = args.filter((arg, position) => !(arg === "-m" || (position > 0 && args[position - 1] === "-m")));
  console.log(`${color.dim("kodevra")} ${color.dim("->")} opencode ${shown.join(" ")}`);
  console.log("");
  start(engine, args, workspace);
}

main().catch((error) => {
  console.error(color.red(error.stack || error.message));
  process.exit(1);
});
