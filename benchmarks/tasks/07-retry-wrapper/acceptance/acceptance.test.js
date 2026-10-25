import test from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/retry.js";

test("acceptance: retries up to the documented count", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error(`failure ${calls}`);
      },
      { retries: 2 },
    ),
    /failure 3/,
  );
  assert.equal(calls, 3);
});

test("acceptance: zero retries means exactly one call", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(calls, 1);
});

test("acceptance: a success on the first attempt is not retried", async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    return 42;
  }, { retries: 5 });
  assert.equal(value, 42);
  assert.equal(calls, 1);
});
