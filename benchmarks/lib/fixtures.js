import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { providerEntry, readConfig } from "../../lib/config.js";
import { snapshotTree, treeChangedFiles } from "../../lib/verify.js";

/**
 * Shared benchmark fixture plumbing.
 *
 * A benchmark run gets a disposable copy of the task template under the system
 * temp directory, its own git root, a hidden acceptance test that only appears
 * after the agent stops, and a fixture hash guard. Both runners (OpenCode and
 * Codex) use exactly these rules so a result is comparable across suites.
 */

export function loadTasks(tasksDir) {
  const entries = fs.readdirSync(tasksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return entries
    .map((entry) => {
      const dir = path.join(tasksDir, entry.name);
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

export function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), `${relative}/`));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

export function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

export function resetWorkspace(task, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  copyDir(task.template, destination);
  // Its own git root: the engine's project root becomes this workspace, so
  // Kodevra's workspace-scoped permission overlay cannot widen to the machine.
  spawnSync("git", ["init", "-q"], { cwd: destination, stdio: "ignore" });
}

export function applyAcceptance(task, workspace) {
  const files = fs.readdirSync(task.acceptance).filter((file) => file.endsWith(".test.js"));
  for (const file of files) {
    fs.copyFileSync(path.join(task.acceptance, file), path.join(workspace, "test", file));
  }
  return files;
}

export function applySolution(task, workspace) {
  if (!fs.existsSync(task.solution)) return 0;
  const before = snapshotTree(workspace);
  copyDir(task.solution, workspace);
  return treeChangedFiles(before, workspace).length;
}

/**
 * Spawn with a hard timeout that kills the whole process tree. A CLI that
 * leaves an orphaned engine behind would keep a provider lock and poison every
 * later run, so killing the tree is part of the measurement, not polish.
 */
function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function run(command, args, { cwd, timeout, shell = false }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;

    // A .cmd shim needs a shell, and an args array with shell:true is
    // deprecated (and would split a prompt on its spaces), so join and quote.
    const spawnOptions = {
      cwd,
      timeout,
      // An inherited stdin pipe makes Codex wait for EOF before it starts
      // working ("Reading additional input from stdin..."). Agents are
      // non-interactive here, so stdin is closed explicitly.
      stdio: ["ignore", "pipe", "pipe"],
      // The engine resolves its project root from PWD, so the benchmark harness
      // must point it at the task workspace, not at whatever shell started it.
      env: { ...process.env, PWD: cwd, KODEVRA_SKIP_DOCKER_PROBE: "1", CI: "1", NO_COLOR: "1" },
    };
    // A verification command is already a shell string (`npm test`), so only
    // quote when there are separate arguments to join.
    const line = args.length ? [command, ...args].map(quoteForShell).join(" ") : command;
    const child = shell ? spawn(line, { ...spawnOptions, shell: true }) : spawn(command, args, spawnOptions);

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

export function hashTree(dir) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(dir).sort()) {
    hash.update(`${file}\u0000`);
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export function tail(text, size = 1500) {
  return text.length > size ? `...${text.slice(-size)}` : text;
}

/**
 * The local DeepSeek proxy is sticky per client. Reset the proxy chat before
 * each run so one task cannot see another task's conversation - and so the two
 * variants do not share memory. Remote providers need no reset.
 */
export async function resetProviderSession(model) {
  const provider = `${model}`.split("/")[0];
  const entry = providerEntry(readConfig().data, provider);
  const baseURL = entry?.options?.baseURL;
  // A hosted provider has no sticky client-side chat to reset: each request is
  // independent, so there is nothing to do and nothing to fail. Kodevra's own
  // provider catalog decides, not a hard-coded provider name.
  if (!baseURL || !/localhost|127\.0\.0\.1|\[::1\]/.test(baseURL)) {
    return { ok: true, applicable: false, reason: "not a local proxy; no session to reset" };
  }
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
