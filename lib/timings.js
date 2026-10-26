/**
 * Phase timings for one CLI run.
 *
 * Every value is a clock reading taken where the phase actually happened, so a
 * slow run can be explained instead of guessed at. The anchor is the moment the
 * CLI module loaded: `total` therefore includes bootstrap, and `agent` starts at
 * spawn, which is what makes wrapper cost separable from engine cost.
 *
 * Nothing here measures the model, retries or network: those show up as the gap
 * between two marks, which is the honest way to report them.
 */

/** Printed in this order; unknown marks are appended so nothing is silently lost. */
export const PHASE_ORDER = [
  "bootstrap",
  "engine_probe",
  "preflight",
  "workspace_scan",
  "authorization",
  "spawn",
  "first_event",
  "first_tool",
  "first_edit",
  "agent",
  "verification",
  "changes",
  "outcome",
  "total",
];

export function createTimings(anchor = Date.now(), now = Date.now) {
  const marks = new Map();

  return {
    mark(name, at = now()) {
      marks.set(name, Math.max(0, at - anchor));
      return marks.get(name);
    },
    /** Record a phase whose timestamp was observed elsewhere (e.g. a streamed line). */
    markAt(name, at) {
      marks.set(name, Math.max(0, at));
      return marks.get(name);
    },
    at(name) {
      return marks.has(name) ? marks.get(name) : null;
    },
    has(name) {
      return marks.has(name);
    },
    /** Milliseconds between two marks; null when either is missing. */
    between(from, to) {
      if (!marks.has(from) || !marks.has(to)) return null;
      return marks.get(to) - marks.get(from);
    },
    toJSON() {
      return Object.fromEntries(marks);
    },
    /** Ordered `[name, ms]` pairs for a stable report. */
    pairs(order = PHASE_ORDER) {
      const seen = new Set(order);
      const tail = [...marks.keys()].filter((name) => !seen.has(name));
      return [...order, ...tail].filter((name) => marks.has(name)).map((name) => [name, marks.get(name)]);
    },
  };
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One compact line: only the marks this run actually recorded. */
export function timingsLine(timings, order = PHASE_ORDER) {
  const pairs = timings.pairs(order);
  if (!pairs.length) return null;
  return pairs.map(([name, ms]) => `${name.replace(/_/g, " ")} ${seconds(ms)}`).join(" · ");
}
