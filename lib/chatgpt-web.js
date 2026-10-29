import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactText } from "./redact.js";

/**
 * EXPERIMENTAL: the ordinary ChatGPT chat product as Kodevra's model.
 *
 * This is not a provider in the accepted sense. chatgpt-bridge drives the real
 * ChatGPT web UI in the developer's own logged-in Chrome profile and exposes a
 * localhost OpenAI-shaped endpoint. It forwards only the last user message and
 * returns plain assistant text - no native tool calls, no system prompt, no
 * history replay. Kodevra therefore owns the tool loop through a small textual
 * action protocol (see lib/chatgpt-web-agent.js).
 *
 * What lives here: the bridge transport, the protocol prompt, the strict action
 * parser and the per-workspace conversation mapping. Kodevra never sees, asks
 * for or stores a ChatGPT cookie, session token or password: authentication is
 * whatever Chrome already has, and the only secret in play is the bridge's own
 * loopback API token, supplied through the environment for one run.
 */

export const CHATGPT_WEB_PROVIDER = "chatgpt-web";
export const CHATGPT_WEB_MODEL = "chatgpt";
export const CHATGPT_WEB_LABEL = "ChatGPT Web (experimental)";
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8080/v1";

/**
 * The durable transport, not a longer timeout, is what makes a slow ChatGPT turn
 * safe.
 *
 * A single HTTP request may not outlive the client's transport defaults: Node's
 * fetch (Undici) closes a silent connection after ~300s whatever AbortSignal
 * says, so a 316s answer was reported as "fetch failed" even though the bridge
 * produced it. Raising turnTimeoutMs never fixed that, because the limit sat
 * below the request, in the socket.
 *
 * Kodevra therefore submits a turn and polls for its state. The long duration
 * belongs to the bridge's persisted request; each HTTP operation here is short,
 * so no transport deadline can truncate model reasoning again.
 */
export const DURABLE = Object.freeze({
  submitTimeoutMs: 20_000,
  statusTimeoutMs: 15_000,
  pollIntervalMs: 2_500,
  // Progress is reported on a state change, and otherwise at this cadence: a
  // long turn must not print a line per poll.
  progressEveryMs: 60_000,
  submitAttempts: 3,
  // Consecutive failed status requests before the bridge itself is the problem.
  maxPollFailures: 5,
});

/**
 * The optional live display channel.
 *
 * Deltas are shown in the terminal while the durable turn runs. Nothing here is
 * required for correctness: if the stream is old, missing, or drops, the durable
 * status poll above still delivers the complete answer, and only that answer is
 * ever parsed into an action.
 */
export const LIVE = Object.freeze({
  reconnectDelayMs: 750,
  maxReconnects: 4,
});

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TRANSPORT_DEADLINE_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** Hard limits. The experiment must not spend dozens of ChatGPT messages. */
export const LIMITS = {
  maxTurns: 8,
  // A run may ask for a larger budget (`--max-turns`), but the tab is the scarce
  // resource: the ceiling keeps even a complex task a finite browser loop.
  maxTurnCeiling: 40,
  maxProtocolRepairs: 1,
  maxVerifyRepairs: 2,
  readBytes: 24_000,
  // A read is a bounded range of lines. `readChars` is what one read may put
  // in front of the model, so a range never gets silently re-clipped later.
  readLines: 400,
  readChars: 6_000,
  searchResults: 40,
  searchFileBytes: 512_000,
  listEntries: 200,
  resultChars: 12_000,
  turnTimeoutMs: 3_600_000,
  // H1: one bounded developer command per shell action.
  shellTimeoutMs: 120_000,
  shellTimeoutMaxMs: 300_000,
  shellOutputChars: 4_000,
  // H1: one patch may carry several files and hunks, but not an endless diff.
  patchBytes: 200_000,
  patchFiles: 20,
  patchFileBytes: 1_000_000,
  // H2: inspect is bounded by the walk, the scan and the rendered view.
  inspectFiles: 2_000,
  inspectScanFiles: 400,
  inspectScanBytes: 200_000,
  inspectFocusFiles: 12,
  inspectSymbols: 60,
  inspectChars: 6_000,
  // Round-trip optimisation: the deterministic bootstrap is gathered locally and
  // sent once with the first message, so it gets its own tighter bound.
  bootstrapChars: 4_000,
  // H3: a batch is a handful of ordered, non-mutating operations.
  batchOperations: 12,
  batchOpChars: 3_000,
  batchChars: 10_000,
  // H4: failure evidence sent back to the model is compact and relevant.
  verificationEvidenceChars: 3_500,
  // H5: working-context bounds for what Kodevra sends and keeps.
  contextStateChars: 1_000,
  contextReadChars: 6_000,
  contextListEntries: 40,
  contextSearchLines: 25,
  contextInspectChars: 3_000,
  contextShellChars: 3_000,
  contextBatchChars: 6_000,
  contextDiagnostics: 60,
  contextDedupeEntries: 100,
  // H6: lightweight metadata checkpoints, bounded per run.
  checkpointMax: 8,
  checkpointFiles: 50,
  checkpointDiffChars: 1_500,
  // H7: subagents are finite, isolated, sequential helpers.
  subagentInvocations: 4,
  subagentPerRole: 2,
  subagentTurns: 4,
  subagentConcurrency: 1,
  subagentContextChars: 4_000,
  subagentResultChars: 2_000,
  subagentEvidenceChars: 1_500,
  subagentDiffChars: 2_000,
  subagentTimeoutMs: 180_000,
};

export const SUBAGENT_ROLES = Object.freeze(["explorer", "reviewer", "failure_diagnoser"]);

/** Mutating actions may carry completion intent: verify locally, then finish. */
export const COMPLETION_ACTIONS = Object.freeze(["write", "edit", "apply_patch", "shell", "batch"]);

export const ACTIONS = [
  "read",
  "search",
  "list",
  "inspect",
  "shell",
  "write",
  "edit",
  "apply_patch",
  "batch",
  "subagent",
  "verify",
  "finish",
];

/**
 * The bridge address and its loopback token. The token protects the local HTTP
 * surface; it is not an OpenAI credential and is never written by Kodevra.
 */
export function bridgeSettings(env = process.env) {
  const raw = `${env.KODEVRA_CHATGPT_BRIDGE_URL || DEFAULT_BRIDGE_URL}`.trim();
  let baseURL = raw.replace(/\/+$/, "");
  if (!/\/v1$/.test(baseURL)) baseURL = `${baseURL}/v1`;
  return { baseURL, token: env.KODEVRA_CHATGPT_BRIDGE_TOKEN || "" };
}

/** The provider row the launcher prints. No engine catalog is involved. */
export function chatGptWebAssessment() {
  return {
    key: CHATGPT_WEB_PROVIDER,
    label: CHATGPT_WEB_LABEL,
    kind: "browser",
    engineId: CHATGPT_WEB_PROVIDER,
    configured: true,
    available: true,
    credentialed: true,
    credential: {
      ok: true,
      kind: "browser",
      source: "existing Chrome ChatGPT session",
      envNames: [],
    },
    plan: null,
    planSource: "chatgpt-bridge",
    models: [CHATGPT_WEB_MODEL],
    defaultModel: CHATGPT_WEB_MODEL,
    ready: true,
    state: "bridge",
    detail: "localhost chatgpt-bridge",
    hint: "",
  };
}

function bridgeError(message, code, hint = "", details = null) {
  const error = new Error(message);
  error.code = code;
  error.hint = hint;
  if (details) error.details = details;
  return error;
}

/**
 * Which failure is this, really?
 *
 * A closed loopback port and a model that has not answered yet used to share one
 * code. They need different fixes, so they get different codes: connection
 * failures are BRIDGE_UNAVAILABLE, transport deadlines are MODEL_RESPONSE_TIMEOUT.
 */
/**
 * Was this failure ambiguous, or a definite "nothing is listening"?
 *
 * A refused connection means no submit happened, so retrying is pointless. A
 * reset, hang-up or short timeout may have happened AFTER the bridge accepted the
 * turn, so the only safe retry is one that reuses the same idempotency key.
 */
export function isAmbiguousTransportFailure(error) {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code]
    .filter(Boolean)
    .map((value) => String(value));
  const definite = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
  if (codes.some((code) => definite.has(code))) return false;
  const ambiguous = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
  if (codes.some((code) => ambiguous.has(code))) return true;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return true;
  return /socket hang up|other side closed|ECONNRESET|premature close/i.test(`${error?.message ?? ""} ${error?.cause?.message ?? ""}`);
}

export function classifyTransportFailure(error) {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code]
    .filter(Boolean)
    .map((value) => String(value));
  const message = `${error?.message ?? ""} ${error?.cause?.message ?? ""}`;
  if (codes.some((code) => TRANSPORT_DEADLINE_CODES.has(code))) return "MODEL_RESPONSE_TIMEOUT";
  if (codes.some((code) => CONNECTION_ERROR_CODES.has(code))) return "BRIDGE_UNAVAILABLE";
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "MODEL_RESPONSE_TIMEOUT";
  if (/ECONNREFUSED|ECONNRESET|socket hang up|connect ECONN|fetch failed/i.test(message)) return "BRIDGE_UNAVAILABLE";
  return "BRIDGE_UNAVAILABLE";
}

/** One short HTTP operation. Never used to wait for model reasoning. */
async function bridgeFetch(url, { token, method = "GET", body = null, timeoutMs, fetchImpl = fetch } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  return await fetchImpl(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * A single request to the bridge with a short deadline.
 *
 * `stage` decides how a deadline reads: a health probe that times out means the
 * bridge is unresponsive, while a completion deadline means the model ran out of
 * configured time. Neither is a "bridge unavailable" by accident.
 */
async function bridgeRequest(
  url,
  { token, method = "GET", body = null, timeoutMs = 5_000, fetchImpl = fetch, stage = "health" } = {},
) {
  try {
    return await bridgeFetch(url, { token, method, body, timeoutMs, fetchImpl });
  } catch (error) {
    const cause = error?.cause?.message ? `${error.message}: ${error.cause.message}` : `${error?.message || error}`;
    const transport = classifyTransportFailure(error);
    const code = stage === "health" ? "BRIDGE_UNAVAILABLE" : transport;
    throw bridgeError(
      stage === "health"
        ? `chatgpt-bridge is not reachable at ${url} (${cause}).`
        : `chatgpt-bridge did not answer ${url} within ${Math.round(timeoutMs / 1000)}s (${cause}).`,
      code,
      code === "MODEL_RESPONSE_TIMEOUT"
        ? "The configured model deadline is the limit, not the socket: raise it with --timeout <seconds> or check whether the bridge is still working on the turn."
        : "Start it in its own checkout: npm start (binds 127.0.0.1:8080), connect the Chrome extension to a logged-in ChatGPT tab, then retry.",
      { transport, stage },
    );
  }
}

/** The bridge's origin, without the OpenAI-compatible `/v1` suffix. */
export function bridgeOrigin(baseURL) {
  return `${baseURL}`.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Throttled, stage-aware progress for one turn.
 *
 * The terminal needs to know something is happening during an eight minute
 * answer, without a line per poll. A state change always prints; the same state
 * prints again only after `everyMs`.
 */
export function createProgressReporter({ onProgress = () => {}, everyMs = DURABLE.progressEveryMs, now = () => Date.now() } = {}) {
  // One-shot stages always print. A stage that can persist (recovering, waiting)
  // prints when it starts and then at the cadence, never per poll.
  const forced = new Set(["submitted", "received"]);
  let lastStage = "";
  let lastAt = 0;
  let count = 0;
  return {
    report(stage, extra = {}) {
      const at = now();
      if (!forced.has(stage) && stage === lastStage && at - lastAt < everyMs) return null;
      lastStage = stage;
      lastAt = at;
      count += 1;
      const event = { stage, at, elapsedMs: Number(extra.elapsedMs) || 0, ...extra };
      try {
        onProgress(event);
      } catch {
        // Progress output must never break a turn.
      }
      return event;
    },
    get count() {
      return count;
    },
    get stage() {
      return lastStage;
    },
  };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", done);
      resolve();
    }
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

/**
 * Follow the bridge's display-only response stream for one request.
 *
 * It is deliberately one-way and best-effort: every failure ends the display, not
 * the turn. A reconnect resumes from the last sequence number seen here, so an
 * already-rendered response is not replayed into the terminal.
 */
export async function followLiveResponse({
  origin,
  token = "",
  requestId,
  onEvent = () => {},
  signal = null,
  fetchImpl = fetch,
  reconnectDelayMs = LIVE.reconnectDelayMs,
  maxReconnects = LIVE.maxReconnects,
}) {
  if (!requestId) return;
  let seq = 0;
  for (let attempt = 0; attempt <= maxReconnects; attempt += 1) {
    if (signal?.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener?.("abort", abort, { once: true });
    try {
      const response = await fetchImpl(`${origin}/kodevra/requests/${encodeURIComponent(requestId)}/events?after=${seq}`, {
        method: "GET",
        headers: { accept: "text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: controller.signal,
      });
      // An older bridge has no live endpoint at all: stop quietly and let the
      // durable transport carry the turn, rather than retrying a missing route.
      if (response.status === 404 || response.status === 503) return;
      if (!response.ok || !response.body) throw new Error(`live stream answered ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            let event = null;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              event = null;
            }
            if (!event || typeof event !== "object") continue;
            const eventSeq = Number(event.seq) || 0;
            if (eventSeq && eventSeq <= seq) continue;
            if (eventSeq) seq = eventSeq;
            if (event.type === "response.completed") return;
            try {
              onEvent(event);
            } catch {
              // Rendering must never break the transport.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // A dropped stream is a display interruption, not a failed turn.
    } finally {
      signal?.removeEventListener?.("abort", abort);
    }
    if (signal?.aborted) return;
    await abortableSleep(reconnectDelayMs * (attempt + 1), signal);
  }
}

function durableDeadlineError({ requestId, timeoutMs, last, elapsedMs }) {
  const state = last?.status ? `last status: ${last.status}` : "no status was ever read";
  const phase = last?.phase ? `, phase ${last.phase}` : "";
  return bridgeError(
    `ChatGPT turn ${requestId} did not finish within the configured ${Math.round(timeoutMs / 1000)}s deadline (${state}${phase}, ${Math.round(elapsedMs / 1000)}s elapsed).`,
    "MODEL_RESPONSE_TIMEOUT",
    "Raise the per-turn deadline with --timeout <seconds>. The bridge still owns the request and will not be resubmitted blindly.",
    { requestId, status: last?.status ?? null, phase: last?.phase ?? null, elapsedMs, deadlinems: timeoutMs },
  );
}

function durableTerminalError({ status: view, requestId, elapsedMs }) {
  const evidence = `${view?.error?.message || "the bridge reported a terminal failure"} (request ${requestId}, ${Math.round(elapsedMs / 1000)}s)`;
  const bridgeCode = String(view?.error?.code || "");
  const details = { requestId, status: view?.status ?? null, bridgeCode: bridgeCode || null, elapsedMs };
  if (bridgeCode === "MODEL_RECOVERY_FAILED" || bridgeCode === "BRIDGE_RESTART_UNRECOVERABLE") {
    return bridgeError(
      `${evidence}.`,
      "MODEL_RECOVERY_FAILED",
      "The turn could not be recovered safely. Start the task again; Kodevra does not resubmit a canonical prompt that may already be in the tab.",
      details,
    );
  }
  if (bridgeCode === "MODEL_RESPONSE_TIMEOUT") {
    return bridgeError(`${evidence}.`, "MODEL_RESPONSE_TIMEOUT", "Raise --timeout <seconds> if the turn legitimately needs longer.", details);
  }
  if (view?.status === "cancelled" || bridgeCode === "REQUEST_CANCELLED") {
    return bridgeError(`${evidence}.`, "MODEL_REQUEST_CANCELLED", "Nothing was resubmitted; run the task again when ready.", details);
  }
  return bridgeError(
    `${evidence}.`,
    "MODEL_REQUEST_FAILED",
    "Check the bridge terminal and the ChatGPT tab; the run stopped instead of retrying blindly.",
    details,
  );
}

/**
 * One readiness probe. A 401 means the bridge is up but KODEVRA_CHATGPT_BRIDGE_TOKEN
 * is missing or wrong, which is a different fix from "no browser tab connected".
 */
export async function probeBridge({ baseURL, token, timeoutMs = 5_000, fetchImpl = fetch } = bridgeSettings()) {
  const origin = baseURL.replace(/\/v1$/, "");
  let response;
  try {
    response = await bridgeRequest(`${origin}/health`, { token, timeoutMs, fetchImpl });
  } catch (error) {
    return { ok: false, code: error.code, detail: error.message, hint: error.hint };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "BRIDGE_UNAUTHORIZED",
      detail: `bridge answered ${response.status} - set KODEVRA_CHATGPT_BRIDGE_TOKEN to the API_TOKEN from the bridge's .env`,
      hint: "The token lives in the bridge's data directory (.bridge-data/.env); export it for this run only.",
    };
  }
  let health = null;
  try {
    health = await response.json();
  } catch {
    health = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      code: "BRIDGE_ERROR",
      detail: `bridge /health answered ${response.status}`,
      hint: "Check the bridge's own terminal output.",
    };
  }
  const clients = Number(health?.clients ?? 0);
  const ready = health?.ok !== false && clients > 0;
  return {
    ok: ready,
    code: ready ? null : "BRIDGE_NO_BROWSER",
    detail: ready
      ? `${origin} · ${clients} browser client(s) connected`
      : `${origin} · ${health?.error || "no browser extension client connected"}`,
    hint: ready
      ? ""
      : "Open ChatGPT in the Chrome profile with the bridge extension enabled and keep that tab loaded.",
    health,
  };
}

/**
 * One conversation turn through the bridge.
 *
 * Only the last user message reaches ChatGPT - the bridge drops system and
 * history - so the caller must send the whole instruction or tool result each
 * time. `newSession` starts a fresh conversation; `sessionId` continues the one
 * the bridge reported for this workspace.
 */
export async function chatTurn({
  message,
  sessionId = null,
  newSession = false,
  model = CHATGPT_WEB_MODEL,
  effort = null,
  timeoutMs = LIMITS.turnTimeoutMs,
  idempotencyKey = null,
  onProgress = () => {},
  // Optional display-only subscription; null keeps the transport untouched.
  onLiveEvent = null,
  progressEveryMs = DURABLE.progressEveryMs,
  pollIntervalMs = DURABLE.pollIntervalMs,
  statusTimeoutMs = DURABLE.statusTimeoutMs,
  submitTimeoutMs = DURABLE.submitTimeoutMs,
  durable = true,
  settings = bridgeSettings(),
  fetchImpl = fetch,
}) {
  const body = {
    model,
    stream: false,
    messages: [{ role: "user", content: message }],
  };
  // Sent only when the run has a policy decision. The extension treats an
  // unchanged effort as a cache hit, so repeating the same value per turn is
  // free; asking for a new one costs one UI change.
  const thinkingEffort = String(effort || "").trim();
  if (thinkingEffort) body.effort = thinkingEffort;
  if (newSession) body.newSession = true;
  else if (sessionId) body.sessionId = sessionId;

  // One logical turn, one key. A caller that knows its turn id (the agent loop
  // does) passes it, so a retry after an ambiguous submit reattaches to the same
  // bridge request instead of asking ChatGPT twice.
  const turnKey = `${idempotencyKey || `${newSession ? "new" : sessionId || "new"}:${randomUUID()}`}`;
  const startedAt = Date.now();
  const reporter = createProgressReporter({ onProgress, everyMs: progressEveryMs });

  if (!durable) {
    return await chatTurnSync({ body, model, timeoutMs, settings, fetchImpl });
  }
  try {
    return await durableChatTurn({
      body,
      turnKey,
      model,
      timeoutMs,
      settings,
      fetchImpl,
      reporter,
      startedAt,
      pollIntervalMs,
      statusTimeoutMs,
      submitTimeoutMs,
      onLiveEvent,
    });
  } catch (error) {
    if (!error?.unsupported) throw error;
    // An older bridge has no durable endpoint. The synchronous contract still
    // works, but it is the contract that cannot outlive the socket deadline, so
    // the caller is told which path it is on.
    reporter.report("legacy", { elapsedMs: Date.now() - startedAt, detail: error.message });
    return await chatTurnSync({ body, model, timeoutMs, settings, fetchImpl });
  }
}

/** Submit now, poll later. No HTTP request outlives a short operation. */
async function durableChatTurn({
  body,
  turnKey,
  model,
  timeoutMs,
  settings,
  fetchImpl,
  reporter,
  startedAt,
  pollIntervalMs,
  statusTimeoutMs,
  submitTimeoutMs,
  onLiveEvent = null,
}) {
  const origin = bridgeOrigin(settings.baseURL);
  const deadlineAt = startedAt + timeoutMs;
  const submitPayload = { ...body, idempotency_key: turnKey, deadline_ms: timeoutMs, dedicatedTab: true };

  let accepted = null;
  let lastSubmitError = null;
  for (let attempt = 1; attempt <= DURABLE.submitAttempts; attempt += 1) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw durableDeadlineError({ requestId: "(not accepted)", timeoutMs, last: null, elapsedMs: Date.now() - startedAt });
    }
    try {
      const response = await bridgeFetch(`${origin}/kodevra/requests`, {
        token: settings.token,
        method: "POST",
        body: submitPayload,
        timeoutMs: Math.min(submitTimeoutMs, Math.max(500, remaining)),
        fetchImpl,
      });
      const raw = await response.text();
      if (response.status === 404 || response.status === 405) {
        const unsupported = bridgeError(
          "chatgpt-bridge does not expose the durable turn endpoint (/kodevra/requests).",
          "BRIDGE_DURABLE_UNSUPPORTED",
          "Restart the bridge from its current checkout. Until then Kodevra falls back to the synchronous /v1 path, whose duration is capped by the HTTP transport.",
        );
        unsupported.unsupported = true;
        throw unsupported;
      }
      if (!response.ok) {
        const unauthorized = response.status === 401 || response.status === 403;
        throw bridgeError(
          `chatgpt-bridge refused the turn submission (${response.status}): ${redactText(raw).slice(0, 400)}`,
          unauthorized ? "BRIDGE_UNAUTHORIZED" : "BRIDGE_ERROR",
          unauthorized
            ? "Set KODEVRA_CHATGPT_BRIDGE_TOKEN from the bridge's .env, then retry."
            : "Check the bridge terminal; the turn was not silently retried.",
          { status: response.status, requestId: null },
        );
      }
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (!payload?.request_id) {
        // A 2xx without a request id cannot be a durable acceptance, so this
        // bridge is not speaking the protocol (an older build, or a proxy that
        // answers the OpenAI shape for any POST). Fall back rather than guess.
        const unsupported = bridgeError(
          "chatgpt-bridge answered the durable submit without a request id.",
          "BRIDGE_DURABLE_UNSUPPORTED",
          "Restart the bridge from its current checkout. Until then Kodevra falls back to the synchronous /v1 path.",
        );
        unsupported.unsupported = true;
        throw unsupported;
      }
      accepted = payload;
      break;
    } catch (error) {
      if (error?.unsupported) throw error;
      if (error?.code && error.code !== "BRIDGE_ERROR") throw error;
      if (!error?.code) {
        const transport = classifyTransportFailure(error);
        if (!isAmbiguousTransportFailure(error)) {
          throw bridgeError(
            `chatgpt-bridge is not reachable at ${origin} (${error?.cause?.message || error?.message || error}).`,
            "BRIDGE_UNAVAILABLE",
            "Start it in its own checkout: npm start (binds 127.0.0.1:8080), connect the Chrome extension to a logged-in ChatGPT tab, then retry.",
            { transport, requestId: null },
          );
        }
      }
      // Ambiguous: the bridge may already have created the request, so this retry
      // reuses the same idempotency key and therefore the same logical turn.
      lastSubmitError = error;
      if (attempt < DURABLE.submitAttempts) await sleep(Math.min(500 * attempt, 2_000));
    }
  }
  if (!accepted) {
    throw bridgeError(
      `chatgpt-bridge did not accept the turn after ${DURABLE.submitAttempts} attempt(s) (${lastSubmitError?.message || "no answer"}).`,
      "BRIDGE_UNAVAILABLE",
      "Check the bridge terminal. The retries reused one idempotency key, so no model turn was duplicated.",
      { requestId: null, idempotencyKey: turnKey },
    );
  }

  const requestId = `${accepted.request_id}`;
  reporter.report("submitted", { requestId, elapsedMs: Date.now() - startedAt, status: accepted.status || "submitted" });
  const statusUrl = `${origin}/kodevra/requests/${encodeURIComponent(requestId)}`;
  let view = accepted;
  let pollFailures = 0;

  // Start the optional display stream after acceptance, so it is scoped to this
  // exact request id. It is aborted when the durable turn settles either way.
  const liveController = new AbortController();
  if (typeof onLiveEvent === "function") {
    void followLiveResponse({
      origin,
      token: settings.token,
      requestId,
      onEvent: onLiveEvent,
      signal: liveController.signal,
      fetchImpl,
    }).catch(() => {});
  }

  try {
    for (;;) {
      const now = Date.now();
      if (now >= deadlineAt) {
        throw durableDeadlineError({ requestId, timeoutMs, last: view, elapsedMs: now - startedAt });
      }
      await sleep(Math.min(pollIntervalMs, Math.max(50, deadlineAt - now)));

      let next = null;
      try {
        const response = await bridgeFetch(statusUrl, {
          token: settings.token,
          method: "GET",
          timeoutMs: Math.min(statusTimeoutMs, Math.max(500, deadlineAt - Date.now())),
          fetchImpl,
        });
        const raw = await response.text();
        if (response.status === 404) {
          throw bridgeError(
            `chatgpt-bridge has no record of turn ${requestId} any more.`,
            "MODEL_RECOVERY_FAILED",
            "The request state was lost; it is not resubmitted blindly. Start the task again.",
            { requestId, status: null },
          );
        }
        if (!response.ok) {
          throw new Error(`status request answered ${response.status}: ${redactText(raw).slice(0, 200)}`);
        }
        next = JSON.parse(raw);
        pollFailures = 0;
      } catch (error) {
        if (error?.code === "MODEL_RECOVERY_FAILED") throw error;
        // A failed status poll is not a failed turn: the bridge still owns the
        // request. Only a bridge that stops answering altogether is unavailable.
        pollFailures += 1;
        if (pollFailures >= DURABLE.maxPollFailures) {
          throw bridgeError(
            `chatgpt-bridge stopped answering status requests for turn ${requestId} (${pollFailures} consecutive failures, ${error?.message || error}).`,
            "BRIDGE_UNAVAILABLE",
            "The turn may still be running in the bridge; check its terminal and do not start the task twice.",
            { requestId, status: view?.status ?? null, elapsedMs: Date.now() - startedAt },
          );
        }
        continue;
      }

      view = next;
      const elapsedMs = Date.now() - startedAt;

      if (view?.status === "completed") {
        reporter.report("received", { requestId, elapsedMs, status: "completed" });
        const response = view.response || {};
        const text = `${response.answer ?? ""}`;
        if (!text.trim()) {
          throw bridgeError(
            `ChatGPT returned an empty message for turn ${requestId}.`,
            "BRIDGE_EMPTY_REPLY",
            "Confirm the ChatGPT tab is signed in and not showing a captcha or error banner, then retry.",
            { requestId },
          );
        }
        return {
          text,
          session: response.session ?? null,
          url: response.url ?? null,
          model: response.model ?? model,
        };
      }

      if (view?.status === "failed" || view?.status === "cancelled") {
        throw durableTerminalError({ status: view, requestId, elapsedMs });
      }

      reporter.report(view?.status === "recovering" ? "recovering" : "waiting", {
        requestId,
        elapsedMs,
        status: view?.status || "waiting_for_model",
        phase: view?.phase || "",
      });
    }
  } finally {
    liveController.abort();
  }
}

/**
 * The synchronous OpenAI-compatible path.
 *
 * Kept for an older bridge. It is one long request, so its duration is bounded by
 * the transport (Undici headers/body timeouts) as well as the AbortSignal; the
 * durable path above exists so correctness no longer depends on either.
 */
async function chatTurnSync({ body, model, timeoutMs, settings, fetchImpl }) {
  const response = await bridgeRequest(`${settings.baseURL}/chat/completions`, {
    token: settings.token,
    method: "POST",
    body,
    timeoutMs,
    fetchImpl,
    stage: "completion",
  });
  const raw = await response.text();
  if (!response.ok) {
    throw bridgeError(
      `chatgpt-bridge refused the request (${response.status}): ${redactText(raw).slice(0, 400)}`,
      response.status === 401 || response.status === 403 ? "BRIDGE_UNAUTHORIZED" : "BRIDGE_ERROR",
      response.status === 401 || response.status === 403
        ? "Set KODEVRA_CHATGPT_BRIDGE_TOKEN from the bridge's .env, then retry."
        : "Check the bridge and the ChatGPT tab; the run stopped instead of retrying blindly.",
    );
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw bridgeError("chatgpt-bridge returned a non-JSON answer.", "BRIDGE_ERROR", "Check the bridge output.");
  }
  const text = payload?.choices?.[0]?.message?.content ?? "";
  if (!`${text}`.trim()) {
    throw bridgeError(
      "ChatGPT returned an empty message.",
      "BRIDGE_EMPTY_REPLY",
      "Confirm the ChatGPT tab is signed in and not showing a captcha or error banner, then retry.",
    );
  }
  return {
    text: `${text}`,
    session: payload?.chatgpt?.session ?? null,
    url: payload?.chatgpt?.url ?? null,
    model: payload?.chatgpt?.model ?? model,
  };
}

/** The instruction sent as the first message of every fresh conversation. */
export function instruction({ workspace, task, verifyCommand = null }) {
  return `You are Kodevra's autonomous coding agent.
Return exactly ONE JSON action per turn.

Actions: read, search, list, inspect, shell, write, edit, apply_patch, batch, subagent, verify, finish

Turn economy (one browser turn per action, so group the work):
- For 2+ related file changes, strongly prefer ONE multi-file apply_patch. Do not use sequential write actions when one apply_patch can express the change; write is mainly for isolated single-file creation.
- Use batch for related read/search/list/inspect operations instead of one action per file.
- A ready final implementation patch should carry "complete": true.

Strategy:
- BOOTSTRAP CONTEXT is already gathered locally. Verify it, then gather related evidence in one batch.
- read supports "offset" (1-based line) and "limit" (1-400), or "startLine"/"endLine"; continue at the reported next offset.
- apply_patch takes one unified diff: ---/+++ headers and @@ hunks, several files per patch; a new file is --- /dev/null.
- "complete": true on a change makes Kodevra apply it, run the configured verification locally, and return PASS or compact failure evidence. Do not spend a separate verify/finish turn after it.
- verify is for early evidence only; it does not finish the run.
- shell runs one bounded project command through the run's executor, inside the workspace.
- Use subagents only when understanding or diagnosis genuinely needs them; most tasks need none.
- Never fabricate tool results. VERIFIED requires a real passing verification.
- After a PASS Kodevra finishes automatically; use finish only when no change is pending or no verification is configured.

Schema examples:
{"action":"batch","operations":[{"action":"read","path":"src/tasks.js"},{"action":"search","query":"formatDate"}]}
{"action":"apply_patch","complete":true,"patch":"--- a/src/tasks.js\\n+++ b/src/tasks.js\\n@@ -1,2 +1,2 @@\\n-old line\\n+new line\\n--- /dev/null\\n+++ b/src/TaskModal.jsx\\n@@ -0,0 +1,1 @@\\n+export default function TaskModal() {}\\n"}

CONFIGURED VERIFICATION:
${verifyCommand || "none - finish when done"}

WORKSPACE:
${workspace}

TASK:
${task}`;
}

export const CORRECTION_MESSAGE =
  "Your previous response did not follow the action protocol. Return exactly one valid JSON action and nothing else.";

/** A bounded tool result, as one user message in the same conversation. */
export function toolResultMessage({ action, ok, detail = "", body = "" }) {
  const parts = ["KODEVRA TOOL RESULT", "", `action: ${action.action}`, `status: ${ok ? "success" : "error"}`];
  if (action.path) parts.push(`path: ${action.path}`);
  if (action.query) parts.push(`query: ${action.query}`);
  if (action.command) parts.push(`command: ${action.command}`);
  if (action.focus) parts.push(`focus: ${action.focus}`);
  if (detail) parts.push(`detail: ${detail}`);
  parts.push("");
  const text = `${body ?? ""}`.trim();
  if (text) {
    parts.push(text.length > LIMITS.resultChars ? `${text.slice(0, LIMITS.resultChars)}\n[truncated]` : text);
    parts.push("");
  }
  parts.push("Continue the task.");
  parts.push("Return exactly one JSON action.");
  return parts.join("\n");
}

/**
 * The first balanced `{...}` in the text, ignoring braces inside strings.
 * Null when there is no complete object.
 */
export function extractFirstJsonObject(text) {
  const source = `${text ?? ""}`;
  const start = source.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      // Skip the whole string literal so an escaped quote or brace cannot end
      // the object early.
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === '"') break;
        else index += 1;
      }
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function actionError(reason) {
  return { ok: false, reason };
}

/**
 * Strict action parsing.
 *
 * Exactly one JSON object is expected. Surrounding prose gets ONE local
 * extraction attempt; nothing is repaired beyond that, and the caller may send a
 * single correction message. Anything ambiguous is rejected instead of guessed.
 */
export function parseAction(text) {
  const source = `${text ?? ""}`.trim();
  if (!source) return actionError("empty response");

  let candidate = null;
  try {
    candidate = JSON.parse(source);
  } catch {
    const extracted = extractFirstJsonObject(source);
    if (!extracted) return actionError("no JSON object found");
    try {
      candidate = JSON.parse(extracted);
    } catch {
      return actionError("the JSON object is not valid JSON");
    }
  }

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return actionError("the response is not a JSON object");
  }
  const name = `${candidate.action ?? ""}`.trim().toLowerCase();
  if (!ACTIONS.includes(name)) {
    return actionError(
      `unknown action "${candidate.action ?? ""}" (allowed: ${ACTIONS.join(", ")})`,
    );
  }

  const stringField = (field, { required = true, allowEmpty = false } = {}) => {
    const value = candidate[field];
    if (value === undefined || value === null) {
      if (required) return actionError(`"${field}" is required for ${name}`);
      return { value: undefined };
    }
    if (typeof value !== "string") return actionError(`"${field}" must be a string for ${name}`);
    if (!allowEmpty && !value.trim()) return actionError(`"${field}" must not be empty for ${name}`);
    return { value };
  };

  if (name === "read" || name === "edit" || name === "write") {
    const field = stringField("path");
    if (field.reason) return field;
    candidate.path = field.value;
  }
  if (name === "read") {
    if (candidate.startLine !== undefined && candidate.startLine !== null) {
      if (candidate.offset !== undefined && candidate.offset !== null) {
        return actionError('use either "offset" or "startLine" for read, not both');
      }
      const value = Number(candidate.startLine);
      if (!Number.isInteger(value) || value < 1) {
        return actionError('"startLine" must be a positive whole line number for read');
      }
      candidate.offset = value;
    }
    const offset = candidate.offset;
    if (offset !== undefined && offset !== null) {
      const value = Number(offset);
      if (!Number.isInteger(value) || value < 1) {
        return actionError('"offset" must be a positive whole line number for read');
      }
      candidate.offset = value;
    }
    if (candidate.endLine !== undefined && candidate.endLine !== null) {
      if (candidate.limit !== undefined && candidate.limit !== null) {
        return actionError('use either "limit" or "endLine" for read, not both');
      }
      const value = Number(candidate.endLine);
      const start = candidate.offset ?? 1;
      if (!Number.isInteger(value) || value < start) {
        return actionError('"endLine" must be a whole line at or after the start line for read');
      }
      const span = value - start + 1;
      if (span > LIMITS.readLines) {
        return actionError(`a read range may cover at most ${LIMITS.readLines} lines`);
      }
      candidate.limit = span;
    }
    const limit = candidate.limit;
    if (limit !== undefined && limit !== null) {
      const value = Number(limit);
      if (!Number.isInteger(value) || value < 1 || value > LIMITS.readLines) {
        return actionError(`"limit" must be a whole number from 1 to ${LIMITS.readLines} for read`);
      }
      candidate.limit = value;
    }
  }
  if (name === "search") {
    const query = stringField("query");
    if (query.reason) return query;
    const folder = stringField("path", { required: false });
    if (folder.reason) return folder;
    candidate.query = query.value;
    candidate.path = folder.value;
  }
  if (name === "list") {
    const folder = stringField("path", { required: false });
    if (folder.reason) return folder;
    candidate.path = folder.value;
  }
  if (name === "subagent") {
    const role = stringField("role");
    if (role.reason) return role;
    const normalized = role.value.trim().toLowerCase();
    if (!SUBAGENT_ROLES.includes(normalized)) {
      return actionError(`"role" must be one of: ${SUBAGENT_ROLES.join(", ")}`);
    }
    candidate.role = normalized;
    const focus = stringField("focus", { required: false, allowEmpty: true });
    if (focus.reason) return focus;
    candidate.focus = focus.value ?? "";
  }
  if (name === "inspect") {
    const focus = stringField("focus", { required: false, allowEmpty: true });
    if (focus.reason) return focus;
    candidate.focus = focus.value ?? "";
  }
  if (name === "shell") {
    const command = stringField("command");
    if (command.reason) return command;
    candidate.command = command.value;
    if (candidate.timeout !== undefined && candidate.timeout !== null) {
      const seconds = Number(candidate.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return actionError('"timeout" must be a positive number of seconds for shell');
      }
      candidate.timeout = seconds;
    }
    const cwd = stringField("cwd", { required: false });
    if (cwd.reason) return cwd;
    candidate.cwd = cwd.value;
  }
  if (name === "apply_patch") {
    const patch = stringField("patch");
    if (patch.reason) return patch;
    candidate.patch = patch.value;
  }
  if (name === "batch") {
    // Backwards-compatible alias: "actions" means exactly the same thing as
    // "operations", so it is normalized here instead of costing a model turn
    // on a correction. The canonical shape is what leaves this function.
    if (!Array.isArray(candidate.operations) && Array.isArray(candidate.actions)) {
      candidate.operations = candidate.actions;
    }
    delete candidate.actions;
    const operations = candidate.operations;
    if (!Array.isArray(operations) || !operations.length) {
      return actionError('"operations" (or its alias "actions") must be a non-empty array for batch');
    }
    if (operations.length > LIMITS.batchOperations) {
      return actionError(`batch allows at most ${LIMITS.batchOperations} operations`);
    }
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        return actionError(`operation ${index + 1} must be an object with an action`);
      }
      const nested = `${operation.action ?? ""}`.trim().toLowerCase();
      if (!nested) return actionError(`operation ${index + 1} needs an "action"`);
      operation.action = nested;
    }
    candidate.operations = operations;
  }
  if (name === "write") {
    const content = stringField("content", { allowEmpty: true });
    if (content.reason) return content;
    candidate.content = content.value;
  }
  if (name === "edit") {
    const old = stringField("old");
    if (old.reason) return old;
    const next = stringField("new", { allowEmpty: true });
    if (next.reason) return next;
    candidate.old = old.value;
    candidate.new = next.value;
  }
  if (name === "finish") {
    const summary = stringField("summary", { required: false, allowEmpty: true });
    if (summary.reason) return summary;
    candidate.summary = summary.value ?? "";
  }
  if (candidate.complete !== undefined && candidate.complete !== null) {
    if (typeof candidate.complete !== "boolean") {
      return actionError('"complete" must be true or false');
    }
    if (!COMPLETION_ACTIONS.includes(name)) {
      return actionError(`"complete" is only valid for ${COMPLETION_ACTIONS.join(", ")}`);
    }
  }

  return { ok: true, action: candidate };
}

/** A failure object shaped like the ones lib/failures.js produces. */
export function webFailure(code, message, action = "") {
  return { code, origin: "chatgpt-web", message, action };
}

/** Conversation id per workspace, so `-c` continues the same chat. Opaque only. */
export function webSessionFile(env = process.env) {
  if (env.KODEVRA_CHATGPT_WEB_SESSIONS) return path.resolve(env.KODEVRA_CHATGPT_WEB_SESSIONS);
  return path.join(os.homedir(), ".kodevra", "chatgpt-web-sessions.json");
}

export function readWebSession(workspace, { env = process.env } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(webSessionFile(env), "utf8"));
    const entry = parsed?.[path.resolve(workspace)];
    return entry && typeof entry.session === "string" ? entry.session : null;
  } catch {
    return null;
  }
}

export function writeWebSession(workspace, { session, model = CHATGPT_WEB_MODEL, env = process.env } = {}) {
  if (!session) return null;
  const file = webSessionFile(env);
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    current = {};
  }
  const next = {
    ...current,
    [path.resolve(workspace)]: { session, model, updatedAt: new Date().toISOString() },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}
