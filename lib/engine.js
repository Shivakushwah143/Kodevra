import { spawn } from "node:child_process";

/**
 * One engine invocation that streams to the terminal while keeping the tail of
 * its output. Kodevra needs both: the user watches progress, and Kodevra needs
 * the text to classify a failure instead of guessing from an exit code.
 *
 * This is still OpenCode's process and OpenCode's output. Kodevra adds no
 * orchestration, retries or parsing of its own.
 */

const KEEP_CHARS = 200_000;

function quoteForShell(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function streamEngine(engine, args, { cwd, env = process.env, color = true } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const commandArgs = engine.shell ? [args.map(quoteForShell).join(" ")] : args;
    let child;
    try {
      child = spawn(engine.command, commandArgs, {
        cwd,
        env,
        shell: engine.shell,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ status: 1, signal: null, output: error.message, durationMs: 0, error: error.message });
      return;
    }

    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > KEEP_CHARS) output = output.slice(-KEEP_CHARS);
    };

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      collect(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      collect(chunk);
    });

    child.on("error", (error) => {
      resolve({ status: 1, signal: null, output: `${output}\n${error.message}`, durationMs: Date.now() - startedAt, error: error.message });
    });

    child.on("close", (status, signal) => {
      resolve({ status: status ?? 1, signal, output, durationMs: Date.now() - startedAt, error: null });
    });
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
      child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ command, ok: false, status: 1, signal: null, timedOut: false, output: error.message, durationMs: 0 });
      return;
    }

    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > KEEP_CHARS) output = output.slice(-KEEP_CHARS);
      if (forward) process.stdout.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, ok: false, status: 1, signal: null, timedOut, output: `${output}\n${error.message}`, durationMs: Date.now() - startedAt });
    });

    child.on("close", (status, signal) => {
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
      });
    });
  });
}
