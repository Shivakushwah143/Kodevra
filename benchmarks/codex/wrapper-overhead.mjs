import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Pure wrapper overhead for `kodevra run --engine codex`.
 *
 * The Codex child is a stub that answers the probes Kodevra performs and exits
 * immediately, so nothing measured here is model or tool time. What remains is
 * Kodevra's own work: CLI parse, engine probe, provider/model resolution, auth
 * and config checks, catalog resolution, workspace scan, spawn preparation and
 * the post-run bookkeeping.
 *
 * Usage: node benchmarks/codex/wrapper-overhead.mjs [default|fast|both]
 * RUNS=11 by default; the first run is reported as cold, the rest as warm.
 *
 * The stub talks only to Kodevra: it never contacts a provider, so this can run
 * without credentials, network or OpenCode installed.
 */
const here = path.resolve(import.meta.dirname);
const repo = path.resolve(here, "..", "..");
const work = path.join(repo, "benchmarks", ".work", "codex-wrapper");
const binDir = path.join(work, "bin");
const ws = path.join(work, "ws");
const stubJs = path.join(binDir, "codex-stub.js");
const stubCmd = path.join(binDir, "codex-stub.cmd");
const BIN = path.join(repo, "bin", "kodevra.js");
const RUNS = Number(process.env.RUNS || 11);

const STUB = `#!/usr/bin/env node
// Stub Codex CLI for Kodevra wrapper-overhead measurements. It answers only the
// probes Kodevra makes and emits the minimal valid exec JSONL stream.
import fs from "node:fs";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("codex-cli 0.149.1");
  process.exit(0);
}

if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}

if (args[0] === "debug" && args[1] === "models") {
  const bundled = args.includes("--bundled");
  const catalog = bundled
    ? { models: [{ slug: "gpt-5.6-terra", default_service_tier: "default", service_tiers: [{ id: "default" }, { id: "priority" }] }] }
    : { models: [] };
  console.log(JSON.stringify(catalog));
  process.exit(0);
}

if (args[0] === "exec" || args.includes("exec")) {
  const outIndex = args.indexOf("-o");
  if (outIndex !== -1 && args[outIndex + 1]) {
    fs.writeFileSync(args[outIndex + 1], "stub finished\\n", "utf8");
  }
  const events = [
    { type: "thread.started", thread_id: "stub-thread" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "stub finished" } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  for (const event of events) console.log(JSON.stringify(event));
  process.exit(0);
}

console.error("stub: unsupported args " + args.join(" "));
process.exit(1);
`;

function prepare() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(stubJs, STUB);
  fs.writeFileSync(stubCmd, '@ECHO off\r\nnode "%~dp0codex-stub.js" %*\r\n');
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"stub-ws","private":true}\n');
  fs.writeFileSync(path.join(ws, "src", "index.js"), "export const value = 1;\n");
  spawnSync("git", ["init", "-q"], { cwd: ws, stdio: "ignore" });
  const git = (args) =>
    spawnSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@local", ...args], { cwd: ws, stdio: "ignore" });
  git(["add", "-A"]);
  git(["commit", "-qm", "fixture"]);
}

function resetWorkspace() {
  fs.writeFileSync(path.join(ws, "src", "index.js"), "export const value = 1;\n");
}

function parseTimings(text) {
  const line = text.split(/\r?\n/).find((entry) => entry.includes("timings ") && entry.includes("·"));
  if (!line) return null;
  const marks = {};
  for (const part of line.replace(/^.*?timings\s+/, "").split("·")) {
    const match = part.trim().match(/^(.+?)\s+([\d.]+)s$/);
    if (match) marks[match[1].replace(/ /g, "_")] = Math.round(Number(match[2]) * 1000);
  }
  return marks;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function bench(label, extraArgs = []) {
  const records = [];
  for (let index = 0; index < RUNS; index += 1) {
    resetWorkspace();
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [BIN, "run", "--engine", "codex", "-m", "openai/gpt-5.6-terra", ...extraArgs, "stub task"],
      {
        cwd: ws,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, CI: "1", NO_COLOR: "1", KODEVRA_CODEX_BIN: stubCmd },
      },
    );
    const wall = Date.now() - started;
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    const marks = parseTimings(output);
    records.push({ index: index + 1, exit: result.status, wall, total: marks?.total ?? null, marks });
    console.log(`${label} ${String(index + 1).padStart(2)} exit=${result.status} wall=${wall}ms total=${marks?.total ?? "?"}ms`);
    if (result.status !== 0) console.log(output.split(/\r?\n/).slice(-12).join("\n"));
  }

  const cold = records[0];
  const warm = records.slice(1);
  const summary = {
    label,
    args: extraArgs,
    runs: RUNS,
    cold: { wall: cold.wall, total: cold.total, exit: cold.exit },
    warm: {
      wall_median: percentile(warm.map((r) => r.wall), 50),
      wall_p95: percentile(warm.map((r) => r.wall), 95),
      total_median: percentile(warm.map((r) => r.total ?? r.wall), 50),
      total_p95: percentile(warm.map((r) => r.total ?? r.wall), 95),
    },
    phase_median: (() => {
      const names = new Set(warm.flatMap((r) => Object.keys(r.marks ?? {})));
      const out = {};
      for (const name of names) {
        const values = warm.map((r) => r.marks?.[name]).filter((value) => Number.isFinite(value));
        if (values.length) out[name] = percentile(values, 50);
      }
      return out;
    })(),
    records,
  };
  fs.writeFileSync(path.join(work, `result-${label}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ ...summary, records: undefined }, null, 2));
  return summary;
}

prepare();
const mode = process.argv[2] || "both";
const failed = [];
if (mode === "default" || mode === "both") if (bench("default").records.some((r) => r.exit !== 0)) failed.push("default");
if (mode === "fast" || mode === "both") if (bench("fast", ["--speed", "fast"]).records.some((r) => r.exit !== 0)) failed.push("fast");
if (failed.length) {
  console.error(`failing runs: ${failed.join(", ")}`);
  process.exit(1);
}
