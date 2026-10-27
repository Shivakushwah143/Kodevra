import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isInside, realpathOfExisting, SENSITIVE_FILE, SENSITIVE_SUFFIX } from "./chatgpt-web-paths.js";

/**
 * The `shell` action: one bounded developer command inside the workspace.
 *
 * This is the general-purpose execution primitive (rg, git, npm, builds). It is
 * not an OS sandbox - the host shell can run arbitrary code - so the containment
 * here is explicit and narrow: a workspace-relative cwd, refusal of path-shaped
 * arguments that resolve outside the workspace, refusal of sensitive files,
 * credential-free environment, a hard timeout, and a bounded output tail.
 * Isolation, when a run needs it, is still the `--executor docker` path.
 */

const CREDENTIAL_ENV = /(_TOKEN|_API_KEY|_SECRET|API_KEY)$/i;
const PATH_SHAPED = /[\\/]/;
const DESTRUCTIVE = /^(rm\s+-rf?\s+[\\/]|del\s+\/[sf]\b|format\s+[a-z]:|shutdown\b|reboot\b|diskpart\b|mkfs\b)/i;

function refusal(code, detail) {
  return { ok: false, code, detail };
}

function stripToken(token) {
  let value = token;
  const equals = value.indexOf("=");
  if (value.startsWith("-") && equals !== -1) value = value.slice(equals + 1);
  return value.replace(/^["'`]+/, "").replace(/["'`),;|&<>]+$/, "");
}

function tokens(command) {
  return command
    .split(/\s+/)
    .map(stripToken)
    .filter((token) => token && !token.startsWith("-"));
}

function guard(command, { workspace, cwd }) {
  if (DESTRUCTIVE.test(command)) {
    return refusal("SHELL_REFUSED", "that command is destructive at the system level and is not allowed");
  }
  if (/\$\(|\$\{|\$[A-Za-z_]|`|%[A-Za-z_]+%/.test(command)) {
    return refusal(
      "SHELL_EXPANSION_REFUSED",
      "shell variable/substitution expansion is not allowed; pass the literal path instead",
    );
  }
  const root = path.resolve(workspace);
  const realRoot = realpathOfExisting(root);
  const list = tokens(command);
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token === "cd" && index + 1 >= list.length) {
      return refusal("SHELL_OUTSIDE_WORKSPACE", "`cd` without a workspace-relative target leaves the workspace");
    }
    const name = path.basename(token);
    if (SENSITIVE_FILE.test(name) || SENSITIVE_SUFFIX.test(name)) {
      return refusal("PATH_SENSITIVE", `that command references a sensitive file: ${token}`);
    }
    const absoluteLike = path.isAbsolute(token) || /^[A-Za-z]:/.test(token) || token.startsWith("~");
    if (absoluteLike) {
      if (token.startsWith("~")) {
        return refusal("SHELL_OUTSIDE_WORKSPACE", `paths outside the workspace are not allowed: ${token}`);
      }
      const target = path.resolve(token);
      if (!isInside(root, target) || !isInside(realRoot, realpathOfExisting(target))) {
        return refusal("SHELL_OUTSIDE_WORKSPACE", `paths outside the workspace are not allowed: ${token}`);
      }
      continue;
    }
    if (!PATH_SHAPED.test(token)) continue;
    const target = path.resolve(cwd, token);
    if (!isInside(root, target) || !isInside(realRoot, realpathOfExisting(target))) {
      return refusal("SHELL_OUTSIDE_WORKSPACE", `path leaves the workspace: ${token}`);
    }
  }
  return null;
}

function shellTimeoutMs(requested, limits) {
  const seconds = Number(requested);
  const wanted = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : limits.shellTimeoutMs;
  return Math.min(Math.max(1_000, Math.round(wanted)), limits.shellTimeoutMaxMs);
}

function bounded(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `[first ${text.length - max} characters omitted]\n${text.slice(-max)}`, truncated: true };
}

function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
    return;
  }
  child.kill("SIGKILL");
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_ENV.test(key) || key === "KODEVRA_CHATGPT_BRIDGE_TOKEN") delete env[key];
  }
  return env;
}

export async function runShellTool(workspace, action, { mode = "workspace-write", limits } = {}) {
  if (mode === "read-only") {
    return refusal(
      "MODE_REFUSES_SHELL",
      "this run is read-only; a shell could change files. Use read/list/search/inspect instead.",
    );
  }
  const command = `${action.command ?? ""}`.trim();
  if (!command) return refusal("SHELL_EMPTY", "command is required");

  let cwd;
  try {
    const root = path.resolve(workspace);
    const requested = action.cwd ? path.resolve(root, `${action.cwd}`) : root;
    if (!isInside(root, requested)) {
      return refusal("SHELL_OUTSIDE_WORKSPACE", `cwd leaves the workspace: ${action.cwd}`);
    }
    if (!fs.statSync(requested).isDirectory()) {
      return refusal("SHELL_BAD_CWD", `cwd is not a directory: ${action.cwd}`);
    }
    const realRoot = realpathOfExisting(root);
    if (!isInside(realRoot, realpathOfExisting(requested))) {
      return refusal("SHELL_OUTSIDE_WORKSPACE", `cwd resolves outside the workspace: ${action.cwd}`);
    }
    cwd = requested;
  } catch (error) {
    return refusal(error.code || "SHELL_BAD_CWD", `${error.message}`);
  }

  const blocked = guard(command, { workspace, cwd });
  if (blocked) return blocked;

  const timeoutMs = shellTimeoutMs(action.timeout, limits);
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child;

    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (spawnError) {
        resolve(refusal("SHELL_SPAWN_FAILED", `${spawnError.message}`));
        return;
      }
      const duration = Date.now() - startedAt;
      const out = bounded(stdout, limits.shellOutputChars);
      const err = bounded(stderr, limits.shellOutputChars);
      const exitCode = typeof code === "number" ? code : null;
      const lines = [`exit code: ${exitCode === null ? "unknown" : exitCode}`, `duration: ${duration} ms`];
      if (timedOut) lines.push(`timed out: yes (${timeoutMs} ms)`);
      lines.push("", "stdout:", out.text.trim() || "(no output)");
      if (err.text.trim()) lines.push("", "stderr:", err.text.trim());
      if (out.truncated || err.truncated) lines.push("", "[output truncated; the tail is kept]");
      resolve({
        ok: exitCode === 0 && !timedOut,
        code: timedOut ? "SHELL_TIMED_OUT" : exitCode === 0 ? null : "SHELL_EXIT_NONZERO",
        detail: timedOut ? `timed out after ${timeoutMs} ms` : `exit ${exitCode === null ? "unknown" : exitCode} in ${duration} ms`,
        body: lines.join("\n"),
      });
    };

    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > limits.shellOutputChars * 8) stdout = stdout.slice(-limits.shellOutputChars * 4);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > limits.shellOutputChars * 8) stderr = stderr.slice(-limits.shellOutputChars * 4);
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}
