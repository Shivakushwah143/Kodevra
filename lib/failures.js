/**
 * Failure taxonomy (FRD 7.8).
 *
 * Kodevra does not own the agent loop, so it cannot fix provider or tool errors.
 * What it can do is name the failure origin truthfully and give one next action,
 * instead of surfacing a raw stack trace or, worse, a green summary.
 *
 * The classifier is pure: it takes captured engine output plus facts the caller
 * already verified (is the local proxy reachable?) and returns a code.
 */

export const FAILURE_CODES = [
  "PROXY_UNAVAILABLE",
  "AUTH_EXPIRED",
  "RATE_LIMITED",
  "MODEL_UNAVAILABLE",
  "PROVIDER_ERROR",
  "PROVIDER_NOT_PERMITTED",
  "MALFORMED_TOOL_CALL",
  "TOOL_DENIED",
  "CONTEXT_EXHAUSTED",
  "COMMAND_FAILED",
  "TEST_FAILED",
  "VERIFICATION_NOT_APPROVED",
  "EXECUTOR_UNAVAILABLE",
  "CANCELLED",
  "AGENT_FAILED",
];

const RULES = [
  {
    code: "MALFORMED_TOOL_CALL",
    origin: "adapter",
    pattern: /malformed (tool|json)|invalid tool|tool[_ ]call.*(invalid|malformed|parse)|could not parse.*tool/i,
    message: "The model returned a tool call the engine could not parse.",
    action: "Retry the task; if it repeats, switch model with kodevra providers use <provider>.",
  },
  {
    code: "TOOL_DENIED",
    origin: "permission",
    pattern: /permission denied|denied by user|user rejected|tool execution.*(denied|rejected)|approval (denied|rejected)/i,
    message: "A tool call was denied, so it was not executed.",
    action: "Re-run with --mode workspace-write for this workspace if the action is intended.",
  },
  {
    code: "PROVIDER_NOT_PERMITTED",
    origin: "provider",
    pattern: /not supported by kodevra|unsupported provider|PROVIDER_NOT_PERMITTED/i,
    message: "The selected provider has no authorized integration in Kodevra.",
    action: "Pick a supported provider: kodevra providers list",
  },
  {
    code: "AUTH_EXPIRED",
    origin: "provider",
    pattern: /401|403|unauthori[sz]ed|invalid api key|authentication|credential|sign in again|token (expired|invalid)|AUTH_EXPIRED/i,
    message: "The provider rejected the stored credentials.",
    action: "Sign in again: kodevra auth login <provider>, then kodevra doctor.",
  },
  {
    code: "RATE_LIMITED",
    origin: "provider",
    pattern: /429|rate limit|too many requests|quota|insufficient (balance|credits)|402/i,
    message: "The provider is rate-limiting or the account has no remaining quota.",
    action: "Wait and retry, or select another configured provider. Kodevra never retries automatically.",
  },
  {
    code: "MODEL_UNAVAILABLE",
    origin: "provider",
    pattern: /model.*(not found|unavailable|unknown)|unknown model|no such model|ProviderModelNotFound/i,
    message: "The selected model is not served by this provider.",
    action: "List real models: kodevra providers list, or pass -m <provider>/<model>.",
  },
  {
    code: "CONTEXT_EXHAUSTED",
    origin: "provider",
    pattern: /context (length|window)|too many tokens|maximum context|token limit exceeded/i,
    message: "The conversation exceeded the model's context window.",
    action: "Start a narrower task, or continue in a fresh session with the relevant files named explicitly.",
  },
  {
    code: "PROXY_UNAVAILABLE",
    origin: "adapter",
    pattern: /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|connect ETIMEDOUT|proxy.*(unreachable|down)|127\.0\.0\.1:9655/i,
    message: "The local model proxy is not reachable.",
    action: "Start it: cd integrations/FreeDeepseekAPI && npm start, then kodevra doctor.",
  },
  {
    code: "PROVIDER_ERROR",
    origin: "provider",
    pattern: /UnknownError|Unexpected server error|Bad Gateway|502|503|504|upstream (error|failure)/i,
    message: "The provider returned an unexpected error.",
    action: "Run kodevra doctor, then retry once. If it persists the provider is unhealthy, not your code.",
  },
];

function applyRule(rule, extra) {
  return {
    code: rule.code,
    origin: rule.origin,
    message: rule.message,
    action: rule.action,
    ...extra,
  };
}

/**
 * @param {object} input
 * @param {string} [input.output] captured stdout+stderr from the engine
 * @param {number} [input.status] engine exit code
 * @param {string|null} [input.signal] termination signal, if any
 * @param {boolean|null} [input.proxyReachable] result of probing a local provider endpoint
 * @param {string} [input.provider] selected provider key, used in guidance
 */
export function classifyFailure({ output = "", status = 1, signal = null, proxyReachable = null, provider = "" } = {}) {
  if (signal) {
    return {
      code: "CANCELLED",
      origin: "user",
      message: `The task was cancelled (${signal}).`,
      action: "Changes already written stay in the workspace; review them with git diff.",
    };
  }

  // A dead local proxy is a fact, not a guess: trust it over any log text.
  if (proxyReachable === false) {
    return applyRule(RULES.find((rule) => rule.code === "PROXY_UNAVAILABLE"));
  }

  for (const rule of RULES) {
    if (rule.pattern.test(output)) {
      const extra = rule.code === "AUTH_EXPIRED" && provider ? { action: `Sign in again: kodevra auth login ${provider}, then kodevra doctor.` } : {};
      return applyRule(rule, extra);
    }
  }

  return {
    code: "AGENT_FAILED",
    origin: "agent",
    message: `opencode exited ${status} without a recognised error code.`,
    action: "Re-run with --print-logs for detail, or run kodevra doctor.",
  };
}

/** One line suitable for a terminal report. */
export function describeFailure(failure) {
  return `${failure.code} (${failure.origin}) - ${failure.message}`;
}
