import test from "node:test";
import assert from "node:assert/strict";

import { PHASE_ORDER, createTimings, timingsLine } from "../lib/timings.js";

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
    },
  };
}

test("marks are measured from the anchor, not from each other", () => {
  const time = clock(1_000);
  const timings = createTimings(1_000, time.now);

  time.advance(250);
  timings.mark("bootstrap");
  time.advance(750);
  timings.mark("spawn");

  assert.equal(timings.at("bootstrap"), 250);
  assert.equal(timings.at("spawn"), 1_000);
  assert.equal(timings.between("bootstrap", "spawn"), 750);
});

test("an observed timestamp can be recorded directly", () => {
  const timings = createTimings(1_000, () => 1_000);
  timings.markAt("first_edit", 61_500);

  assert.equal(timings.at("first_edit"), 61_500);
});

test("between is null when a mark never happened instead of guessing", () => {
  const timings = createTimings();
  timings.mark("spawn");

  assert.equal(timings.between("spawn", "first_edit"), null);
});

test("phases are reported in a stable order and unknown marks are kept", () => {
  const time = clock();
  const timings = createTimings(0, time.now);
  time.advance(10);
  timings.mark("spawn");
  time.advance(10);
  timings.mark("custom_phase");
  time.advance(10);
  timings.mark("total");

  assert.deepEqual(timings.pairs().map(([name, ms]) => [name, ms]), [
    ["spawn", 10],
    ["total", 30],
    ["custom_phase", 20],
  ]);
  assert.ok(PHASE_ORDER.indexOf("spawn") < PHASE_ORDER.indexOf("total"));
});

test("the summary line only mentions phases that actually ran", () => {
  const time = clock();
  const timings = createTimings(0, time.now);
  time.advance(1_200);
  timings.mark("spawn");
  time.advance(60_300);
  timings.mark("first_edit");

  assert.equal(timingsLine(timings), "spawn 1.2s · first edit 61.5s");
  assert.equal(timingsLine(createTimings()), null);
});
