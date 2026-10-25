import { spawnSync } from "node:child_process";

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

function label(text, width = 13) {
  return color.dim(text.padEnd(width));
}

/**
 * The TASK RESULT block. Returns plain lines so it can be printed or tested.
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
}) {
  const lines = [""];
  lines.push(`  ${color.bold("TASK RESULT")}`);
  lines.push("");
  lines.push(`  ${label("model")}${model}`);
  lines.push(`  ${label("duration")}${(durationMs / 1000).toFixed(1)}s`);

  if (executor) {
    const sandbox = executor.sandboxed ? color.green("sandboxed") : color.yellow("not sandboxed");
    lines.push(`  ${label("executor")}${executor.name} - ${executor.description} ${sandbox}`);
  }

  if (approval?.required) {
    lines.push(`  ${label("verification")}${color.red("refused - approval required")}`);
    const files = [...(approval.changed ?? []), ...(approval.added ?? []), ...(approval.removed ?? [])];
    if (files.length) lines.push(`  ${label("agent changed", 14)}${files.slice(0, 8).join(", ")}${files.length > 8 ? ` (+${files.length - 8} more)` : ""}`);
    lines.push(`  ${label("next")}${color.yellow("renew authorization explicitly: --reapprove")}`);
  } else if (!verification) {
    lines.push(`  ${label("verification")}${color.yellow("none - result is UNVERIFIED")}`);
    lines.push(`  ${label("next")}${color.dim('pass --verify "<command>" to base the result on a real exit code')}`);
  } else {
    const verdict = verification.ok
      ? color.green(`PASS (exit 0)`)
      : color.red(`FAIL (exit ${verification.status}${verification.timedOut ? ", timed out" : ""})`);
    lines.push(`  ${label("verification")}${verification.command} -> ${verdict}`);
  }

  if (authorization && !approval?.required) {
    lines.push(
      `  ${label("authorization", 14)}${authorization.source} · ${authorization.files.length} file(s) · sha256 ${authorization.fingerprint.slice(0, 12)}`,
    );
  }

  if (repairs > 0) lines.push(`  ${label("repairs")}${repairs}/${maxRepairs} bounded repair run(s)`);

  if (!changes || !changes.isGit) {
    lines.push(`  ${label("changed")}${color.dim("workspace is not a git repository")}`);
  } else if (!changes.files.length) {
    lines.push(`  ${label("changed")}${color.dim("no changes vs git HEAD in this workspace")}`);
  } else {
    const shown = changes.files.slice(0, 10);
    const more = changes.files.length > shown.length ? ` (+${changes.files.length - shown.length} more)` : "";
    lines.push(`  ${label("changed")}${shown.join(", ")}${more}`);
    if (changes.stat) lines.push(`  ${label("diff")}${color.dim(changes.stat.split("\n").pop())}`);
  }
  if (preexisting > 0) {
    lines.push(`  ${label("note")}${color.dim(`${preexisting} of these file(s) were already modified before this task`)}`);
  }

  if (failure) {
    lines.push(`  ${label("failure")}${color.red(`${failure.code} (${failure.origin}) - ${failure.message}`)}`);
    if (failure.action) lines.push(`  ${label("next")}${color.yellow(failure.action)}`);
  }

  if (eventsFile) lines.push(`  ${label("events")}${color.dim(eventsFile)}`);

  lines.push("");
  return lines;
}
