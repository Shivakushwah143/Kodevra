import { average } from "./stats.js";

/** Builds the score report shown to a reviewer. */
export function buildReport(scores) {
  const mean = average(scores);
  return { mean, grade: mean >= 70 ? "pass" : "review" };
}
