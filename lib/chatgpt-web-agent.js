import {
  CORRECTION_MESSAGE,
  LIMITS,
  chatTurn,
  instruction,
  parseAction,
  toolResultMessage,
  webFailure,
} from "./chatgpt-web.js";
import { executeAction } from "./chatgpt-web-tools.js";
import { DEFAULT_TASK_CLASS, escalateTaskClass, resolveThinkingPlan } from "./thinking-policy.js";

/**
 * The Kodevra-owned tool loop for the ChatGPT-web experiment.
 *
 * chatgpt-bridge supplies only assistant text, so Kodevra asks for exactly one
 * JSON action per ChatGPT turn, executes it against the workspace, and feeds the
 * bounded result back into the SAME conversation. ChatGPT keeps the history;
 * Kodevra keeps the tools, the workspace boundary and the verification gate.
 *
 * No path leaves the workspace. Shell commands are bounded by time and output;
 * every turn is budgeted, so a run that cannot finish inside the limits fails
 * and says why.
 */

/** Actions whose success can change the workspace and invalidate a verification. */
const MUTATIONS = new Set(["write", "edit", "apply_patch", "shell"]);
const EDITS = new Set(["write", "edit", "apply_patch"]);

function tail(text, size = 4_000) {
  const value = `${text ?? ""}`;
  return value.length > size ? `[first ${value.length - size} characters omitted]\n${value.slice(-size)}` : value;
}

function verificationBody(result) {
  const lines = [`exit code: ${result.status ?? "unknown"}`, `result: ${result.ok ? "PASS" : "FAIL"}`];
  if (result.timedOut) lines.push("timed out: yes");
  if (result.refused) lines.push("authorization: refused - approval required");
  lines.push("", "output tail:", tail(result.output) || "(no output)");
  return lines.join("\n");
}

export async function runChatGptWebAgent({
  workspace,
  task,
  mode = "workspace-write",
  chat = chatTurn,
  verify = null,
  continueSession = false,
  sessionId = null,
  limits = LIMITS,
  onEvent = () => {},
}) {
  const startedAt = Date.now();
  const actions = [];
  const verifications = [];
  let turns = 0;
  let protocolRepairs = 0;
  let verifyRepairs = 0;
  let editVersion = 0;
  let lastVerification = null;
  let currentSession = continueSession ? sessionId : null;
  let newSession = !continueSession || !sessionId;
  let message = instruction({ workspace, task });
  let lastReply = "";
  // One effort per run, escalated on evidence only: a failed verification or a
  // protocol repair means the task turned out to be harder than it looked. The
  // class never drops back, because every change is one UI interaction in the
  // ChatGPT tab.
  let taskClass = DEFAULT_TASK_CLASS;

  const status = (event) => {
    try {
      onEvent(event);
    } catch {
      // status printing must never break the run
    }
  };

  const failure = (code, detail, action) => {
    status({ type: "error", code, detail });
    return {
      ok: false,
      code,
      failure: webFailure(code, detail, action),
      turns,
      actions,
      verifications,
      lastVerification: null,
      session: currentSession,
      transcript: lastReply,
      startedAt,
      endedAt: Date.now(),
      firstEditMs: null,
    };
  };

  status({ type: "waiting", turn: 1, session: currentSession, newSession });

  while (turns < limits.maxTurns) {
    turns += 1;
    let reply;
    try {
      reply = await chat({
        message,
        sessionId: currentSession,
        newSession,
        effort: resolveThinkingPlan({ taskClass }).effort,
      });
    } catch (error) {
      return failure(
        error.code || "BRIDGE_ERROR",
        error.message,
        error.hint || "Check the bridge and the ChatGPT tab, then retry.",
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

    if (action.action === "finish") {
      status({ type: "finish", turn: turns, summary: action.summary });
      const reusable = lastVerification && lastVerification.editVersion === editVersion ? lastVerification : null;
      return {
        ok: true,
        code: null,
        failure: null,
        summary: action.summary,
        turns,
        actions,
        verifications,
        lastVerification: reusable,
        session: currentSession,
        transcript: lastReply,
        startedAt,
        endedAt: Date.now(),
        firstEditMs: actions.find((entry) => EDITS.has(entry.action))?.atMs ?? null,
      };
    }

    if (action.action === "verify") {
      if (!verify) {
        const result = {
          ok: false,
          detail: "Kodevra was started without --verify",
          body: "No verification command was supplied to Kodevra for this run. Keep editing, or finish and report that no verification ran.",
        };
        actions.push({ turn: turns, action: "verify", ok: false, atMs: Date.now() - startedAt });
        status({ type: "tool", turn: turns, action: "verify", ok: false, detail: result.detail });
        message = toolResultMessage({ action, ...result });
        newSession = false;
        continue;
      }
      status({ type: "verify", turn: turns });
      const result = await verify();
      const record = { ...result, editVersion };
      lastVerification = record;
      verifications.push(record);
      actions.push({ turn: turns, action: "verify", ok: Boolean(result.ok), atMs: Date.now() - startedAt });
      status({ type: "verify_result", ok: Boolean(result.ok), status: result.status, refused: Boolean(result.refused) });
      message = toolResultMessage({
        action,
        ok: Boolean(result.ok),
        detail: result.refused
          ? "verification refused: the agent changed verification files"
          : `exit ${result.status ?? "?"}`,
        body: verificationBody(result),
      });
      newSession = false;
      if (!result.ok && !result.refused) {
        verifyRepairs += 1;
        taskClass = escalateTaskClass(taskClass);
        if (verifyRepairs > limits.maxVerifyRepairs) {
          return failure(
            "VERIFICATION_BUDGET",
            `verification still failed after ${limits.maxVerifyRepairs} repair attempt(s).`,
            "Read the failing output yourself; the experiment stops rather than burning more ChatGPT turns.",
          );
        }
      }
      continue;
    }

    const result = await executeAction(workspace, action, { mode, limits });
    const edited = result.ok && MUTATIONS.has(action.action);
    if (edited) editVersion += 1;
    actions.push({
      turn: turns,
      action: action.action,
      path: action.path,
      ok: Boolean(result.ok),
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
    message = toolResultMessage({
      action,
      ok: Boolean(result.ok),
      detail: result.ok ? result.detail : `${result.code}: ${result.detail}`,
      body: result.body,
    });
    newSession = false;
  }

  return failure(
    "TURN_BUDGET_EXHAUSTED",
    `the task did not finish within ${limits.maxTurns} ChatGPT turn(s).`,
    "Narrow the task, or split it; raise the budget with --max-turns when a task genuinely needs more turns. The experiment refuses to keep prompting a browser tab indefinitely.",
  );
}
