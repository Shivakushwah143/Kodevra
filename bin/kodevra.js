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
import { unavailableTools, writePermissionOverlay } from "../lib/permissions.js";
import { createVerificationAuthorization, authorizationDrift, renewAgentSurface, renewAuthorization } from "../lib/authorization.js";
import { deriveContract, summarizeContract } from "../lib/verification-contract.js";
import { captureContractBaseline, runContractVerification } from "../lib/verification-runner.js";
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
import {
  describeProfile,
  modelConfigBlock,
  modelProfile,
  resolveEffort,
  resolveOutputTokens,
} from "../lib/model-profile.js";
import { createTrace } from "../lib/trace.js";
import {
  buildCodexArgs,
  codexFailureText,
  codexSandbox,
  parseCodexEvents,
  readCodexCatalog,
  readCodexConfig,
  renderCodexRun,
  resolveCodexRun,
} from "../lib/codex.js";
import { bundledCatalog, normalizeSpeed, planFastSpeed } from "../lib/codex-catalog.js";
import { HARNESS_NAMES, activeHarness, harnessRows, harnessStatus, normalizeHarness } from "../lib/harness.js";
import { normalizeOutcome, writeOutcome } from "../lib/outcome.js";
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
  CHATGPT_WEB_MODEL,
  CHATGPT_WEB_PROVIDER,
  LIMITS,
  bridgeSettings,
  chatGptWebAssessment,
  chatTurn,
  probeBridge,
  readWebSession,
  writeWebSession,
} from "../lib/chatgpt-web.js";
import { runChatGptWebAgent } from "../lib/chatgpt-web-agent.js";
import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../lib/approval-policy.js";
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
  readState,
  withoutApiKeyBilling,
  writeState,
} from "../lib/providers.js";
import { createTimings, timingsLine } from "../lib/timings.js";
import { buildWorkspacePacket, withWorkspacePacket } from "../lib/packet.js";

/** Anchor for phase timings: everything after this point is measured, not inferred. */
const PROCESS_STARTED_AT = Date.now();

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
  kodevra engines             list execution engines and their readiness
  kodevra engines use <name>  select opencode (default) or codex for future runs
  kodevra engines current     show the active execution engine
  kodevra run -p chatgpt-web "<task>"  EXPERIMENTAL: the ordinary ChatGPT web tab through a local
                              chatgpt-bridge (no API key, no engine tool calls)
  kodevra auth login chatgpt  sign in with a ChatGPT Plus/Pro account (OpenCode's official OAuth)
  kodevra auth login deepseek-web  run the FreeDeepseekAPI adapter's own browser sign-in
  kodevra auth login <p>      sign in to any provider through OpenCode's official flow
  kodevra auth status [p]     authentication state, plan, proxy health and cooldown
  kodevra <cmd> -- <args>     forward arguments to OpenCode

${color.bold("Options")}
  -w, --workspace <path>      workspace to run in
  -p, --provider <key>        provider for this run (default: ${DEFAULT_PROVIDER})
  -m, --model <provider/model>  default: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}
      --engine <name>         execution engine: opencode (default) | codex
      --agent <name>          OpenCode agent to use (default: build, or plan in read-only)
      --mode <mode>           read-only | ask | workspace-write
                              (default: workspace-write for run, ask for launch)
      --speed <mode>          default | fast - Codex only; fast selects Codex's
                              advertised priority service tier for this run
      --verify <command>      run this command after the task; its exit code decides PASS/FAIL
      --runtime, --no-runtime  after --verify passes, prove the built software actually runs
                              (runtime adapter + acceptance; default: on)
      --max-repairs <n>       bounded repairs after a failed verification (default: 2);
                              ChatGPT-web counts repeated failures against the same edits
      --max-turns <n>         ChatGPT-web only: turns one task may use (default: 8, ceiling: ${LIMITS.maxTurnCeiling})
      --approval <mode>       ChatGPT-web only: ${APPROVAL_MODES.join(" | ")} (default: ${DEFAULT_APPROVAL_MODE})
                              strict needs approval for execution-surface changes; autonomous is for disposable workspaces
      --reasoning <level>     reasoning effort passed to OpenCode (--variant); validated against the
                              model catalog, e.g. low | medium | high | xhigh
      --output-tokens <n>     cap the model's output budget for this run (OpenCode model limit);
                              aggregators reserve it up front, so a small balance needs a cap
      --trace                 keep the engine's native --format json stream and report steps, tool
                              calls, tokens and cost for the run (OpenCode)
      --context, --no-context give Codex the workspace facts Kodevra measured first
                              (root, files, pre-flight failure output, shell notes;
                              on by default for run --engine codex)
  -c, --continue              continue the last session
  -s, --session <id>          continue a specific session
      --executor <name>       where project commands run: host | docker (default: host,
                              or docker when --verify is available). Applies to --verify and
                              to the ChatGPT-web shell; docker also enables sandbox_exec for OpenCode
      --reapprove <sha256>    renew host-execution authorization for that exact changed
                              surface (the fingerprint is printed when it refuses)
      --timeout <seconds>     wall-clock limit for one agent call (default 1800);
                              for --provider chatgpt-web it is the model-turn deadline
                              (one hour when omitted), enforced by polling a durable
                              bridge request, never by one long HTTP connection
      --idle-timeout <secs>   cancel an agent call with no output for this long (default 300);
                              chatgpt-web ignores it: a browser reasoning silently is not
                              idle, and its turn is bounded by --timeout
      --events-json           stream structured execution events to stderr
      --outcome <file>        write the normalised run outcome as JSON to this file
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
  KODEVRA_ENGINE              default execution engine (opencode | codex)
  KODEVRA_SKIP_DOCTOR=1       skip diagnostics
  OPENCODE_BIN                path to the OpenCode executable
  OPENCODE_CONFIG             path to the OpenCode config file
  KODEVRA_CODEX_BIN           path to the Codex CLI executable
  CODEX_HOME                  Codex's own config and credential directory
  KODEVRA_STATE               path to Kodevra's provider selection state
`;

// Phase marks: how long each Kodevra-side step took, relative to this process
// starting. They are written into the run's event log (metadata only) so a run
// can be split into bootstrap / engine startup / model / verification instead of
// guessing where the seconds went.
const phaseMarks = [];

function phaseMark(name, extra = {}) {
  const entry = { name, ms: Date.now() - PROCESS_STARTED_AT, ...extra };
  phaseMarks.push(entry);
  return entry;
}

const VALUE_FLAGS = new Set([
  "-w",
  "--workspace",
  "-m",
  "--model",
  "-p",
  "--provider",
  "--agent",
  "--mode",
  "--speed",
  "--verify",
  "--max-repairs",
  "--max-turns",
  "--approval",
  "-s",
  "--session",
  "--executor",
  "--reapprove",
  "--timeout",
  "--idle-timeout",
  "--reasoning",
  "--output-tokens",
  "--engine",
  "--outcome",
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
  "engines",
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
    engine: null,
    outcome: null,
    agent: null,
    auto: false,
    autoExplicit: false,
    doctor: true,
    help: false,
    headless: false,
    mode: null,
    speed: "default",
    verify: null,
    runtime: true,
    maxRepairs: 2,
    maxTurns: null,
    approval: null,
    session: null,
    continueSession: false,
    executor: null,
    executorExplicit: false,
    reapprove: null,
    eventsJson: false,
    context: true,
    yes: false,
    agentTimeoutMs: null,
    agentIdleMs: null,
    reasoning: null,
    reasoningEffort: null,
    outputTokens: null,
    trace: false,
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
    else if (arg === "--engine") opts.engine = argv[(index += 1)];
    else if (arg === "--outcome") opts.outcome = argv[(index += 1)];
    else if (arg === "--agent") opts.agent = argv[(index += 1)];
    else if (arg === "--auto") {
      opts.auto = true;
      opts.autoExplicit = true;
    } else if (arg === "--no-auto") {
      opts.auto = false;
      opts.autoExplicit = true;
    } else if (arg === "--headless") opts.headless = true;
    else if (arg === "--mode") opts.mode = argv[(index += 1)];
    else if (arg === "--speed") opts.speed = argv[(index += 1)];
    else if (arg === "--verify") opts.verify = argv[(index += 1)];
    else if (arg === "--no-runtime") opts.runtime = false;
    else if (arg === "--runtime") opts.runtime = true;
    else if (arg === "--max-repairs") opts.maxRepairs = Number(argv[(index += 1)]);
    else if (arg === "--approval") opts.approval = argv[(index += 1)] || null;
    else if (arg === "--max-turns") {
      // A budget the user typed must be the budget that runs. Refuse values the
      // loop cannot honour instead of silently falling back to the default.
      const raw = argv[(index += 1)];
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxTurnCeiling) {
        throw new Error(`--max-turns needs a whole number from 1 to ${LIMITS.maxTurnCeiling}; got "${raw ?? ""}".`);
      }
      opts.maxTurns = value;
    } else if (arg === "-s" || arg === "--session") opts.session = argv[(index += 1)];
    else if (arg === "-c" || arg === "--continue") opts.continueSession = true;
    else if (arg === "--executor") {
      opts.executor = argv[(index += 1)] || "host";
      opts.executorExplicit = true;
    } else if (arg === "--reapprove") opts.reapprove = argv[(index += 1)] || null;
    else if (arg === "--timeout") opts.agentTimeoutMs = Math.max(1, Number(argv[(index += 1)]) || 0) * 1000;
    else if (arg === "--idle-timeout") opts.agentIdleMs = Math.max(1, Number(argv[(index += 1)]) || 0) * 1000;
    else if (arg === "--reasoning") opts.reasoning = argv[(index += 1)] || null;
    else if (arg === "--output-tokens") opts.outputTokens = Number(argv[(index += 1)]) || null;
    else if (arg === "--trace") opts.trace = true;
    else if (arg === "--events-json") opts.eventsJson = true;
    else if (arg === "--context") opts.context = true;
    else if (arg === "--no-context") opts.context = false;
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

/**
 * One line of sandbox truth for the startup panel: probe only, never pull.
 *
 * Docker is only part of a run that will actually use it. With the host executor
 * nothing is containerised - and probing anyway costs 200-400 ms on a machine
 * where the engine is stopped, for a line the user cannot act on. `null` means
 * "the default executor decides" (`--verify` without `--executor`), which is the
 * one case where the answer is about to matter.
 */
function sandboxStatusLine(executorName = "host") {
  if (process.env.KODEVRA_SKIP_DOCKER_PROBE === "1") return color.dim("probe skipped");
  if (executorName !== "docker" && executorName !== null) return color.dim("host executor - nothing containerised");
  const probe = probeDocker();
  return probe.ok
    ? color.green(probe.detail)
    : `${color.yellow("unavailable")}${color.dim(` · ${probe.detail}`)}`;
}

/** Which executor `executeRun` will use, without paying a Docker probe to know. */
function executorNameForDisplay(opts) {
  if (opts.executor) return String(opts.executor).toLowerCase();
  return opts.verify ? null : "host";
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
 * changes nobody has seen yet. Autonomous runs rebind their own edits first (see
 * renewAgentSurface); strict and balanced still stop here.
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

async function runVerificationWithEvents({ executor, command, workspace, events, attempt, contract = null, includeRuntime = true }) {
  events.emit("verification_started", {
    command,
    executor: executor.name,
    sandboxed: executor.sandboxed,
    attempt,
    contract: contract
      ? { project: contract.project.kind, gates: contract.repository.map((gate) => gate.command) }
      : null,
  });
  console.log(`\n  ${color.dim("verify ")} ${command}`);
  let result;
  try {
    // The contract runs cheapest-first and returns the same result shape the
    // single-command path returns; only its evidence is richer.
    result = contract
      ? await runContractVerification({
          contract,
          workspace,
          executor,
          includeRuntime,
          onGate: (gate) => {
            events.emit("verification_gate", {
              id: gate.id,
              layer: gate.layer,
              ok: Boolean(gate.ok),
              skipped: Boolean(gate.skipped),
              blocking: Boolean(gate.blocking),
              status: gate.status ?? null,
              code: gate.code ?? null,
              duration_ms: gate.durationMs ?? null,
              attempt,
            });
            const state = gate.skipped ? color.dim("skip") : gate.ok ? color.green("pass") : color.red("fail");
            console.log(`  ${color.dim("gate  ")} ${gate.layer}:${gate.id} ${color.dim(trim(gate.command ?? "", 64))} -> ${state}`);
          },
        })
      : await executor.run(command, { cwd: workspace });
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
    contract: result.contract
      ? { project: result.contract.project?.kind ?? null, verdict: result.verdict ?? null, failed: result.failedGates ?? [] }
      : null,
  });
  return result;
}

/**
 * Phase marks taken from Codex's own streamed events. `spawn` is the anchor, so
 * "first edit" really is spawn + the timestamp of Codex's file_change event,
 * not an average or an estimate from the total duration.
 */
function markCodexPhases(timings, evidence) {
  const spawnAt = timings.at("spawn");
  if (spawnAt === null) return;
  if (Number.isFinite(evidence.firstEventAt)) timings.markAt("first_event", spawnAt + evidence.firstEventAt);
  const tool = (evidence.commands ?? []).find((command) => Number.isFinite(command.at_ms));
  if (tool) timings.markAt("first_tool", spawnAt + tool.at_ms);
  const edit = (evidence.fileChanges ?? []).find((change) => Number.isFinite(change.at_ms));
  if (edit) timings.markAt("first_edit", spawnAt + edit.at_ms);
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
async function executeRun({
  engine,
  harness,
  harnessInfo,
  codexTarget,
  opts,
  workspace,
  model,
  selection,
  assessment,
  modelConfig = null,
  codexSpeed = null,
  speedConfig = [],
  stopSpeed = () => {},
  timings = createTimings(PROCESS_STARTED_AT),
  chatGptWeb = false,
  bridge = null,
}) {
  const startedAt = Date.now();
  const before = workspaceChanges(workspace).files;
  const beforeTree = snapshotTree(workspace);
  timings.mark("workspace_scan");
  const maxRepairs = Number.isFinite(opts.maxRepairs) ? Math.max(0, Math.min(5, opts.maxRepairs)) : 2;
  // The ChatGPT-web turn budget is per run and already validated against the
  // finite ceiling in parse(); a plain run ignores it entirely.
  const webTurns = opts.maxTurns ?? LIMITS.maxTurns;
  // For chatgpt-web this is the model-turn deadline, not an HTTP timeout: the
  // durable transport submits a turn and polls briefly, so --timeout bounds how
  // long the model may take rather than how long a socket may stay silent.
  const webTurnDeadlineMs = opts.agentTimeoutMs ?? LIMITS.turnTimeoutMs;
  const mode = resolveMode(opts);
  const agentTimeoutMs = opts.agentTimeoutMs ?? Number(process.env.KODEVRA_RUN_TIMEOUT_MS || 1_800_000);
  const agentIdleMs = opts.agentIdleMs ?? Number(process.env.KODEVRA_RUN_IDLE_MS || 300_000);

  let executor;
  let executorInfo = null;
  try {
    executor = resolveExecutor(opts.executor || (opts.verify ? defaultVerifyExecutor() : "host"));
    if ((opts.verify || (chatGptWeb && executor.name === "docker")) && executor.check) {
      executorInfo = await executor.check();
    }
  } catch (error) {
    console.error(color.red(error.message));
    if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
    console.error(
      `${color.dim(
        chatGptWeb && executor?.name === "docker"
          ? "No task was started: the selected executor is unavailable and Kodevra will not fall back to the host."
          : "No verification ran, and Kodevra did not fall back to the host executor.",
      )}`,
    );
    process.exit(2);
  }
  phaseMark("executor_ready", { executor: executor.name, checked: Boolean(executorInfo) });

  // sandbox_exec is an OpenCode tool, so it only exists for OpenCode runs with
  // the Docker executor. Codex brings its own sandbox; the ChatGPT-web loop has
  // no engine tools at all, and its `shell` action runs through this same
  // executor directly instead of attaching a tool.
  const sandboxExec = harness === "opencode" && executor.name === "docker" && !chatGptWeb;
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
  // Everything Kodevra did before this run started is still worth timing, so the
  // marks collected during bootstrap are replayed into the run's own log.
  for (const entry of phaseMarks) events.emit("phase", entry);
  const markNow = (name, extra = {}) => events.emit("phase", phaseMark(name, extra));

  // A tool this run can never execute is not offered to the model: OpenCode's
  // native per-agent `tools` map removes it from the request instead of rejecting
  // the call after the model has already spent a turn on it. Codex loads no
  // OpenCode tools, so there is nothing to hide for it.
  const hiddenTools = harness === "opencode" && !chatGptWeb ? unavailableTools({ agent: mode.agent }) : null;

  //
  // Codex is different by design: its sandbox flag is the policy, and Codex
  // reads neither OPENCODE_CONFIG nor OpenCode tools. Kodevra therefore adds no
  // overlay for it and keeps the developer's environment untouched.
  let scope;
  if (chatGptWeb) {
    // chatgpt-bridge is a browser transport, not an engine: no OpenCode overlay,
    // no engine process, no environment rewriting.
    scope = { env: { ...process.env }, warnings: [], cleanup() {} };
  } else if (harness === "codex") {
    try {
      codexSandbox(mode.name);
    } catch (error) {
      console.error(color.red(error.message));
      if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
      console.error(color.dim("No task was started."));
      process.exit(2);
    }
    scope = { env: { ...process.env }, warnings: [], cleanup() {} };
  } else {
    try {
      scope = writePermissionOverlay({ workspace, mode: mode.name, sandboxExec, modelConfig, hiddenTools });
    } catch (error) {
      console.error(color.red(error.message));
      if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
      console.error(color.dim("No task was started: the workspace policy could not be enforced."));
      process.exit(2);
    }
  }
  markNow("overlay_written");
  if (sandboxExec) {
    Object.assign(scope.env, {
      KODEVRA_SANDBOX_EXEC: "1",
      KODEVRA_HOME: path.resolve(import.meta.dirname, ".."),
      KODEVRA_WORKSPACE: workspace,
      KODEVRA_RUN_ID: events.runId,
      KODEVRA_RUN_FILE: events.file ?? "",
    });
  }
  if (harness === "opencode" && !chatGptWeb) {
    const planEnv = planRunEnv(selection, assessment, scope.env);
    scope.env = planEnv.env;
    if (planEnv.stripped) {
      console.log(
        `  ${color.dim("plan   ")} ChatGPT plan - OPENAI_API_KEY was not passed to the engine ${color.dim("(no API billing)")}`,
      );
    }
  }
  if (scope.warnings?.length) {
    for (const warning of scope.warnings) console.log(`  ${color.yellow("scope  ")} ${warning}`);
  }
  if (chatGptWeb) {
    const shellScope = executor.sandboxed
      ? `shell follows --executor ${executor.name} (ephemeral snapshot; shell changes are discarded)`
      : "shell runs on the host against the workspace (not sandboxed)";
    console.log(`  ${color.dim("scope  ")} ${workspace} ${color.dim(`- file tools confined here; ${shellScope}`)}`);
  } else if (harness === "codex") {
    if (codexTarget.note) console.log(`  ${color.yellow("model  ")} ${codexTarget.note}`);
    console.log(
      `  ${color.dim("scope  ")} ${workspace} ${color.dim(`- codex sandbox ${mode.name === "read-only" ? "read-only" : "workspace-write"}`)}`,
    );
    if (codexSpeed?.requested === "fast") {
      const catalog = codexSpeed.catalog_source === "bundled+user" ? "merged temp catalog" : "bundled catalog";
      console.log(
        `  ${color.dim("speed  ")} fast ${color.dim("->")} service_tier ${codexSpeed.effective_service_tier} ${color.dim(
          `· ${codexSpeed.model} · ${catalog} (${codexSpeed.catalog_models} models)`,
        )}`,
      );
    }
  } else {
    console.log(`  ${color.dim("scope  ")} ${workspace} ${color.dim("- file tools confined here; shell needs approval")}`);
    if (hiddenTools) {
      console.log(
        `  ${color.dim("tools  ")} bash hidden on agent ${hiddenTools.agent} ${color.dim("absent from the model's tool set (no shell in this run)")}`,
      );
    }
  }
  if (chatGptWeb) {
    console.log(
      `${color.dim("kodevra")} ${color.dim("->")} chatgpt-bridge ${bridge.baseURL.replace(/^https?:\/\//, "")} ${color.dim(
        "- textual action protocol, no native tool calls",
      )}`,
    );
  } else {
    console.log(
      `${color.dim("kodevra")} ${color.dim("->")} ${harness} ${visibleArgs(
        withProbePrefix(harness, harnessInfo, agentInvocation({ harness, opts, workspace, selection, mode, codexTarget })),
      ).join(" ")}`,
    );
  }
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
    harness,
    provider: selection.provider,
    plan: assessment?.plan ?? null,
    mode: mode.name,
    executor: executor.name,
    sandboxed: executor.sandboxed,
    image: executorInfo?.image ?? null,
    sandbox_exec: sandboxExec,
    hidden_tools: hiddenTools ? [`${hiddenTools.agent}:bash`] : [],
    shell_executor: chatGptWeb ? executor.name : null,
    verify: opts.verify ?? null,
  });
  events.emit("speed_selected", codexSpeed ?? { requested: "default", effective_service_tier: null });

  let authorization = null;
  if (opts.verify) {
    try {
      authorization = createVerificationAuthorization({ workspace, command: opts.verify });
      timings.mark("authorization");
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

  // ---- verification contract ------------------------------------------------
  // Derived locally from the workspace, once, before implementation starts, then
  // frozen for the run: repository gates, one runtime adapter, and any acceptance
  // criteria from workspace configuration. The model is never asked what kind of
  // project this is and cannot weaken the contract later.
  let contract = null;
  if (opts.verify) {
    try {
      contract = deriveContract({ workspace, verifyCommand: opts.verify, runtime: opts.runtime !== false });
    } catch (error) {
      console.error(`  ${color.yellow("contract")} could not be derived: ${error.message}`);
      contract = null;
    }
    if (contract) {
      if (contract.repository.some((gate) => gate.cheap)) {
        // Cheap static analysers only, run before mutation, so a failure that was
        // already there is never blamed on this run.
        const captured = await captureContractBaseline({ contract, workspace, executor });
        if (captured.baseline) contract.baseline = captured.baseline;
      }
      const runtimeLabel = contract.runtime
        ? `${contract.runtime.adapter}${contract.runtime.mode === "static" ? " (static)" : ""}`
        : "none";
      const baselineFailures = Object.entries(contract.baseline?.gates ?? {})
        .filter(([, entry]) => !entry.ok)
        .map(([id]) => id);
      console.log(
        `  ${color.dim("contract")} ${contract.project.kind} · ${contract.repository.length} repository gate(s) · runtime ${runtimeLabel}${
          contract.acceptance.length ? ` · ${contract.acceptance.length} acceptance` : ""
        }${baselineFailures.length ? color.yellow(` · baseline failures: ${baselineFailures.join(", ")}`) : ""}`,
      );
      for (const warning of contract.warnings) console.log(`  ${color.yellow("contract")} ${warning}`);
      events.emit("verification_contract", {
        ...summarizeContract(contract),
        runtime_enabled: opts.runtime !== false,
      });
      timings.mark("contract");
    }
  }
  console.log("");  // Pre-flight + workspace facts for Codex. One extra run of the verification
  // command, *before* the agent starts, turns "the tests fail somewhere" into
  // evidence the model can act on, instead of something it has to rediscover a
  // turn at a time. It is skipped for a sandboxed executor (the container run is
  // the expensive one) and can be turned off with --no-context.
  const wantsContext = harness === "codex" && opts.context !== false && opts.message.length > 0;
  let packet = null;
  if (wantsContext) {
    let preflight = null;
    if (opts.verify && executor.name === "host") {
      events.emit("preflight_started", { command: opts.verify });
      const preflightStartedAt = Date.now();
      try {
        // Quiet: the output is captured for the packet, not sprayed into the
        // terminal before the run has even started.
        preflight = await executor.run(opts.verify, { cwd: workspace, forward: false });
      } catch (error) {
        preflight = { command: opts.verify, ok: false, status: 1, output: error.message, durationMs: 0 };
      }
      timings.mark("preflight");
      const preflightMs = Date.now() - preflightStartedAt;
      events.emit("preflight_finished", {
        command: opts.verify,
        ok: Boolean(preflight?.ok),
        status: preflight?.status ?? null,
        duration_ms: preflightMs,
      });
      console.log(
        `  ${color.dim("preflight")} ${opts.verify} ${color.dim("->")} ${
          preflight?.ok ? color.green("exit 0") : color.yellow(`exit ${preflight?.status ?? "?"}`)
        } ${color.dim(`(${(preflightMs / 1000).toFixed(1)}s)`)}`,
      );
    }
    const knownFiles = [...beforeTree.files.keys()].sort();
    packet = buildWorkspacePacket({ workspace, verify: opts.verify, verification: preflight, files: knownFiles });
    console.log(
      `  ${color.dim("context ")} ${knownFiles.length} file(s)${preflight ? " + pre-flight output" : ""} ${color.dim("- facts only; the task text is unchanged")}`,
    );
  }

  let run = { status: 1, signal: null, output: "", durationMs: 0 };
  let failure = null;
  // The post-agent git view is computed once and reused by the outcome, instead
  // of asking git the same question twice in one run.
  let changesAfterRun = null;

  let verification = null;
  let repairs = 0;
  let approval = null;
  let sandboxCommands = 0;
  let codexEvidence = null;

  // --trace keeps the engine's own JSON event stream: one line per step, plus the
  // real token counts and cost the engine reports for itself. Codex already
  // emits JSONL of its own, which is parsed as evidence instead.
  const trace = opts.trace && harness === "opencode" ? createTrace() : null;
  const traceSink = trace
    ? (line) => {
        for (const output of trace.ingestLine(line)) if (String(output).trim()) console.log(output);
      }
    : null;
  // One invocation shape for both harnesses: the probe path, the prefix
  // arguments and the line handling differ, not the clock, the scope or the log.
  const runAgent = async (args, attempt) => {
    if (trace) trace.beginCall();
    markNow("engine_spawn", { attempt });
    const codexLines = [];
    const result = await streamEngine(harnessInfo.probe, withProbePrefix(harness, harnessInfo, args), {
      cwd: workspace,
      env: scope.env,
      timeoutMs: agentTimeoutMs,
      idleMs: agentIdleMs,
      // Codex's JSONL is evidence, not terminal output; it is rendered compactly
      // below and kept in the run log.
      forward: harness !== "codex",
      forwardStdout: !trace,
      onLine: harness === "codex" ? (line, at) => codexLines.push({ line, at }) : traceSink,
      onFirstByte: () => markNow("engine_first_byte", { attempt }),
    });
    if (harness === "codex") {
      codexEvidence = parseCodexEvents(codexLines.length ? codexLines : result.output);
      for (const line of renderCodexRun(codexEvidence)) console.log(line);
    }
    const metrics = trace ? trace.endCall() : null;
    if (metrics) events.emit("model_metrics", { attempt, ...metrics });
    return result;
  };

  // ---- experimental ChatGPT-web controller -------------------------------
  // The bridge returns plain assistant text, so Kodevra owns the tool loop.
  // Verification is still the developer's `--verify` command through the same
  // executor and the same authorization gate.
  const webSession = chatGptWeb
    ? opts.continueSession || opts.session
      ? readWebSession(workspace)
      : null
    : null;
  let webState = null;
  let webReauthorizations = 0;

  const runWebVerification = async (attempt, { changedFiles = [], approval: requestedApproval = null } = {}) => {
    const policy = requestedApproval ?? normalizeApprovalMode(opts.approval) ?? DEFAULT_APPROVAL_MODE;
    let gate = verificationGate({ authorization, workspace, command: opts.verify, reapprove: opts.reapprove });
    if (!gate.ok && !gate.fingerprintMismatch) {
      // Test/config work is normal coding. Balanced re-authorizes the agent's own
      // test-surface edits; autonomous also re-authorizes manifests, lockfiles and
      // build config this run created, because the workspace was empty when the
      // command was authorized. Strict still needs the developer.
      const renewal = renewAgentSurface({
        authorization,
        drift: gate.drift,
        workspace,
        command: opts.verify,
        approval: policy,
        changedFiles,
        renewals: webReauthorizations,
      });
      if (renewal.ok && renewal.renewed) {
        authorization = renewal.authorization;
        webReauthorizations += 1;
        gate = { ok: true };
        events.emit("verification_reauthorized", {
          command: opts.verify,
          policy,
          changed: renewal.drift.changed,
          added: renewal.drift.added,
          removed: renewal.drift.removed,
          fingerprint: authorization.fingerprint,
          source: authorization.source,
        });
        console.log(
          `  ${color.dim("gate    ")} ${policy === "autonomous" ? "surface" : "test surface"} re-authorized by the agent ${color.dim(
            `· ${renewal.drift.changed.length + renewal.drift.added.length + renewal.drift.removed.length} file(s) · sha256 ${authorization.fingerprint.slice(0, 12)}`,
          )}`,
        );
      } else if (renewal.reason) {
        events.emit("verification_reauthorization_refused", { command: opts.verify, reason: renewal.reason });
      }
    }
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
      return {
        command: opts.verify,
        ok: false,
        refused: true,
        status: null,
        output: "verification refused - approval required",
        durationMs: 0,
      };
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
    const result = await runVerificationWithEvents({
      executor,
      command: opts.verify,
      workspace,
      events,
      attempt,
      contract,
      includeRuntime: opts.runtime !== false,
    });
    timings.mark("verification");
    return result;
  };

  const formatWebElapsed = (ms) => {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  };

  // Live display of the streamed response. The durable answer still prints
  // nowhere else: this state only mirrors text so a long turn is visible while
  // it happens, and it is always closed before any ordinary status line.
  let webStreamOpen = false;
  let webStreamLength = 0;
  const closeWebStream = () => {
    if (!webStreamOpen) return;
    process.stdout.write("\n");
    webStreamOpen = false;
  };
  const writeWebDelta = (text) => {
    if (!text) return;
    if (!webStreamOpen) {
      process.stdout.write(`  ${color.dim("chatgpt >")} `);
      webStreamOpen = true;
    }
    process.stdout.write(text);
  };
  const printWebStreamEvent = (event) => {
    if (event.stream === "response.started") {
      closeWebStream();
      webStreamLength = 0;
      return;
    }
    if (event.stream === "response.delta") {
      let delta = `${event.delta ?? ""}`;
      if (!delta) return;
      // Resume from what the terminal already shows: a reconnect can replay an
      // overlapping delta, but it must never repeat text on screen.
      const answerLength = Math.max(0, Number(event.answerLength) || 0);
      if (answerLength > 0) {
        const start = answerLength - delta.length;
        if (start < webStreamLength) delta = delta.slice(webStreamLength - start);
        else if (start > webStreamLength) delta = "";
      }
      if (!delta) return;
      writeWebDelta(delta);
      webStreamLength += delta.length;
      return;
    }
    if (event.stream === "response.completed" || event.stream === "response.recovering") closeWebStream();
  };

  const printWebEvent = (event) => {
    if (event.type !== "stream") closeWebStream();
    if (event.type === "stream") {
      printWebStreamEvent(event);
    } else if (event.type === "bootstrap") {
      console.log(
        `  ${color.dim("context ")} gathered locally in ${event.ms} ms · ${event.chars} chars${event.detail ? color.dim(` · ${trim(event.detail, 80)}`) : ""}`,
      );
    } else if (event.type === "waiting") {
      const turn = event.turn ? color.dim(` (turn ${event.turn}/${webTurns})`) : "";
      console.log(`  ${color.dim("chatgpt")} waiting for ChatGPT...${turn}`);
    } else if (event.type === "progress") {
      // A long turn reports its state, not every poll: the transport throttles.
      const turn = event.turn ? color.dim(` · turn ${event.turn}/${webTurns}`) : "";
      const request = event.requestId ? color.dim(` · request ${String(event.requestId).slice(0, 8)}`) : "";
      if (event.stage === "submitted") {
        console.log(`  ${color.dim("chatgpt")} submitted${request}${turn}`);
      } else if (event.stage === "recovering") {
        console.log(`  ${color.yellow("chatgpt")} recovering browser connection · ${formatWebElapsed(event.elapsedMs)}${request}${turn}`);
      } else if (event.stage === "received") {
        console.log(`  ${color.dim("chatgpt")} response received · ${formatWebElapsed(event.elapsedMs)}${turn}`);
      } else if (event.stage === "legacy") {
        console.log(`  ${color.yellow("chatgpt")} bridge has no durable turn endpoint; using the synchronous /v1 path`);
      } else {
        console.log(`  ${color.dim("chatgpt")} waiting · ${formatWebElapsed(event.elapsedMs)}${request}${turn}`);
      }
    } else if (event.type === "action") {
      const verb =
        {
          read: "Reading",
          write: "Writing",
          edit: "Editing",
          list: "Listing",
          search: "Searching",
          inspect: "Inspecting",
          shell: "Running",
          apply_patch: "Patching",
          batch: "Batching",
          verify: "Verifying",
          finish: "Finishing",
        }[event.action] || event.action;
      const subject =
        event.action === "search"
          ? `"${event.query}"${event.path ? ` in ${event.path}` : ""}`
          : event.action === "shell"
            ? trim(event.command || "command", 100)
            : event.action === "inspect"
              ? `"${event.focus || "repository"}"`
              : event.path
                ? `${event.path}...`
                : "...";
      console.log(`  ${color.dim("chatgpt")} ${verb} ${subject}`);
    } else if (event.type === "subagent") {
      const focus = event.focus ? ` "${trim(event.focus, 80)}"` : "";
      if (event.phase === "start") {
        console.log(
          `  ${color.dim("subagent")} ${event.role}${focus} starting (invocation ${event.invocation}/${LIMITS.subagentInvocations})`,
        );
      } else {
        const state = event.ok ? color.green("done") : color.yellow(event.code || "failed");
        const summary = event.summary ? ` · ${trim(event.summary, 100)}` : "";
        console.log(
          `  ${color.dim("subagent")} ${event.role} ${state} · ${event.turns} turn(s) · ${(
            event.durationMs / 1000
          ).toFixed(1)}s · ${event.total} total${summary}`,
        );
      }
      // Subagent telemetry rides the existing run log; H8 reads the same data.
      events.emit("subagent", {
        role: event.role,
        phase: event.phase,
        ok: event.phase === "finish" ? Boolean(event.ok) : null,
        code: event.code ?? null,
        duration_ms: event.durationMs ?? null,
        turns: event.turns ?? null,
        invocation: event.invocation,
        total: event.total ?? null,
        focus: event.focus ?? null,
        summary: event.summary ?? null,
      });
    } else if (event.type === "tool" && !event.ok) {
      console.log(`  ${color.yellow("tool   ")} ${event.action} failed: ${trim(event.detail || "error", 120)}`);
    } else if (event.type === "protocol_error") {
      console.log(`  ${color.yellow("protocol")} ${event.reason}; sending one correction`);
    } else if (event.type === "verify_result" && !event.ok) {
      console.log(`  ${color.yellow("repair ")} verification failed (exit ${event.status ?? "?"}); the result went back to ChatGPT`);
    } else if (event.type === "verification_state" && ["verification_passed", "verification_failed", "repair_needed", "refused", "terminal_failed"].includes(event.state)) {
      const attempt = event.attempt ? ` · attempt ${event.attempt}` : "";
      const trigger = event.trigger ? ` (${event.trigger})` : "";
      console.log(`  ${color.dim("verify  ")} ${event.state}${attempt}${trigger}`);
    } else if (event.type === "checkpoint") {
      console.log(
        `  ${color.dim("checkpt ")} ${event.label} · ${event.files} file(s) · ${event.git ? "git metadata" : "file metadata"}`,
      );
      // The checkpoint record itself is metadata; it belongs in the run log.
      events.emit("checkpoint", {
        label: event.label,
        at: event.at,
        files: event.files,
        git: event.git,
        rollback: event.rollback,
      });
    } else if (event.type === "approval_policy") {
      // Every policy decision is logged, allow included; only refusals print.
      events.emit("approval_policy", {
        action: event.action,
        decision: event.decision,
        policy: event.policy,
        kind: event.kind,
        reason: event.reason,
      });
      if (event.decision !== "allow") {
        console.log(`  ${color.yellow("policy  ")} ${event.action} ${event.decision} (${event.policy}): ${trim(event.reason, 100)}`);
      }
    } else if (event.type === "finish_blocked") {
      console.log(`  ${color.yellow("verify  ")} finish blocked: ${event.code}`);
    } else if (event.type === "finish") {
      console.log(`  ${color.dim("chatgpt")} finished: ${trim(event.summary || "(no summary)", 120)}`);
    }
  };

  const webRun = async (attempt, taskText) => {
    const result = await runChatGptWebAgent({
      workspace,
      task: taskText,
      mode: mode.name,
      chat: (message) => chatTurn({ ...message, settings: bridge, timeoutMs: webTurnDeadlineMs }),
      verify: opts.verify ? (info) => runWebVerification(attempt, info ?? {}) : null,
      continueSession: Boolean(opts.continueSession || opts.session) && attempt === 0,
      sessionId: webSession,
      verifyCommand: opts.verify ?? null,
      approval: normalizeApprovalMode(opts.approval) ?? DEFAULT_APPROVAL_MODE,
      provider: selection.provider,
      model: selection.model,
      fingerprint: authorization?.fingerprint ?? null,
      executor,
      limits: { ...LIMITS, maxTurns: webTurns, maxVerifyRepairs: maxRepairs },
      onEvent: printWebEvent,
    });
    if (result.session) {
      try {
        writeWebSession(workspace, { session: result.session });
      } catch {
        // The conversation mapping is a convenience for -c; the run is the truth.
      }
    }
    return result;
  };

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
    const firstPrompt = wantsContext ? withWorkspacePacket(packet, opts.message.join(" ")) : null;
    timings.mark("spawn");
    events.emit("model_started", {
      attempt: 0,
      agent: chatGptWeb ? "chatgpt-bridge" : harness === "codex" ? "codex exec" : mode.agent,
    });
    if (chatGptWeb) {
      webState = await webRun(0, opts.message.join(" "));
      run = {
        status: webState.ok ? 0 : 1,
        signal: null,
        output: webState.transcript,
        durationMs: webState.endedAt - webState.startedAt,
      };
      const spawnAt = timings.at("spawn");
      if (webState.firstEditMs !== null && spawnAt !== null) {
        timings.markAt("first_edit", spawnAt + webState.firstEditMs);
      }
      if (!webState.ok) {
        failure = webState.failure;
        printFailure(failure);
        events.emit("failure", { code: failure.code, origin: failure.origin, message: failure.message });
        events.emit("verification_skipped", { reason: "the chatgpt-web loop stopped" });
      }
      const subagentTotal = webState.harness?.subagents?.total ?? 0;
      const economy = webState.harness?.economy ?? null;
      console.log(
        `  ${color.dim("chatgpt")} ${webState.turns} turn(s) · ${webState.actions.length} action(s) · ${(
          (webState.endedAt - webState.startedAt) /
          1000
        ).toFixed(1)}s${economy ? ` · ${economy.localOperations} local op(s)` : ""}${subagentTotal ? ` · ${subagentTotal} subagent(s)` : ""}`,
      );
    } else {
      run = await runAgent(
        agentInvocation({ harness, opts, workspace, selection, mode, codexTarget, prompt: firstPrompt, speedConfig }),
        0,
      );
    }
    timings.mark("agent");
    if (harness === "codex") markCodexPhases(timings, codexEvidence);
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

    if (run.status !== 0 && !failure) {
      failure = classifyFailure({
        output: harness === "codex" ? codexFailureText(run, codexEvidence) : run.output,
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
    changesAfterRun = emitFileChanges(events, workspace);

    if (opts.verify && !failure && chatGptWeb) {
      // The controller already ran the developer's command when ChatGPT asked
      // for it. Reuse that authoritative result only while the workspace has not
      // been edited since; otherwise run the gate once, now.
      const last = webState?.lastVerification ?? null;
      if (last && !last.refused) {
        verification = last;
      } else if (!last) {
        const result = await runWebVerification(0, {
          changedFiles: webState?.harness?.context?.changedFiles ?? [],
        });
        if (!result.refused) verification = result;
      }
    } else if (opts.verify && !failure) {
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
        verification = await runVerificationWithEvents({
          executor,
          command: opts.verify,
          workspace,
          events,
          attempt: 0,
          contract,
          includeRuntime: opts.runtime !== false,
        });
        timings.mark("verification");
        let signature = failureSignature(verification.output);

        while (!verification.ok && repairs < maxRepairs) {
          repairs += 1;
          events.emit("repair_started", { attempt: repairs, max: maxRepairs });
          console.log(`\n  ${color.yellow(`repair ${repairs}/${maxRepairs}`)} ${color.dim("passing the failure back to the model")}`);
          const repairMessage = [
            repairPrompt({ command: opts.verify, result: verification, attempt: repairs, maxRepairs }),
          ];
          const repairArgs = agentInvocation({
            harness,
            opts,
            workspace,
            selection,
            mode,
            codexTarget,
            message: repairMessage,
            speedConfig,
            repair: true,
          });
          events.emit("model_started", { attempt: repairs, agent: harness === "codex" ? "codex exec" : mode.agent });
          run = await runAgent(repairArgs, repairs);
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
              output: harness === "codex" ? codexFailureText(run, codexEvidence) : run.output,
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

          verification = await runVerificationWithEvents({
            executor,
            command: opts.verify,
            workspace,
            events,
            attempt: repairs,
            contract,
            includeRuntime: opts.runtime !== false,
          });
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
    stopSpeed();
  }

  // A repair run lets the model edit again, so the post-agent view is stale once
  // one has happened; without a repair it is still the truth and is reused.
  const changes = repairs > 0 || !changesAfterRun ? workspaceChanges(workspace) : changesAfterRun;
  timings.mark("changes");
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

  timings.mark("outcome");
  const outcome = normalizeOutcome({
    harness,
    model,
    provider: selection.provider,
    run,
    verification,
    failure,
    approval: approval ? { ...approval, required: true } : null,
    changes,
    // A ChatGPT-web repair is a real failed verification against changed files,
    // not the number of model patches.
    repairs: chatGptWeb ? (webState?.harness?.economy?.failedVerifications ?? repairs) : repairs,
    maxRepairs,
    executor,
    authorization,
    eventsFile: events.file,
    startedAt,
    endedAt: Date.now(),
    codex: codexEvidence,
    speed: codexSpeed,
    timings: timings.toJSON(),
    subagents: webState?.harness?.subagents ?? null,
    economy: webState?.harness?.economy ?? null,
  });
  timings.mark("total");
  outcome.timing.phases_ms = timings.toJSON();

  // The phase table only describes the engine that produced it; OpenCode runs
  // keep exactly the output they had before.
  if (harness === "codex") {
    const line = timingsLine(timings);
    if (line) console.log(`\n  ${color.dim("timings ")} ${color.dim(line)}`);
  }

  events.emit("run_outcome", outcome);
  if (opts.outcome) {
    const outcomeFile = writeOutcome(opts.outcome, outcome);
    console.log(`  ${color.dim("outcome")} ${outcomeFile}`);
  }

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
    metrics: trace ? trace.summary() : null,
  });
  for (const line of lines) console.log(line);

  process.exit(ok ? 0 : 1);
}

function start(engine, args, workspace, env = process.env, hint = "Try: npm i -g opencode-ai") {
  const commandArgs = engine.shell ? [args.map(quoteForShell).join(" ")] : args;
  const child = spawn(engine.command, commandArgs, {
    cwd: workspace,
    stdio: "inherit",
    shell: engine.shell,
    // See lib/engine.js: the engine's project root follows PWD.
    env: { ...env, PWD: workspace },
  });

  child.on("error", (error) => {
    console.error(`\n${color.red("Kodevra could not start the engine:")} ${error.message}`);
    console.error(`  ${hint}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : code ?? 0);
  });
}

/**
 * A probe that runs the npm-installed package through Node carries prefix
 * arguments (the codex.js entry point); a PATH shim carries none.
 */
function withProbePrefix(harness, harnessInfo, args) {
  if (harness !== "codex") return args;
  return [...(harnessInfo.probe?.prefixArgs ?? []), ...args];
}

/**
 * Arguments for one harness invocation.
 *
 * OpenCode receives Kodevra's workspace hint and agent flags; Codex receives
 * `codex exec` with its own sandbox flag and the task verbatim, so Kodevra adds
 * no orchestration around it. Repairs re-run Codex with the failure prompt
 * (Codex `exec resume` has no sandbox flag, so it is deliberately not used).
 *
 * `prompt` only exists so the first Codex call can carry the workspace facts
 * block; the task text inside it is never rewritten.
 */
function agentInvocation({
  harness,
  opts,
  workspace,
  selection,
  mode,
  codexTarget,
  message = opts.message,
  prompt = null,
  speedConfig = [],
  repair = false,
}) {
  if (harness === "codex") {
    return buildCodexArgs({
      mode: mode.name,
      workspace,
      target: codexTarget,
      prompt: prompt ?? (message.length ? message.join(" ") : null),
      config: speedConfig,
      interactive: false,
    });
  }
  const callOpts = repair ? { ...opts, continueSession: true, session: null } : opts;
  return buildArgs(callOpts, engineModel(selection), workspace, { message });
}

function buildArgs(opts, model, workspace, { message = opts.message } = {}) {
  const mode = resolveMode(opts);
  const args = opts.command === "run" ? ["run"] : [];

  if (model) args.push("-m", model);
  // Provider-specific reasoning effort is the engine's own flag: Kodevra only
  // decides which level to ask for, never how the provider spends it.
  if (opts.reasoningEffort) args.push("--variant", opts.reasoningEffort);
  if (mode.agent) args.push("--agent", mode.agent);
  // Machine-readable events, so Kodevra can report the engine's real steps and
  // token counts instead of estimating them. Headless only: an interactive
  // session needs the engine's own terminal interface.
  if (opts.trace && opts.command === "run") args.push("--format", "json");
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

/**
 * `kodevra engines` - the second harness is opt-in, so this surface has to make
 * the default and the readiness of each engine obvious before a run starts.
 */
function enginesCommand(opts, engine) {
  const sub = (opts.message[0] || "list").toLowerCase();

  if (sub === "use") {
    const requested = opts.message[1];
    if (!requested) {
      console.error(`${color.red("kodevra engines use needs an engine:")} ${HARNESS_NAMES.join(" | ")}`);
      process.exit(2);
    }
    const name = normalizeHarness(requested);
    const status = harnessStatus(name, { engine });
    if (!status) {
      console.error(`${color.red(`Unknown engine "${requested}".`)} Use: ${HARNESS_NAMES.join(" | ")}`);
      process.exit(2);
    }
    if (!status.available) {
      console.error(`${color.red(`${status.label} is not available: ${status.detail}`)}`);
      if (status.hint) console.error(`  ${color.yellow("->")} ${status.hint}`);
      console.error(`  ${color.dim("No engine was selected; the current default is unchanged.")}`);
      process.exit(1);
    }
    const file = writeState({ engine: name });
    console.log(`  ${color.green("selected")} ${name} ${color.dim(status.detail)}`);
    console.log(`  ${color.dim(`saved to ${file}; neither OpenCode's nor Codex's config was modified`)}`);
    if (!status.auth.ok) console.log(`  ${color.yellow("auth")} ${status.auth.hint}`);
    return;
  }

  if (sub === "current") {
    console.log(`  ${color.dim("engine")} ${color.green(activeHarness({ flag: opts.engine }))}`);
    return;
  }

  if (sub !== "list") {
    console.error(`${color.red(`Unknown engines command: ${sub}`)} (list, use, current)`);
    process.exit(2);
  }

  const rows = harnessRows({ engine });
  const active = activeHarness({ flag: opts.engine });
  const tableHeader = ["engine", "state", "version", "auth"];
  const cells = (row) => [
    row.name,
    row.available ? (row.name === active ? "active" : "available") : "unavailable",
    row.version ?? "-",
    row.auth?.detail ?? "-",
  ];
  const widths = tableHeader.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => cells(row)[column].length)),
  );
  const line = (values) => values.map((value, column) => String(value).padEnd(widths[column])).join("  ");

  console.log("");
  console.log(`  ${color.dim(line(tableHeader))}`);
  for (const row of rows) {
    const values = line(cells(row));
    console.log(`  ${row.available ? (row.name === active ? color.green(values) : values) : color.yellow(values)}`);
  }
  console.log("");
  console.log(`  ${color.dim("default")}  opencode ${color.dim("- Codex stays opt-in until the benchmarks justify a switch")}`);
  console.log(`  ${color.dim("switch")}   kodevra engines use codex   ·   one-off: kodevra run --engine codex \"<task>\"`);
  for (const row of rows.filter((entry) => !entry.available && entry.hint)) {
    console.log(`  ${color.yellow("->")} ${row.name}: ${row.hint}`);
  }
  if (rows.find((row) => row.name === "codex" && row.available && !row.auth.ok)?.auth?.hint) {
    console.log(`  ${color.yellow("->")} codex auth: ${rows.find((row) => row.name === "codex").auth.hint}`);
  }
}

async function main() {
  const timings = createTimings(PROCESS_STARTED_AT);
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`${color.red(error.message)}\n`);
    console.log(USAGE);
    process.exit(2);
  }
  timings.mark("bootstrap");

  const speed = normalizeSpeed(opts.speed);
  if (!speed) {
    console.error(`${color.red(`Unknown speed "${opts.speed}".`)} Use: default | fast`);
    console.error(`  ${color.dim("--speed is an opt-in Codex service tier; the default is unchanged.")}`);
    process.exit(2);
  }

  if (opts.command === "help" || opts.help) {
    console.log(banner({}));
    console.log(USAGE);
    return;
  }

  phaseMark("cli_parsed");
  const config = readConfig();
  timings.mark("config");
  const engine = findExecutable("opencode");
  phaseMark("engine_located");

  let harness;
  try {
    harness = activeHarness({ flag: opts.engine });
  } catch (error) {
    console.error(color.red(error.message));
    if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
    process.exit(2);
  }
  // One cached probe: `codex --version` and `codex login status` are separate
  // processes but a single readiness question, so they are timed as one phase.
  const harnessInfo = harnessStatus(harness, { engine });
  timings.mark("engine_probe");

  if (opts.command === "version") {
    const selection = activeSelection({ config: config.data, engine });
    const engineLabel =
      harness === "codex"
        ? harnessInfo.available
          ? `codex ${harnessInfo.version || "unknown"}`
          : "codex not installed"
        : engine
          ? `opencode ${harnessInfo.version || "unknown"}`
          : "opencode not installed";
    const modelLabel =
      harness === "codex"
        ? resolveCodexRun({ selection, explicitModel: Boolean(opts.model), config: harnessInfo.config }).modelLabel
        : fullModel(selection);
    console.log(`${PRODUCT} ${VERSION} · engine ${engineLabel} · model ${modelLabel} (${selection.source})`);
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

  if (opts.command === "engines") {
    await enginesCommand(opts, engine);
    return;
  }

  const selection = activeSelection({
    flagModel: opts.model,
    flagProvider: opts.provider,
    config: config.data,
    engine,
  });
  // EXPERIMENTAL: the ordinary ChatGPT web tab. It is a browser transport, not
  // an engine catalog entry, so it bypasses provider assessment and model
  // profiles entirely.
  const chatGptWeb = selection.provider === CHATGPT_WEB_PROVIDER;
  if (chatGptWeb) {
    if (harness === "codex") {
      console.error(`${color.red("--provider chatgpt-web does not run through Codex.")} ${color.dim("Drop --engine codex.")}`);
      process.exit(2);
    }
    selection.model = CHATGPT_WEB_MODEL;
    if (opts.command !== "run" && opts.command !== "doctor") {
      console.error(
        `${color.red("--provider chatgpt-web is only available for kodevra run.")} ${color.dim(
          "It drives a browser tab; there is no interactive engine session behind it.",
        )}`,
      );
      process.exit(2);
    }
  } else if (opts.maxTurns !== null || opts.approval !== null) {
    // Only the ChatGPT-web controller has a turn budget and an approval policy
    // Kodevra owns; the engine has its own loop and permission system.
    const flag = opts.maxTurns !== null ? "--max-turns" : "--approval";
    console.error(
      `${color.red(`${flag} belongs to --provider chatgpt-web.`)} ${color.dim(
        "The engine manages its own turns and permissions.",
      )}`,
    );
    process.exit(2);
  }
  if (opts.approval !== null && !normalizeApprovalMode(opts.approval)) {
    console.error(`${color.red(`Unknown approval mode "${opts.approval}".`)} Use: ${APPROVAL_MODES.join(" | ")}`);
    console.error(`  ${color.dim("Autonomy is opt-in; Kodevra never widens it silently.")}`);
    process.exit(2);
  }
  const webBridge = chatGptWeb ? bridgeSettings() : null;
  timings.mark("selection");
  // Provider assessment exists for OpenCode's credential and model plumbing. A
  // Codex run only needs it for the unsupported-provider guard and the plan, yet
  // the full assessment is expensive: it parses OpenCode's ~6 MB model catalog
  // and, for an account provider, asks OpenCode to enumerate its models in a
  // child process (`opencode models openai`, 4-5 s here) - neither of which is a
  // fact about a Codex run. Ask for neither. `kodevra providers`, `kodevra auth
  // status` and `kodevra doctor` still do the full assessment.
  const assessment = chatGptWeb
    ? chatGptWebAssessment()
    : assessProvider(
        selection.provider,
        harness === "codex" ? { config: config.data, catalog: null, liveModels: null } : { config: config.data, engine },
      );
  timings.mark("assessment");
  phaseMark("provider_assessed");
  // Codex has its own provider config and credential store; Kodevra reports the
  // model Codex will actually use rather than pretending it applied ours.
  const codexTarget =
    harness === "codex"
      ? resolveCodexRun({
          selection,
          explicitModel: Boolean(opts.model),
          config: harnessInfo.config ?? readCodexConfig(),
        })
      : null;

  // Service-tier plumbing. `default` adds nothing at all: the argv, the catalog
  // and the environment stay exactly what they were. `fast` is planned against
  // the catalog Codex itself reports, and refuses rather than pretending.
  let codexSpeed = {
    requested: speed,
    effective_service_tier: null,
    model_supports_priority: null,
    catalog_source: null,
  };
  let speedConfig = [];
  let stopSpeed = () => {};
  if (speed === "fast") {
    if (harness !== "codex") {
      console.error(`${color.red("--speed fast is a Codex option.")} ${color.dim("OpenCode has no service tier to select.")}`);
      process.exit(2);
    }
    // Two CLI calls per fast run are one too many. The bundled catalog is
    // version-derived and cached by binary identity; and when Codex's config
    // names no custom catalog and no profile, the catalog it reports *is* the
    // bundled one (verified byte-for-byte against a clean CODEX_HOME), so the
    // effective view does not need a second launch.
    const bundled = bundledCatalog(harnessInfo.probe).catalog;
    timings.mark("speed_bundled");
    const customCatalog = Boolean(harnessInfo.config?.modelCatalogJson || harnessInfo.config?.profile);
    const user = customCatalog ? readCodexCatalog(harnessInfo.probe) : bundled;
    timings.mark("speed_catalog");
    const plan = planFastSpeed({
      model: codexTarget.model ?? harnessInfo.config?.model ?? null,
      bundled,
      user,
    });
    if (!plan.ok) {
      console.error(`\n  ${color.red(plan.code)} ${plan.message}`);
      console.error(`  ${color.yellow("->")} ${plan.hint}`);
      console.error(color.dim("  No task was started; the run was not silently downgraded to the standard tier."));
      process.exit(2);
    }
    codexSpeed = plan.evidence;
    speedConfig = plan.config;
    stopSpeed = plan.cleanup;
    timings.mark("speed");
    // The merged catalog is a temporary file for this invocation; it must not
    // outlive the process even on an early exit.
    process.once("exit", stopSpeed);
  }

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
  const model = harness === "codex" ? codexTarget.modelLabel : fullModel(selection);
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

  // What the catalog says this model actually is. Resolving it here means a typo
  // in --reasoning costs nothing, and the run does not discover the problem after
  // the engine has already started. That catalog describes OpenCode's models, so
  // a Codex run asks it nothing.
  let profile = null;
  let effort = { effort: null, warning: null };
  let modelConfig = null;
  let outputPlan = { output: null, note: null, source: "model catalog" };
  if (harness === "opencode" && !chatGptWeb) {
    profile = modelProfile(engineProviderId(selection.provider), selection.model);
    try {
      effort = resolveEffort(profile, opts.reasoning ?? process.env.KODEVRA_REASONING ?? null);
    } catch (error) {
      console.error(color.red(error.message));
      if (error.hint) console.error(`  ${color.yellow("->")} ${error.hint}`);
      process.exit(2);
    }
    opts.reasoningEffort = effort.effort;
    phaseMark("model_profile");

    if (opts.command === "run" || opts.command === "launch") {
      outputPlan = resolveOutputTokens(profile, {
        requested: opts.outputTokens ?? (Number(process.env.KODEVRA_OUTPUT_TOKENS) || null),
      });
      modelConfig = modelConfigBlock(profile, { output: outputPlan.output });
      if (outputPlan.output && !modelConfig) {
        outputPlan.note =
          `no output cap applied: the engine catalog has no context window for ${selection.model}, ` +
          "and OpenCode rejects a partial model limit.";
      }
    }
  }

  // The startup panel follows the same effective provider as doctor: an
  // explicit OpenAI run is signed in with ChatGPT, not with whatever provider
  // Codex's config.toml happens to name.
  const codexAuthLine = (() => {
    const auth = harnessInfo.auth;
    if (codexTarget?.provider !== "openai") return `${auth.ok ? auth.state : "needs auth"} · ${auth.detail}`;
    if (auth.state === "chatgpt") return "chatgpt · ChatGPT sign-in";
    if (auth.state === "api-key") return "api-key · API key stored by codex login";
    if (auth.state === "stored") return "stored · auth.json present (not read)";
    return `${auth.ok ? auth.state : "needs auth"} · ${auth.detail}`;
  })();
  const authLine =
    harness === "codex"
      ? codexAuthLine
      : assessment.ready
        ? `${assessment.state} · ${assessment.credential.source}`
        : `${assessment.state} · ${assessment.detail}`;
  const activeMode = opts.command === "run" || opts.command === "launch" ? `${mode.name} - ${mode.description}` : null;

  if (opts.command === "providers") {
    if ((opts.message[0] || "list").toLowerCase() === "list") {
      console.log(banner({ model, workspace, engine: harness, auth: authLine }));
    }
    await providerCommand(opts, config.data, selection, engine);
    return;
  }

  if (opts.command === "auth") {
    if ((opts.message[0] || "status").toLowerCase() === "status") {
      console.log(banner({ model, workspace, engine: harness, auth: authLine }));
    }
    await runAuth(opts, config.data, selection, engine);
    return;
  }

  console.log(
    header({
      workspace,
      model,
      provider: harness === "codex" ? `Codex (${codexTarget.source})` : assessment.label,
      auth: authLine,
      sandbox: sandboxStatusLine(executorNameForDisplay(opts)),
      mode: activeMode,
      engine: chatGptWeb ? "chatgpt-bridge" : harness,
      hints: opts.command === "launch" || opts.command === "run",
    }),
  );

  if (chatGptWeb) {
    console.log(`  ${color.dim("Billing ")} ChatGPT web account ${color.dim("- the signed-in Chrome session, not API billing")}`);
    console.log(`  ${color.dim("Bridge  ")} ${webBridge.baseURL} ${color.dim("- localhost only; Kodevra never reads ChatGPT cookies")}`);
    console.log(
      `  ${color.dim("Protocol")} one JSON action per turn ${color.dim("- ChatGPT has no native tool calls on this path")}`,
    );
  }

  if (harness === "opencode" && !chatGptWeb && (opts.command === "run" || opts.command === "launch")) {
    const appliedOutput = modelConfig ? outputPlan.output : null;
    console.log(`  ${color.dim("model   ")} ${describeProfile(profile, { effort: effort.effort, output: appliedOutput })}`);
    if (effort.warning) console.log(`  ${color.yellow("model   ")} ${effort.warning}`);
    if (outputPlan.note) console.log(`  ${color.dim("model   ")} ${color.dim(outputPlan.note)}`);
    if (opts.trace && opts.command === "run") {
      console.log(`  ${color.dim("trace   ")} engine --format json ${color.dim("steps, tool calls, tokens, cost")}`);
    }
  }

  // Sessions stay in OpenCode's own local store; Kodevra only makes them
  // reachable from its own command surface (FRD J-06).
  if (opts.command === "sessions") {
    if (harness === "codex") {
      console.log(color.dim("  Codex keeps sessions in its own store; Kodevra does not copy them."));
      console.log(`  ${color.dim("list")}   codex resume --all`);
      console.log(`  ${color.dim("resume")} codex resume --last`);
      return;
    }
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
  // The executor this invocation will really use, including the implicit
  // Docker choice `--verify` makes when no executor was named.
  const diagnosticExecutor = opts.executor || process.env.KODEVRA_EXECUTOR || (opts.verify ? "docker" : "host");
  let failed = 0;
  let optionalMissing = 0;
  // The experiment has exactly one readiness question: is the local bridge up
  // with a logged-in browser tab attached? Engine/provider diagnostics say
  // nothing about that, so asking them would only invent failures.
  if (chatGptWeb) {
    const probe = await probeBridge(webBridge);
    console.log(`  ${mark(probe.ok)}  ${color.bold("ChatGPT bridge".padEnd(18))}  ${color.dim(probe.detail)}`);
    if (!probe.ok) {
      if (probe.hint) console.log(`  ${color.yellow("->")} ${probe.hint}`);
      timings.mark("diagnostics");
      if (diagnosticsAlways || opts.doctor) process.exit(1);
    }
    timings.mark("diagnostics");
    phaseMark("diagnostics");
    if (diagnosticsAlways) {
      if (probe.ok) console.log(color.green("All checks passed."));
      process.exit(probe.ok ? 0 : 1);
    }
  }
  if (!chatGptWeb && (diagnosticsAlways || (opts.doctor && process.env.KODEVRA_SKIP_DOCTOR !== "1"))) {
    const result = await runDiagnostics({
      workspace,
      model,
      harness,
      // Reuse the status, target and config this process already resolved: no
      // second `codex --version` / `codex login status` / config read.
      codexStatus: harnessInfo,
      codexTarget,
      executor: diagnosticExecutor,
      config,
      purpose: diagnosticsAlways ? "doctor" : "run",
    });
    timings.mark("diagnostics");
    printChecks(result.checks);
    console.log("");
    failed = result.failed;
    optionalMissing = result.checks.filter((check) => !check.ok && !check.fatal).length;
    phaseMark("diagnostics");
  }

  if (diagnosticsAlways) {
    const warnings = optionalMissing;
    if (failed) console.log(color.red(`${failed} check(s) failed.`));
    else if (warnings) console.log(color.yellow(`All required checks passed (${warnings} optional check(s) unavailable).`));
    else console.log(color.green("All checks passed."));
    process.exit(failed ? 1 : 0);
  }

  if (failed) {
    console.error(`${color.red("Diagnostics failed")} - fix the items marked FAIL (or run with --no-doctor).`);
    process.exit(1);
  }

  if (!chatGptWeb && !harnessInfo.available) {
    console.error(color.red(harnessInfo.detail || `${harness} is not installed.`));
    if (harnessInfo.hint) console.error(`  ${color.yellow("->")} ${harnessInfo.hint}`);
    process.exit(1);
  }

  if (opts.command === "run") {
    await executeRun({
      engine,
      harness,
      harnessInfo,
      codexTarget,
      opts,
      workspace,
      model,
      selection,
      assessment,
      modelConfig,
      codexSpeed,
      speedConfig,
      stopSpeed,
      timings,
      chatGptWeb,
      bridge: webBridge,
    });
    return;
  }

  if (opts.verify) {
    console.error(`${color.yellow("--verify is only used by kodevra run")} ${color.dim("(the interactive session has no headless result to check)")}`);
  }

  if (harness === "codex") {
    const args = [
      ...(harnessInfo.probe.prefixArgs ?? []),
      ...buildCodexArgs({
        mode: mode.name,
        workspace,
        target: codexTarget,
        prompt: opts.message.length ? opts.message.join(" ") : null,
        config: speedConfig,
        interactive: true,
        extra: opts.passthrough,
      }),
    ];
    console.log(`${color.dim("kodevra")} ${color.dim("->")} codex ${visibleArgs(args).join(" ")}`);
    console.log("");
    start(harnessInfo.probe, args, workspace, process.env, harnessInfo.hint || "Install Codex: npm i -g @openai/codex");
    return;
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
