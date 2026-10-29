import fs from "node:fs";
import path from "node:path";

/**
 * One machine-readable record per task, whatever harness ran it.
 *
 * The record never upgrades a run: `ok` is true only for a verified pass (or a
 * clean unverified agent exit), and every claim points at evidence Kodevra
 * captured itself - the verification exit code, git/file changes, the event log
 * and Codex's own JSONL commands.
 */

export const OUTCOME_SCHEMA = "kodevra.outcome/1";

export function normalizeOutcome({
  harness,
  model,
  provider = null,
  run = {},
  verification = null,
  failure = null,
  approval = null,
  changes = { files: [] },
  repairs = 0,
  maxRepairs = 0,
  executor = null,
  authorization = null,
  eventsFile = null,
  startedAt = Date.now(),
  endedAt = Date.now(),
  codex = null,
  speed = null,
  timings = null,
  subagents = null,
  economy = null,
} = {}) {
  const status = approval
    ? "approval_required"
    : run.timedOut
      ? "timeout"
      : failure
        ? "failed"
        : verification
        ? verification.ok
          ? "verified"
          : "verification_failed"
        : run.status === 0
          ? "unverified"
          : "failed";

  const ok = status === "verified" || status === "unverified";

  return {
    schema: OUTCOME_SCHEMA,
    harness,
    model,
    provider,
    status,
    ok,
    timing: {
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: endedAt - startedAt,
      agent_ms: run.durationMs ?? null,
      verification_ms: verification?.durationMs ?? null,
      // Real clock readings per phase (see lib/timings.js); `total` is measured
      // from CLI start, so the wrapper and the engine stay separable.
      phases_ms: timings ?? null,
    },
    exit: {
      code: run.status ?? null,
      signal: run.signal ?? null,
      timed_out: Boolean(run.timedOut),
      timeout_reason: run.timeoutReason ?? null,
    },
    error: failure ? { code: failure.code, origin: failure.origin, message: failure.message } : null,
    verification: verification
      ? {
          command: verification.command,
          ok: Boolean(verification.ok),
          exit_code: verification.status ?? null,
          timed_out: Boolean(verification.timedOut),
          executor: executor?.name ?? null,
          sandboxed: Boolean(executor?.sandboxed),
          // Additive: only runs with a verification contract carry these.
          verdict: verification.verdict ?? null,
          failed_gate: verification.code ?? null,
          contract: verification.contract ?? null,
        }
      : null,
    authorization: authorization
      ? { fingerprint: authorization.fingerprint, files: authorization.files?.length ?? null, source: authorization.source ?? null }
      : null,
    changes: {
      count: changes.files?.length ?? 0,
      files: changes.files ?? [],
    },
    repairs: { attempts: repairs, max: maxRepairs },
    // Turn economy: model round trips versus cheap local work. Null for
    // harnesses that do not report it, so an older run cannot look optimised.
    economy: economy
      ? {
          model_turns: economy.modelTurns ?? null,
          local_operations: economy.localOperations ?? null,
          tool_actions: economy.toolActions ?? null,
          verification_attempts: economy.verificationAttempts ?? null,
          verification_runs: economy.verificationRuns ?? null,
          failed_verifications: economy.failedVerifications ?? null,
          bootstrap: economy.bootstrap
            ? {
                ms: economy.bootstrap.ms ?? null,
                chars: economy.bootstrap.chars ?? null,
                detail: economy.bootstrap.detail ?? null,
              }
            : null,
          duration_ms: economy.durationMs ?? null,
        }
      : null,
    // H7 telemetry, null for harnesses that never spawn a subagent. Counts and
    // durations come from the harness state the run already kept; H8 reads the
    // same object rather than a parallel counter.
    subagents: subagents
      ? {
          total: subagents.total ?? 0,
          explorer: subagents.explorer ?? 0,
          reviewer: subagents.reviewer ?? 0,
          failure_diagnoser: subagents.failure_diagnoser ?? 0,
          duration_ms: subagents.durationMs ?? 0,
          turns: (subagents.history ?? []).reduce((sum, entry) => sum + (entry.turns ?? 0), 0),
          concurrency: subagents.concurrency ?? 1,
          invocations: (subagents.history ?? []).map((entry) => ({
            turn: entry.turn ?? null,
            role: entry.role ?? null,
            ok: Boolean(entry.ok),
            duration_ms: entry.durationMs ?? null,
            turns: entry.turns ?? null,
            code: entry.code ?? null,
          })),
        }
      : null,
    // Proof that the requested speed was actually requested, and that Codex's own
    // catalog advertised it. `effective_service_tier` is null unless Kodevra
    // passed one, so a standard run can never look fast.
    speed: {
      requested: speed?.requested ?? "default",
      effective_service_tier: speed?.effective_service_tier ?? null,
      model_supports_priority: speed?.model_supports_priority ?? null,
      catalog_source: speed?.catalog_source ?? null,
    },
    evidence: {
      events_file: eventsFile,
      agent: codex
        ? {
            thread_id: codex.threadId ?? null,
            // `turns` and the `at_ms` marks are what a turn budget is read from:
            // total duration alone cannot separate thinking from environment
            // recovery.
            turns: codex.turns ?? null,
            commands: (codex.commands ?? []).map((command) => ({
              command: command.command,
              exit_code: command.exit_code,
              status: command.status,
              ...(Number.isFinite(command.at_ms) ? { at_ms: command.at_ms } : {}),
            })),
            failed_commands: (codex.failedCommands ?? []).length,
            first_command_at_ms: codex.commands?.[0]?.at_ms ?? null,
            file_changes: (codex.fileChanges ?? []).length,
            first_change_at_ms: codex.fileChanges?.[0]?.at_ms ?? null,
            messages: codex.agentMessages?.length ?? 0,
            tokens: codex.tokens ?? null,
            turn_completed: Boolean(codex.turnCompleted),
            turn_failed: Boolean(codex.turnFailed),
            errors: codex.errors ?? [],
          }
        : null,
    },
  };
}

export function writeOutcome(file, outcome) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  return target;
}
