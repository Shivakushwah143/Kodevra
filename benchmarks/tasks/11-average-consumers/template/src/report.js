import { average } from "./stats.js";

/** Builds the score report shown to a reviewer. */
export function buildReport(scores) {
  const mean = Number.isNaN(average(scores)) ? 0 : average(scores);
  return { mean, grade: mean >= 70 ? "pass" : "review" };
}
