#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findCodex, parseCodexEvents, readCodexConfig } from "../../lib/codex.js";
import { snapshotTree, treeChangedFiles } from "../../lib/verify.js";
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
} from "../lib/fixtures.js";

/**
 * Codex benchmark suite.
 *
 * Two comparable execution paths over the same model, prompt and starting
 * repository:
 *
 *   kodevra    `kodevra run --engine codex --verify ...` - Kodevra's adapter,
 *              verification gate and bounded repair loop around `codex exec`
 *   codex-cli  the official `codex exec` on its own - no Kodevra involvement
 *
 * The hidden acceptance test, not either CLI's prose, decides success. Each run
 * gets a disposable repository under the system temp directory and a fixture
 * hash guard, so an agent cannot score by editing the fixtures.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TASKS_DIR = path.join(ROOT, "benchmarks", "codex", "tasks");
const RESULTS_DIR = path.join(ROOT, "benchmarks", "codex", "results");
const RAW_DIR = path.join(RESULTS_DIR, "raw");
const WORK_DIR = path.join(os.tmpdir(), "kodevra-codex-bench");

const DEFAULT_MODEL = process.env.KODEVRA_BENCH_MODEL || "freedeepseek/deepseek-v4-flash";
const AGENT_TIMEOUT = Number(process.env.KODEVRA_BENCH_TIMEOUT_MS || 600_000);
const VERIFY_TIMEOUT = Number(process.env.KODEVRA_BENCH_VERIFY_MS || 120_000);
const VARIANTS = ["kodevra", "codex-cli"];
const REQUIRED_CATEGORIES = ["bug-fix", "feature", "refactoring", "multi-file", "debugging"];

function usage() {
  console.log(`Codex benchmark suite

  node benchmarks/codex/runner.js --list
  node benchmarks/codex/runner.js --validate
  node benchmarks/codex/runner.js --check
  node benchmarks/codex/runner.js --task 01-bugfix-invoice-tax --variant both
  node benchmarks/codex/runner.js --all
  node benchmarks/codex/runner.js --summary

Options
  --all                 every task, both variants
  --task <id>           one task (repeatable, or comma separated)
  --variant <v>         kodevra | codex-cli | both (default: both)
  --model <id>          provider/model used by both variants (default: ${DEFAULT_MODEL})
  --force               re-run tasks that already have a result
  --retries <n>         retry an infrastructure failure (default: 1, max: 2)
  --timeout <ms>        per agent run (default: ${AGENT_TIMEOUT})
  --summary             regenerate results/summary.md

Environment
  KODEVRA_CODEX_BIN     Codex CLI executable when it is not on PATH
  KODEVRA_BENCH_MODEL   model id for both variants
`);
}

function parse(argv) {
  const opts = {
    tasks: [],
    variant: "both",
    model: DEFAULT_MODEL,
    force: false,
    check: false,
    list: false,
    summary: false,
    all: false,
    validate: false,
    retries: 1,
    timeout: AGENT_TIMEOUT,
  };
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
  if (!["kodevra", "codex-cli", "both"].includes(opts.variant)) {
    console.error(`Unknown variant "${opts.variant}". Use kodevra, codex-cli or both.`);
    process.exit(2);
  }
  return opts;
}

function loadTasks() {
  return loadTaskFixtures(TASKS_DIR);
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

/** The provider/model split Codex itself expects (bare model id). */
function splitModel(model) {
  const index = `${model}`.indexOf("/");
  if (index === -1) return { provider: null, model: `${model}` };
  return { provider: model.slice(0, index), model: model.slice(index + 1) };
}

function codexTarget(options) {
  const info = findCodex();
  if (!info.ok) {
    const error = new Error(`Codex CLI is not runnable: ${info.detail}`);
    error.hint = info.hint;
    error.code = "CODEX_UNAVAILABLE";
    throw error;
  }
  const config = readCodexConfig();
  const { provider, model } = splitModel(options.model);
  // Passing the same model id to both paths is what makes the comparison fair.
  // The provider override is only safe for Codex's built-in openai provider; a
  // custom provider must already be the one in Codex's own config.toml.
  const providerOverride = provider === "openai" ? "openai" : null;
  const providerMismatch = Boolean(provider && provider !== "openai" && config.provider && provider !== config.provider);
  return { info, config, model, provider, providerOverride, providerMismatch };
}

function buildAgent(variant, task, workspace, options, target, outcomeFile) {
  if (variant === "kodevra") {
    return {
      command: process.execPath,
      args: [
        path.join(ROOT, "bin", "kodevra.js"),
        "run",
        "--engine",
        "codex",
        "-w",
        workspace,
        "--verify",
        task.verify,
        "--executor",
        "host",
        "-m",
        options.model,
        "--outcome",
        outcomeFile,
        "--no-doctor",
        task.prompt,
      ],
      shell: false,
    };
  }

  const args = [
    ...(target.info.prefixArgs ?? []),
    "exec",
    "--sandbox",
    "workspace-write",
    "-C",
    workspace,
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "-m",
    target.model,
  ];
  if (target.providerOverride) args.push("-c", `model_provider="${target.providerOverride}"`);
  args.push(task.prompt);
  return { command: target.info.command, args, shell: target.info.shell };
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
    "HARNESS_MODE_UNSUPPORTED",
  ];
  return codes.find((code) => output.includes(code)) ?? null;
}

function classifyRun({ agent, verification, tampered, session }) {
  if (tampered) return "fixture_tampered";
  if (!session.ok) return "infra";
  if (agent.timedOut) return "timeout";
  if (agent.status !== 0) {
    if (/rate limit|too many requests|cooldown|quota/i.test(agent.output)) return "rate_limit";
    if (/401|403|unauthori[sz]ed|invalid api key|not logged in/i.test(agent.output)) return "auth";
    if (/ECONNREFUSED|fetch failed|proxy|unreachable/i.test(agent.output)) return "infra";
    return "agent_failure";
  }
  if (verification.status !== 0) return "test_failure";
  return "success";
}

function readOutcome(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function executeTask(task, variant, options, attempt) {
  const workspace = path.join(WORK_DIR, variant, task.id);
  resetWorkspace(task, workspace);

  const beforeTree = snapshotTree(workspace);
  const fixtureHash = hashTree(task.dir);
  const session = await resetProviderSession(options.model);
  // A remote provider (e.g. ChatGPT) has no sticky local session to reset; that
  // is not an infrastructure failure. A local proxy that refuses the reset is.
  const sessionOk = session.ok || session.reason === "no local proxy";
  const outcomeFile = path.join(WORK_DIR, variant, `${task.id}.outcome.json`);
  fs.rmSync(outcomeFile, { force: true });

  const target = codexTarget(options);
  const base = {
    task: task.id,
    title: task.title,
    category: task.category,
    variant,
    model: options.model,
    codex_model: target.model,
    codex_provider: target.provider,
    codex_provider_mismatch: target.providerMismatch,
    codex_version: target.info.version,
    started_at: new Date().toISOString(),
    attempt,
    session_reset: sessionOk,
    session_reset_detail: session.reason,
    tool_failures: null,
  };

  if (!sessionOk) {
    return {
      ...base,
      ok: false,
      error_type: "infra",
      error: "provider session reset failed",
      duration_ms: 0,
      agent_exit: null,
      agent_timed_out: false,
      verify_exit: null,
      verify_tail: "",
      agent_tail: "",
      files_changed: [],
    };
  }

  const agent = buildAgent(variant, task, workspace, options, target, outcomeFile);
  console.log(`  run     ${variant.padEnd(9)} ${task.id}${attempt > 1 ? ` retry ${attempt}` : ""}`);
  const agentRun = await run(agent.command, agent.args, {
    cwd: workspace,
    timeout: options.timeout,
    shell: agent.shell,
  });
  const filesChanged = treeChangedFiles(beforeTree, workspace);
  const tampered = hashTree(task.dir) !== fixtureHash;
  const outcome = variant === "kodevra" ? readOutcome(outcomeFile) : null;
  // Plain Codex emits the same official JSONL, so its own usage and command
  // evidence are read from it rather than from the terminal text.
  const events = outcome ? null : parseCodexEvents(agentRun.output);

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
    };
  }

  const acceptance = applyAcceptance(task, workspace);
  const verification = await run(task.verify, [], { cwd: workspace, timeout: VERIFY_TIMEOUT, shell: true });
  for (const file of acceptance) fs.rmSync(path.join(workspace, "test", file), { force: true });

  // Kodevra's own verification is the source of truth for its path. The extra
  // (hidden) acceptance run above is the judge for both paths, so a Kodevra
  // "verified" claim is never taken on trust.
  const errorType = classifyRun({ agent: agentRun, verification, tampered, session: { ok: sessionOk } });

  return {
    ...base,
    ok: errorType === "success",
    status: outcome?.status ?? (errorType === "success" ? "verified" : errorType),
    error_type: errorType,
    error: errorType === "success" ? null : errorType,
    duration_ms: agentRun.durationMs + verification.durationMs,
    agent_exit: agentRun.status,
    agent_timed_out: agentRun.timedOut,
    verify_exit: verification.status,
    verify_tail: tail(verification.output),
    agent_tail: tail(agentRun.output),
    files_changed: filesChanged,
    tokens: outcome?.evidence?.agent?.tokens ?? events?.tokens ?? null,
    thread_id: outcome?.evidence?.agent?.thread_id ?? events?.threadId ?? null,
    commands: outcome?.evidence?.agent?.commands?.length ?? events?.commands?.length ?? null,
    failed_commands: outcome?.evidence?.agent?.failed_commands ?? events?.failedCommands?.length ?? null,
    turn_completed: outcome?.evidence?.agent?.turn_completed ?? events?.turnCompleted ?? null,
    repairs: outcome?.repairs?.attempts ?? null,
    provider_error: providerError(agentRun.output),
    outcome,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTask(task, variant, options) {
  const existing = readResult(variant, task);
  if (existing && !options.force) {
    console.log(`  skip    ${variant.padEnd(9)} ${task.id} ${existing.ok ? "PASS" : "FAIL"} (recorded; --force to re-run)`);
    return existing;
  }

  let record;
  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    record = await executeTask(task, variant, options, attempt);
    if (record.error_type === "infra" && attempt <= options.retries) {
      console.log(`  retry   ${variant.padEnd(9)} ${task.id} after infrastructure failure (${record.error})`);
      await sleep(2000);
      continue;
    }
    break;
  }

  writeResult(record);
  console.log(
    `  ${record.ok ? "PASS" : "FAIL"}    ${variant.padEnd(9)} ${record.task} (${record.error_type}) files=${record.files_changed.length} agent_exit=${record.agent_exit} verify_exit=${record.verify_exit} ${(record.duration_ms / 1000).toFixed(1)}s`,
  );
  return record;
}

function validateFixtures(tasks) {
  const problems = [];
  const categories = new Set();
  for (const task of tasks) {
    const fail = (message) => problems.push(`${task.id}: ${message}`);
    categories.add(task.category);
    if (task.id !== path.basename(task.dir)) fail(`manifest id "${task.id}" does not match its directory`);
    for (const field of ["title", "category", "prompt", "verify"]) {
      if (!task[field] || typeof task[field] !== "string") fail(`manifest is missing "${field}"`);
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(task.template, "package.json"), "utf8"));
      if (!pkg.scripts?.test) fail("template package.json has no test script");
    } catch {
      fail("template package.json is missing or invalid");
    }

    if (!listFiles(task.template).some((file) => file.startsWith("src/"))) fail("template has no src files");

    const hidden = fs.existsSync(task.acceptance)
      ? fs.readdirSync(task.acceptance).filter((file) => file.endsWith(".test.js"))
      : [];
    if (!hidden.length) fail("no hidden acceptance test");

    if (!fs.existsSync(task.solution) || !listFiles(task.solution).length) fail("no reference solution");

    for (const leaked of hidden) {
      if (listFiles(task.template).some((file) => path.basename(file) === path.basename(leaked))) {
        fail(`template contains the hidden acceptance test: ${leaked}`);
      }
    }
  }

  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) problems.push(`suite is missing a "${category}" scenario`);
  }

  console.log(`\n  ${tasks.length} manifests checked · categories ${[...categories].sort().join(", ")}`);
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
      category: task.category,
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

  const variantsRun = [...new Set(records.map((record) => record.variant))];
  const lines = ["# Kodevra Codex harness benchmark", ""];
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Requested model (both variants): \`${options.model}\``);
  lines.push(`Machine: ${process.platform}/${process.arch}, Node ${process.versions.node}`);
  const codex = findCodex({ refresh: true });
  lines.push(`Codex CLI: ${codex.ok ? `\`${codex.version}\` (${codex.source})` : `unavailable - ${codex.detail}`}`);
  lines.push("");

  lines.push("## Coverage");
  lines.push("");
  lines.push(`- Scenarios implemented: **${tasks.length}** (${[...new Set(tasks.map((task) => task.category))].join(", ")})`);
  for (const variant of VARIANTS) {
    const own = records.filter((record) => record.variant === variant);
    lines.push(`- ${variant}: ${own.length}/${tasks.length} executed, ${own.filter((record) => record.ok).length} verified success`);
  }
  const unexecuted = [];
  for (const task of tasks) {
    for (const variant of VARIANTS) {
      if (!executed.has(`${variant}/${task.id}`)) unexecuted.push(`${variant}/${task.id}`);
    }
  }
  if (unexecuted.length) lines.push(`- Not executed: ${unexecuted.join(", ")}`);
  if (fixtures) {
    lines.push(`- Fixture integrity (last --check): ${fixtures.tasks.filter((task) => task.ok).length}/${fixtures.tasks.length} sound`);
  }
  if (fs.existsSync(path.join(RESULTS_DIR, "reference"))) {
    lines.push(
      "- A verified Codex-adapter run is preserved in `results/reference/` because a later `--force` re-run overwrote its raw record with a quota failure. `runs.jsonl` holds every attempt.",
    );
  }
  if (records.length && records.every((record) => record.agent_timed_out)) {
    lines.push("- **No valid comparison:** every recorded run timed out. These are infrastructure results, not model results.");
  }
  if (records.length && records.every((record) => record.error_type === "infra" || !record.session_reset)) {
    lines.push("- **No valid comparison:** the provider session reset failed for every run, so task isolation is unproven.");
  }
  const rateLimited = records.filter((record) => record.error_type === "rate_limit");
  if (rateLimited.length) {
    const variants = [...new Set(rateLimited.map((record) => record.variant))].join(", ");
    lines.push(
      `- **${rateLimited.length} run(s) hit the provider usage limit** (${variants}). Those are quota failures, not harness results; re-run them when the account has quota with \`node benchmarks/codex/runner.js --all\`.`,
    );
  }
  lines.push("");

  lines.push("## Per-task results");
  lines.push("");
  lines.push(`| Task | Category | ${VARIANTS.join(" | ")} |`);
  lines.push(`| --- | --- | ${VARIANTS.map(() => "---").join(" | ")} |`);
  for (const task of tasks) {
    const cell = (variant) => {
      const record = readResult(variant, task);
      if (!record) return "not run";
      const label = record.ok ? "PASS" : `FAIL (${record.error_type})`;
      return `${label} ${(record.duration_ms / 1000).toFixed(1)}s verify=${record.verify_exit}`;
    };
    lines.push(`| \`${task.id}\` ${task.title} | ${task.category} | ${VARIANTS.map(cell).join(" | ")} |`);
  }
  lines.push("");

  lines.push("## What each variant did");
  lines.push("");
  lines.push("- `kodevra`: `kodevra run --engine codex --verify <task verify> --executor host` - the Codex adapter, Kodevra's verification gate, bounded repair (2) and a normalised outcome file (`--outcome`).");
  lines.push("- `codex-cli`: the official `codex exec --sandbox workspace-write --json` with the same prompt, model and starting repository, and no Kodevra involvement.");
  lines.push("- Both are judged afterwards by the same hidden acceptance test, copied in only after the agent stops.");
  lines.push("");

  lines.push("## Fairness notes");
  lines.push("");
  lines.push("- Same model id, same task prompt (Kodevra does not prepend a workspace hint for Codex; `-C` anchors the run), same starting repository, same acceptance test.");
  lines.push("- Every repository is reset from its fixture before a run, and its own git root is created under the system temp directory.");
  lines.push("- The fixture directory is hashed before and after; a run that touches a fixture is rejected as `fixture_tampered` instead of scored.");
  lines.push("- A Kodevra PASS requires both its own verification and the hidden acceptance test to pass. Plain Codex gets one attempt; Kodevra may run up to two repairs, so a Kodevra win can reflect the repair loop rather than the harness.");
  lines.push("- Codex runs under its own sandbox (`workspace-write`) and its own credentials. On Windows the `[windows] sandbox = \"elevated\"` setting in Codex's config is required for shell tools to run at all; without it Codex can exit 0 while doing nothing, and the hidden test catches that.");
  lines.push("- Token counts come from Codex's `turn.completed` usage event (Kodevra's outcome file, or the plain CLI's own JSONL). They are never estimated; a record made before that extraction shows `null`.");
  lines.push("");

  lines.push("## Known gaps");
  lines.push("");
  lines.push("- A single machine, one date and one model: this is a reproducibility harness, not a claim of superiority.");
  lines.push("- Plain Codex gets no `--verify` loop, so the comparison measures the whole Kodevra path (gate + repair + outcome) against the raw CLI, not the two harnesses' reasoning in isolation.");
  lines.push("- Kodevra's `--verify` runs the task suite inside the run and the runner runs it again with the hidden test; Kodevra's recorded duration therefore includes one extra suite run.");
  lines.push("");

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, "summary.md");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  console.log(`\n  wrote ${path.relative(ROOT, file)} (${records.length}/${tasks.length * VARIANTS.length} runs recorded${variantsRun.length ? `; variants ${variantsRun.join(", ")}` : ""})`);
  return file;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const tasks = loadTasks();
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  if (options.list) {
    for (const task of tasks) console.log(`  ${task.id.padEnd(30)} ${task.category.padEnd(12)} ${task.title}`);
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
  const target = codexTarget(options);
  console.log(`\n  model ${options.model} · codex ${target.info.version} · ${selected.length} task(s) · variants ${variants.join(", ")}`);
  if (target.providerMismatch) {
    console.log(
      `  ${"note"}     Codex config.toml uses provider "${target.config.provider}"; the requested "${target.provider}" is not applied by the Codex path.`,
    );
  }
  console.log("");

  const records = [];
  for (const task of selected) {
    for (const variant of variants) records.push(await runTask(task, variant, options));
  }

  const executed = records.filter(Boolean);
  console.log(`\n  ${executed.filter((record) => record.ok).length}/${executed.length} executed runs verified success`);
  summarize(tasks, options);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.hint) console.error(`  -> ${error.hint}`);
  process.exit(1);
});
