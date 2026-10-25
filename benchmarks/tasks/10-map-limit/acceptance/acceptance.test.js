import test from "node:test";
import assert from "node:assert/strict";
import { mapLimit } from "../src/map-limit.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("acceptance: results follow input order even with uneven delays", async () => {
  const items = [30, 5, 15];
  const result = await mapLimit(items, 3, async (item) => {
    await wait(item);
    return item * 10;
  });
  assert.deepEqual(result, [300, 50, 150]);
});

test("acceptance: an empty list needs no calls", async () => {
  let calls = 0;
  const result = await mapLimit([], 2, async () => {
    calls += 1;
  });
  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});

test("acceptance: a limit larger than the list is fine and stays sequential at 1", async () => {
  let active = 0;
  let peak = 0;

  const result = await mapLimit([1, 2, 3], 1, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(2);
    active -= 1;
    return item + 1;
  });

  assert.deepEqual(result, [2, 3, 4]);
  assert.equal(peak, 1);

  const wide = await mapLimit([4, 5], 10, async (item) => item * 2);
  assert.deepEqual(wide, [8, 10]);
});
