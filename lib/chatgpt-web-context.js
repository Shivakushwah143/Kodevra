import { createHash } from "node:crypto";
import path from "node:path";

/**
 * H5 - working context for one coding task.
 *
 * The ChatGPT tab keeps its own transcript; Kodevra cannot edit it and must not
 * pretend to. What this module controls is what Kodevra sends and what it keeps
 * as its own deterministic picture of the task:
 *
 * - every tool result is bounded before it is sent (large reads, listings,
 *   searches, inspect views and shell output are compacted);
 * - identical bodies are not resent verbatim;
 * - a small TASK STATE block rides along only when the state actually changed;
 * - the task, workspace, verification state, repair budget and changed files are
 *   never compressed away.
 *
 * No model call, no embeddings, no external memory: every summary comes from
 * state Kodevra already has.
 */

const ANSI = /\u001b\[[0-9;]*m/g;

function hash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function clip(text, max) {
  const value = `${text ?? ""}`;
  if (value.length <= max) return { text: value, clipped: false };
  return { text: `${value.slice(0, max)}\n[${value.length - max} characters omitted; re-read if needed]`, clipped: true };
}

function firstLines(text, count) {
  const lines = `${text ?? ""}`.replace(/\r\n/g, "\n").split("\n");
  if (lines.length <= count) return { text: lines.join("\n"), clipped: false };
  return {
    text: `${lines.slice(0, count).join("\n")}\n[${lines.length - count} more line(s) omitted]`,
    clipped: true,
  };
}

function lastChars(text, max) {
  const value = `${text ?? ""}`;
  if (value.length <= max) return { text: value, clipped: false };
  return { text: `[first ${value.length - max} characters omitted]\n${value.slice(-max)}`, clipped: true };
}

export function createContextState({ task, workspace, provider = null, model = null, limits, constraints = [] }) {
  return {
    task: `${task ?? ""}`,
    workspace: path.resolve(workspace),
    provider,
    model,
    constraints: [...constraints],
    changedFiles: new Set(),
    gitSummary: null,
    unresolvedErrors: [],
    latestFailure: null,
    relevantFiles: [],
    relevantSymbols: [],
    lastFailedAction: null,
    turn: { used: 0, max: limits.maxTurns },
    retained: 0,
    compacted: 0,
    dropped: 0,
    diagnostics: [],
    sent: new Map(),
    lastRendered: null,
    limits,
  };
}

function record(context, entry) {
  context.diagnostics.push({ at: Date.now(), ...entry });
  while (context.diagnostics.length > context.limits.contextDiagnostics) context.diagnostics.shift();
}

/** Bound one tool body before it is sent to the model. */
export function compactBody(context, action, body) {
  const text = `${body ?? ""}`.replace(ANSI, "");
  if (!text.trim()) return "";
  const name = action?.action;

  // Repeated identical output is the most expensive kind: send a reference.
  const digest = hash(text);
  if (digest.length && context.sent.has(digest)) {
    const previous = context.sent.get(digest);
    context.dropped += 1;
    record(context, {
      kind: "drop",
      action: name,
      reason: `identical to turn ${previous.turn}`,
      before: text.length,
      after: 0,
    });
    return `[identical output to turn ${previous.turn}; unchanged]`;
  }
  if (context.sent.size >= context.limits.contextDedupeEntries) {
    const oldest = context.sent.keys().next().value;
    context.sent.delete(oldest);
  }
  context.sent.set(digest, { turn: context.turn.used, action: name });

  let bounded;
  let reason = null;
  if (name === "read") {
    bounded = clip(text, context.limits.contextReadChars);
    reason = "read capped";
  } else if (name === "list") {
    bounded = firstLines(text, context.limits.contextListEntries);
    reason = "directory listing capped";
  } else if (name === "search") {
    bounded = firstLines(text, context.limits.contextSearchLines);
    reason = "search results capped";
  } else if (name === "inspect") {
    bounded = clip(text, context.limits.contextInspectChars);
    reason = "inspect view capped";
  } else if (name === "batch") {
    bounded = clip(text, context.limits.contextBatchChars);
    reason = "batch output capped";
  } else if (name === "shell") {
    bounded = lastChars(text, context.limits.contextShellChars);
    reason = "shell output capped (tail kept)";
  } else {
    bounded = { text, clipped: false };
  }

  if (bounded.clipped) {
    context.compacted += 1;
    record(context, {
      kind: "compress",
      action: name,
      reason,
      before: text.length,
      after: bounded.text.length,
    });
  } else {
    context.retained += 1;
  }
  return bounded.text;
}

function safeRelative(workspace, file) {
  const value = `${file ?? ""}`.trim().replace(/^\.\//, "");
  if (!value) return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return null;
  const relative = path.relative(path.resolve(workspace), path.resolve(workspace, value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

export function noteMutation(context, action, result) {
  if (!result?.ok) return;
  const targets = [];
  if (action.action === "write" || action.action === "edit") targets.push(action.path);
  if (action.action === "apply_patch") {
    let previous = null;
    for (const line of `${action.patch ?? ""}`.split(/\r?\n/)) {
      if (line.startsWith("--- ")) {
        const value = line.slice(4).trim().split("\t")[0];
        previous = !value || value === "/dev/null" ? null : value.replace(/^a\//, "");
        continue;
      }
      if (!line.startsWith("+++ ")) continue;
      const value = line.slice(4).trim().split("\t")[0];
      if (!value) continue;
      targets.push(value === "/dev/null" ? previous : value.replace(/^b\//, ""));
    }
  }
  for (const target of targets) {
    const relative = safeRelative(context.workspace, target);
    if (relative) context.changedFiles.add(relative);
  }
}

export function noteToolResult(context, { action, result, turn }) {
  context.turn.used = turn;
  if (!result?.ok) {
    context.lastFailedAction = {
      turn,
      action: action.action,
      code: result?.code ?? "ERROR",
      detail: `${result?.detail ?? ""}`.slice(0, 240),
    };
    context.unresolvedErrors.push({ turn, action: action.action, detail: `${result?.code ?? "ERROR"}: ${`${result?.detail ?? ""}`.slice(0, 200)}` });
    while (context.unresolvedErrors.length > 5) context.unresolvedErrors.shift();
    return;
  }

  // A later success on the same action clears that unresolved error.
  if (context.lastFailedAction?.action === action.action) {
    context.unresolvedErrors = context.unresolvedErrors.filter((entry) => entry.action !== action.action);
    context.lastFailedAction = null;
  }

  if (action.action === "inspect" && `${result.body ?? ""}`) {
    const body = `${result.body}`;
    const files = [];
    for (const line of body.split(/\r?\n/)) {
      const match = /^ {2}([^\s].*?) \(score \d+\)$/.exec(line);
      if (match) files.push(match[1]);
    }
    const symbols = [];
    for (const line of body.split(/\r?\n/)) {
      const match = /^ {2}([^\s].*?:\d+ [A-Za-z_$][\w$]*)$/.exec(line);
      if (match) symbols.push(match[1]);
    }
    if (files.length) context.relevantFiles = files.slice(0, 8);
    if (symbols.length) context.relevantSymbols = symbols.slice(0, 8);
  }
}

export function noteVerification(context, verification) {
  if (verification.state === "verification_passed") {
    context.latestFailure = null;
    context.unresolvedErrors = [];
    return;
  }
  if (verification.latestFailure) {
    // One short line in the state block; the full evidence is sent once, next
    // to the tool result, so the two never compete for the same budget.
    context.latestFailure = {
      kind: verification.latestFailure.kind,
      entry: verification.latestFailure.evidence.split("\n").find((line) => line.trim() && line !== "relevant lines:")?.slice(0, 160) ?? "",
    };
  }
}

export function noteChangedFiles(context, files, summary = null) {
  for (const file of files ?? []) {
    const relative = safeRelative(context.workspace, file);
    if (relative) context.changedFiles.add(relative);
  }
  if (summary) context.gitSummary = `${summary}`.slice(0, 400);
}

/**
 * The compact TASK STATE block. Returns null when nothing changed since the last
 * block was sent, so a long conversation does not accumulate repeated copies.
 */
export function renderContext(context, { turn, verification, force = false } = {}) {
  const changed = [...context.changedFiles].sort();
  const lines = ["KODEVRA TASK STATE"];
  lines.push(`task: ${context.task.replace(/\s+/g, " ").slice(0, 160)}`);
  if (context.constraints.length) lines.push(`constraints: ${context.constraints.join(" | ").slice(0, 200)}`);
  lines.push(`workspace: ${context.workspace}`);
  if (context.provider || context.model) lines.push(`model: ${[context.provider, context.model].filter(Boolean).join("/")}`);
  lines.push(
    `verification: ${verification.state}${verification.command ? ` (${verification.command})` : ""} · attempt ${verification.attempts}/${verification.maxAttempts}${
      verification.exitCode === null ? "" : ` · exit ${verification.exitCode}`
    }`,
  );
  if (changed.length) lines.push(`changed: ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ` (+${changed.length - 12} more)` : ""}`);
  if (context.gitSummary) lines.push(`diff: ${context.gitSummary}`);
  if (context.latestFailure) lines.push(`latest failure: ${context.latestFailure.kind} · ${context.latestFailure.entry}`);
  if (context.lastFailedAction) {
    lines.push(
      `unresolved: ${context.lastFailedAction.action} ${context.lastFailedAction.code} - ${context.lastFailedAction.detail.replace(/\s+/g, " ")}`,
    );
  }
  if (context.unresolvedErrors.length > 1) lines.push(`pending errors: ${context.unresolvedErrors.length}`);
  if (context.relevantFiles.length) lines.push(`relevant: ${context.relevantFiles.slice(0, 6).join(", ")}`);
  if (context.relevantSymbols.length) lines.push(`symbols: ${context.relevantSymbols.slice(0, 5).join(", ")}`);
  lines.push(`budget: ${Math.max(0, context.turn.max - turn)} turn(s) left · ${Math.max(0, verification.maxAttempts - verification.attempts)} repair(s) left`);

  let text = lines.join("\n");
  if (text.length > context.limits.contextStateChars) {
    text = `${text.slice(0, context.limits.contextStateChars)}\n[state truncated]`;
  }
  const digest = hash(text);
  if (!force && digest === context.lastRendered) {
    record(context, { kind: "skip", action: "state", reason: "state unchanged since last send", before: 0, after: 0 });
    return null;
  }
  context.lastRendered = digest;
  return text;
}

export function contextDiagnostics(context) {
  return {
    retained: context.retained,
    compacted: context.compacted,
    dropped: context.dropped,
    changedFiles: [...context.changedFiles].sort(),
    unresolved: context.unresolvedErrors,
    latestFailure: context.latestFailure,
    relevantFiles: context.relevantFiles,
    entries: context.diagnostics.slice(-20),
  };
}
