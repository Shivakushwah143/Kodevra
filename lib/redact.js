/**
 * Credential redaction for logs.
 *
 * Event files are evidence, not a secret store. Commands and messages can
 * contain API keys, bearer tokens or `--token=...` flags, so every string that
 * enters the event log is redacted first. Kodevra is deliberately conservative:
 * a masked value is still useful evidence ("the command used a token"), while
 * the token itself is not.
 */

const REPLACEMENT = "***";

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi;

const ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|client[_-]?secret)(\s*[=:]\s*)(["']?)([^\s"',;]{3,})\3/gi;

const FLAG = /(--?(?:api[_-]?key|token|password|secret|passwd)(?:=|\s+))([^\s"']{3,})/gi;

const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;

export function redactText(value) {
  let text = `${value ?? ""}`;
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REPLACEMENT);
  text = text.replace(AUTH_SCHEME, (_match, scheme) => `${scheme} ${REPLACEMENT}`);
  text = text.replace(ASSIGNMENT, (_match, key, separator) => `${key}${separator}${REPLACEMENT}`);
  text = text.replace(FLAG, (_match, flag) => `${flag}${REPLACEMENT}`);
  text = text.replace(URL_USERINFO, (_match, scheme) => `${scheme}${REPLACEMENT}:${REPLACEMENT}@`);
  return text;
}

/** Recursively redact one event payload. Plain strings, arrays and objects only. */
export function redactValue(value, depth = 0) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object" || depth > 6) return value;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = redactValue(entry, depth + 1);
  }
  return out;
}

/** A command is logged as text; keep its shape but never its secrets. */
export function redactCommand(command) {
  return redactText(command);
}
