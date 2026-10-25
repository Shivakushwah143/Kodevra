import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/limiter.js";

test("acceptance: expired hits stop counting at the window boundary", () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => time });

  assert.equal(limiter.check("a"), true);
  time = 999;
  assert.equal(limiter.check("a"), false);
  time = 1000;
  assert.equal(limiter.check("a"), true);
});

test("acceptance: blocked attempts do not consume budget", () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 100, now: () => time });

  assert.equal(limiter.check("a"), true);
  time = 50;
  assert.equal(limiter.check("a"), false);
  assert.equal(limiter.check("a"), false);
  time = 150;
  assert.equal(limiter.check("a"), true);
});

test("acceptance: keys are independent", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });

  assert.equal(limiter.check("a"), true);
  assert.equal(limiter.check("b"), true);
  assert.equal(limiter.check("a"), false);
  assert.equal(limiter.check("b"), false);
});
