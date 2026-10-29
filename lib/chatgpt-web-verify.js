/**
 * H4 - the verification state machine.
 *
 * Kodevra owns the lifecycle; the model only supplies edits and repair
 * reasoning. Every transition is explicit, so a run can never report VERIFIED
 * without a real command that exited 0.
 */

export const VERIFICATION_STATES = Object.freeze([
  "not_configured",
  "not_verified",
  "verification_requested",
  "verifying",
  "verification_failed",
  "repair_needed",
  "verification_passed",
  "refused",
  "terminal_failed",
]);

const TRANSITIONS = {
  not_configured: [],
  not_verified: ["verification_requested"],
  verification_requested: ["verifying"],
  verifying: ["verification_passed", "verification_failed", "refused", "terminal_failed"],
  verification_failed: ["repair_needed", "terminal_failed"],
  repair_needed: ["verification_requested", "terminal_failed"],
  // A pass can be invalidated by an edit, or re-checked on purpose: a model may
  // ask to verify again without changing anything.
  verification_passed: ["not_verified", "verification_requested"],
  refused: ["verification_requested", "terminal_failed"],
  terminal_failed: [],
};

const ANSI = /\u001b\[[0-9;]*m/g;

export function createVerification({ command = null, maxAttempts = 2 } = {}) {
  return {
    state: command ? "not_verified" : "not_configured",
    command: command ?? null,
    attempts: 0,
    maxAttempts: Math.max(0, Math.min(5, Number(maxAttempts) || 0)),
    exitCode: null,
    passedEditVersion: null,
    latestFailure: null,
    history: [],
    lastDurationMs: null,
  };
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function transition(verification, to, extra = {}) {
  if (!canTransition(verification.state, to)) {
    const error = new Error(`verification cannot move ${verification.state} -> ${to}`);
    error.code = "VERIFICATION_TRANSITION";
    throw error;
  }
  const from = verification.state;
  verification.state = to;
  verification.history.push({ from, to, at: Date.now(), ...extra });
  if (verification.history.length > 40) verification.history.shift();
  return verification.state;
}

/** not_verified/repair_needed/refused -> verification_requested. */
export function requestVerification(verification) {
  if (verification.state === "verification_requested") return;
  transition(verification, "verification_requested");
}

export function markVerifying(verification) {
  transition(verification, "verifying");
}

/**
 * Record one real verification result.
 *
 * Returns `{ kind, terminal, repair }` where kind is the failure class the run
 * reports: pass | verification | authorization | timeout.
 */
export function recordVerification(verification, result, editVersion, { maxChars = 3_500 } = {}) {
  const refused = Boolean(result?.refused);
  const timedOut = Boolean(result?.timedOut);
  const exitCode = Number.isFinite(result?.status) ? result.status : null;
  const passed = !refused && !timedOut && result?.ok === true && exitCode === 0;

  verification.exitCode = exitCode;
  verification.lastDurationMs = Number.isFinite(result?.durationMs) ? result.durationMs : null;

  if (passed) {
    transition(verification, "verification_passed");
    verification.passedEditVersion = editVersion;
    verification.latestFailure = null;
    // A pass clears the repair budget: the next failure is a new problem.
    verification.attempts = 0;
    return { kind: "pass", terminal: false, repair: false };
  }

  if (refused) {
    // The authorization gate is not something the model can repair.
    transition(verification, "refused");
    verification.passedEditVersion = null;
    verification.latestFailure = {
      at: Date.now(),
      kind: "authorization",
      exitCode: null,
      exitCodeText: "not run",
      evidence: "verification refused: the run needs reauthorization (--reapprove <fingerprint>)",
    };
    return { kind: "authorization", terminal: false, repair: false };
  }

  if (timedOut) {
    transition(verification, "terminal_failed");
    verification.passedEditVersion = null;
    verification.latestFailure = {
      at: Date.now(),
      kind: "timeout",
      exitCode: null,
      exitCodeText: "timed out",
      evidence: compactFailure(result, { maxChars }),
    };
    return { kind: "timeout", terminal: true, repair: false };
  }

  // The repair budget counts repeated failures against the same workspace,
  // not the number of patches a repair needed. When the files changed since the
  // last failed attempt the model made progress, so the earlier attempt is
  // stale and must not push a multi-step repair into terminal failure.
  const previousEditVersion = verification.latestFailure?.editVersion;
  if (previousEditVersion !== null && previousEditVersion !== undefined && previousEditVersion !== editVersion) {
    verification.attempts = 0;
  }
  verification.attempts += 1;
  transition(verification, "verification_failed");
  verification.passedEditVersion = null;
  verification.latestFailure = {
    at: Date.now(),
    kind: "verification",
    editVersion,
    exitCode,
    exitCodeText: `exit ${exitCode === null ? "unknown" : exitCode}`,
    evidence: compactFailure(result, { maxChars }),
  };

  const terminal = verification.attempts > verification.maxAttempts;
  return { kind: "verification", terminal, repair: !terminal };
}

export function markTerminal(verification, reason) {
  if (verification.state === "terminal_failed") return;
  transition(verification, "terminal_failed");
  verification.passedEditVersion = null;
  verification.latestFailure = verification.latestFailure ?? {
    at: Date.now(),
    kind: "infrastructure",
    exitCode: null,
    exitCodeText: "not run",
    evidence: `${reason}`,
  };
}

/** A passing verification only covers the edit version it ran against. */
export function invalidateOnEdit(verification) {
  if (verification.state !== "verification_passed") return;
  transition(verification, "not_verified");
}

export function verificationSnapshot(verification) {
  return {
    state: verification.state,
    command: verification.command,
    attempts: verification.attempts,
    maxAttempts: verification.maxAttempts,
    exitCode: verification.exitCode,
    lastDurationMs: verification.lastDurationMs,
    latestFailure: verification.latestFailure,
    passedEditVersion: verification.passedEditVersion,
    history: verification.history.slice(-8),
  };
}

/**
 * Bounded, relevance-first failure evidence: matched error lines plus the tail,
 * with ANSI stripped. Large test/build output never goes to the model whole.
 */
export function compactFailure(result, { maxChars = 3_500, matchedLines = 30, tailLines = 10 } = {}) {
  const raw = `${result?.output ?? ""}`.replace(ANSI, "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length);
  const interesting = lines.filter((line) =>
    /(error|fail|✖|✗|×|not ok|expected|actual|assert|exception|traceback|panic|TS\d{3,}|denied|refused|cannot find|undefined|EADDRINUSE|ENOENT)/i.test(
      line,
    ),
  );

  const selected = [];
  const seen = new Set();
  for (const line of interesting) {
    if (selected.length >= matchedLines) break;
    if (seen.has(line)) continue;
    seen.add(line);
    selected.push(line.slice(0, 300));
  }

  const tail = lines.slice(-tailLines).map((line) => line.slice(0, 300));
  const parts = [];
  if (result?.timedOut) parts.push("verification timed out");
  if (result?.refused) parts.push("verification refused: authorization required");
  if (selected.length) {
    parts.push("relevant lines:", ...selected);
    const extra = tail.filter((line) => !seen.has(line));
    if (extra.length) parts.push("", "output tail:", ...extra);
  } else {
    parts.push("no error lines matched; output tail:", ...(tail.length ? tail : ["(no output)"]));
  }

  const body = parts.join("\n");
  if (body.length > maxChars) return `${body.slice(0, maxChars)}\n[verification output truncated]`;
  return body || "(no output)";
}
