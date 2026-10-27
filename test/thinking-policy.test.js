import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TASK_CLASS,
  EFFORT_ORDER,
  THINKING_POLICY,
  escalateTaskClass,
  resolveThinkingPlan,
} from "../lib/thinking-policy.js";

test("the default coding turn runs at Medium", () => {
  const plan = resolveThinkingPlan({});
  assert.equal(DEFAULT_TASK_CLASS, "coding");
  assert.equal(plan.effort, "medium");
  assert.equal(plan.explicit, false);
});

test("each task class maps to its documented effort", () => {
  assert.equal(resolveThinkingPlan({ taskClass: "read" }).effort, THINKING_POLICY.read);
  assert.equal(resolveThinkingPlan({ taskClass: "search" }).effort, "low");
  assert.equal(resolveThinkingPlan({ taskClass: "coding" }).effort, "medium");
  assert.equal(resolveThinkingPlan({ taskClass: "debug" }).effort, "high");
  assert.equal(resolveThinkingPlan({ taskClass: "design" }).effort, "high");
});

test("an explicit effort wins over the task class", () => {
  const plan = resolveThinkingPlan({ taskClass: "debug", effort: "Low" });
  assert.equal(plan.effort, "low");
  assert.equal(plan.explicit, true);
});

test("a benchmark without an explicit effort is refused, not guessed", () => {
  assert.throws(
    () => resolveThinkingPlan({ taskClass: "benchmark" }),
    (error) => error.code === "BENCHMARK_EFFORT_REQUIRED",
  );
  assert.equal(resolveThinkingPlan({ taskClass: "benchmark", effort: "high" }).effort, "high");
});

test("an unavailable effort falls back one tier down, once", () => {
  const plan = resolveThinkingPlan({ taskClass: "debug", available: ["instant", "low", "medium"] });
  assert.equal(plan.effort, "medium");
  assert.match(plan.fallback, /not offered/);

  const atFloor = resolveThinkingPlan({ taskClass: "read", available: ["instant"] });
  assert.equal(atFloor.effort, EFFORT_ORDER[0]);
});

test("escalation only ever moves up and never downgrades", () => {
  assert.equal(escalateTaskClass("read"), "coding");
  assert.equal(escalateTaskClass("coding"), "debug");
  assert.equal(escalateTaskClass("debug"), "debug");
  assert.equal(escalateTaskClass("design"), "design");

  // A run that hit a failed verification keeps the higher effort next turn.
  const escalated = escalateTaskClass(DEFAULT_TASK_CLASS);
  assert.equal(resolveThinkingPlan({ taskClass: escalated }).effort, "high");
});
