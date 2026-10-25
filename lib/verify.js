import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { color } from "./brand.js";

/**
 * Verification evidence (FRD 7.7, J-02/V-05).
 *
 * The rule is simple and non-negotiable: a task is PASS only when a command the
 * developer named actually exited 0 afterwards. Everything this module prints is
 * read from git and from that command's real output.
 */

function git(workspace, args) {
  return spawnSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 15_000 });
}

/**
 * Current working-tree changes for the *selected workspace* only, from git.
 * The `-- .` pathspec matters: a workspace nested inside a larger repository
 * must not be credited with (or blamed for) changes outside itself.
 */
export function workspaceChanges(workspace) {
  const inside = git(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { isGit: false, files: [], stat: null };
  }
  const status = git(workspace, ["status", "--porcelain", "--", "."]);
  const files = status.status === 0
    ? status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3).trim().replace(/^.* -> /, ""))
    : [];
  const stat = git(workspace, ["diff", "--stat", "--", "."]);
  const statText = stat.status === 0 ? stat.stdout.trim() : "";
  return { isGit: true, files, stat: statText || null };
}

const TREE_SKIP = new Set([".git", "node_modules", ".tmp", ".kodevra", "dist", "build"]);

/**
 * Cheap file state (size + mtime) for workspaces git cannot speak for: an
 * untracked directory, an ignored sandbox, a plain folder. Metadata only, so a
 * summary can say how many files really changed without reading their contents.
 */
export function snapshotTree(workspace, { limit = 20000 } = {}) {
  const files = new Map();
  let truncated = false;

  const walk = (dir, prefix) => {
    if (files.size >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= limit) {
        truncated = true;
        return;
      }
      if (TREE_SKIP.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(absolute);
          files.set(relative, `${stat.size}:${Math.round(stat.mtimeMs)}`);
        } catch {
          // a file that vanished mid-scan is not evidence of a change
        }
      }
    }
  };

  walk(workspace, "");
  return { files, truncated };
}

/** Files added, modified or removed since the snapshot. */
export function treeChangedFiles(baseline, workspace) {
  if (!baseline) return [];
  const after = snapshotTree(workspace);
  const changed = [];
  for (const [file, state] of after.files) {
    if (baseline.files.get(file) !== state) changed.push(file);
  }
  for (const file of baseline.files.keys()) {
    if (!after.files.has(file)) changed.push(file);
  }
  return changed.sort();
}

/**
 * A stable fingerprint of a failure, so a repair loop can stop when it is going
 * in circles. Timings, paths and digit noise are removed first.
 */
export function failureSignature(output) {
  return String(output || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/gi, "")
    .replace(/\b[0-9a-f]{7,}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1500);
}

/** Bounded repair instruction. It must not invite the model to fake a pass. */
export function repairPrompt({ command, result, attempt, maxRepairs }) {
  const tail = result.output.length > 3500 ? `...${result.output.slice(-3500)}` : result.output;
  return [
    `Repair attempt ${attempt} of ${maxRepairs}.`,
    `The workspace verification command \`${command}\` exited ${result.status}${result.timedOut ? " (timed out)" : ""}:`,
    "",
    "```",
    tail.trim() || "(no output)",
    "```",
    "",
    "Fix the underlying cause with the smallest change in this workspace.",
    "Do not edit the verification command, the test files or their assertions to force a pass.",
    "Do not claim success: the command will be re-run and its exit code decides the result. Stop when the fix is in.",
  ].join("\n");
}

function label(text, width = 17) {
  return color.dim(text.padEnd(width));
}

/**
 * The completion summary.
 *
 * VERIFIED appears only when the developer's own command actually exited 0 in
 * this run. Anything else is UNVERIFIED, REFUSED or FAILED, with the real
 * category. Returns plain lines so it can be printed or tested.
 */
export function resultLines({
  model,
  durationMs,
  verification,
  repairs = 0,
  maxRepairs = 0,
  changes,
  failure = null,
  preexisting = 0,
  executor = null,
  authorization = null,
  approval = null,
  eventsFile = null,
  sandboxCommands = 0,
}) {
  const lines = [""];
  lines.push(`  ${color.bold("TASK COMPLETE")}`);
  lines.push("");

  const changedCount = changes?.files?.length ?? 0;
  const status = approval?.required
    ? "refused"
    : verification
      ? verification.ok
        ? "verified"
        : "failed"
      : failure
        ? "failed"
        : "unverified";

  lines.push(`  ${label("Files changed")}${changedCount}`);
  lines.push(`  ${label("Sandbox commands")}${sandboxCommands}`);

  if (approval?.required) {
    lines.push(`  ${label("Verification")}${color.red("refused - approval required")}`);
  } else if (!verification) {
    lines.push(`  ${label("Verification")}${color.yellow("none - result is UNVERIFIED")}`);
  } else {
    const verdict = verification.ok
      ? color.green(`PASS (exit 0)`)
      : color.red(`FAIL (exit ${verification.status}${verification.timedOut ? ", timed out" : ""})`);
    lines.push(`  ${label("Verification")}${verification.command} -> ${verdict}`);
  }

  lines.push(`  ${label("Repair attempts")}${repairs > 0 ? `${repairs}/${maxRepairs} bounded repair run(s)` : "none"}`);
  lines.push(`  ${label("Duration")}${(durationMs / 1000).toFixed(1)}s`);
  lines.push(`  ${label("Model")}${model}`);

  if (executor) {
    const sandbox = executor.sandboxed ? color.green("sandboxed") : color.yellow("not sandboxed");
    lines.push(`  ${label("Executor")}${executor.name} - ${executor.description} ${sandbox}`);
  }

  const files = [...(approval?.changed ?? []), ...(approval?.added ?? []), ...(approval?.removed ?? [])];
  if (files.length) {
    lines.push(`  ${label("Agent changed")}${files.slice(0, 8).join(", ")}${files.length > 8 ? ` (+${files.length - 8} more)` : ""}`);
  }

  if (authorization && !approval?.required) {
    lines.push(
      `  ${label("Authorization")}${authorization.source} · ${authorization.files.length} file(s) · sha256 ${authorization.fingerprint.slice(0, 12)}`,
    );
  }

  lines.push("");
  lines.push(`  ${color.bold("Changes")}`);
  if (!changes || !changes.isGit) {
    lines.push(`  ${color.dim("workspace is not a git repository")}`);
  } else if (!changes.files.length) {
    lines.push(`  ${color.dim("no changes vs git HEAD in this workspace")}`);
  } else {
    const shown = changes.files.slice(0, 10);
    for (const file of shown) lines.push(`  ${file}`);
    if (changes.files.length > shown.length) {
      lines.push(`  ${color.dim(`+${changes.files.length - shown.length} more`)}`);
    }
    if (changes.stat) lines.push(`  ${color.dim(changes.stat.split("\n").pop())}`);
  }
  if (preexisting > 0) {
    lines.push(`  ${color.dim(`${preexisting} of these file(s) were already modified before this task`)}`);
  }

  if (failure) {
    lines.push("");
    lines.push(`  ${label("Failure")}${color.red(`${failure.code} (${failure.origin}) - ${failure.message}`)}`);
    if (failure.action) lines.push(`  ${label("Next")}${color.yellow(failure.action)}`);
  }

  if (!verification && !approval?.required) {
    lines.push("");
    lines.push(`  ${label("Next")}${color.dim('pass --verify "<command>" to base the result on a real exit code')}`);
  }
  if (approval?.required) {
    lines.push(`  ${label("Next")}${color.yellow("renew authorization explicitly: --reapprove")}`);
  }

  lines.push("");
  lines.push(`  ${label("Status")}${status === "verified" ? color.green("VERIFIED") : status === "failed" ? color.red("FAILED") : status === "refused" ? color.yellow("REFUSED") : color.yellow("UNVERIFIED")}`);
  if (eventsFile) lines.push(`  ${label("Events")}${color.dim(eventsFile)}`);

  lines.push("");
  return lines;
}
