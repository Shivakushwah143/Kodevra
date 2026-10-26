import { spawn, spawnSync } from "node:child_process";

/**
 * One engine invocation that streams to the terminal while keeping the tail of
 * its output. Kodevra needs both: the user watches progress, and Kodevra needs
 * the text to classify a failure instead of guessing from an exit code.
 *
 * This is still OpenCode's process and OpenCode's output. Kodevra adds no
 * orchestration, retries or parsing of its own - but it does own the clock: an
 * unattended agent must not run forever, so a wall-clock limit and an idle
 * limit cancel the whole process tree (on Windows too) and say why.
 */

const KEEP_CHARS = 200_000;

export const DEFAULT_RUN_TIMEOUT_MS = Number(process.env.KODEVRA_RUN_TIMEOUT_MS || 1_800_000);
export const DEFAULT_RUN_IDLE_MS = Number(process.env.KODEVRA_RUN_IDLE_MS || 300_000);

function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Kill a child and everything it spawned. `child.kill()` leaves orphans on Windows. */
export function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 15_000 });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function streamEngine(
  engine,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    idleMs = DEFAULT_RUN_IDLE_MS,
    forward = true,
    onLine = null,
  } = {},
) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const commandArgs = engine.shell ? [args.map(quoteForShell).join(" ")] : args;
    let child;
    try {
      child = spawn(engine.command, commandArgs, {
        cwd,
        env,
        shell: engine.shell,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        status: 1,
        signal: null,
        output: error.message,
        durationMs: 0,
        error: error.message,
        timedOut: false,
        timeoutReason: null,
        timedOutAtMs: null,
      });
      return;
    }

    let output = "";
    let settled = false;
    let timedOut = false;
    let timeoutReason = null;
    let timedOutAtMs = null;

    // Lines are handed to the caller as they arrive so an instrumented run can
    // say when the first tool call or the first edit really happened instead of
    // estimating it from the end of the process.
    let pending = "";

    const collect = (chunk) => {
      const text = chunk.toString();
      output += text;
      if (output.length > KEEP_CHARS) output = output.slice(-KEEP_CHARS);
      touch();
      if (!onLine) return;
      pending += text;
      let index = pending.indexOf("\n");
      while (index !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (line) onLine(line, Date.now() - startedAt);
        index = pending.indexOf("\n");
      }
    };

    let idleTimer = null;
    const touch = () => {
      if (!idleMs || timedOut) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cancel("idle"), idleMs);
    };

    const wallTimer = setTimeout(() => cancel("wall-clock"), Math.max(timeoutMs, 1));

    const cancel = (reason) => {
      if (timedOut) return;
      timedOut = true;
      timeoutReason = reason;
      timedOutAtMs = Date.now() - startedAt;
      clearTimeout(idleTimer);
      killTree(child);
    };

    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      clearTimeout(idleTimer);
      if (onLine && pending) {
        onLine(pending, Date.now() - startedAt);
        pending = "";
      }
      resolve({
        status: timedOut ? 124 : status ?? 1,
        signal,
        output,
        durationMs: Date.now() - startedAt,
        error: error ?? (timedOut ? `TIMEOUT:${timeoutReason}` : null),
        timedOut,
        timeoutReason,
        timedOutAtMs,
      });
    };

    child.stdout.on("data", (chunk) => {
      if (forward) process.stdout.write(chunk);
      collect(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (forward) process.stderr.write(chunk);
      collect(chunk);
    });

    child.on("error", (error) => finish(1, null, error.message));
    child.on("close", (status, signal) => finish(status, signal));
    touch();
  });
}

/**
 * Run a user-supplied verification command in the workspace. This is the only
 * source of truth for "done": Kodevra reports what the command actually exited
 * with, never what the model said about it.
 */
export function runCommand(command, { cwd, timeoutMs = 180_000, forward = true } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ command, ok: false, status: 1, signal: null, timedOut: false, output: error.message, durationMs: 0 });
      return;
    }

    let output = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > KEEP_CHARS) output = output.slice(-KEEP_CHARS);
      if (forward) process.stdout.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (status, signal, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = timedOut ? 124 : status ?? 1;
      resolve({
        command,
        ok: code === 0,
        status: code,
        signal,
        timedOut,
        output,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    child.on("error", (error) => finish(1, null, { output: `${output}\n${error.message}` }));
    child.on("close", (status, signal) => finish(status, signal));
  });
}
