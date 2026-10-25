#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { banner, color, header, mark, PRODUCT, VERSION } from "../lib/brand.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  providerEntry,
  readConfig,
} from "../lib/config.js";
import { streamEngine } from "../lib/engine.js";
import { classifyFailure, describeFailure } from "../lib/failures.js";
import { writePermissionOverlay } from "../lib/permissions.js";
import { createVerificationAuthorization, authorizationDrift, renewAuthorization } from "../lib/authorization.js";
import { listExecutors, resolveExecutor } from "../lib/executors.js";
import { probeDocker } from "../lib/docker-executor.js";
import { watchRunEvents } from "../lib/progress.js";
import { createRunLog } from "../lib/events.js";
import { installSandboxTool } from "../lib/sandbox-tool.js";
import {
  failureSignature,
  repairPrompt,
  resultLines,
  snapshotTree,
  treeChangedFiles,
  workspaceChanges,
} from "../lib/verify.js";
import { findExecutable, runDiagnostics } from "../lib/doctor.js";
import { runInit } from "../lib/onboarding.js";
import {
  adapterInfo,
  credentialFile,
  credentialPresent,
  delegateLogin,
  describeOAuthStatus,
  loginCapabilities,
  oauthStatus,
  resolveAuthTarget,
} from "../lib/auth.js";
import {
  WEB_ADAPTER_LABEL,
  accountSummary,
  isLoopbackOrigin,
  modelRows,
  proxyBaseURL,
  proxyOrigin,
  proxyVerdict,
  readHealth,
  readProxyCatalog,
} from "../lib/deepseek-web.js";
import {
  PRESET_KEYS,
  activeSelection,
  assessProvider,
  defaultModelFor,
  engineModel,
  engineProviderId,
  fullModel,
  liveEngineModels,
  normalizeProvider,
  readAuthProviders,
  readCatalog,
  withoutApiKeyBilling,
  writeState,
} from "../lib/providers.js";

const USAGE = `${color.bold("Usage")}
  kodevra [path]              start the agent in a workspace (default: current directory)
  kodevra run "<task>"        run one task headlessly (workspace-write by default)
  kodevra run "<task>" --verify "npm test"
                              run a task, then let a real command decide PASS/FAIL
  kodevra sessions            list the local sessions for this workspace
  kodevra doctor              check engine, provider, model, auth, proxy and workspace
  kodevra init                apply Kodevra defaults (DeepSeek provider, Gemini output cap)
  kodevra providers           list providers, credentials and default models
  kodevra providers use <p>   select a provider for future runs (Kodevra state only)
  kodevra providers current   show the active provider/model
  kodevra providers models <p>  real model ids from the provider itself
  kodevra auth login chatgpt  sign in with a ChatGPT Plus/Pro account (OpenCode's official OAuth)
  kodevra auth login deepseek-web  run the FreeDeepseekAPI adapter's own browser sign-in
  kodevra auth login <p>      sign in to any provider through OpenCode's official flow
  kodevra auth status [p]     authentication state, plan, proxy health and cooldown
  kodevra <cmd> -- <args>     forward arguments to OpenCode

${color.bold("Options")}
  -w, --workspace <path>      workspace to run in
  -p, --provider <key>        provider for this run (default: ${DEFAULT_PROVIDER})
  -m, --model <provider/model>  default: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}
      --agent <name>          OpenCode agent to use (default: build, or plan in read-only)
      --mode <mode>           read-only | ask | workspace-write
                              (default: workspace-write for run, ask for launch)
      --verify <command>      run this command after the task; its exit code decides PASS/FAIL
      --max-repairs <n>       bounded repair runs after a failed verification (default: 2)
  -c, --continue              continue the last session
  -s, --session <id>          continue a specific session
      --executor <name>       where project commands run: host | docker (default: host)
                              docker also enables the trusted sandbox_exec tool for the agent
      --reapprove <sha256>    renew host-execution authorization for that exact changed
                              surface (the fingerprint is printed when it refuses)
      --timeout <seconds>     wall-clock limit for one agent call (default 1800)
      --idle-timeout <secs>   cancel an agent call with no output for this long (default 300)
      --events-json           stream structured execution events to stderr
  -y, --yes                   accept the setup plan without prompting (init)
      --auto, --no-auto       auto-approve permissions on an interactive launch
                              (ignored for run: unattended runs never auto-approve)
      --headless              use the headless OAuth method (openai only)
      --no-doctor             skip startup diagnostics
  -h, --help                  show this help
  -v, --version               show version

${color.bold("Provider credentials")}
  Kodevra never asks for API keys or reads session files. Export the provider API key in your
  environment, authenticate once with OpenCode ("opencode auth login"), or let the
  FreeDeepseekAPI adapter run its own sign-in ("kodevra auth login deepseek-web").

${color.bold("Environment")}
  KODEVRA_MODEL               override the selected model
  KODEVRA_SKIP_DOCTOR=1       skip diagnostics
  OPENCODE_BIN                path to the OpenCode executable
  OPENCODE_CONFIG             path to the OpenCode config file
  KODEVRA_STATE               path to Kodevra's provider selection state
`;

const VALUE_FLAGS = new Set([
  "-w",
  "--workspace",
  "-m",
  "--model",
  "-p",
  "--provider",
  "--agent",
  "--mode",
  "--verify",
  "--max-repairs",
  "-s",
  "--session",
  "--executor",
  "--reapprove",
  "--timeout",
  "--idle-timeout",
]);
const COMMANDS = new Set([
  "doctor",
  "init",
  "run",
  "help",
  "version",
  "launch",
  "providers",
  "auth",
  "sessions",
]);

/**
 * Automation modes (FRD FR-017). They map onto what OpenCode already enforces:
 * the read-only `plan` agent, the normal build agent, and its approval flag.
 * Kodevra does not implement its own permission engine.
 */
const MODES = {
  "read-only": { agent: "plan", description: "no file edits" },
  ask: { agent: "build", description: "edits require approval" },
  "workspace-write": { agent: "build", description: "workspace edits allowed" },
};

/** Only an interactive launch may auto-approve. Unattended runs never do. */
function modeAuto(opts, name) {
  if (opts.command !== "launch") return false;
  if (opts.autoExplicit) return opts.auto;
  return name === "workspace-write";
}

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
    mode: null,
    verify: null,
    maxRepairs: 2,
    session: null,
    continueSession: false,
    executor: null,
    executorExplicit: false,
    reapprove: null,
    eventsJson: false,
    yes: false,
    agentTimeoutMs: null,
    agentIdleMs: null,
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
    else if (arg === "--mode") opts.mode = argv[(index += 1)];
    else if (arg === "--verify") opts.verify = argv[(index += 1)];
    else if (arg === "--max-repairs") opts.maxRepairs = Number(argv[(index += 1)]);
    else if (arg === "-s" || arg === "--session") opts.session = argv[(index += 1)];
    else if (arg === "-c" || arg === "--continue") opts.continueSession = true;
    else if (arg === "--executor") {
      opts.executor = argv[(index += 1)] || "host";
      opts.executorExplicit = true;
    } else if (arg === "--reapprove") opts.reapprove = argv[(index += 1)] || null;
    else if (arg === "--timeout") opts.agentTimeoutMs = Math.max(1, Number(argv[(index += 1)]) || 0) * 1000;
    else if (arg === "--idle-timeout") opts.agentIdleMs = Math.max(1, Number(argv[(index += 1)]) || 0) * 1000;
    else if (arg === "--events-json") opts.eventsJson = true;
    else if (arg === "-y" || arg === "--yes") opts.yes = true;
    else if (arg === "--no-doctor") opts.doctor = false;
    else if (arg === "--") {
      opts.passthrough.push(...argv.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) opts.passthrough.push(arg);
    else opts.message.push(arg);
  }

  return opts;
}

/** One line of sandbox truth for the startup panel: probe only, never pull. */
function sandboxStatusLine() {
  if (process.env.KODEVRA_SKIP_DOCKER_PROBE === "1") return color.dim("probe skipped");
  const probe = probeDocker();
  return probe.ok
    ? color.green(probe.detail)
    : `${color.yellow("unavailable")}${color.dim(` · ${probe.detail}`)}`;
}

/**
 * Project code is isolated by default: `--verify` picks Docker when it is
 * available and refuses otherwise. Running on the host is an explicit opt-in
 * (`--executor host`), never a silent fallback.
 */
function defaultVerifyExecutor() {
  if (process.env.KODEVRA_EXECUTOR) return process.env.KODEVRA_EXECUTOR;
  const probe = probeDocker();
  if (probe.ok) return "docker";
  const error = new Error(`No isolated executor is available for --verify (${probe.detail}).`);
  error.code = "EXECUTOR_UNAVAILABLE";
  error.hint = "Start Docker Desktop, or opt in to running project code on this machine with --executor host.";
  throw error;
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

function resolveMode(opts) {
  const name = (opts.mode || (opts.command === "run" ? "workspace-write" : "ask")).toLowerCase();
  const mode = MODES[name];
  if (!mode) {
    throw new Error(`Unknown mode "${name}". Use: ${Object.keys(MODES).join(" | ")}`);
  }
  if (name === "read-only" && opts.agent && opts.agent !== "plan") {
    throw new Error(`--mode read-only runs the plan agent; --agent ${opts.agent} would allow edits. Drop --agent or use --mode workspace-write.`);
  }
  return {
    name,
    description: mode.description,
    agent: opts.agent || mode.agent,
    auto: modeAuto(opts, name),
  };
}

function visibleArgs(args) {
  return args
    .filter((arg, position) => !(arg === "-m" || (position > 0 && args[position - 1] === "-m")))
    .map((arg) => trim(arg));
}

function printFailure(failure) {
  console.error(`\n  ${color.red("failure")} ${color.red(describeFailure(failure))}`);
  if (failure.action) console.error(`  ${color.yellow("next")} ${failure.action}`);
}

/** Is the local proxy actually reachable? Used to classify, never to guess. */
async function proxyReachableIfLocal(provider) {
  if (assessProvider(provider).kind !== "local") return null;
  const baseURL = providerEntry(readConfig().data, provider)?.options?.baseURL;
  if (!baseURL) return null;
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A verification command may only run while the developer's authorization still
 * matches what the command would execute. If the agent changed scripts, test
 * files or their configuration, execution stops until the developer approves
 * *that exact surface* by naming its fingerprint. A bare flag cannot approve
 * changes nobody has seen yet.
 */
function verificationGate({ authorization, workspace, command, reapprove }) {
  const drift = authorizationDrift(authorization, { workspace, command });
  if (drift.ok && !drift.commandChanged) return { ok: true, drift, renewed: false, authorization };
  if (!reapprove) return { ok: false, drift, renewed: false, authorization };
  const renewed = renewAuthorization(authorization, { workspace, command, fingerprint: reapprove });
  if (!renewed.renewed) return { ok: false, drift, renewed: false, authorization, fingerprintMismatch: true };
  return { ok: true, drift, renewed: true, authorization: renewed.authorization };
}

function printApproval(approval) {
  console.error(`\n  ${color.red("approval required")} ${color.dim("the verification command was not executed")}`);
  const files = [...approval.changed, ...approval.added, ...approval.removed];
  if (files.length) console.error(`  ${color.dim("changed by agent")} ${files.join(", ")}`);
  if (approval.fingerprint) console.error(`  ${color.dim("current surface")} sha256 ${approval.fingerprint}`);
  if (approval.fingerprintMismatch) {
    console.error(`  ${color.yellow("next")} the supplied fingerprint does not match the current surface; review the diff and retry`);
  } else {
    console.error(`  ${color.yellow("next")} review the changes, then re-run with --reapprove <fingerprint>`);
  }
}

async function runVerificationWithEvents({ executor, command, workspace, events, attempt }) {
  events.emit("verification_started", {
    command,
    executor: executor.name,
    sandboxed: executor.sandboxed,
    attempt,
  });
  console.log(`\n  ${color.dim("verify ")} ${command}`);
  let result;
  try {
    result = await executor.run(command, { cwd: workspace });
  } catch (error) {
    result = {
      command,
      ok: false,
      status: 1,
      timedOut: false,
      output: error.message,
      durationMs: 0,
      error: error.code ?? "EXECUTOR_ERROR",
    };
  }
  if (result.details?.snapshot) {
    console.log(
      `  ${color.dim("snapshot")} ${result.details.snapshot} ${color.dim("- source workspace was not mounted")}`,
    );
  }
  events.emit("verification_finished", {
    command,
    executor: executor.name,
    sandboxed: executor.sandboxed,
    status: result.status,
    ok: result.ok,
    timed_out: Boolean(result.timedOut),
    duration_ms: result.durationMs,
    image: result.details?.image ?? null,
    snapshot: result.details?.snapshot ?? null,
    staged_files: result.details?.staged_files ?? null,
    error: result.error ?? null,
  });
  return result;
}

function emitFileChanges(events, workspace) {
  const changes = workspaceChanges(workspace);
  events.emit("file_changes", {
    files: changes.files,
    diff: changes.stat ? changes.stat.split("\n").pop() : null,
  });
  return changes;
}

/**
 * The engine environment for one run. In ChatGPT-plan mode an exported
 * OPENAI_API_KEY is removed: OpenCode prefers it over the stored OAuth
 * credential, which would bill the API key instead of the subscription.
 */
function planRunEnv(selection, assessment, env = process.env) {
  return withoutApiKeyBilling(env, { provider: selection.provider, plan: assessment?.plan ?? null });
}

/**
 * One headless task, optionally proved by a real command.
 *
 * Flow: engine run -> authorization check -> verification through the resolved
 * executor -> bounded repair (new failure only) -> report. The verification
 * command's exit code, not the model's prose, makes this PASS or FAIL. The
 * executor is the host today and says so; it is not sandboxed.
 */
async function executeRun({ engine, opts, workspace, model, selection, assessment }) {
  const startedAt = Date.now();
  const before = workspaceChanges(workspace).files;
  const beforeTree = snapshotTree(workspace);
  const maxRepairs = Number.isFinite(opts.maxRepairs) ? Math.max(0, Math.min(5, opts.maxRepairs)) : 2;
  const mode = resolveMode(opts);
  const agentTimeoutMs = opts.agentTimeoutMs ?? Number(process.env.KODEVRA_RUN_TIMEOUT_MS || 1_800_000);
  const agentIdleMs = opts.agentIdleMs ?? Number(process.env.KODEVRA_RUN_IDLE_MS || 300_000);

  let executor;
  let executorInfo = null;
  try {
    executor = resolveExecutor(opts.executor || (opts.verify ? defaultVerifyExecutor() : "host"));
    if (opts.verify && executor.check) executorInfo = await executor.check();
  } catch (error) {
    console.error(color.red(error.message));
    if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
    console.error(`  ${color.dim("No verification ran, and Kodevra did not fall back to the host executor.")}`);
    process.exit(2);
  }

  // Model-requested shell only exists inside the Docker sandbox. The trusted
  // tool is installed into OpenCode's global tools directory (never the
  // workspace, which the agent can write) and stays inert unless this run
  // enables it through the environment below.
  const sandboxExec = executor.name === "docker";
  let sandboxTool = null;
  if (sandboxExec) {
    try {
      sandboxTool = installSandboxTool();
    } catch (error) {
      console.error(color.red(error.message));
      if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
      console.error(`  ${color.dim("No agent terminal is available, and Kodevra did not fall back to host bash.")}`);
      process.exit(2);
    }
  }

  const events = createRunLog({
    workspace,
    model,
    provider: selection.provider,
    mode: mode.name,
    executor: executor.name,
    verify: opts.verify,
    stream: opts.eventsJson,
  });

  // Automated runs get an explicit workspace scope instead of --auto. With the
  // Docker executor, native host bash is denied and sandbox_exec is the only
  // shell the agent has; otherwise bash stays on "ask", which the engine
  // auto-rejects when nobody can approve it.
  let scope;
  try {
    scope = writePermissionOverlay({ workspace, mode: mode.name, sandboxExec });
  } catch (error) {
    console.error(color.red(error.message));
    if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
    console.error(color.dim("No task was started: the workspace policy could not be enforced."));
    process.exit(2);
  }
  if (sandboxExec) {
    Object.assign(scope.env, {
      KODEVRA_SANDBOX_EXEC: "1",
      KODEVRA_HOME: path.resolve(import.meta.dirname, ".."),
      KODEVRA_WORKSPACE: workspace,
      KODEVRA_RUN_ID: events.runId,
      KODEVRA_RUN_FILE: events.file ?? "",
    });
  }
  const planEnv = planRunEnv(selection, assessment, scope.env);
  scope.env = planEnv.env;
  if (planEnv.stripped) {
    console.log(
      `  ${color.dim("plan   ")} ChatGPT plan - OPENAI_API_KEY was not passed to the engine ${color.dim("(no API billing)")}`,
    );
  }
  if (scope.warnings?.length) {
    for (const warning of scope.warnings) console.log(`  ${color.yellow("scope  ")} ${warning}`);
  }
  console.log(`  ${color.dim("scope  ")} ${workspace} ${color.dim("- file tools confined here; shell needs approval")}`);
  console.log(`${color.dim("kodevra")} ${color.dim("->")} opencode ${visibleArgs(buildArgs(opts, engineModel(selection), workspace)).join(" ")}`);
  console.log(`${color.dim("mode   ")} ${mode.name} ${color.dim(`- ${mode.description}`)}`);
  if (opts.autoExplicit && opts.auto) {
    console.log(`  ${color.yellow("--auto ignored")} ${color.dim("unattended runs do not auto-approve tool permissions")}`);
  }

  if (sandboxExec) {
    console.log(
      `  ${color.dim("tool    ")} sandbox_exec ${color.dim("->")} ${sandboxTool.file} ${color.green("docker sandbox")}`,
    );
  }

  events.emit("run_started", {
    workspace,
    model,
    provider: selection.provider,
    plan: assessment?.plan ?? null,
    mode: mode.name,
    executor: executor.name,
    sandboxed: executor.sandboxed,
    image: executorInfo?.image ?? null,
    sandbox_exec: sandboxExec,
    verify: opts.verify ?? null,
  });

  let authorization = null;
  if (opts.verify) {
    try {
      authorization = createVerificationAuthorization({ workspace, command: opts.verify });
    } catch (error) {
      console.error(`\n  ${color.red("authorization unavailable")} ${error.message}`);
      console.error(`  ${color.yellow("->")} ${error.code === "AUTHORIZATION_SURFACE_TOO_LARGE" ? "narrow the test scope (a single test directory is enough) and retry." : "fix file permissions in the workspace and retry."}`);
      console.error(color.dim("No model call was started and no verification was authorized."));
      process.exit(2);
    }
    console.log(`  ${color.dim("executor")} ${executor.name} ${color.dim(`- ${executor.description}`)} ${executor.sandboxed ? color.green("sandboxed") : color.yellow("not sandboxed")}`);
    if (executorInfo?.image) console.log(`  ${color.dim("image   ")} ${executorInfo.image}`);
    console.log(
      `  ${color.dim("gate    ")} authorized by --verify · ${authorization.files.length} verification file(s) · sha256 ${authorization.fingerprint.slice(0, 12)}`,
    );
    events.emit("verification_authorized", {
      command: opts.verify,
      fingerprint: authorization.fingerprint,
      files: authorization.files.length,
      source: authorization.source,
    });
  }
  console.log("");

  let run = { status: 1, signal: null, output: "", durationMs: 0 };
  let failure = null;
  let verification = null;
  let repairs = 0;
  let approval = null;
  let sandboxCommands = 0;

  // Sandbox commands run inside the engine's process, so Kodevra learns about
  // them by tailing the run's own event file. No extra orchestration.
  const stopProgress = watchRunEvents(events.file, {
    onEvent: (event) => {
      if (event.event === "sandbox_started") {
        console.log(`  ${color.dim("sandbox")} ${trim(event.command, 72)} ${color.dim("running ...")}`);
      } else if (event.event === "sandbox_finished") {
        sandboxCommands += 1;
        const code = event.timed_out ? `${event.status} timed out` : `${event.status}`;
        const state = event.ok ? color.green(`exit ${code}`) : color.red(`exit ${code}`);
        console.log(
          `  ${color.dim("sandbox")} ${trim(event.command, 72)} ${color.dim("->")} ${state} ${color.dim(`(${(event.duration_ms / 1000).toFixed(1)}s)`)}`,
        );
      }
    },
  });

  try {
    events.emit("model_started", { attempt: 0, agent: mode.agent });
    run = await streamEngine(engine, buildArgs(opts, engineModel(selection), workspace), {
      cwd: workspace,
      env: scope.env,
      timeoutMs: agentTimeoutMs,
      idleMs: agentIdleMs,
    });
    if (run.timedOut) {
      events.emit("model_cancelled", {
        attempt: 0,
        reason: run.timeoutReason,
        after_ms: run.timedOutAtMs,
        status: run.status,
      });
      console.log(`  ${color.yellow("cancelled")} the engine was stopped (${run.timeoutReason}, ${(run.timedOutAtMs / 1000).toFixed(0)}s)`);
    }
    events.emit("model_finished", {
      attempt: 0,
      status: run.status,
      signal: run.signal,
      duration_ms: run.durationMs,
    });

    if (run.status !== 0) {
      failure = classifyFailure({
        output: run.output,
        status: run.status,
        signal: run.signal,
        timedOut: run.timedOut,
        provider: selection.provider,
        proxyReachable: await proxyReachableIfLocal(selection.provider),
      });
      printFailure(failure);
      events.emit("failure", { code: failure.code, origin: failure.origin, message: failure.message });
      events.emit("verification_skipped", { reason: "model execution failed" });
    }
    emitFileChanges(events, workspace);

    if (opts.verify && !failure) {
      let gate = verificationGate({ authorization, workspace, command: opts.verify, reapprove: opts.reapprove });
      if (!gate.ok) {
        approval = {
          required: true,
          changed: gate.drift.changed,
          added: gate.drift.added,
          removed: gate.drift.removed,
          fingerprint: gate.drift.fingerprint,
          fingerprintMismatch: Boolean(gate.fingerprintMismatch),
        };
        events.emit("approval_required", { command: opts.verify, ...approval });
        printApproval(approval);
      } else {
        if (gate.renewed) {
          authorization = gate.authorization;
          events.emit("verification_reapproved", {
            command: opts.verify,
            changed: gate.drift.changed,
            added: gate.drift.added,
            removed: gate.drift.removed,
            fingerprint: authorization.fingerprint,
          });
        }
        verification = await runVerificationWithEvents({ executor, command: opts.verify, workspace, events, attempt: 0 });
        let signature = failureSignature(verification.output);

        while (!verification.ok && repairs < maxRepairs) {
          repairs += 1;
          events.emit("repair_started", { attempt: repairs, max: maxRepairs });
          console.log(`\n  ${color.yellow(`repair ${repairs}/${maxRepairs}`)} ${color.dim("passing the failure back to the model")}`);
          const repairArgs = buildArgs(
            { ...opts, continueSession: true, session: null },
            engineModel(selection),
            workspace,
            { message: [repairPrompt({ command: opts.verify, result: verification, attempt: repairs, maxRepairs })] },
          );
          events.emit("model_started", { attempt: repairs, agent: mode.agent });
          run = await streamEngine(engine, repairArgs, {
            cwd: workspace,
            env: scope.env,
            timeoutMs: agentTimeoutMs,
            idleMs: agentIdleMs,
          });
          if (run.timedOut) {
            events.emit("model_cancelled", {
              attempt: repairs,
              reason: run.timeoutReason,
              after_ms: run.timedOutAtMs,
              status: run.status,
            });
            console.log(`  ${color.yellow("cancelled")} the repair run was stopped (${run.timeoutReason})`);
          }
          events.emit("model_finished", {
            attempt: repairs,
            status: run.status,
            signal: run.signal,
            duration_ms: run.durationMs,
          });
          if (run.status !== 0) {
            failure = classifyFailure({
              output: run.output,
              status: run.status,
              signal: run.signal,
              timedOut: run.timedOut,
              provider: selection.provider,
              proxyReachable: await proxyReachableIfLocal(selection.provider),
            });
            printFailure(failure);
            events.emit("failure", { code: failure.code, origin: failure.origin, message: failure.message });
            break;
          }
          emitFileChanges(events, workspace);

          gate = verificationGate({ authorization, workspace, command: opts.verify, reapprove: opts.reapprove });
          if (!gate.ok) {
            approval = {
              required: true,
              changed: gate.drift.changed,
              added: gate.drift.added,
              removed: gate.drift.removed,
              fingerprint: gate.drift.fingerprint,
              fingerprintMismatch: Boolean(gate.fingerprintMismatch),
            };
            events.emit("approval_required", { command: opts.verify, ...approval });
            printApproval(approval);
            break;
          }
          if (gate.renewed) {
            authorization = gate.authorization;
            events.emit("verification_reapproved", {
              command: opts.verify,
              changed: gate.drift.changed,
              added: gate.drift.added,
              removed: gate.drift.removed,
              fingerprint: authorization.fingerprint,
            });
          }

          verification = await runVerificationWithEvents({ executor, command: opts.verify, workspace, events, attempt: repairs });
          const next = failureSignature(verification.output);
          if (!verification.ok && next === signature) {
            console.log(`\n  ${color.yellow("stopped")} the same failure repeated; no progress after ${repairs} repair run(s).`);
            break;
          }
          signature = next;
        }
      }
    }
  } finally {
    stopProgress();
    scope.cleanup();
  }

  const changes = workspaceChanges(workspace);
  // Git speaks for tracked files; a workspace inside an ignored directory gets
  // its evidence from the file-metadata snapshot instead of claiming zero.
  const treeFiles = treeChangedFiles(beforeTree, workspace);
  if (!changes.isGit) changes.files = treeFiles;
  else if (treeFiles.length) changes.files = [...new Set([...changes.files, ...treeFiles])].sort();

  const preexisting = before.filter((file) => changes.files.includes(file)).length;
  const ok = approval ? false : verification ? verification.ok && !failure : run.status === 0 && !failure;

  events.emit("run_finished", {
    ok,
    duration_ms: Date.now() - startedAt,
    repairs,
    executor: executor.name,
    sandboxed: executor.sandboxed,
    approval_required: Boolean(approval),
    verification: verification
      ? { command: verification.command, ok: verification.ok, status: verification.status }
      : null,
    changed_files: changes.files.length,
  });

  const lines = resultLines({
    model,
    durationMs: Date.now() - startedAt,
    verification,
    repairs,
    maxRepairs,
    changes,
    failure,
    preexisting,
    executor,
    authorization,
    approval: approval ? { ...approval, required: true } : null,
    eventsFile: events.file,
    sandboxCommands,
  });
  for (const line of lines) console.log(line);

  process.exit(ok ? 0 : 1);
}

function start(engine, args, workspace, env = process.env) {
  const commandArgs = engine.shell ? [args.map(quoteForShell).join(" ")] : args;
  const child = spawn(engine.command, commandArgs, {
    cwd: workspace,
    stdio: "inherit",
    shell: engine.shell,
    env,
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

function buildArgs(opts, model, workspace, { message = opts.message } = {}) {
  const mode = resolveMode(opts);
  const args = opts.command === "run" ? ["run"] : [];

  if (model) args.push("-m", model);
  if (mode.agent) args.push("--agent", mode.agent);
  if (mode.auto) args.push("--auto");
  // Automated runs never load third-party plugins from the project.
  if (opts.command === "run") args.push("--pure");
  if (opts.continueSession) args.push("--continue");
  if (opts.session) args.push("--session", opts.session);

  if (opts.command === "run") {
    if (message.length) {
      // Keep file work anchored to the selected workspace: models otherwise tend
      // to build absolute paths from the repository root.
      const task = `Workspace: ${workspace}. Use paths relative to this directory.\n\n${message.join(" ")}`;
      args.push(task);
    }
  } else if (message.length) {
    args.push(...message);
  }
  args.push(...opts.passthrough);
  return args;
}

function providerRows(config, engine) {
  const catalog = readCatalog();
  const authProviders = readAuthProviders();
  const keys = [
    ...new Set(
      [...Object.keys(config?.provider ?? {}), ...authProviders, ...PRESET_KEYS].map((key) => normalizeProvider(key)),
    ),
  ];
  const rows = keys.map((key) => assessProvider(key, { config, catalog, authProviders, engine }));
  const rank = (row) => (row.ready ? (row.kind === "local" ? 0 : 1) : row.available ? 2 : 3);
  return rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

function printProviderTable(config, selection, engine) {
  const rows = providerRows(config, engine);
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
  for (const row of rows.filter((entry) => entry.plan)) {
    console.log(`  ${color.dim("plan  ")}  ${row.key}: ${row.plan} ${color.dim(`(${row.planSource})`)}`);
  }
  console.log(
    `  ${color.dim("note  ")}  ${DEFAULT_PROVIDER}: ${WEB_ADAPTER_LABEL} ${color.dim("- DeepSeek Web session via FreeDeepseekAPI, not vendor OAuth")}`,
  );
  console.log(`  ${color.dim("switch")}  kodevra providers use <provider>   ·   one-off: kodevra run -p <provider> "<task>"`);
}

async function providerCommand(opts, config, selection, engine) {
  const sub = (opts.message[0] || "list").toLowerCase();

  if (sub === "list") {
    printProviderTable(config, selection, engine);
    return;
  }

  if (sub === "models") {
    await printProviderModels(opts.message[1] || DEFAULT_PROVIDER, config, engine);
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
    const assessment = assessProvider(key, { config, engine });

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

  console.error(`${color.red(`Unknown providers command: ${sub}`)} (list, models, use, current)`);
  process.exit(2);
}

function printAuthStatus(config, selection, engine) {
  const rows = providerRows(config, engine);
  const header = ["provider", "status", "model", "guidance"];
  const cellsFor = (row) => [
    row.key,
    row.state,
    row.defaultModel ?? "-",
    row.kind === "unsupported"
      ? "no authorized flow - use google-api"
      : row.ready
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
  for (const row of rows.filter((entry) => entry.plan)) {
    const lifetime = row.plan === "chatgpt" ? ` · ${describeOAuthStatus(oauthStatus(row.engineId))}` : "";
    console.log(`  ${color.dim("plan  ")}  ${row.key}: ${row.plan}${color.dim(lifetime)}`);
  }
  console.log(`  ${color.dim("store")}   ${credentialFile()} ${color.dim("- values are never read by Kodevra")}`);
}

function authFailure(message, hint) {
  console.error(`${color.red(message)}`);
  if (hint) console.error(`  ${color.yellow("->")} ${hint}`);
  process.exit(1);
}

/** Explicit consent before opening a browser on the user's machine. */
async function confirmAction(question, { yes = false } = {}) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function yesNo(value) {
  return value === true ? "yes" : value === false ? "no" : "?";
}

function describeAccount(account) {
  if (account.status === "cooldown") {
    return `${account.cooldown_reason ?? "cooldown"} · ${account.cooldown_remaining_sec ?? 0}s left`;
  }
  if (account.status === "no_credentials") return "session missing or expired";
  if (account.status === "busy") return `busy${account.busy_agent ? ` · ${account.busy_agent}` : ""}`;
  if (account.status === "disabled") return `paused${account.disabled_by ? ` (${account.disabled_by})` : ""}`;
  if (account.last_error?.kind) return `last error: ${account.last_error.kind}`;
  return "-";
}

function printTable(header, rows) {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => String(row[column] ?? "").length)),
  );
  const line = (cells) => cells.map((cell, column) => String(cell ?? "").padEnd(widths[column])).join("  ");
  console.log(`  ${color.dim(line(header))}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

/**
 * DeepSeek Web status: proxy health, session readiness, cooldown and the real
 * model ids. Read-only against the adapter's public endpoints.
 */
async function printAdapterStatus(config, engine) {
  console.log(`  ${color.bold("DeepSeek Web")} ${color.yellow(WEB_ADAPTER_LABEL)}`);
  const base = proxyBaseURL(config);
  const origin = proxyOrigin(base);
  if (!origin || !isLoopbackOrigin(origin)) {
    console.log(`  ${color.dim("proxy")}     ${base} ${color.red("not loopback")}`);
    const verdict = proxyVerdict({ origin });
    console.error(`  ${color.red(verdict.message)}`);
    console.error(`  ${color.yellow("->")} ${verdict.action}`);
    return false;
  }
  console.log(`  ${color.dim("proxy")}     ${origin} ${color.dim("loopback only")}`);

  const health = await readHealth(origin);
  if (!health.ok) {
    const verdict = proxyVerdict({ origin, health });
    console.log(`  ${color.dim("health")}    ${color.red("unreachable")}`);
    console.error(`  ${color.red(verdict.message)}`);
    console.error(`  ${color.yellow("->")} ${verdict.action}`);
    return false;
  }

  const summary = accountSummary(health.body);
  console.log(`  ${color.dim("health")}    ok · ${summary.total} login(s)`);
  console.log(
    `  ${color.dim("session")}   ${summary.state === "ready" ? color.green(summary.state) : color.yellow(summary.state)}`,
  );
  if (summary.accounts.length) {
    printTable(
      ["login", "status", "detail"],
      summary.accounts.map((account) => [account.name ?? account.id, account.status, describeAccount(account)]),
    );
  }

  const assessment = assessProvider("freedeepseek", { config, engine });
  console.log(
    `  ${color.dim("models")}    ${summary.modelIds.length} from /v1/models · ${assessment.models.length} selectable in opencode`,
  );
  if (assessment.models.length) console.log(`  ${color.dim("select")}    ${assessment.models.join(", ")}`);

  const verdict = proxyVerdict({ origin, health });
  if (verdict) {
    console.error(`  ${color.red(verdict.message)}`);
    console.error(`  ${color.yellow("->")} ${verdict.action}`);
    return false;
  }
  console.log(`  ${color.dim("catalog")}   kodevra providers models freedeepseek`);
  return true;
}

/** Real model ids for one provider: the proxy's own list, or the engine's. */
async function printProviderModels(key, config, engine) {
  const normalized = normalizeProvider(key);

  if (normalized === DEFAULT_PROVIDER) {
    const base = proxyBaseURL(config);
    const origin = proxyOrigin(base);
    if (!origin || !isLoopbackOrigin(origin)) {
      const verdict = proxyVerdict({ origin });
      authFailure(verdict.message, verdict.action);
    }
    const { models, capabilities, ready } = await readProxyCatalog(origin);
    const health = await readHealth(origin);
    const verdict = proxyVerdict({ origin, health, ready });
    if (verdict && !health.ok) authFailure(verdict.message, verdict.action);

    const rows = modelRows(models.body, capabilities.body);
    if (!rows.length) {
      authFailure(
        `The DeepSeek Web proxy at ${origin} listed no models on /v1/models.`,
        "Check the proxy log; Kodevra will not invent model ids.",
      );
    }
    console.log(`  ${color.bold("DeepSeek Web models")} ${color.yellow(WEB_ADAPTER_LABEL)}`);
    console.log(`  ${color.dim("source")}    ${origin}/v1/models + /v1/model-capabilities\n`);
    printTable(
      ["model", "thinking", "web search", "files", "state"],
      rows.map((row) => [
        row.id,
        yesNo(row.thinking),
        yesNo(row.search),
        yesNo(row.files),
        row.supported === false ? color.yellow(`unavailable${row.reason ? `: ${row.reason}` : ""}`) : "available",
      ]),
    );
    console.log("");
    console.log(`  ${color.dim("select")}    kodevra providers use freedeepseek/<model>   ·   kodevra run -m freedeepseek/<model> "<task>"`);
    console.log(`  ${color.dim("note")}      these ids come from the adapter; Kodevra adds none of its own`);
    if (verdict) {
      console.error(`  ${color.red(verdict.message)}`);
      console.error(`  ${color.yellow("->")} ${verdict.action}`);
    }
    return rows.length > 0;
  }

  const ids = liveEngineModels(engine, engineProviderId(normalized));
  if (ids === null) {
    authFailure(
      `The engine could not list models for ${normalized}.`,
      "Check that opencode is installed: opencode models " + engineProviderId(normalized),
    );
  }
  if (!ids.length) {
    authFailure(
      `The engine lists no models for ${normalized}.`,
      `Authenticate first: kodevra auth login ${normalized}`,
    );
  }
  console.log(`  ${color.bold(`${normalized} models`)} ${color.dim("(engine authenticated catalog)")}\n`);
  for (const id of ids) console.log(`  ${id}`);
  return true;
}

/**
 * The adapter's documented browser sign-in, run with explicit consent. The
 * session file belongs to the adapter; Kodevra never reads it.
 */
async function adapterLogin(opts, config, engine) {
  const info = adapterInfo();
  if (!info.present) {
    authFailure(
      `The FreeDeepseekAPI adapter is not installed at ${info.root}.`,
      "It is a separate Apache-2.0 project: clone it into integrations/FreeDeepseekAPI and run npm install there, then retry.",
    );
  }

  console.log(`  ${color.dim("adapter")}  ${info.root}`);
  console.log(`  ${color.dim("flow")}     scripts/deepseek_chrome_auth.js ${color.dim("(the adapter's documented sign-in)")}`);
  console.log(`  ${color.dim("what")}     a separate Chrome profile opens at chat.deepseek.com; you sign in there, send one short prompt, then press Enter here`);
  console.log(`  ${color.dim("storage")}  the adapter writes its own session file; Kodevra never reads it and never sees a cookie or token\n`);

  const agreed = await confirmAction("  Run the DeepSeek Web sign-in now? [y/N] ", opts);
  if (!agreed) {
    console.error(`${color.yellow("cancelled")} nothing was opened and nothing changed.`);
    console.error(`  ${color.yellow("->")} re-run interactively, or pass --yes once you accept the step above.`);
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [info.script], { cwd: info.root, stdio: "inherit", env: process.env });
  if (result.error) {
    authFailure(`The adapter sign-in could not start: ${result.error.message}`, "Check Node and the adapter folder, then retry.");
  }
  if ((result.status ?? 1) !== 0) {
    console.error(`\n  ${color.yellow(`the adapter exited ${result.status}`)} - Kodevra claims nothing about the session.`);
    process.exit(result.status ?? 1);
  }

  console.log(`\n  ${color.green("adapter finished")} ${color.dim("the running proxy reads session files at start")}`);
  console.log(
    `  ${color.dim("reload")}   curl -X POST ${proxyOrigin(proxyBaseURL(config))}/admin/accounts/reload ${color.dim("(or restart the proxy)")}`,
  );
  console.log("");
  const ok = await printAdapterStatus(config, engine);
  process.exit(ok ? 0 : 1);
}

async function runAuth(opts, config, selection, engine) {
  const sub = (opts.message[0] || "status").toLowerCase();

  if (sub === "status") {
    const requested = opts.message[1];
    if (requested) {
      const normalized = normalizeProvider(resolveAuthTarget(requested)?.key ?? requested);
      if (normalized === DEFAULT_PROVIDER) {
        const ok = await printAdapterStatus(config, engine);
        process.exit(ok ? 0 : 1);
      }
      const assessment = assessProvider(normalized, { config, engine });
      if (!assessment.available) {
        authFailure(`Unknown provider "${requested}".`, `Known providers: ${PRESET_KEYS.join(", ")}`);
      }
      console.log(`  ${color.bold(assessment.label)}\n`);
      console.log(`  ${color.dim("state")}    ${assessment.state}`);
      console.log(`  ${color.dim("credential")} ${assessment.credentialed ? assessment.credential.source : assessment.detail}`);
      if (assessment.plan) console.log(`  ${color.dim("plan")}     ${assessment.plan}`);
      if (assessment.models.length) console.log(`  ${color.dim("models")}   ${assessment.models.slice(0, 8).join(", ")}${assessment.models.length > 8 ? " ..." : ""}`);
      if (assessment.hint) console.log(`  ${color.yellow("->")} ${assessment.hint}`);
      process.exit(assessment.ready ? 0 : 1);
    }
    printAuthStatus(config, selection, engine);
    return;
  }

  if (sub !== "login") {
    console.error(`${color.red(`Unknown auth command: ${sub}`)} (login, status)`);
    process.exit(2);
  }

  const requested = opts.message[1];
  if (!requested) {
    console.error(`${color.red("kodevra auth login needs a provider:")} kodevra auth login chatgpt|openai|google-api|deepseek|openrouter`);
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

  if (target.kind === "adapter") {
    await adapterLogin(opts, config, engine);
    return;
  }

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
      `OpenCode stored no ${target.label} credential (exit ${result.status}).`,
      `The sign-in was cancelled, timed out, or the account is not eligible for this flow. Nothing was changed; retry with: kodevra auth login ${target.key}`,
    );
  }

  if (result.status !== 0) {
    console.log(`  ${color.yellow(`OpenCode exited ${result.status}; existing credentials are unchanged.`)}`);
  }

  const readiness = assessProvider(target.key, { config, engine });
  console.log(`  ${color.green("verified")} credentials present in ${credentialFile()} ${color.dim("(values not read)")}`);
  console.log(`  ${color.dim("state")}   ${readiness.state} · ${readiness.credential.source}`);
  if (readiness.plan) {
    const lifetime = readiness.plan === "chatgpt" ? ` · ${describeOAuthStatus(oauthStatus(readiness.engineId))}` : "";
    console.log(`  ${color.dim("plan")}    ${readiness.plan}${color.dim(lifetime)}`);
  }
  const models = readiness.models.slice(0, 6);
  if (models.length) {
    console.log(`  ${color.dim("models")}  ${models.join(", ")}${readiness.models.length > models.length ? " ..." : ""}`);
    console.log(`  ${color.dim("source")}  ${readiness.planSource}`);
  } else if (readiness.plan === "chatgpt") {
    console.log(`  ${color.yellow("models")}  the engine lists no openai models yet: opencode models --refresh`);
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
  const engine = findExecutable("opencode");

  if (opts.command === "version") {
    const selection = activeSelection({ config: config.data, engine });
    const version = engine
      ? `${spawnSync(engine.command, ["--version"], { encoding: "utf8", timeout: 20000, shell: engine.shell }).stdout || ""}`.trim()
      : "not installed";
    console.log(
      `${PRODUCT} ${VERSION} · engine opencode ${version || "unknown"} · model ${fullModel(selection)} (${selection.source})`,
    );
    return;
  }

  if (opts.command === "init") {
    let result;
    try {
      result = await runInit({ requestedProvider: opts.provider, yes: opts.yes });
    } catch (error) {
      console.error(color.red(error.message));
      if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
      process.exit(2);
    }
    process.exit(result.ok || result.cancelled ? 0 : 1);
  }

  const selection = activeSelection({
    flagModel: opts.model,
    flagProvider: opts.provider,
    config: config.data,
    engine,
  });
  const assessment = assessProvider(selection.provider, { config: config.data, engine });

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

  let mode;
  try {
    mode = resolveMode(opts);
  } catch (error) {
    console.error(color.red(error.message));
    process.exit(2);
  }

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`${color.red("Workspace not found:")} ${workspace}`);
    console.error(`  ${color.yellow("->")} pass an existing directory: kodevra <path>`);
    process.exit(2);
  }

  const authLine = assessment.ready
    ? `${assessment.state} · ${assessment.credential.source}`
    : `${assessment.state} · ${assessment.detail}`;
  const activeMode = opts.command === "run" || opts.command === "launch" ? `${mode.name} - ${mode.description}` : null;

  if (opts.command === "providers") {
    if ((opts.message[0] || "list").toLowerCase() === "list") {
      console.log(banner({ model, workspace, engine: "opencode", auth: authLine }));
    }
    await providerCommand(opts, config.data, selection, engine);
    return;
  }

  if (opts.command === "auth") {
    if ((opts.message[0] || "status").toLowerCase() === "status") {
      console.log(banner({ model, workspace, engine: "opencode", auth: authLine }));
    }
    await runAuth(opts, config.data, selection, engine);
    return;
  }

  console.log(
    header({
      workspace,
      model,
      provider: assessment.label,
      auth: authLine,
      sandbox: sandboxStatusLine(),
      mode: activeMode,
      engine: "opencode",
      hints: opts.command === "launch" || opts.command === "run",
    }),
  );

  // Sessions stay in OpenCode's own local store; Kodevra only makes them
  // reachable from its own command surface (FRD J-06).
  if (opts.command === "sessions") {
    if (!engine) {
      console.error(color.red("OpenCode is not installed. Install it with: npm i -g opencode-ai"));
      process.exit(1);
    }
    const result = await streamEngine(engine, ["session", "list"], { cwd: workspace });
    console.log("");
    console.log(`  ${color.dim("resume")} kodevra run -c "<task>"   ·   kodevra -c   ·   kodevra run -s <id> "<task>"`);
    process.exit(result.status);
  }

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

  if (!engine) {
    console.error(color.red("OpenCode is not installed. Install it with: npm i -g opencode-ai"));
    process.exit(1);
  }

  if (opts.command === "run") {
    await executeRun({ engine, opts, workspace, model, selection, assessment });
    return;
  }

  if (opts.verify) {
    console.error(`${color.yellow("--verify is only used by kodevra run")} ${color.dim("(the interactive session has no headless result to check)")}`);
  }

  const args = buildArgs(opts, engineModel(selection), workspace);
  console.log(`${color.dim("kodevra")} ${color.dim("->")} opencode ${visibleArgs(args).join(" ")}`);
  console.log("");

  start(engine, args, workspace, planRunEnv(selection, assessment).env);
}

main().catch((error) => {
  console.error(color.red(error.stack || error.message));
  process.exit(1);
});
