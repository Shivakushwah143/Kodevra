import { average } from "./stats.js";

/** One-line summary of a score set. */
export function summarize(scores) {
  const mean = scores.length ? average(scores) : 0;
  return `Average: ${mean}`;
}
