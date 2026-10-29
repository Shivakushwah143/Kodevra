#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { normalizeApprovalMode } from "../../lib/approval-policy.js";
import { createVerificationAuthorization } from "../../lib/authorization.js";
import { runChatGptWebAgent } from "../../lib/chatgpt-web-agent.js";
import {
  CHATGPT_WEB_MODEL,
  CHATGPT_WEB_PROVIDER,
  LIMITS,
  bridgeSettings,
  chatTurn,
  probeBridge,
} from "../../lib/chatgpt-web.js";
import { HARNESS_V2, buildRecord, formatReport, packageVersion, summarize } from "./metrics.js";

/**
 * H8 - Kodevra harness benchmark.
 *
 *   node benchmarks/harness/runner.js --set benchmarks/harness/tasks.smoke.json
 *   node benchmarks/harness/runner.js --set ./my-set.json --out results.jsonl
 *
 * One manifest, one harness, one record per task. The measurement is the real
 * run: the same agent loop, the same verification command, the same bridge. No
 * task id ever reaches the prompt, and nothing here special-cases a repository.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RESULTS_DIR = path.join(ROOT, "benchmarks", "harness", "results");
const DEFAULT_TURNS = 20;
const DEFAULT_REPAIRS = 2;
const VERIFY_TIMEOUT_MS = Number(process.env.KODEVRA_BENCH_VERIFY_MS || 180_000);

function usage() {
  console.log(`Kodevra harness benchmark

  node benchmarks/harness/runner.js --set <manifest.json> [options]

Options
  --set <file>        task manifest (repeatable; JSON array or {"tasks":[...]})
  --task <id>         run only this task (repeatable or comma separated)
  --list              print the tasks in the manifest and exit
  --approval <mode>   strict | balanced | autonomous (overrides the manifest)
  --max-turns <n>     override the manifest turn budget (default ${DEFAULT_TURNS})
  --max-repairs <n>   override the manifest repair budget (default ${DEFAULT_REPAIRS})
  --harness <name>    harness label for the record (default ${HARNESS_V2};
                      other names are representable but not executable here)
  --out <file>        JSONL output (default benchmarks/harness/results/harness-<stamp>.jsonl)
  --json              print machine-readable records instead of the table
  --quiet             only the final report

Manifest task
  { "id": "...", "workspace": "./repo", "task": "...", "verify": "npm test",
    "maxTurns": 30, "maxRepairs": 2, "approval": "autonomous", "timeoutMs": 180000 }

Workspace paths are resolved relative to the manifest file. A run is only
counted VERIFIED when the task's verification command really exits 0.
`);
}

function parse(argv) {
  const opts = {
    sets: [],
    tasks: [],
    list: false,
    json: false,
    quiet: false,
    approval: null,
    maxTurns: null,
    maxRepairs: null,
    harness: HARNESS_V2,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--set") opts.sets.push(path.resolve(argv[(index += 1)] || ""));
    else if (arg === "--task") opts.tasks.push(...`${argv[(index += 1)] || ""}`.split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--list") opts.list = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--quiet") opts.quiet = true;
    else if (arg === "--approval") opts.approval = argv[(index += 1)] || null;
    else if (arg === "--max-turns") opts.maxTurns = Math.max(1, Number(argv[(index += 1)]) || 0);
    else if (arg === "--max-repairs") opts.maxRepairs = Math.max(0, Math.min(5, Number(argv[(index += 1)]) || 0));
    else if (arg === "--harness") opts.harness = `${argv[(index += 1)] || ""}`.trim() || HARNESS_V2;
    else if (arg === "--out") opts.out = path.resolve(argv[(index += 1)] || "");
    else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    } else {
      opts.sets.push(path.resolve(arg));
    }
  }
  if (!opts.sets.length && !opts.list) {
    usage();
    process.exit(2);
  }
  return opts;
}

function normalizeTask(task, base, index, file) {
  const id = `${task.id ?? ""}`.trim();
  if (!id) throw new Error(`${file}: task ${index + 1} needs an "id"`);
  const workspace = path.resolve(base, `${task.workspace ?? ""}`);
  if (!task.workspace) throw new Error(`${file}: task "${id}" needs a "workspace"`);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`${file}: task "${id}" workspace does not exist: ${workspace}`);
  }
  const prompt = `${task.task ?? ""}`.trim();
  if (!prompt) throw new Error(`${file}: task "${id}" needs a "task" prompt`);
  const verify = `${task.verify ?? ""}`.trim();
  if (!verify) throw new Error(`${file}: task "${id}" needs a "verify" command`);
  const approval = task.approval ? normalizeApprovalMode(task.approval) : null;
  if (task.approval && !approval) throw new Error(`${file}: task "${id}" has an unknown approval mode "${task.approval}"`);
  return {
    id,
    workspace,
    task: prompt,
    verify,
    maxTurns: Number.isFinite(Number(task.maxTurns)) ? Math.max(1, Math.floor(Number(task.maxTurns))) : null,
    maxRepairs: Number.isFinite(Number(task.maxRepairs)) ? Math.max(0, Math.min(5, Math.floor(Number(task.maxRepairs)))) : null,
    approval,
    timeoutMs: Number.isFinite(Number(task.timeoutMs)) ? Math.max(10_000, Math.floor(Number(task.timeoutMs))) : VERIFY_TIMEOUT_MS,
  };
}

function loadManifest(file) {
  if (!fs.existsSync(file)) throw new Error(`manifest not found: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  const tasks = Array.isArray(parsed) ? parsed : parsed?.tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error(`${file}: manifest has no tasks`);
  const base = path.dirname(path.resolve(file));
  return tasks.map((task, index) => normalizeTask(task ?? {}, base, index, file));
}

function runVerification({ command, workspace, timeoutMs }) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: workspace,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  const timedOut = result.error?.code === "ETIMEDOUT" || Boolean(result.signal);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-6_000);
  return {
    command,
    ok: result.status === 0 && !timedOut,
    status: result.status ?? null,
    timedOut,
    output,
    durationMs: Date.now() - startedAt,
  };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const version = `${packageVersion(ROOT)}+harness-v2`;
  const harnessVersion = `${opts.harness}@${version}`;

  const tasks = opts.sets.flatMap(loadManifest);
  const seen = new Set();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
  }
  const selected = opts.tasks.length ? tasks.filter((task) => opts.tasks.includes(task.id)) : tasks;
  if (!selected.length) {
    console.error(`No tasks matched: ${opts.tasks.join(", ") || "(all)"}`);
    process.exit(2);
  }

  if (opts.list) {
    for (const task of selected) console.log(`${task.id}\t${task.verify}\t${task.workspace}`);
    return;
  }

  if (opts.harness !== HARNESS_V2) {
    console.error(`Harness "${opts.harness}" is not executable here.`);
    console.error(`  Only ${HARNESS_V2} is implemented; the record schema can carry other harness names later.`);
    process.exit(2);
  }
  if (opts.approval && !normalizeApprovalMode(opts.approval)) {
    console.error(`Unknown approval mode "${opts.approval}". Use: strict | balanced | autonomous`);
    process.exit(2);
  }

  const settings = bridgeSettings();
  const health = await probeBridge(settings);
  if (!health.ok) {
    console.error(`${health.code}: ${health.detail}`);
    if (health.hint) console.error(`  -> ${health.hint}`);
    console.error("  No benchmark task was started.");
    process.exit(2);
  }

  const outFile = opts.out ?? path.join(RESULTS_DIR, `harness-${stamp()}.jsonl`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const records = [];

  for (const task of selected) {
    const approval = normalizeApprovalMode(opts.approval) ?? task.approval ?? "balanced";
    const maxTurns = opts.maxTurns ?? task.maxTurns ?? DEFAULT_TURNS;
    const maxRepairs = opts.maxRepairs ?? task.maxRepairs ?? DEFAULT_REPAIRS;

    if (!opts.quiet) {
      console.log(`\n${task.id}`);
      console.log(`  workspace ${task.workspace}`);
      console.log(`  verify    ${task.verify}`);
      console.log(`  approval  ${approval} · turns ${maxTurns} · repairs ${maxRepairs}`);
    }

    const limits = { ...LIMITS, maxTurns, maxVerifyRepairs: maxRepairs };
    // Same authorization source as `kodevra run --verify`: the fingerprint of the
    // verification surface the run is actually started against, so benchmark
    // checkpoints record a real execution fingerprint instead of null.
    let authorization = null;
    try {
      authorization = createVerificationAuthorization({ workspace: task.workspace, command: task.verify });
    } catch (error) {
      if (!opts.quiet) console.warn(`  warning: no execution fingerprint (${error.code || error.message})`);
    }
    const startedAt = Date.now();
    let result;
    try {
      result = await runChatGptWebAgent({
        workspace: task.workspace,
        task: task.task,
        approval,
        provider: CHATGPT_WEB_PROVIDER,
        model: CHATGPT_WEB_MODEL,
        verifyCommand: task.verify,
        fingerprint: authorization?.fingerprint ?? null,
        limits,
        chat: (message) => chatTurn({ ...message, settings }),
        verify: () => runVerification({ command: task.verify, workspace: task.workspace, timeoutMs: task.timeoutMs }),
      });
    } catch (error) {
      result = {
        ok: false,
        code: error.code || "UNKNOWN",
        failureKind: "harness",
        verified: false,
        turns: 0,
        actions: [],
        verifications: [],
        verification: { state: "not_verified", attempts: 0, exitCode: null },
        harness: { context: { changedFiles: [] } },
        failure: { code: error.code || "UNKNOWN", message: error.message },
      };
    }
    const endedAt = Date.now();
    const record = buildRecord({
      task: { ...task, maxTurns, maxRepairs, approval },
      workspace: task.workspace,
      provider: CHATGPT_WEB_PROVIDER,
      model: CHATGPT_WEB_MODEL,
      harnessVersion,
      result,
      limits,
      startedAt,
      endedAt,
    });
    records.push(record);
    fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`, "utf8");

    if (!opts.quiet && !opts.json) {
      console.log(`  -> ${record.status} · ${(record.durationMs / 1000).toFixed(1)}s · ${record.modelTurns} turn(s) · ${record.repairAttempts} repair(s)`);
      if (record.failureCategory) console.log(`  -> ${record.failureCategory} (${record.failureCode ?? record.failureKind ?? "unknown"})`);
    }
  }

  const summary = summarize(records);
  if (opts.json) {
    for (const record of records) console.log(JSON.stringify(record));
  } else {
    console.log(`\nRESULTS ${outFile}\n`);
    console.log(formatReport(records, summary));
  }

  process.exitCode = records.every((record) => record.status === "VERIFIED") ? 0 : 1;
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exit(1);
});
