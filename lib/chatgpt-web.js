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

/** Hard limits. The experiment must not spend dozens of ChatGPT messages. */
export const LIMITS = {
  maxTurns: 8,
  // A run may ask for a larger budget (`--max-turns`), but the tab is the scarce
  // resource: the ceiling keeps even a complex task a finite browser loop.
  maxTurnCeiling: 40,
  maxProtocolRepairs: 1,
  maxVerifyRepairs: 2,
  readBytes: 24_000,
  searchResults: 40,
  searchFileBytes: 512_000,
  listEntries: 200,
  resultChars: 12_000,
  turnTimeoutMs: 240_000,
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
  // H3: a batch is a handful of ordered, non-mutating operations.
  batchOperations: 8,
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

function bridgeError(message, code, hint = "") {
  const error = new Error(message);
  error.code = code;
  error.hint = hint;
  return error;
}

async function bridgeRequest(url, { token, method = "GET", body = null, timeoutMs = 5_000, fetchImpl = fetch } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json";
  try {
    return await fetchImpl(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw bridgeError(
      `chatgpt-bridge is not reachable at ${url} (${error.message}).`,
      "BRIDGE_UNAVAILABLE",
      "Start it in its own checkout: npm start (binds 127.0.0.1:8080), connect the Chrome extension to a logged-in ChatGPT tab, then retry.",
    );
  }
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

  const response = await bridgeRequest(`${settings.baseURL}/chat/completions`, {
    token: settings.token,
    method: "POST",
    body,
    timeoutMs,
    fetchImpl,
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
export function instruction({ workspace, task }) {
  return `You are Kodevra's autonomous coding agent.

Solve the task using repository actions.
Return exactly ONE JSON action per turn.

Actions: read, search, list, inspect, shell, write, edit, apply_patch, batch, subagent, verify, finish

Rules:
- paths are workspace-relative
- use inspect once instead of crawling with list/read/search
- batch independent read/search/inspect/shell operations in one action
- prefer apply_patch (unified diff) for multi-file or multi-hunk edits
- shell runs one bounded command in the workspace
- subagent (explorer | reviewer | failure_diagnoser) is read-only assistance for non-trivial work
- edit once sufficient evidence exists
- never fabricate tool results
- the harness verifies before finish and after a repair; request verify only when you need evidence sooner
- after successful verification, finish

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
    const operations = candidate.operations;
    if (!Array.isArray(operations) || !operations.length) {
      return actionError('"operations" must be a non-empty array for batch');
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
