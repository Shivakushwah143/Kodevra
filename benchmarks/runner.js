#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findExecutable } from "../lib/doctor.js";
import { snapshotTree, treeChangedFiles } from "../lib/verify.js";
import {
  applyAcceptance,
  applySolution,
  hashTree,
  listFiles,
  loadTasks as loadTaskFixtures,
  resetProviderSession,
  resetWorkspace,
  run,
  tail,
} from "./lib/fixtures.js";

/**
 * Kodevra coding benchmarks.
 *
 * Two variants, one model, one starting repository per task:
 *   opencode  plain `opencode run <prompt>` (the engine alone)
 *   kodevra   `kodevra run <prompt> --verify <task verify>`
 *
 * Nothing here orchestrates models: each variant is the real CLI, and the
 * acceptance test decides success. Results are resumable: a finished record is
 * never re-run unless --force is passed.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const TASKS_DIR = path.join(ROOT, "benchmarks", "tasks");
const RESULTS_DIR = path.join(ROOT, "benchmarks", "results");
const RAW_DIR = path.join(RESULTS_DIR, "raw");
// Task workspaces live outside the repository: an agent with shell access must
// not be able to wander into the fixtures or another task's workspace.
const WORK_DIR = path.join(os.tmpdir(), "kodevra-bench");

const DEFAULT_MODEL = process.env.KODEVRA_BENCH_MODEL || "freedeepseek/deepseek-v4-flash";
const AGENT_TIMEOUT = Number(process.env.KODEVRA_BENCH_TIMEOUT_MS || 300_000);
const VERIFY_TIMEOUT = Number(process.env.KODEVRA_BENCH_VERIFY_MS || 120_000);
const VARIANTS = ["opencode", "kodevra"];

function usage() {
  console.log(`Kodevra benchmarks

  node benchmarks/runner.js --list
  node benchmarks/runner.js --validate
  node benchmarks/runner.js --check
  node benchmarks/runner.js --task 01-cart-total --variant both
  node benchmarks/runner.js --all
  node benchmarks/runner.js --summary

Options
  --all                 every task, both variants
  --task <id>           one task (repeatable, or comma separated)
  --variant <v>         opencode | kodevra | both (default: both)
  --model <id>          model id for both variants (default: ${DEFAULT_MODEL})
  --force               re-run tasks that already have a result
  --retries <n>         retry an infrastructure failure (default: 1, max: 2)
  --timeout <ms>        per agent run (default: ${AGENT_TIMEOUT})
  --summary             regenerate results/summary.md from recorded results
`);
}

function parse(argv) {
  const opts = { tasks: [], variant: "both", model: DEFAULT_MODEL, force: false, check: false, list: false, summary: false, all: false, validate: false, retries: 1, timeout: AGENT_TIMEOUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--all") opts.all = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--validate") opts.validate = true;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--summary") opts.summary = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--retries") opts.retries = Math.max(0, Math.min(2, Number(argv[(index += 1)]) || 0));
    else if (arg === "--task") opts.tasks.push(...String(argv[(index += 1)] || "").split(",").filter(Boolean));
    else if (arg === "--variant") opts.variant = argv[(index += 1)] || "both";
    else if (arg === "--model") opts.model = argv[(index += 1)] || DEFAULT_MODEL;
    else if (arg === "--timeout") opts.timeout = Number(argv[(index += 1)] || AGENT_TIMEOUT);
    else {
      console.error(`Unknown option: ${arg}\n`);
      usage();
      process.exit(2);
    }
  }
  if (!["opencode", "kodevra", "both"].includes(opts.variant)) {
    console.error(`Unknown variant "${opts.variant}". Use opencode, kodevra or both.`);
    process.exit(2);
  }
  return opts;
}

function loadTasks() {
  return loadTaskFixtures(TASKS_DIR);
}

function opencodeCommand() {
  const engine = findExecutable("opencode");
  if (!engine) throw new Error("opencode is not on PATH; install it with: npm i -g opencode-ai");
  return engine;
}

function buildAgent(variant, task, workspace, options) {
  if (variant === "kodevra") {
    return {
      command: process.execPath,
      args: [
        path.join(ROOT, "bin", "kodevra.js"),
        "run",
        "-w",
        workspace,
        "--verify",
        task.verify,
        "--executor",
        "host",
        "-m",
        options.model,
        "--no-doctor",
        task.prompt,
      ],
      shell: false,
    };
  }
  const engine = opencodeCommand();
  // Plain OpenCode has to be able to edit files and run the suite in a
  // headless run, otherwise the baseline is "model that cannot use tools".
  // Kodevra's own headless permissions are stricter (no host shell); that
  // difference is reported in the summary rather than hidden.
  const args = ["run", "--auto", "-m", options.model, task.prompt];
  if (engine.shell) {
    const quoted = (value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    return { command: engine.command, args: [args.map(quoted).join(" ")], shell: true };
  }
  return { command: engine.command, args, shell: false };
}

function countRepairs(output) {
  const match = output.match(/Events\s+(\S+\.jsonl)/);
  if (!match) return null;
  try {
    const lines = fs.readFileSync(match[1], "utf8").trim().split("\n");
    return lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "repair_started").length;
  } catch {
    return null;
  }
}

function providerError(output) {
  const codes = [
    "PROXY_UNAVAILABLE",
    "AUTH_EXPIRED",
    "RATE_LIMITED",
    "MODEL_UNAVAILABLE",
    "CONTEXT_EXHAUSTED",
    "TOOL_DENIED",
    "MALFORMED_TOOL_CALL",
  ];
  return codes.find((code) => output.includes(code)) ?? null;
}


function resultPath(variant, task) {
  return path.join(RAW_DIR, variant, `${task.id}.json`);
}

function readResult(variant, task) {
  try {
    return JSON.parse(fs.readFileSync(resultPath(variant, task), "utf8"));
  } catch {
    return null;
  }
}

function writeResult(record) {
  const file = path.join(RAW_DIR, record.variant, `${record.task}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.appendFileSync(path.join(RESULTS_DIR, "runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  return file;
}

/** The model id the CLI itself reported, if it printed one. */
function reportedModel(output) {
  const labeled = `${output}`.match(/Model\s+(freedeepseek\/[^\s]+)/);
  if (labeled) return labeled[1];
  const badge = `${output}`.match(/>\s*(?:build|plan)\s+·\s+([^\s]+)/);
  return badge ? `freedeepseek/${badge[1]}` : null;
}

/**
 * A benchmark PASS is a clean agent exit AND a passing acceptance suite on the
 * same model. A hidden-test pass after an agent timeout is not a success, and
 * infrastructure failures are named instead of being scored as model failures.
 */
function classifyRun({ agent, verification, session, modelMismatch, tampered }) {
  if (tampered) return "fixture_tampered";
  if (!session.ok) return "infra";
  if (agent.timedOut) return "timeout";
  if (agent.status !== 0) {
    if (/429|rate limit|too many requests|cooldown/i.test(agent.output)) return "rate_limit";
    if (/401|403|unauthori[sz]ed|invalid api key/i.test(agent.output)) return "auth";
    if (/ECONNREFUSED|fetch failed|proxy/i.test(agent.output)) return "infra";
    return "agent_failure";
  }
  if (modelMismatch) return "model_mismatch";
  if (verification.status !== 0) return "test_failure";
  return "success";
}

async function executeTask(task, variant, options, attempt) {
  const workspace = path.join(WORK_DIR, variant, task.id);
  resetWorkspace(task, workspace);

  const beforeTree = snapshotTree(workspace);
  const fixtureHash = hashTree(task.dir);
  const session = await resetProviderSession(options.model);
  const base = {
    task: task.id,
    title: task.title,
    category: task.category,
    variant,
    model: options.model,
    started_at: new Date().toISOString(),
    attempt,
    session_reset: session.ok,
    session_reset_detail: session.reason,
    tokens: null,
    tool_failures: null,
  };

  if (!session.ok) {
    return { ...base, ok: false, error_type: "infra", error: "provider session reset failed", duration_ms: 0, agent_exit: null, agent_timed_out: false, verify_exit: null, verify_tail: "", agent_tail: "", files_changed: [] };
  }

  const agent = buildAgent(variant, task, workspace, options);
  console.log(`  run     ${variant.padEnd(8)} ${task.id} ${path.basename(task.dir, "")}${attempt > 1 ? ` retry ${attempt}` : ""}`);
  const agentRun = await run(agent.command, agent.args, { cwd: workspace, timeout: options.timeout, shell: agent.shell });
  const filesChanged = treeChangedFiles(beforeTree, workspace);
  const tampered = hashTree(task.dir) !== fixtureHash;

  if (tampered) {
    return {
      ...base,
      ok: false,
      error_type: "fixture_tampered",
      error: "fixture tampered during the run",
      duration_ms: agentRun.durationMs,
      agent_exit: agentRun.status,
      agent_timed_out: agentRun.timedOut,
      verify_exit: null,
      verify_tail: "",
      agent_tail: tail(agentRun.output),
      files_changed: filesChanged,
      repairs: null,
      provider_error: providerError(agentRun.output),
    };
  }

  const acceptance = applyAcceptance(task, workspace);
  const verification = await run(task.verify, [], { cwd: workspace, timeout: VERIFY_TIMEOUT, shell: true });
  for (const file of acceptance) fs.rmSync(path.join(workspace, "test", file), { force: true });

  const reported = reportedModel(agentRun.output);
  const modelMismatch = Boolean(reported && reported !== options.model);
  const repairs = variant === "kodevra" ? countRepairs(agentRun.output) : null;
  const errorType = classifyRun({ agent: agentRun, verification, session, modelMismatch, tampered });

  return {
    ...base,
    ok: errorType === "success",
    error_type: errorType,
    error: errorType === "success" ? null : errorType,
    duration_ms: agentRun.durationMs + verification.durationMs,
    agent_exit: agentRun.status,
    agent_timed_out: agentRun.timedOut,
    agent_timeout_reason: agentRun.timedOut ? "limit" : null,
    verify_exit: verification.status,
    verify_tail: tail(verification.output),
    agent_tail: tail(agentRun.output),
    files_changed: filesChanged,
    attempts: 1 + (repairs ?? 0),
    repairs,
    provider_error: providerError(agentRun.output),
    model_reported: reported,
    model_mismatch: modelMismatch,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTask(task, variant, options) {
  const existing = readResult(variant, task);
  if (existing && !options.force) {
    console.log(`  skip    ${variant.padEnd(8)} ${task.id} ${existing.ok ? "PASS" : "FAIL"} (recorded; --force to re-run)`);
    return existing;
  }

  let record;
  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    record = await executeTask(task, variant, options, attempt);
    // Retry only infrastructure failures. Timeouts, rate limits and model
    // behaviour are results, not transient noise.
    if (record.error_type === "infra" && attempt <= options.retries) {
      console.log(`  retry   ${variant.padEnd(8)} ${task.id} after infrastructure failure (${record.error})`);
      await sleep(2000);
      continue;
    }
    break;
  }

  writeResult(record);
  console.log(
    `  ${record.ok ? "PASS" : "FAIL"}    ${variant.padEnd(8)} ${task.id} (${record.error_type}) files=${record.files_changed.length} agent_exit=${record.agent_exit} verify_exit=${record.verify_exit} ${(record.duration_ms / 1000).toFixed(1)}s`,
  );
  return record;
}

/** Structural validation: manifest, template, hidden acceptance and solution. */
function validateFixtures(tasks) {
  const problems = [];
  for (const task of tasks) {
    const fail = (message) => problems.push(`${task.id}: ${message}`);
    if (task.id !== path.basename(task.dir)) fail(`manifest id "${task.id}" does not match its directory`);
    for (const field of ["title", "category", "prompt", "verify"]) {
      if (!task[field] || typeof task[field] !== "string") fail(`manifest is missing "${field}"`);
    }

    const pkgFile = path.join(task.template, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (!pkg.scripts?.test) fail("template package.json has no test script");
    } catch {
      fail("template package.json is missing or invalid");
    }

    const templateFiles = listFiles(task.template).filter((file) => file.startsWith("src/"));
    if (!templateFiles.length) fail("template has no src files");

    const hidden = fs.existsSync(task.acceptance)
      ? fs.readdirSync(task.acceptance).filter((file) => file.endsWith(".test.js"))
      : [];
    if (!hidden.length) fail("no hidden acceptance test");

    const solutionFiles = fs.existsSync(task.solution) ? listFiles(task.solution) : [];
    if (!solutionFiles.length) fail("no reference solution");

    // The agent must never receive the hidden acceptance test. Solution files
    // are allowed to share a name with the template file they replace.
    for (const leaked of hidden) {
      if (templateFiles.some((file) => path.basename(file) === path.basename(leaked))) {
        fail(`template contains the hidden acceptance test: ${leaked}`);
      }
    }
  }

  console.log(`\n  ${tasks.length} manifests checked`);
  if (problems.length) {
    for (const problem of problems) console.log(`  BAD  ${problem}`);
    console.log(`\n  ${problems.length} problem(s) found`);
    process.exitCode = 1;
  } else {
    console.log("  all manifests, templates, acceptance tests and solutions are present");
  }
  return problems;
}

/** Fixture integrity: broken without the fix, green with the reference solution. */
async function checkFixtures(tasks) {
  const results = [];
  for (const task of tasks) {
    const workspace = path.join(WORK_DIR, "check", task.id);
    resetWorkspace(task, workspace);

    const broken = await run(task.verify, [], { cwd: workspace, timeout: VERIFY_TIMEOUT, shell: true });
    const acceptance = applyAcceptance(task, workspace);
    const hiddenBroken = await run(task.verify, [], { cwd: workspace, timeout: VERIFY_TIMEOUT, shell: true });
    for (const file of acceptance) fs.rmSync(path.join(workspace, "test", file), { force: true });

    applySolution(task, workspace);
    for (const file of acceptance) {
      fs.copyFileSync(path.join(task.acceptance, file), path.join(workspace, "test", file));
    }
    const solved = await run(task.verify, [], { cwd: workspace, timeout: VERIFY_TIMEOUT, shell: true });

    const ok = broken.status !== 0 && hiddenBroken.status !== 0 && solved.status === 0;
    results.push({
      task: task.id,
      ok,
      template_verify_exit: broken.status,
      hidden_verify_exit: hiddenBroken.status,
      solution_verify_exit: solved.status,
    });
    console.log(
      `  ${ok ? "ok  " : "BAD "} ${task.id} template=${broken.status} hidden=${hiddenBroken.status} solution=${solved.status}`,
    );
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RESULTS_DIR, "fixtures.json"),
    `${JSON.stringify({ checked_at: new Date().toISOString(), tasks: results }, null, 2)}\n`,
    "utf8",
  );
  const bad = results.filter((result) => !result.ok);
  console.log(`\n  ${results.length - bad.length}/${results.length} fixtures are sound${bad.length ? ` (${bad.length} need attention)` : ""}.`);
  return results;
}

function pct(passed, total) {
  if (!total) return "-";
  return `${Math.round((passed / total) * 100)}%`;
}

function summarize(tasks, options) {
  const records = tasks.flatMap((task) => VARIANTS.map((variant) => readResult(variant, task)).filter(Boolean));
  const executed = new Set(records.map((record) => `${record.variant}/${record.task}`));
  const fixtures = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, "fixtures.json"), "utf8"));
    } catch {
      return null;
    }
  })();

  const lines = ["# Kodevra vs plain OpenCode — benchmark results", ""];
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Model (both variants): \`${options.model}\``);
  lines.push(`Machine: ${process.platform}/${process.arch}, Node ${process.versions.node}`);
  lines.push("");

  const totalRuns = tasks.length * VARIANTS.length;
  const perVariant = VARIANTS.map((variant) => {
    const own = records.filter((record) => record.variant === variant);
    return { variant, runs: own.length, passed: own.filter((record) => record.ok).length };
  });

  lines.push("## Coverage");
  lines.push("");
  lines.push(`- Tasks implemented: **${tasks.length}**`);
  lines.push(`- Expected runs (2 variants): **${totalRuns}**`);
  lines.push(`- Runs executed: **${records.length}** (${pct(records.length, totalRuns)})`);
  for (const item of perVariant) {
    lines.push(`- ${item.variant}: ${item.runs}/${tasks.length} executed, ${item.passed} verified success`);
  }
  const unexecuted = [];
  for (const task of tasks) {
    for (const variant of VARIANTS) {
      if (!executed.has(`${variant}/${task.id}`)) unexecuted.push(`${variant}/${task.id}`);
    }
  }
  if (unexecuted.length) {
    lines.push(`- Not executed: ${unexecuted.join(", ")}`);
  }
  if (fixtures) {
    const sound = fixtures.tasks.filter((task) => task.ok).length;
    lines.push(`- Fixture integrity (last check): ${sound}/${fixtures.tasks.length} sound`);
  }
  if (records.length && records.every((record) => record.agent_timed_out)) {
    lines.push(
      "- **Pilot note:** every executed run timed out while the local DeepSeek proxy account was in cooldown. These are infrastructure failures, not a model comparison.",
    );
  }
  lines.push("");

  lines.push("## Per-task results");
  lines.push("");
  lines.push("| Task | Category | OpenCode | Kodevra |");
  lines.push("| --- | --- | --- | --- |");
  for (const task of tasks) {
    const cell = (variant) => {
      const record = readResult(variant, task);
      if (!record) return "not run";
      return record.ok ? `PASS (${(record.duration_ms / 1000).toFixed(1)}s)` : `FAIL (verify ${record.verify_exit})`;
    };
    lines.push(`| \`${task.id}\` ${task.title} | ${task.category} | ${cell("opencode")} | ${cell("kodevra")} |`);
  }
  lines.push("");

  lines.push("## Fairness notes");
  lines.push("");
  lines.push("- Both variants run the same model id, the same task prompt and the same starting repository.");
  lines.push("- Every repository is reset from its fixture before a run; hidden acceptance tests are copied in only after the agent finishes.");
  lines.push("- Kodevra adds a verification loop and prepends `Workspace: <dir>` to the prompt; plain OpenCode does not, so a Kodevra win can reflect the verification loop rather than model quality.");
  lines.push("- Plain OpenCode runs with `--auto` so file edits and shell commands are approved; Kodevra's headless runs allow workspace edits but deny host bash. Tool access therefore favors OpenCode, verification favors Kodevra.");
  lines.push("- Both variants run on the host for this comparison: Kodevra uses `--executor host`. Kodevra's `--executor docker` would run verification in a container, which is a different environment and is reported as such when used.");
  lines.push("- Repair runs are Kodevra's bounded loop (default 2). Plain OpenCode gets one attempt.");
  lines.push("- Token counts and costs are not reported: neither CLI exposes a reliable per-run figure here, so none are invented.");
  lines.push("");

  lines.push("## Known gaps");
  lines.push("");
  lines.push("- `tool_failures` is not measurable from the CLIs' output and is recorded as `null`.");

  lines.push("- A single machine, one date and one model: this is a reproducibility harness, not a claim of general superiority.");
  lines.push("");

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, "summary.md");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  console.log(`\n  wrote ${path.relative(ROOT, file)} (${records.length}/${totalRuns} runs recorded)`);
  return file;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const tasks = loadTasks();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  if (options.list) {
    for (const task of tasks) console.log(`  ${task.id.padEnd(24)} ${task.category.padEnd(16)} ${task.title}`);
    console.log(`\n  ${tasks.length} tasks`);
    return;
  }
  if (options.validate) {
    validateFixtures(tasks);
    return;
  }
  if (options.check) {
    await checkFixtures(tasks);
    return;
  }
  if (options.summary) {
    summarize(tasks, options);
    return;
  }

  const selected = options.all
    ? tasks
    : options.tasks.length
      ? tasks.filter((task) => options.tasks.includes(task.id))
      : null;
  if (!selected) {
    usage();
    process.exit(2);
  }
  if (!selected.length) {
    console.error("No matching tasks. Try --list.");
    process.exit(2);
  }
  const variants = options.variant === "both" ? VARIANTS : [options.variant];

  console.log(`\n  model ${options.model} · ${selected.length} task(s) · variants ${variants.join(", ")}\n`);
  const records = [];
  for (const task of selected) {
    for (const variant of variants) records.push(await runTask(task, variant, options));
  }

  const executed = records.filter(Boolean);
  console.log(
    `\n  ${executed.filter((record) => record.ok).length}/${executed.length} executed runs verified success`,
  );
  summarize(tasks, options);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
