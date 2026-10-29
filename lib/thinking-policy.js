/**
 * Kodevra's model/thinking-effort policy for browser providers.
 *
 * The ChatGPT tab exposes the thinking effort as a UI picker, so every change
 * costs a menu interaction. This policy therefore answers one question per
 * turn - "what effort should this turn run at?" - and keeps the answer stable:
 * it only escalates on evidence (a failed verification or a protocol repair),
 * never downgrades mid-run, and never guesses for a benchmark.
 *
 * Effort names match the bridge/extension vocabulary: instant | low | medium |
 * high | xhigh.
 */

export const THINKING_POLICY = Object.freeze({
  read: "low",
  list: "low",
  search: "low",
  coding: "medium",
  debug: "high",
  design: "high",
});

export const EFFORT_ORDER = Object.freeze(["instant", "low", "medium", "high", "xhigh"]);

export const DEFAULT_TASK_CLASS = "coding";

/** Debugging and system design stay escalated; nothing escalates back down. */
export function escalateTaskClass(taskClass = DEFAULT_TASK_CLASS) {
  const value = String(taskClass || DEFAULT_TASK_CLASS).toLowerCase();
  if (value === "read" || value === "search" || value === "list") return "coding";
  if (value === "coding") return "debug";
  return value;
}

function lowerTier(effort = "") {
  const index = EFFORT_ORDER.indexOf(String(effort || "").toLowerCase());
  if (index <= 0) return EFFORT_ORDER[0];
  return EFFORT_ORDER[index - 1];
}

/**
 * Resolve one turn's effort.
 *
 * - `effort` wins when the caller names one (benchmarks and repeatable runs).
 * - otherwise the task class decides.
 * - a benchmark without an explicit effort is an error, not a guess.
 * - when the account does not offer the wanted effort, the documented fallback
 *   is the next lower tier, reported in `fallback` so the run can say so. There
 *   is no retry loop: the caller sends this effort and moves on.
 */
export function resolveThinkingPlan({ taskClass = DEFAULT_TASK_CLASS, effort = null, available = null } = {}) {
  const normalizedClass = String(taskClass || DEFAULT_TASK_CLASS).toLowerCase();
  const explicit = String(effort || "").trim().toLowerCase();

  if (normalizedClass === "benchmark" && !explicit) {
    const error = new Error(
      "A deterministic benchmark needs an explicit effort (low | medium | high); Kodevra does not guess one.",
    );
    error.code = "BENCHMARK_EFFORT_REQUIRED";
    throw error;
  }

  const wanted = explicit || THINKING_POLICY[normalizedClass] || THINKING_POLICY[DEFAULT_TASK_CLASS];
  const offered = Array.isArray(available) && available.length
    ? available.map((value) => String(value || "").toLowerCase())
    : null;

  if (!offered || offered.includes(wanted)) {
    return { taskClass: normalizedClass, effort: wanted, explicit: Boolean(explicit), fallback: null };
  }

  let candidate = lowerTier(wanted);
  while (candidate && !offered.includes(candidate) && candidate !== EFFORT_ORDER[0]) candidate = lowerTier(candidate);
  const fallback = offered.includes(candidate) ? candidate : offered[0];
  return {
    taskClass: normalizedClass,
    effort: fallback,
    explicit: Boolean(explicit),
    fallback: `"${wanted}" is not offered by this account; using "${fallback}".`,
  };
}
