import { average } from "./stats.js";

/** One-line summary of a score set. */
export function summarize(scores) {
  return `Average: ${average(scores)}`;
}
