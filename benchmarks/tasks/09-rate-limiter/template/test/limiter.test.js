import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/limiter.js";

test("allows calls up to the limit", () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });

  assert.equal(limiter.check("client"), true);
  assert.equal(limiter.check("client"), true);
  assert.equal(limiter.check("client"), false);
});

test("allows again once the window has passed", () => {
  let time = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });

  assert.equal(limiter.check("client"), true);
  assert.equal(limiter.check("client"), true);
  time = 1001;
  assert.equal(limiter.check("client"), true);
});
