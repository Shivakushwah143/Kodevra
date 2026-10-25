import test from "node:test";
import assert from "node:assert/strict";

import { listExecutors, registerExecutor, resolveExecutor } from "../lib/executors.js";

test("the host executor says it is not sandboxed", () => {
  const executor = resolveExecutor("host");
  assert.equal(executor.name, "host");
  assert.equal(executor.sandboxed, false);
  assert.equal(typeof executor.run, "function");
  assert.match(executor.description, /this machine/);
  assert.ok(listExecutors().includes("host"));
});

test("the docker executor is registered and reports itself as sandboxed", () => {
  const executor = resolveExecutor("docker");
  assert.equal(executor.name, "docker");
  assert.equal(executor.sandboxed, true);
  assert.equal(typeof executor.check, "function");
  assert.ok(listExecutors().includes("docker"));
});

test("an unknown executor fails with an explicit code instead of falling back", () => {
  assert.throws(
    () => resolveExecutor("podman"),
    (error) => error.code === "EXECUTOR_UNAVAILABLE" && /Available: host, docker/.test(error.message),
  );
});

test("a future isolated executor can register without changing the loop", () => {
  const fake = {
    name: "fake-sandbox",
    sandboxed: true,
    description: "test double",
    run: async () => ({ ok: true, status: 0, output: "", durationMs: 1, timedOut: false }),
  };
  const registered = registerExecutor(fake);
  assert.equal(registered.sandboxed, true);
  assert.equal(resolveExecutor("fake-sandbox").name, "fake-sandbox");
  assert.ok(listExecutors().includes("fake-sandbox"));
});
