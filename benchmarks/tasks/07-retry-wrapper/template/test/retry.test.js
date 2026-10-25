import test from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../src/retry.js";

test("retries until the call succeeds", async () => {
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    { retries: 3 },
  );

  assert.equal(value, "ok");
  assert.equal(calls, 3);
});
