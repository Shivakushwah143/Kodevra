import fs from "node:fs";
import path from "node:path";

/**
 * H8 - one benchmark record per harness run.
 *
 * This is a projection of what the harness already reports (run result, harness
 * state, verification result), not a second telemetry system. The same shape can
 * represent a different harness later (`harness.name`, `harness.version`,
 * `config`), which is what makes comparisons possible without integrating those
 * harnesses now.
 */

export const HARNESS_V2 = "kodevra-harness-v2";
export const EXECUTABLE_HARNESSES = [HARNESS_V2];

export const FAILURE_CATEGORIES = Object.freeze([
  "MODEL_PROTOCOL_ERROR",
  "TOOL_FAILURE",
  "PATCH_FAILURE",
  "SHELL_FAILURE",
  "VERIFICATION_FAILED",
  "TURN_BUDGET_EXHAUSTED",
  "REPAIR_BUDGET_EXHAUSTED",
  "APPROVAL_REQUIRED",
  "BRIDGE_ERROR",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "USER_INTERRUPTED",
  "UNKNOWN",
]);

const RULES = [
  [/^PROTOCOL_ERROR$/, "MODEL_PROTOCOL_ERROR"],
  [/^VERIFICATION_BUDGET$/, "REPAIR_BUDGET_EXHAUSTED"],
  [/^VERIFICATION_TIMEOUT$/, "TIMEOUT"],
  [/^VERIFICATION_REFUSED$/, "APPROVAL_REQUIRED"],
  [/^VERIFICATION_INFRA$/, "UNKNOWN"],
  [/^VERIFICATION_/, "VERIFICATION_FAILED"],
  [/^UNVERIFIED/, "VERIFICATION_FAILED"],
  [/^TURN_BUDGET_EXHAUSTED$/, "TURN_BUDGET_EXHAUSTED"],
  [/^BRIDGE_/, "BRIDGE_ERROR"],
  [/^(APPROVAL_REQUIRED|POLICY_DENIED)/, "APPROVAL_REQUIRED"],
  [/^PATCH_/, "PATCH_FAILURE"],
  [/^SHELL_/, "SHELL_FAILURE"],
  [/^SUBAGENT_/, "TOOL_FAILURE"],
  [/^TOOL_|^MODE_|^PATH_|^EDIT_|^READ_|^WRITE_|^LIST_|^SEARCH_|^FILE_/, "TOOL_FAILURE"],
  [/(PROVIDER|RATE_LIMIT|MODEL_UNAVAILABLE|AUTH_|QUOTA)/, "PROVIDER_ERROR"],
  [/TIMEOUT|TIMED_OUT/, "TIMEOUT"],
  [/CANCEL|INTERRUPT/, "USER_INTERRUPTED"],
];

/** Normalise a run's code/kind into one reporting category. */
export function classifyFailure({ code = null, failureKind = null } = {}) {
  if (code) {
    for (const [pattern, category] of RULES) if (pattern.test(code)) return category;
  }
  if (failureKind === "verification") return "VERIFICATION_FAILED";
  if (failureKind === "authorization") return "APPROVAL_REQUIRED";
  if (failureKind === "timeout") return "TIMEOUT";
  if (failureKind === "protocol") return "MODEL_PROTOCOL_ERROR";
  if (failureKind === "infrastructure") return code && /^BRIDGE_/.test(code) ? "BRIDGE_ERROR" : "UNKNOWN";
  return "UNKNOWN";
}

export function packageVersion(root = path.resolve(import.meta.dirname, "..", "..")) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function countActions(actions = []) {
  const counts = new Map();
  for (const entry of actions) counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  const get = (name) => counts.get(name) ?? 0;
  return {
    inspect: get("inspect"),
    batch: get("batch"),
    read: get("read"),
    search: get("search"),
    list: get("list"),
    shell: get("shell"),
    applyPatch: get("apply_patch"),
    write: get("write"),
    edit: get("edit"),
    verify: get("verify"),
    subagent: get("subagent"),
  };
}

export function buildRecord({ task, workspace, provider, model, result, startedAt, endedAt, harnessVersion, limits = null }) {
  const harness = result.harness ?? {};
  const usage = harness.subagents ?? {};
  const verification = result.verification ?? {};
  const approvalDecisions = harness.approval?.decisions ?? [];
  const failureCategory = result.ok && result.verified ? null : classifyFailure({ code: result.code, failureKind: result.failureKind });
  const status = result.ok && result.verified ? "VERIFIED" : failureCategory === "APPROVAL_REQUIRED" ? "REFUSED" : "FAILED";

  return {
    schema: "kodevra.harness-benchmark/1",
    taskId: task.id,
    repository: path.resolve(workspace),
    provider,
    model,
    harnessVersion,
    harness: { name: HARNESS_V2, version: harnessVersion },
    approvalMode: harness.approval?.mode ?? task.approval ?? "balanced",
    status,
    durationMs: Math.max(0, endedAt - startedAt),
    modelTurns: result.turns ?? 0,
    modelRoundTrips: result.turns ?? 0,
    toolCalls: countActions(result.actions),
    failedToolCalls: (result.actions ?? []).filter((entry) => !entry.ok).length,
    verificationAttempts: (result.verifications ?? []).length,
    repairAttempts: verification.attempts ?? 0,
    subagentInvocations: {
      explorer: usage.explorer ?? 0,
      reviewer: usage.reviewer ?? 0,
      failureDiagnoser: usage.failure_diagnoser ?? 0,
      total: usage.total ?? 0,
    },
    subagentMs: usage.durationMs ?? 0,
    subagentTurns: (usage.history ?? []).reduce((sum, entry) => sum + (entry.turns ?? 0), 0),
    approvalInterruptions: approvalDecisions.filter((entry) => entry.decision !== "allow").length,
    humanInterventions: result.failureKind === "authorization" ? 1 : 0,
    filesChanged: harness.context?.changedFiles ?? [],
    // Not detectable without a pre-run snapshot of every file; the harness records
    // only changes it can attribute. Left null instead of guessing.
    unnecessaryFilesChanged: null,
    verification: {
      command: task.verify ?? null,
      state: verification.state ?? null,
      exitCode: verification.exitCode ?? null,
    },
    failureCategory,
    failureCode: result.code ?? null,
    failureKind: result.failureKind ?? null,
    checkpoints: (harness.checkpoints ?? []).length,
    context: {
      compacted: harness.context?.compacted ?? 0,
      dropped: harness.context?.dropped ?? 0,
    },
    config: {
      maxTurns: task.maxTurns ?? null,
      maxVerifyRepairs: task.maxRepairs ?? null,
      subagents: {
        invocations: Boolean(result.harness?.subagents),
        maxInvocations: limits?.subagentInvocations ?? null,
        perRole: limits?.subagentPerRole ?? null,
        maxTurns: limits?.subagentTurns ?? null,
      },
      features: ["shell", "apply_patch", "inspect", "batch", "verify-controller", "context-manager", "checkpoints", "subagents"],
    },
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };
}

export function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

export function summarize(records) {
  const total = records.length;
  const verified = records.filter((record) => record.status === "VERIFIED");
  const failureCounts = new Map();
  for (const record of records) {
    if (!record.failureCategory) continue;
    failureCounts.set(record.failureCategory, (failureCounts.get(record.failureCategory) ?? 0) + 1);
  }
  const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  return {
    total,
    verified: verified.length,
    failed: records.filter((record) => record.status === "FAILED").length,
    refused: records.filter((record) => record.status === "REFUSED").length,
    successRate: total ? Math.round((verified.length / total) * 1000) / 10 : 0,
    medianTimeToVerifiedMs: median(verified.map((record) => record.durationMs)),
    averageModelTurns: average(records.map((record) => record.modelTurns)),
    averageRepairAttempts: average(records.map((record) => record.repairAttempts)),
    subagents: {
      explorer: records.reduce((sum, record) => sum + record.subagentInvocations.explorer, 0),
      reviewer: records.reduce((sum, record) => sum + record.subagentInvocations.reviewer, 0),
      failure_diagnoser: records.reduce((sum, record) => sum + record.subagentInvocations.failureDiagnoser, 0),
      durationMs: records.reduce((sum, record) => sum + (record.subagentMs ?? 0), 0),
    },
    failures: Object.fromEntries(failureCounts),
  };
}

function seconds(ms) {
  if (ms === null || ms === undefined) return "-";
  return `${Math.round(ms / 1000)}s`;
}

/** Compact terminal report: one row per task, then the aggregate. */
export function formatReport(records, summary = summarize(records)) {
  const header = ["TASK", "STATUS", "TIME", "TURNS", "REPAIRS"];
  const rows = records.map((record) => [
    record.taskId,
    record.status,
    seconds(record.durationMs),
    String(record.modelTurns),
    String(record.repairAttempts),
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index].length)));
  const line = (row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();

  const lines = [line(header), ...rows.map(line), "", "SUMMARY", ""];
  lines.push(`Verified: ${summary.verified}/${summary.total}`);
  lines.push(`Success rate: ${summary.successRate}%`);
  lines.push(`Median time to verified result: ${seconds(summary.medianTimeToVerifiedMs)}`);
  lines.push(`Average model turns: ${summary.averageModelTurns === null ? "-" : summary.averageModelTurns.toFixed(1)}`);
  lines.push(`Average repair attempts: ${summary.averageRepairAttempts === null ? "-" : summary.averageRepairAttempts.toFixed(1)}`);
  lines.push(
    `Subagents: explorer ${summary.subagents.explorer} · reviewer ${summary.subagents.reviewer} · failure_diagnoser ${summary.subagents.failure_diagnoser} · ${seconds(
      summary.subagents.durationMs,
    )}`,
  );
  const failures = Object.entries(summary.failures);
  if (failures.length) lines.push(`Failures: ${failures.map(([category, count]) => `${category} ${count}`).join(" · ")}`);
  return lines.join("\n");
}
