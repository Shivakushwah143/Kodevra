import { decideApproval, DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "./approval-policy.js";
import {
  CORRECTION_MESSAGE,
  LIMITS,
  chatTurn,
  instruction,
  parseAction,
  toolResultMessage,
  webFailure,
} from "./chatgpt-web.js";
import { checkpointSummary, createCheckpoint } from "./chatgpt-web-checkpoint.js";
import {
  compactBody,
  contextDiagnostics,
  createContextState,
  noteChangedFiles,
  noteMutation,
  noteToolResult,
  noteVerification,
  renderBudget,
  renderContext,
} from "./chatgpt-web-context.js";
import { inspectTool } from "./chatgpt-web-inspect.js";
import {
  clipSubagentBody,
  compactWorkspaceDiff,
  emptySubagentUsage,
  runSubagent,
} from "./chatgpt-web-subagents.js";
import { executeAction } from "./chatgpt-web-tools.js";
import {
  createVerification,
  invalidateOnEdit,
  markTerminal,
  markVerifying,
  recordVerification,
  requestVerification,
  transition,
  verificationSnapshot,
} from "./chatgpt-web-verify.js";
import { DEFAULT_TASK_CLASS, escalateTaskClass, resolveThinkingPlan } from "./thinking-policy.js";

/**
 * The Kodevra-owned tool loop for the ChatGPT-web experiment.
 *
 * chatgpt-bridge supplies only assistant text, so Kodevra asks for exactly one
 * JSON action per ChatGPT turn, executes it against the workspace, and feeds the
 * bounded result back into the SAME conversation. ChatGPT keeps the history;
 * Kodevra keeps the tools, the workspace boundary, the verification state and
 * the approval policy.
 *
 * No tool path leaves the workspace. Shell command lines are parsed before they
 * run - including redirects, globs, operators and revision paths - and are
 * bounded by time and output; every turn is budgeted, so a run that cannot
 * finish inside the limits fails and says why.
 */

/** Actions that can change the workspace; the tool result says whether they did. */
const EDITS = new Set(["write", "edit", "apply_patch"]);
const REVIEWED = new Set(["write", "edit", "apply_patch", "shell"]);
const POTENTIAL_MUTATIONS = new Set([...EDITS, "shell", "batch"]);

export async function runChatGptWebAgent({
  workspace,
  task,
  mode = "workspace-write",
  chat = chatTurn,
  verify = null,
  verifyCommand = null,
  continueSession = false,
  sessionId = null,
  limits: providedLimits = LIMITS,
  approval = DEFAULT_APPROVAL_MODE,
  provider = null,
  model = null,
  fingerprint = null,
  executor = null,
  onEvent = () => {},
}) {
  // A caller may pass a partial budget; the harness reads many keys from it.
  const limits = { ...LIMITS, ...providedLimits };
  const startedAt = Date.now();
  const actions = [];
  const verifications = [];
  const approvalDecisions = [];
  const checkpoints = [];
  let turns = 0;
  let protocolRepairs = 0;
  let editVersion = 0;
  let checkpointIndex = 0;
  let burstCheckpointed = false;
  let currentSession = continueSession ? sessionId : null;
  let newSession = !continueSession || !sessionId;
  // Round-trip optimisation: deterministic repository context is gathered once,
  // locally, before the model spends its first turn asking for it.
  const bootstrap = (() => {
    const started = Date.now();
    try {
      // Bootstrap is cheap on purpose: a smaller walk/scan than a model-requested
      // inspect, because it runs before every first turn.
      const view = inspectTool(workspace, { focus: task }, {
        ...limits,
        inspectFiles: Math.min(limits.inspectFiles, 1_500),
        inspectScanFiles: Math.min(limits.inspectScanFiles, 200),
        inspectScanBytes: Math.min(limits.inspectScanBytes, 120_000),
        inspectFocusFiles: Math.min(limits.inspectFocusFiles, 8),
        inspectChars: limits.bootstrapChars,
      });
      const body = `${view.body ?? ""}`.trim();
      const text = body.length > limits.bootstrapChars ? `${body.slice(0, limits.bootstrapChars)}\n[bootstrap truncated]` : body;
      return { text, ms: Date.now() - started, chars: text.length, detail: `${view.detail ?? ""}`.slice(0, 200) };
    } catch (error) {
      return { text: "", ms: Date.now() - started, chars: 0, detail: `${error.code || "BOOTSTRAP_FAILED"}` };
    }
  })();
  let localOperations = bootstrap.text ? 1 : 0;
  let message = instruction({ workspace, task, verifyCommand: verifyCommand ?? (verify ? "caller-supplied" : null) });
  if (bootstrap.text) message += `\n\nBOOTSTRAP CONTEXT (local, deterministic):\n${bootstrap.text}`;
  let lastReply = "";
  // One effort per run, escalated on evidence only: a failed verification or a
  // protocol repair means the task turned out to be harder than it looked. The
  // class never drops back, because every change is one UI interaction in the
  // ChatGPT tab.
  let taskClass = DEFAULT_TASK_CLASS;

  const approvalMode = normalizeApprovalMode(approval);
  if (!approvalMode) {
    const error = new Error(`unknown approval mode "${approval}" (use: strict | balanced | autonomous)`);
    error.code = "APPROVAL_MODE_INVALID";
    throw error;
  }

  // H4/H5/H6: one state tree for the run. Verification, context, approval and
  // checkpoints are views on it rather than separate sources of truth.
  const verification = createVerification({
    command: verifyCommand ?? (verify ? "verify" : null),
    maxAttempts: limits.maxVerifyRepairs,
  });
  const context = createContextState({ task, workspace, provider, model, limits });
  context.turn.max = limits.maxTurns;
  // Approval mode is static for the run; including it never causes the state
  // block to churn and tells the model what the harness will allow.
  context.approvalMode = approvalMode;
  // The bootstrap already contains focus files and symbols; seed the packet so
  // the first state block carries that evidence instead of empty fields.
  if (bootstrap.text) {
    noteToolResult(context, {
      action: { action: "inspect" },
      result: { ok: true, body: bootstrap.text, detail: bootstrap.detail },
      turn: 0,
    });
    context.turn.used = 0;
  }
  const subagents = emptySubagentUsage();

  // Compact, role-shaped one-liner for the live status stream and the run log.
  const subagentSummary = (role, result) => {
    if (!result) return null;
    if (role === "reviewer") {
      const issues = Array.isArray(result.issues) ? result.issues.length : 0;
      return `${result.status ?? "unknown"}${issues ? ` (${issues} issue(s))` : ""}`;
    }
    if (role === "failure_diagnoser") return `${result.rootCause ?? ""}`.slice(0, 200) || null;
    return `${result.summary ?? ""}`.slice(0, 200) || null;
  };

  const subagentBudgetBlock = (role) => {
    if (subagents.total >= limits.subagentInvocations) {
      return `subagent budget exhausted (${limits.subagentInvocations} per run)`;
    }
    if (subagents[role] >= limits.subagentPerRole) {
      return `the ${role} subagent already ran ${limits.subagentPerRole} time(s) this run`;
    }
    return null;
  };

  const buildSubagentInput = (action) => ({
    task,
    focus: action.focus ?? "",
    workspace,
    changedFiles: [...context.changedFiles].sort(),
    constraints: [...context.constraints],
    diff: compactWorkspaceDiff(workspace, limits.subagentDiffChars),
    verification: {
      state: verification.state,
      command: verification.command,
      attempts: verification.attempts,
      maxAttempts: verification.maxAttempts,
      exitCode: verification.exitCode,
      failureKind: verification.latestFailure?.kind ?? null,
      evidence: verification.latestFailure?.evidence ?? "",
    },
    files: context.relevantFiles,
    symbols: context.relevantSymbols,
    failures: context.unresolvedErrors.map((entry) => `${entry.action}: ${entry.detail}`),
  });

  const status = (event) => {
    try {
      onEvent(event);
    } catch {
      // status printing must never break the run
    }
  };

  const harnessResult = () => ({
    verification: verificationSnapshot(verification),
    approval: { mode: approvalMode, decisions: approvalDecisions },
    checkpoints: checkpoints.map(checkpointSummary),
    subagents: {
      ...subagents,
      history: [...subagents.history],
      concurrency: limits.subagentConcurrency,
    },
    context: contextDiagnostics(context),
    // H8 turn economy: model round trips are the expensive resource; local
    // operations are counted so the ratio is visible instead of guessed.
    economy: {
      modelTurns: turns,
      localOperations,
      toolActions: actions.length,
      verificationAttempts: verification.attempts,
      verificationRuns: verifications.length,
      failedVerifications: verifications.filter((entry) => entry.ok === false).length,
      bootstrap: { ms: bootstrap.ms, chars: bootstrap.chars, detail: bootstrap.detail },
      durationMs: Date.now() - startedAt,
    },
  });

  status({
    type: "bootstrap",
    ms: bootstrap.ms,
    chars: bootstrap.chars,
    detail: bootstrap.detail,
    localOperations,
  });

  const failure = (code, detail, action, kind = "harness") => {
    status({ type: "error", code, detail, kind });
    return {
      ok: false,
      code,
      failure: webFailure(code, detail, action),
      failureKind: kind,
      turns,
      actions,
      verifications,
      verification: verificationSnapshot(verification),
      lastVerification: null,
      session: currentSession,
      transcript: lastReply,
      startedAt,
      endedAt: Date.now(),
      firstEditMs: null,
      verified: false,
      harness: harnessResult(),
    };
  };

  const recordCheckpoint = (label, { force = false } = {}) => {
    const latest = checkpoints.at(-1);
    if (!force && latest && latest.editVersion === editVersion && latest.label === label) return latest;
    const checkpoint = createCheckpoint({
      workspace,
      label,
      verification,
      changedFiles: context.changedFiles,
      fingerprint,
      task,
      limits,
      index: (checkpointIndex += 1),
    });
    checkpoint.editVersion = editVersion;
    checkpoints.push(checkpoint);
    if (checkpoints.length > limits.checkpointMax) checkpoints.shift();
    noteChangedFiles(context, checkpoint.changedFiles, checkpoint.git.isGit ? checkpoint.git.diffStat : null);
    status({
      type: "checkpoint",
      label,
      at: checkpoint.at,
      files: checkpoint.changedFileCount,
      git: checkpoint.git.isGit,
      rollback: checkpoint.rollback.kind,
    });
    return checkpoint;
  };

  const evidenceMessage = () => {
    const snapshot = verification.latestFailure;
    const lines = [
      `verification: ${verification.state}`,
      `command: ${verification.command ?? "(none)"}`,
      `attempt: ${verification.attempts}/${verification.maxAttempts}`,
    ];
    if (verification.exitCode !== null) lines.push(`exit code: ${verification.exitCode}`);
    if (snapshot?.evidence) lines.push("", snapshot.evidence);
    return lines.join("\n");
  };

  const verificationFailure = () => {
    const kind = verification.latestFailure?.kind;
    if (kind === "timeout") {
      return failure(
        "VERIFICATION_TIMEOUT",
        `verification timed out: ${verification.command ?? "verify"}.`,
        "The command itself blocked; fix the command or run it yourself, then retry the task.",
        "timeout",
      );
    }
    if (kind === "authorization") {
      return failure(
        "VERIFICATION_REFUSED",
        "verification was refused by the authorization gate.",
        "The verification surface changed outside this run's own edits, or the approval mode does not allow rebinding. Review the change and re-run with --reapprove <fingerprint>.",
        "authorization",
      );
    }
    if (kind === "infrastructure") {
      return failure(
        "VERIFICATION_INFRA",
        "verification could not run.",
        "That is an infrastructure failure, not a code failure; check the executor and retry.",
        "infrastructure",
      );
    }
    return failure(
      "VERIFICATION_BUDGET",
      `verification still failed after ${verification.maxAttempts} repair attempt(s).`,
      "Read the failing output yourself; the harness stops rather than burning more ChatGPT turns on the same failure.",
      "verification",
    );
  };

  const executeVerification = async ({ trigger = "model" } = {}) => {
    if (!verify) return { kind: "unavailable", terminal: false };

    requestVerification(verification);
    status({ type: "verification_state", state: verification.state, attempt: verification.attempts, trigger });
    recordCheckpoint(`before-verify-${verification.attempts + 1}`);
    markVerifying(verification);
    status({ type: "verification_state", state: verification.state, attempt: verification.attempts, trigger });

    let result;
    try {
      result = await verify({
        changedFiles: [...context.changedFiles].sort(),
        approval: approvalMode,
        editVersion,
      });
    } catch (error) {
      markTerminal(verification, error.message);
      status({ type: "verification_state", state: verification.state, attempt: verification.attempts, trigger });
      noteVerification(context, verification);
      burstCheckpointed = false;
      return { kind: "infrastructure", terminal: true, error };
    }

    const outcome = recordVerification(verification, result, editVersion, {
      maxChars: limits.verificationEvidenceChars,
    });
    verifications.push({ ...result, editVersion, state: verification.state, attempt: verification.attempts });
    if (outcome.kind === "pass") {
      status({ type: "verify_result", ok: true, status: result.status, refused: false, state: verification.state });
    } else {
      if (outcome.repair) transition(verification, "repair_needed");
      if (outcome.terminal && verification.state === "verification_failed") transition(verification, "terminal_failed");
      status({
        type: "verify_result",
        ok: false,
        status: result.status,
        refused: Boolean(result.refused),
        state: verification.state,
        kind: outcome.kind,
      });
    }
    status({ type: "verification_state", state: verification.state, attempt: verification.attempts, trigger });
    noteVerification(context, verification);
    burstCheckpointed = false;
    return outcome;
  };

  const reviewAction = (action) => {
    if (!REVIEWED.has(action.action)) return { decision: "allow", policy: approvalMode, kind: action.action, reason: "" };
    const decision = decideApproval({ mode: approvalMode, action });
    approvalDecisions.push({
      turn: turns,
      action: action.action,
      decision: decision.decision,
      policy: decision.policy,
      kind: decision.kind,
      reason: decision.reason,
    });
    while (approvalDecisions.length > 40) approvalDecisions.shift();
    status({
      type: "approval_policy",
      action: action.action,
      decision: decision.decision,
      policy: decision.policy,
      kind: decision.kind,
      reason: decision.reason,
    });
    return decision;
  };

  const composeMessage = (action, result, { verificationOutcome = null } = {}) => {
    const body = compactBody(context, action, result.body);
    const detail = result.ok ? result.detail : `${result.code}: ${result.detail}`;
    let text = toolResultMessage({ action, ok: Boolean(result.ok), detail, body });
    if (verificationOutcome) text += `\n\n${evidenceMessage()}`;
    const state = renderContext(context, { turn: turns, verification });
    if (state) text += `\n\n${state}`;
    text += `\n${renderBudget(context, { turn: turns, verification })}`;
    return text;
  };

  /**
   * One completion path for `finish` and for completion intent. It is the only
   * place that can return a VERIFIED result, and it only does so after the
   * harness itself observed a passing verification for the current edit version.
   */
  const completeRun = async (action, { trigger = "finish", force = false } = {}) => {
    const needsVerification =
      Boolean(verify) && verification.passedEditVersion !== editVersion && (force || editVersion > 0);
    if (needsVerification) {
      const outcome = await executeVerification({ trigger });
      if (outcome.kind !== "pass") {
        if (outcome.kind === "authorization" || outcome.terminal) return { done: true, result: verificationFailure() };
        const finishAction = action.action === "finish" ? action : { action: "finish", summary: action.summary ?? "" };
        const blocked = {
          ok: false,
          code: "UNVERIFIED_FINISH",
          detail: "finish blocked: verification failed, so the task is not verified",
          body: "",
        };
        actions.push({ turn: turns, action: "finish", ok: false, mutated: false, atMs: Date.now() - startedAt });
        status({ type: "finish_blocked", turn: turns, code: blocked.code });
        noteToolResult(context, { action: finishAction, result: blocked, turn: turns });
        message = composeMessage(finishAction, blocked, { verificationOutcome: outcome });
        newSession = false;
        return { done: false };
      }
    }

    recordCheckpoint("final", { force: true });
    status({ type: "finish", turn: turns, summary: action.summary });
    const reusable = verification.passedEditVersion === editVersion && verification.state === "verification_passed";
    const summary =
      `${action.summary ?? ""}`.trim() ||
      (reusable ? "task complete (verification passed)" : force ? "task complete (no verification configured)" : "");
    const lastPass = verifications.filter((entry) => entry.ok && entry.editVersion === editVersion).at(-1) ?? null;
    return {
      done: true,
      result: {
        ok: true,
        code: null,
        failure: null,
        summary,
        turns,
        actions,
        verifications,
        verification: verificationSnapshot(verification),
        lastVerification: reusable ? lastPass : null,
        verified: reusable,
        session: currentSession,
        transcript: lastReply,
        startedAt,
        endedAt: Date.now(),
        firstEditMs: actions.find((entry) => entry.mutated)?.atMs ?? null,
        harness: harnessResult(),
      },
    };
  };

  status({ type: "waiting", turn: 1, session: currentSession, newSession });

  // One logical model turn, one idempotency key: the durable transport can then
  // retry an ambiguous submit without asking ChatGPT the same question twice.
  const runKey = `${startedAt}`;

  while (turns < limits.maxTurns) {
    turns += 1;
    context.turn.used = turns;
    let reply;
    try {
      reply = await chat({
        message,
        sessionId: currentSession,
        newSession,
        effort: resolveThinkingPlan({ taskClass }).effort,
        idempotencyKey: `${runKey}:turn:${turns}`,
        // Polling and progress are local transport work: they never consume a
        // model turn, and a silent browser is not an idle failure.
        onProgress: (progress) =>
          status({
            type: "progress",
            turn: turns,
            stage: progress?.stage ?? "waiting",
            requestId: progress?.requestId ?? null,
            elapsedMs: progress?.elapsedMs ?? 0,
            phase: progress?.phase ?? "",
            status: progress?.status ?? "",
          }),
        // Display only: streamed text is never parsed or executed. The action
        // below still comes from the complete durable response.
        onLiveEvent: (event) =>
          status({
            type: "stream",
            turn: turns,
            stream: event?.type ?? "",
            status: event?.status ?? "",
            seq: event?.seq ?? 0,
            delta: event?.delta ?? "",
            answerLength: event?.answerLength ?? 0,
          }),
      });
    } catch (error) {
      return failure(
        error.code || "BRIDGE_ERROR",
        error.message,
        error.hint || "Check the bridge and the ChatGPT tab, then retry.",
        "infrastructure",
      );
    }
    if (reply.session) currentSession = reply.session;
    lastReply = reply.text;
    status({ type: "reply", turn: turns, session: currentSession });

    const parsed = parseAction(reply.text);
    if (!parsed.ok) {
      if (protocolRepairs < limits.maxProtocolRepairs) {
        protocolRepairs += 1;
        taskClass = escalateTaskClass(taskClass);
        status({ type: "protocol_error", turn: turns, reason: parsed.reason, repair: protocolRepairs });
        message = CORRECTION_MESSAGE;
        newSession = false;
        continue;
      }
      return failure(
        "PROTOCOL_ERROR",
        `ChatGPT did not answer with one valid JSON action (${parsed.reason}).`,
        "The experiment stops instead of guessing at prose. Retry the task; if it repeats, the bridge or the tab is not returning the assistant message.",
        "protocol",
      );
    }

    const action = parsed.action;
    status({
      type: "action",
      turn: turns,
      action: action.action,
      path: action.path,
      query: action.query,
      command: action.command,
      focus: action.focus,
    });

    // ---- finish: the only path to a VERIFIED result ------------------------
    if (action.action === "finish") {
      const finished = await completeRun(action, { trigger: "finish" });
      if (finished.done) return finished.result;
      continue;
    }

    // ---- subagent: bounded, read-only assistance (H7) --------------------
    if (action.action === "subagent") {
      const blocked = subagentBudgetBlock(action.role);
      if (blocked) {
        const result = {
          ok: false,
          code: "SUBAGENT_BUDGET",
          detail: blocked,
          body: "Subagents are a finite budget. Continue the task yourself with inspect/batch/read.",
        };
        actions.push({ turn: turns, action: "subagent", ok: false, atMs: Date.now() - startedAt });
        status({ type: "tool", turn: turns, action: "subagent", ok: false, detail: blocked });
        noteToolResult(context, { action, result, turn: turns });
        message = composeMessage(action, result);
        newSession = false;
        continue;
      }

      status({
        type: "subagent",
        phase: "start",
        role: action.role,
        focus: action.focus ?? null,
        turn: turns,
        invocation: subagents.total + 1,
      });
      const outcome = await runSubagent({
        role: action.role,
        input: buildSubagentInput(action),
        workspace,
        chat,
        limits,
        mode,
        approval: approvalMode,
        executor,
        onEvent: (event) => status({ ...event, turn: turns }),
      });
      subagents.total += 1;
      subagents[action.role] += 1;
      subagents.durationMs += outcome.durationMs;
      subagents.history.push({
        turn: turns,
        role: action.role,
        ok: Boolean(outcome.ok),
        durationMs: outcome.durationMs,
        turns: outcome.turns,
        code: outcome.code ?? null,
      });
      while (subagents.history.length > 20) subagents.history.shift();
      status({
        type: "subagent",
        phase: "finish",
        role: action.role,
        ok: Boolean(outcome.ok),
        code: outcome.code ?? null,
        durationMs: outcome.durationMs,
        turns: outcome.turns,
        invocation: subagents.total,
        total: subagents.total,
        summary: subagentSummary(action.role, outcome.result),
      });

      const result = {
        ok: Boolean(outcome.ok),
        code: outcome.ok ? null : outcome.code,
        detail: outcome.ok
          ? `${action.role} reported in ${outcome.durationMs} ms (${outcome.turns} turn(s))`
          : `${outcome.code}: ${outcome.detail}`,
        body: clipSubagentBody(outcome.result, limits),
      };
      actions.push({ turn: turns, action: "subagent", ok: result.ok, atMs: Date.now() - startedAt });
      status({ type: "tool", turn: turns, action: "subagent", ok: result.ok, detail: result.detail });
      noteToolResult(context, { action, result, turn: turns });
      message = composeMessage(action, result);
      newSession = false;
      continue;
    }

    // ---- explicit verify: same state machine, model-triggered --------------
    if (action.action === "verify") {
      if (!verify) {
        const result = {
          ok: false,
          detail: "Kodevra was started without --verify",
          body: "No verification command was supplied to Kodevra for this run. Keep editing, or finish and report that no verification ran.",
        };
        actions.push({ turn: turns, action: "verify", ok: false, atMs: Date.now() - startedAt });
        status({ type: "tool", turn: turns, action: "verify", ok: false, detail: result.detail });
        noteToolResult(context, { action, result, turn: turns });
        message = composeMessage(action, result);
        newSession = false;
        continue;
      }
      status({ type: "verify", turn: turns });
      const outcome = await executeVerification({ trigger: "model" });
      if (outcome.kind === "infrastructure" || outcome.terminal) return verificationFailure();
      const result = {
        ok: outcome.kind === "pass",
        detail:
          outcome.kind === "pass"
            ? `verification passed (exit ${verification.exitCode ?? 0})`
            : outcome.kind === "authorization"
              ? "verification refused: authorization required"
              : `verification failed (${verification.latestFailure?.exitCodeText ?? "exit ?"})`,
        // Evidence is appended once, by composeMessage, from the state machine.
        body: "",
      };
      actions.push({ turn: turns, action: "verify", ok: result.ok, atMs: Date.now() - startedAt });
      noteToolResult(context, { action, result, turn: turns });
      message = composeMessage(action, result, { verificationOutcome: outcome });
      newSession = false;
      continue;
    }

    // ---- approval policy (H6) ---------------------------------------------
    const policy = reviewAction(action);
    if (policy.decision !== "allow") {
      const blocked = {
        ok: false,
        code: policy.decision === "deny" ? "POLICY_DENIED" : "APPROVAL_REQUIRED",
        detail: `${policy.reason} (approval mode: ${policy.policy})`,
        body:
          policy.decision === "deny"
            ? "This action is blocked in every approval mode and was not executed."
            : "This run is unattended, so no human can approve it. Choose an approach inside the policy, or re-run with --approval autonomous in a disposable workspace.",
      };
      actions.push({ turn: turns, action: action.action, path: action.path, ok: false, atMs: Date.now() - startedAt });
      status({ type: "tool", turn: turns, action: action.action, path: action.path, ok: false, detail: blocked.detail });
      noteToolResult(context, { action, result: blocked, turn: turns });
      message = composeMessage(action, blocked);
      newSession = false;
      continue;
    }

    // ---- checkpoint before a new edit burst (H6) ---------------------------
    if (POTENTIAL_MUTATIONS.has(action.action) && !burstCheckpointed) {
      recordCheckpoint(verification.state === "repair_needed" ? `before-repair-${verification.attempts + 1}` : "before-edits");
      burstCheckpointed = true;
    }

    // `authorize` applies the same approval policy to operations nested inside a
    // batch, so grouping actions is never a way around strict/balanced mode.
    const result = await executeAction(workspace, action, { mode, limits, authorize: reviewAction, executor });
    localOperations += action.action === "batch" && Array.isArray(action.operations) ? Math.max(1, action.operations.length) : 1;
    // The tool layer is the one mutation source. A write, a patch, a shell that
    // really changed files and a batch containing any of those all report it the
    // same way; an inspection command reports nothing.
    const mutated = result.mutated === true;
    if (mutated) {
      editVersion += 1;
      noteMutation(context, action, result);
      // The model should never need a `git diff` turn to learn what its own
      // change did; keep a compact current diff in the state packet.
      const diff = compactWorkspaceDiff(workspace, 400);
      // Replace, never keep a pre-edit diff: an untracked-only change has no
      // `git diff` text, and changed files carry that evidence instead.
      context.gitSummary = diff || null;
      invalidateOnEdit(verification);
    }
    actions.push({
      turn: turns,
      action: action.action,
      path: action.path,
      ok: Boolean(result.ok),
      mutated,
      atMs: Date.now() - startedAt,
    });
    status({
      type: "tool",
      turn: turns,
      action: action.action,
      path: action.path,
      ok: Boolean(result.ok),
      detail: result.detail || result.code,
    });
    noteToolResult(context, { action, result, turn: turns });

    // Completion intent: the model marked this action as the finished change.
    // Kodevra runs the configured verification locally now, so a passing change
    // does not spend another round trip on `verify` + `finish`. A failure comes
    // back as compact evidence in the same conversation.
    if (action.complete === true && result.ok) {
      const completed = await completeRun(action, { trigger: "complete", force: true });
      if (completed.done) return completed.result;
      newSession = false;
      continue;
    }

    // Repairs are coalesced. Verification runs on an explicit `verify`, on
    // `finish`, or when an action carries completion intent, so several patches
    // can land between two attempts; an inspection command or a partial fix
    // never burns a verification attempt.
    message = composeMessage(action, result);
    newSession = false;
  }

  return failure(
    "TURN_BUDGET_EXHAUSTED",
    `the task did not finish within ${limits.maxTurns} ChatGPT turn(s).`,
    "Narrow the task, or split it; raise the budget with --max-turns when a task genuinely needs more turns. The experiment refuses to keep prompting a browser tab indefinitely.",
    "harness",
  );
}
