import { spawnSync } from "node:child_process";

import { decideApproval } from "./approval-policy.js";
import { extractFirstJsonObject, parseAction, toolResultMessage } from "./chatgpt-web.js";
import { runShellTool } from "./chatgpt-web-shell.js";
import { executeAction } from "./chatgpt-web-tools.js";

/**
 * H7 - three small, read-only subagents.
 *
 * The main agent stays the owner of the task. A subagent is a bounded, isolated
 * helper: its own ChatGPT conversation, its own small context, read-only tools,
 * no recursion and no way to finish the parent task. Results come back as one
 * compact JSON object the main agent can act on.
 */

export const SUBAGENT_DEFINITIONS = Object.freeze({
  explorer: {
    label: "explorer",
    purpose: "map an unfamiliar repository and report where the work belongs",
    actions: ["read", "search", "list", "inspect", "batch", "shell"],
    final: '{"role":"explorer","summary":"...","relevantFiles":["..."],"symbols":["..."],"evidence":["..."],"recommendedNextFiles":["..."]}',
    rules: [
      "Start with inspect; use batch for cheap grouped reads/searches.",
      "Only safe read-only shell commands are allowed (git status/diff/log, ls, rg, cat, node --version).",
      "Never edit, patch, install, or finish the parent task.",
    ],
  },
  reviewer: {
    label: "reviewer",
    purpose: "review the current change before verification or finish",
    actions: ["read", "search", "list", "inspect", "batch"],
    final: '{"role":"reviewer","status":"pass|issues_found","issues":[{"severity":"high|medium|low","file":"...","reason":"...","suggestion":"..."}]}',
    rules: [
      "Judge the change against the task, not against your own preferences.",
      "Only report a real defect, missing requirement, regression, unrelated change or security mistake.",
      "You cannot rewrite the implementation; suggestions only.",
    ],
  },
  failure_diagnoser: {
    label: "failure_diagnoser",
    purpose: "explain a failed verification without dumping raw logs",
    actions: ["read", "search", "list", "inspect", "batch"],
    final: '{"role":"failure_diagnoser","rootCause":"...","confidence":"high|medium|low","relevantFiles":["..."],"evidence":["..."],"recommendedAction":"..."}',
    rules: [
      "Decide whether the failure is caused by the current change or pre-existing.",
      "Recommend one concrete next debugging action.",
      "Do not run the failing command yourself.",
    ],
  },
});

export function subagentRole(value) {
  const role = `${value ?? ""}`.trim().toLowerCase();
  return SUBAGENT_DEFINITIONS[role] ? role : null;
}

export function emptySubagentUsage() {
  return {
    total: 0,
    explorer: 0,
    reviewer: 0,
    failure_diagnoser: 0,
    durationMs: 0,
    history: [],
  };
}

const CORRECTION =
  "Return exactly one JSON action (read, search, list, inspect, batch) or, when you have enough evidence, the single final result JSON object described in the instructions. Nothing else.";

function clip(text, max) {
  const value = `${text ?? ""}`;
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

function listOf(value, max, length = 220) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => entry.trim().slice(0, length))
    .slice(0, max);
}

function contextBlock(input, limits) {
  const lines = [];
  lines.push(`TASK:\n${clip(input.task, 600)}`);
  lines.push(`WORKSPACE:\n${input.workspace}`);
  if (input.focus) lines.push(`FOCUS:\n${clip(input.focus, 300)}`);
  if (input.constraints?.length) lines.push(`CONSTRAINTS:\n${input.constraints.slice(0, 8).join("\n")}`);
  if (input.verification?.command) {
    const verification = input.verification;
    lines.push(
      `VERIFICATION:\ncommand: ${verification.command}\nstate: ${verification.state}\nattempt: ${verification.attempts ?? 0}/${
        verification.maxAttempts ?? 0
      }\nexit: ${verification.exitCode ?? "none"}${verification.failureKind ? `\nfailure: ${verification.failureKind}` : ""}`,
    );
    if (verification.evidence) lines.push(`FAILURE EVIDENCE:\n${clip(verification.evidence, limits.subagentEvidenceChars)}`);
  }
  if (input.changedFiles?.length) lines.push(`CHANGED FILES:\n${input.changedFiles.slice(0, 20).join("\n")}`);
  if (input.diff) lines.push(`DIFF SUMMARY (compact):\n${clip(input.diff, 2_000)}`);
  if (input.files?.length) lines.push(`INSPECT FILES:\n${input.files.slice(0, 10).join("\n")}`);
  if (input.symbols?.length) lines.push(`SYMBOLS:\n${input.symbols.slice(0, 10).join("\n")}`);
  if (input.failures?.length) lines.push(`RECENT TOOL FAILURES:\n${input.failures.slice(0, 5).join("\n")}`);
  return clip(lines.join("\n\n"), limits.subagentContextChars);
}

export function buildSubagentPrompt({ role, input, limits }) {
  const definition = SUBAGENT_DEFINITIONS[role];
  return [
    `You are Kodevra's ${definition.label} subagent. Purpose: ${definition.purpose}.`,
    "",
    "You are read-only. You must not modify files, apply patches, install dependencies, change manifests or finish the parent task.",
    "You cannot spawn another agent and must not try to.",
    `Allowed actions: ${definition.actions.join(", ")}.`,
    "Return exactly ONE JSON action per turn.",
    "",
    "When you have enough evidence, reply with only this JSON object:",
    definition.final,
    "",
    "Rules:",
    ...definition.rules.map((rule) => `- ${rule}`),
    "",
    contextBlock(input, limits),
  ].join("\n");
}

function parseJsonObject(text) {
  const source = `${text ?? ""}`.trim();
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    const extracted = extractFirstJsonObject(source);
    if (!extracted) return null;
    try {
      const value = JSON.parse(extracted);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function normalizeFinal(role, value) {
  if (role === "explorer") {
    if (typeof value.summary !== "string" || !value.summary.trim()) return null;
    return {
      role,
      summary: value.summary.trim().slice(0, 800),
      relevantFiles: listOf(value.relevantFiles, 12),
      symbols: listOf(value.symbols, 12),
      evidence: listOf(value.evidence, 8, 300),
      recommendedNextFiles: listOf(value.recommendedNextFiles, 8),
    };
  }
  if (role === "reviewer") {
    const issues = Array.isArray(value.issues)
      ? value.issues
          .filter((issue) => issue && typeof issue === "object")
          .map((issue) => ({
            severity: ["high", "medium", "low"].includes(`${issue.severity}`.toLowerCase())
              ? `${issue.severity}`.toLowerCase()
              : "medium",
            file: clip(issue.file ?? "", 200),
            reason: clip(issue.reason ?? "", 300),
            suggestion: clip(issue.suggestion ?? "", 300),
          }))
          .slice(0, 10)
      : [];
    const status =
      value.status === "pass" || value.status === "issues_found" ? value.status : issues.length ? "issues_found" : "pass";
    return { role, status, issues };
  }
  if (role === "failure_diagnoser") {
    if (typeof value.rootCause !== "string" || !value.rootCause.trim()) return null;
    return {
      role,
      rootCause: value.rootCause.trim().slice(0, 800),
      confidence: ["high", "medium", "low"].includes(`${value.confidence}`.toLowerCase())
        ? `${value.confidence}`.toLowerCase()
        : "low",
      relevantFiles: listOf(value.relevantFiles, 10),
      evidence: listOf(value.evidence, 8, 300),
      recommendedAction: clip(value.recommendedAction ?? "", 400),
    };
  }
  return null;
}

/** A plain, un-chained command only: no `&&`, `;`, pipes or redirection. */
function isPlainCommand(command) {
  return !/[;&|<>`\n]/.test(`${command ?? ""}`);
}

async function runSubagentAction(workspace, action, { mode, approval, limits, executor }) {
  if (action.action === "shell") {
    if (!isPlainCommand(action.command)) {
      return { ok: false, code: "SUBAGENT_SHELL_REFUSED", detail: "chained shell commands are not allowed for subagents" };
    }
    const decision = decideApproval({ mode: approval, action });
    if (decision.kind !== "shell:inspection") {
      return {
        ok: false,
        code: "SUBAGENT_SHELL_REFUSED",
        detail: `only read-only inspection commands are allowed for subagents (${decision.kind})`,
      };
    }
    // The command itself is inspection-only; read-only mode in the tool layer
    // would refuse the shell outright, so this narrow path is explicit.
    return runShellTool(workspace, action, { mode: "workspace-write", limits, executor });
  }
  // Everything else runs read-only, which also refuses shell inside a batch.
  return executeAction(workspace, action, { mode: "read-only", limits, executor });
}

/**
 * Run one bounded subagent. Uses the same chat transport and model as the
 * parent, in a NEW conversation, and never exposes subagent actions to itself.
 */
export async function runSubagent({
  role,
  input,
  workspace,
  chat,
  limits,
  mode = "workspace-write",
  approval = "balanced",
  executor = null,
  onEvent = () => {},
}) {
  const definition = SUBAGENT_DEFINITIONS[role];
  if (!definition) return { ok: false, code: "SUBAGENT_UNKNOWN_ROLE", durationMs: 0, turns: 0 };
  const startedAt = Date.now();
  const observed = [];
  let session = null;
  let turns = 0;
  let message = buildSubagentPrompt({ role, input, limits });
  let lastReply = "";

  const status = (event) => {
    try {
      onEvent(event);
    } catch {
      // status output must never break a subagent
    }
  };

  for (let round = 1; round <= limits.subagentTurns; round += 1) {
    if (Date.now() - startedAt > limits.subagentTimeoutMs) break;
    turns = round;
    let reply;
    try {
      reply = await chat({ message, sessionId: session, newSession: round === 1 });
    } catch (error) {
      return {
        ok: false,
        code: error.code || "SUBAGENT_BRIDGE_ERROR",
        detail: error.message,
        durationMs: Date.now() - startedAt,
        turns,
        result: { role, summary: "subagent transport failed", evidence: observed.slice(-4) },
      };
    }
    if (reply?.session) session = reply.session;
    lastReply = `${reply?.text ?? ""}`;
    const object = parseJsonObject(lastReply);

    if (object && !object.action) {
      const result = normalizeFinal(role, object);
      if (result) {
        return { ok: true, result, durationMs: Date.now() - startedAt, turns };
      }
      message = CORRECTION;
      continue;
    }

    if (!object) {
      message = CORRECTION;
      continue;
    }

    const parsed = parseAction(lastReply);
    if (!parsed.ok) {
      message = CORRECTION;
      continue;
    }
    const action = parsed.action;
    if (!definition.actions.includes(action.action)) {
      const refusal = {
        ok: false,
        code: "SUBAGENT_ACTION_REFUSED",
        detail: `${action.action} is not available to the ${role} subagent`,
      };
      status({ type: "subagent_tool", role, action: action.action, ok: false });
      message = `${toolResultMessage({ action, ...refusal, body: refusal.detail })}\n\nContinue as the ${role} subagent: one JSON action, or the final result object.`;
      continue;
    }

    const result = await runSubagentAction(workspace, action, { mode, approval, limits, executor });
    status({ type: "subagent_tool", role, action: action.action, ok: Boolean(result.ok) });
    observed.push(`${action.action}${action.path ? ` ${action.path}` : ""} -> ${result.ok ? "ok" : result.code}`);
    message = `${toolResultMessage({
      action,
      ok: Boolean(result.ok),
      detail: result.ok ? result.detail : `${result.code}: ${result.detail}`,
      body: result.body,
    })}\n\nContinue as the ${role} subagent: one JSON action, or the final result object.`;
  }

  const partial = {
    role,
    summary: "subagent stopped before reporting a final result",
    relevantFiles: [],
    symbols: [],
    evidence: observed.slice(-6),
    recommendedNextFiles: [],
    incomplete: true,
  };
  return {
    ok: false,
    code: "SUBAGENT_INCOMPLETE",
    detail: `the ${role} subagent did not report within ${turns}/${limits.subagentTurns} turn(s)`,
    durationMs: Date.now() - startedAt,
    turns,
    result: partial,
    transcript: lastReply,
  };
}

export function clipSubagentBody(result, limits) {
  return clip(JSON.stringify(result, null, 2), limits.subagentResultChars);
}

/** Compact tracked diff for the reviewer/diagnoser; untracked files are listed separately. */
export function compactWorkspaceDiff(workspace, maxChars = 2_000) {
  try {
    const result = spawnSync("git", ["diff", "--unified=1", "--", "."], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout?.trim()) return "";
    const text = result.stdout
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !/^index |^diff --git |^new file mode|^deleted file mode|^old mode|^new mode/.test(line))
      .join("\n");
    return clip(text, maxChars);
  } catch {
    return "";
  }
}
