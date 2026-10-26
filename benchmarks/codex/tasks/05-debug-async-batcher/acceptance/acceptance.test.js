import test from "node:test";
import assert from "node:assert/strict";

import { createBatcher } from "../src/batcher.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function asyncSink() {
  const batches = [];
  async function flush(batch) {
    await tick();
    batches.push([...batch]);
  }
  return { batches, flush };
}

test("acceptance: a live mutation cannot empty a batch already handed to flush", async () => {
  const sink = asyncSink();
  const batcher = createBatcher({ flush: sink.flush, maxSize: 2 });

  batcher.add("a");
  batcher.add("b");
  await settle();

  assert.deepEqual(sink.batches, [["a", "b"]]);
});

test("acceptance: batches arrive in order and each holds its own items", async () => {
  const sink = asyncSink();
  const batcher = createBatcher({ flush: sink.flush, maxSize: 2 });

  for (const item of ["a", "b", "c", "d", "e", "f"]) batcher.add(item);
  await settle();

  assert.deepEqual(sink.batches, [["a", "b"], ["c", "d"], ["e", "f"]]);
});

test("acceptance: awaiting the triggering add resolves with the flush result", async () => {
  const batcher = createBatcher({
    flush: async (batch) => {
      await tick();
      return `flushed ${batch.length}`;
    },
    maxSize: 2,
  });

  assert.equal(batcher.add("a"), false);
  assert.equal(await batcher.add("b"), "flushed 2");
});

test("acceptance: maxSize one flushes every item on its own", async () => {
  const sink = asyncSink();
  const batcher = createBatcher({ flush: sink.flush, maxSize: 1 });

  batcher.add("a");
  batcher.add("b");
  await settle();

  assert.deepEqual(sink.batches, [["a"], ["b"]]);
});

test("acceptance: a rejected flush propagates and later items still batch", async () => {
  const batches = [];
  let fail = true;
  const batcher = createBatcher({
    flush: async (batch) => {
      await tick();
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      batches.push([...batch]);
    },
    maxSize: 2,
  });

  batcher.add("a");
  await assert.rejects(batcher.add("b"), /boom/);

  batcher.add("c");
  batcher.add("d");
  await settle();

  assert.deepEqual(batches, [["c", "d"]]);
});
