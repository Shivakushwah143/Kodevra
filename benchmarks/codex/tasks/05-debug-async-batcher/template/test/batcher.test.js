import test from "node:test";
import assert from "node:assert/strict";

import { createBatcher } from "../src/batcher.js";

/** A sink that only reads its batch after yielding, like a real network flush. */
function asyncSink() {
  const batches = [];
  async function flush(batch) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    batches.push([...batch]);
  }
  return { batches, flush };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("an async flush still sees the items it was handed", async () => {
  const sink = asyncSink();
  const batcher = createBatcher({ flush: sink.flush, maxSize: 2 });

  assert.equal(batcher.add("a"), false);
  batcher.add("b");
  batcher.add("c");
  batcher.add("d");
  await settle();

  assert.deepEqual(sink.batches, [["a", "b"], ["c", "d"]]);
});

test("add returns false while the batch is not full", () => {
  const batcher = createBatcher({ flush: () => "flushed", maxSize: 3 });
  assert.equal(batcher.add("a"), false);
  assert.equal(batcher.add("b"), false);
});
