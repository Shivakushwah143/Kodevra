#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { readConfig, providerEntry } from "../lib/config.js";
import { findExecutable } from "../lib/doctor.js";
import { snapshotTree, treeChangedFiles } from "../lib/verify.js";

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
  --timeout <ms>        per agent run (default: ${AGENT_TIMEOUT})
  --summary             regenerate results/summary.md from recorded results
`);
}

function parse(argv) {
  const opts = { tasks: [], variant: "both", model: DEFAULT_MODEL, force: false, check: false, list: false, summary: false, all: false, validate: false, timeout: AGENT_TIMEOUT };
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
  const entries = fs.readdirSync(TASKS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return entries
    .map((entry) => {
      const dir = path.join(TASKS_DIR, entry.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
      return {
        ...manifest,
        dir,
        template: path.join(dir, "template"),
        acceptance: path.join(dir, "acceptance"),
        solution: path.join(dir, "solution"),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function resetWorkspace(task, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  copyDir(task.template, destination);
  // Its own git root: the engine's project root becomes this workspace, so
  // Kodevra's workspace-scoped permission overlay cannot widen to the machine.
  spawnSync("git", ["init", "-q"], { cwd: destination, stdio: "ignore" });
}

function applyAcceptance(task, workspace) {
  const files = fs.readdirSync(task.acceptance).filter((file) => file.endsWith(".test.js"));
  for (const file of files) {
    fs.copyFileSync(path.join(task.acceptance, file), path.join(workspace, "test", file));
  }
  return files;
}

function applySolution(task, workspace) {
  if (!fs.existsSync(task.solution)) return 0;
  const before = snapshotTree(workspace);
  copyDir(task.solution, workspace);
  return treeChangedFiles(before, workspace).length;
}

/**
 * Spawn with a hard timeout that kills the whole process tree. A CLI that
 * leaves an orphaned engine behind would keep the proxy chat lock and poison
 * every later run, so killing the tree is part of the measurement, not polish.
 */
function run(command, args, { cwd, timeout, shell = false }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      timeout,
      shell,
      env: { ...process.env, KODEVRA_SKIP_DOCKER_PROBE: "1", CI: "1", NO_COLOR: "1" },
    });

    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut ? 124 : status ?? 1,
        signal: signal ?? null,
        timedOut,
        output,
        durationMs: Date.now() - startedAt,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
      finish(124, null);
    }, timeout);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 4_000_000) output = output.slice(-4_000_000);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 4_000_000) output = output.slice(-4_000_000);
    });
    child.on("error", (error) => {
      output += `\n${error.message}`;
      finish(1, null);
    });
    child.on("close", (status, signal) => finish(status, signal));
  });
}

function opencodeCommand() {
  const engine = findExecutable("opencode");
  if (!engine) throw new Error("opencode is not on PATH; install it with: npm i -g opencode-ai");
  return engine;
}

/**
 * The local DeepSeek proxy is sticky per client. Every CLI run here is the same
 * unkeyed client, so without a reset one benchmark task would see the previous
 * task's conversation - and the two variants would share memory. Reset the
 * proxy chat before each run so task state is genuinely fresh.
 */
async function resetProviderSession(model) {
  const provider = `${model}`.split("/")[0];
  const entry = providerEntry(readConfig().data, provider);
  const baseURL = entry?.options?.baseURL;
  if (!baseURL || !/localhost|127\.0\.0\.1|\[::1\]/.test(baseURL)) return { ok: false, reason: "no local proxy" };
  try {
    const origin = baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const response = await fetch(`${origin}/reset-session?agent=all&history=drop`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
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

function tail(text, size = 1500) {
  return text.length > size ? `...${text.slice(-size)}` : text;
}

function hashTree(dir) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(dir).sort()) {
    hash.update(`${file}\u0000`);
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update("\u0000");
  }
  return hash.digest("hex");
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

async function runTask(task, variant, options) {
  const existing = readResult(variant, task);
  if (existing && !options.force) {
    console.log(`  skip    ${variant.padEnd(8)} ${task.id} ${existing.ok ? "PASS" : "FAIL"} (recorded; --force to re-run)`);
    return existing;
  }

  const workspace = path.join(WORK_DIR, variant, task.id);
  resetWorkspace(task, workspace);

  const beforeTree = snapshotTree(workspace);
  const fixtureHash = hashTree(task.dir);
  const session = await resetProviderSession(options.model);
  const agent = buildAgent(variant, task, workspace, options);
  console.log(`  run     ${variant.padEnd(8)} ${task.id} ${path.basename(task.dir)}`);
  const agentRun = await run(agent.command, agent.args, { cwd: workspace, timeout: options.timeout, shell: agent.shell });
  const filesChanged = treeChangedFiles(beforeTree, workspace);

  // A read-only hash guard: if an agent reached back into the fixtures, the
  // run is invalid and is reported as such instead of scoring a fake pass.
  if (hashTree(task.dir) !== fixtureHash) {
    const record = {
      task: task.id,
      title: task.title,
      category: task.category,
      variant,
      model: options.model,
      ok: false,
      error: "fixture tampered during the run",
      started_at: new Date().toISOString(),
      duration_ms: agentRun.durationMs,
      agent_exit: agentRun.status,
      agent_timed_out: agentRun.timedOut,
      verify_exit: null,
      verify_tail: "",
      agent_tail: tail(agentRun.output),
      files_changed: filesChanged,
      attempts: 1,
      repairs: null,
      tool_failures: null,
      provider_error: providerError(agentRun.output),
      tokens: null,
      session_reset: session.ok,
      session_reset_detail: session.reason,
    };
    writeResult(record);
    console.log(`  TAMPER  ${variant.padEnd(8)} ${task.id} fixture changed during the run; result rejected`);
    return record;
  }

  const acceptance = applyAcceptance(task, workspace);
  const verification = await run(task.verify, [], {
    cwd: workspace,
    timeout: VERIFY_TIMEOUT,
    shell: true,
  });
  for (const file of acceptance) fs.rmSync(path.join(workspace, "test", file), { force: true });

  const repairs = variant === "kodevra" ? countRepairs(agentRun.output) : null;
  const record = {
    task: task.id,
    title: task.title,
    category: task.category,
    variant,
    model: options.model,
    ok: verification.status === 0,
    started_at: new Date().toISOString(),
    duration_ms: agentRun.durationMs + verification.durationMs,
    agent_exit: agentRun.status,
    agent_timed_out: agentRun.timedOut,
    verify_exit: verification.status,
    verify_tail: tail(verification.output),
    agent_tail: tail(agentRun.output),
    files_changed: filesChanged,
    attempts: 1 + (repairs ?? 0),
    repairs,
    tool_failures: null,
    provider_error: providerError(agentRun.output),
    tokens: null,
    session_reset: session.ok,
    session_reset_detail: session.reason,
  };

  writeResult(record);
  console.log(
    `  ${record.ok ? "PASS" : "FAIL"}    ${variant.padEnd(8)} ${task.id} files=${filesChanged.length} agent_exit=${agentRun.status} verify_exit=${verification.status} ${(record.duration_ms / 1000).toFixed(1)}s`,
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

function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), `${relative}/`));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
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
