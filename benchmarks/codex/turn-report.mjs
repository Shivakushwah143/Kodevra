#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Turn-level report for real Codex rollouts.
 *
 * The number that decides whether a prompt change helped is the count of model
 * round trips to a verified change, not the number of tool calls: several
 * independent calls inside one response are one turn. Codex writes its full
 * rollout to `$CODEX_HOME/sessions/<date>/rollout-*.jsonl`, which is the only
 * place where that boundary is recorded, so this reads those files directly.
 *
 * A turn is one model response: everything from just after the previous tool
 * output up to and including the call batch (or final message) it produced. Two
 * calls in one response are one turn; the same two calls in two responses are
 * two. `tools per turn` therefore reads 1.00 for a model that never batches.
 *
 * Usage:
 *   node benchmarks/codex/turn-report.mjs <rollout.jsonl>...
 *   node benchmarks/codex/turn-report.mjs --dir <sessions dir> [--json]
 *   node benchmarks/codex/turn-report.mjs --dir <sessions dir> --group
 *
 * Exit code 0 always: this is a measuring instrument, not a gate.
 */

/** Environment failures this workspace has actually produced, by signature. */
const ENVIRONMENT_SIGNATURES = [
  [/access to the path .* is denied/i, "cwd/ACL denied"],
  [/access is denied/i, "cwd/ACL denied"],
  [/running scripts is disabled|npm\.ps1 cannot be loaded/i, "powershell policy (npm.ps1)"],
  [/not a git repository/i, "cwd not applied (git)"],
  [/the system cannot find the path specified/i, "relative path from C:\\"],
  [/invalid patch|last line of the patch must be|requires a utf-8 patch argument/i, "apply_patch quoting"],
  [/failed to read file to update/i, "relative path from C:\\"],
];

const EDIT_PATTERN = /apply_patch|Set-Content|Out-File|Add-Content/i;
const VERIFY_PATTERN = /\b(npm|npm\.cmd|yarn|pnpm|node|pytest|jest|vitest|go|cargo|dotnet)\b[^\n]*\b(test|spec|check|lint|build|tsc)\b/i;
const READ_PATTERN = /Get-Content|\bcat\b|Select-String|Get-Item/i;
const SEARCH_PATTERN = /\brg\b|Get-ChildItem|\bls\b|\bdir\b|git status|git diff|git log|\bfind\b|\bgrep\b|Get-Command/i;

function environmentKind(text = "") {
  for (const [pattern, label] of ENVIRONMENT_SIGNATURES) if (pattern.test(text)) return label;
  return null;
}

/** What a tool call did, from the call itself - never from the model's prose. */
export function classifyCall({ name = "", arguments: args = "", failed = false, output = "" }) {
  const call = `${name} ${args}`;
  if (/update_plan/.test(call)) return "PLANNING";
  if (EDIT_PATTERN.test(call)) return "EDIT";
  if (VERIFY_PATTERN.test(call)) return "VERIFICATION";
  if (/package\.json|\.lock\b|tsconfig|AGENTS\.md|pyproject\.toml|go\.mod/i.test(call)) return "DEPENDENCY_LOOKUP";
  if (READ_PATTERN.test(call)) return "READ";
  if (SEARCH_PATTERN.test(call)) return "DISCOVERY";
  // A failed call is still what the model tried to do; the failure is recorded
  // separately (and by environment signature), so classification stays stable.
  return "OTHER";
}

/**
 * One rollout, as turns. `prompt` keeps every user message so a run can be
 * labelled by what it was actually told (baseline vs context block vs contract).
 */
export function parseRollout(file) {
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A truncated final line (interrupted run) is not a record.
    }
  }

  const meta = records.find((record) => record.type === "session_meta")?.payload ?? {};
  const prompts = [];
  const turns = [];
  let current = null;
  let sawOutput = false;
  let startedAt = null;
  let previousEnd = null;

  for (const record of records) {
    const at = record.timestamp ? Date.parse(record.timestamp) : null;
    if (record.type === "event_msg") {
      if (record.payload?.type === "task_started" && startedAt === null) startedAt = at;
      continue;
    }
    if (record.type !== "response_item") continue;
    const payload = record.payload ?? {};

    if (payload.type === "message" && payload.role === "user") {
      prompts.push((payload.content ?? []).map((part) => part.text ?? "").join("\n"));
      continue;
    }
    if (payload.type === "message" && payload.role === "developer") continue;

    if (payload.type === "reasoning" || (payload.type === "message" && payload.role === "assistant")) {
      if (!current) current = { start: at, end: at, calls: [], messages: [], reasoning: 0 };
      if (payload.type === "reasoning") current.reasoning += 1;
      else current.messages.push((payload.content ?? []).map((part) => part.text ?? "").join(" "));
      continue;
    }
    if (payload.type === "function_call") {
      // A call after an output is a new response; two calls before any output are
      // one response with a batch.
      if (!current || sawOutput) {
        current = { start: at, end: at, calls: [], messages: [], reasoning: 0 };
        turns.push(current);
        sawOutput = false;
      }
      current.calls.push({ at, name: payload.name ?? "", arguments: `${payload.arguments ?? ""}`, call_id: payload.call_id });
      continue;
    }
    if (payload.type === "function_call_output") {
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
      const call = current?.calls.find((entry) => entry.call_id === payload.call_id);
      if (call) {
        call.output = output;
        call.failed = /(?:Process exited with code|exit code[:\s]+)\s*[1-9]/i.test(output);
        call.failure = environmentKind(output);
        call.class = classifyCall(call);
      }
      if (current) current.end = at;
      sawOutput = true;
      previousEnd = at;
    }
  }

  for (const turn of turns) {
    turn.classes = turn.calls.map((call) => call.class ?? classifyCall(call));
    turn.model_gap_ms = previousEnd !== null && turn.start ? turn.start - previousEnd : null;
    for (const call of turn.calls) {
      call.class = call.class ?? classifyCall(call);
      if (!call.failure && call.failed) call.failure = environmentKind(call.output ?? "");
    }
    previousEnd = turn.end ?? turn.start;
  }

  return {
    file: path.basename(file),
    cwd: meta.cwd ?? null,
    cli: meta.cli_version ?? null,
    model: meta.model ?? null,
    prompts,
    turns: turns.filter((turn) => turn.calls.length || turn.messages.length),
    startedAt,
  };
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Everything the acceptance rule needs from one rollout. */
export function rollup(parsed) {
  const turns = parsed.turns;
  const calls = turns.flatMap((turn) => turn.calls);
  const failures = calls.filter((call) => call.failed);
  const start = parsed.startedAt ?? turns[0]?.start ?? null;
  const end = turns.at(-1)?.end ?? null;
  // The first turn that actually changed a file: a refused patch attempt is not
  // an edit, it is a wasted turn.
  const editTurn = turns.findIndex((turn) => turn.calls.some((call) => call.class === "EDIT" && !call.failed));
  const verifyTurns = turns.filter((turn) => turn.classes.includes("VERIFICATION")).length;

  const reads = calls
    .filter((call) => call.class === "READ" || call.class === "DEPENDENCY_LOOKUP")
    .map((call) => (call.arguments.match(/['"]([^'"]+\.\w{1,5})['"]/) ?? [])[1])
    .filter(Boolean);
  const repeatedReads = reads.filter((file, index) => reads.indexOf(file) !== index);
  const commandKeys = calls.map((call) => call.arguments.replace(/\s+/g, " ").trim());
  const repeatedCommands = commandKeys.filter((key, index) => key && commandKeys.indexOf(key) !== index);

  const prompt = parsed.prompts.join("\n");
  return {
    file: parsed.file,
    label: /kodevra_execution_contract/i.test(prompt) ? "contract" : /kodevra_context/i.test(prompt) ? "context" : "native",
    task: (parsed.prompts.find((text) => text && !text.startsWith("<")) ?? "").replace(/\s+/g, " ").slice(0, 70),
    turns: turns.length,
    calls: calls.length,
    callsPerTurn: turns.length ? Number((calls.length / turns.length).toFixed(2)) : 0,
    failed: failures.length,
    environmentFailures: failures.filter((call) => call.failure).length,
    environmentKinds: [...new Set(failures.map((call) => call.failure).filter(Boolean))],
    verificationTurns: verifyTurns,
    planningTurns: turns.filter((turn) => turn.classes.every((name) => name === "PLANNING")).length,
    firstEditTurn: editTurn === -1 ? null : editTurn + 1,
    firstEditS: editTurn === -1 || !start ? null : Number(((turns[editTurn].calls[0].at - start) / 1000).toFixed(1)),
    repeatedReads: repeatedReads.length,
    repeatedCommands: repeatedCommands.length,
    durationS: start && end ? Number(((end - start) / 1000).toFixed(1)) : null,
    thinkMs: turns.map((turn) => turn.model_gap_ms).filter((value) => Number.isFinite(value) && value > 0 && value < 600_000),
    timeline: turns.map((turn) => `${turn.classes.join("+") || "MESSAGE"}${turn.calls.some((call) => call.failure) ? "!" : ""}`),
  };
}

function group(rows) {
  const buckets = new Map();
  for (const row of rows) {
    if (!buckets.has(row.label)) buckets.set(row.label, []);
    buckets.get(row.label).push(row);
  }
  return [...buckets.entries()].map(([label, list]) => ({
    label,
    runs: list.length,
    turnsMedian: median(list.map((row) => row.turns)),
    turnsP95: percentile(list.map((row) => row.turns), 95),
    durationMedian: median(list.map((row) => row.durationS).filter((value) => value !== null)),
    durationP95: percentile(list.map((row) => row.durationS).filter((value) => value !== null), 95),
    callsPerTurn: Number((list.reduce((sum, row) => sum + row.calls, 0) / Math.max(1, list.reduce((sum, row) => sum + row.turns, 0))).toFixed(2)),
    firstEditMedian: median(list.map((row) => row.firstEditTurn).filter((value) => value !== null)),
    environmentFailures: list.reduce((sum, row) => sum + row.environmentFailures, 0),
    repeatedReads: list.reduce((sum, row) => sum + row.repeatedReads, 0),
    thinkMedian: median(list.flatMap((row) => row.thinkMs)),
  }));
}

function main(argv) {
  const json = argv.includes("--json");
  const grouped = argv.includes("--group");
  const dirIndex = argv.indexOf("--dir");
  let files = argv.filter((arg) => !arg.startsWith("--") && arg !== argv[dirIndex + 1] && arg.endsWith(".jsonl"));
  if (dirIndex !== -1) {
    const dir = argv[dirIndex + 1];
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
  }
  if (!files.length) {
    const fallback = path.join(os.homedir(), ".codex", "sessions");
    console.error(`No rollout files. Pass paths, or --dir <sessions dir> (default location: ${fallback}).`);
    return 1;
  }

  const rows = files.map((file) => rollup(parseRollout(file))).filter((row) => row.turns > 0);
  const byDuration = [...rows].sort((a, b) => (a.durationS ?? 0) - (b.durationS ?? 0));

  if (json) {
    console.log(JSON.stringify({ runs: byDuration, groups: group(byDuration) }, null, 2));
    return 0;
  }

  console.log("wall   turns calls c/t  fail env  plan verify editTurn firstEdit  kind      task");
  for (const row of byDuration) {
    console.log(
      [
        String(row.durationS ?? "-").padStart(6),
        String(row.turns).padStart(5),
        String(row.calls).padStart(5),
        String(row.callsPerTurn).padStart(4),
        String(row.failed).padStart(5),
        String(row.environmentFailures).padStart(3),
        String(row.planningTurns).padStart(4),
        String(row.verificationTurns).padStart(6),
        String(row.firstEditTurn ?? "-").padStart(8),
        String(row.firstEditS ?? "-").padStart(9),
        row.label.padEnd(9),
        row.task,
      ].join(" "),
    );
  }

  if (grouped) {
    console.log("\nlabel      runs  turns med/p95   wall med/p95   calls/turn  envFail  repeat reads  think med");
    for (const bucket of group(byDuration)) {
      console.log(
        [
          bucket.label.padEnd(10),
          String(bucket.runs).padStart(4),
          `${bucket.turnsMedian ?? "-"}/${bucket.turnsP95 ?? "-"}`.padStart(12),
          `${bucket.durationMedian ?? "-"}/${bucket.durationP95 ?? "-"}`.padStart(14),
          String(bucket.callsPerTurn).padStart(10),
          String(bucket.environmentFailures).padStart(8),
          `${bucket.repeatedReads}`.padStart(14),
          `${bucket.thinkMedian ?? "-"} ms`.padStart(10),
        ].join(" "),
      );
    }
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("turn-report.mjs")) process.exit(main(process.argv.slice(2)));
