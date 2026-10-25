import test from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../src/map-limit.js";

test("maps every item and keeps the input order", async () => {
  const result = await mapLimit([1, 2, 3], 2, async (item) => item * 2);
  assert.deepEqual(result, [2, 4, 6]);
});

test("never runs more than the requested number of callbacks", async () => {
  let active = 0;
  let peak = 0;

  await mapLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item;
  });

  assert.ok(peak <= 2, `observed ${peak} concurrent callbacks`);
});
