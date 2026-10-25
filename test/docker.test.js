import test from "node:test";
import assert from "node:assert/strict";
import { buildDockerArgs, DOCKER_DEFAULTS } from "../lib/docker-executor.js";

function argsFor() {
  return buildDockerArgs({
    image: "node:22-alpine",
    snapshot: "C:/Users/dev/.kodevra/sandboxes/sbx_1/workspace",
    command: "npm test",
    name: "kodevra-abc123",
  });
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

test("the container gets no network, no capabilities and no privilege escalation", () => {
  const args = argsFor();
  assert.equal(valueAfter(args, "--network"), "none");
  assert.equal(valueAfter(args, "--cap-drop"), "ALL");
  assert.equal(valueAfter(args, "--security-opt"), "no-new-privileges");
  assert.equal(valueAfter(args, "--user"), "1000:1000");
  assert.ok(args.includes("--read-only"));
});

test("resource limits are always present", () => {
  const args = argsFor();
  assert.equal(valueAfter(args, "--pids-limit"), "256");
  assert.equal(valueAfter(args, "--memory"), "2g");
  assert.equal(valueAfter(args, "--cpus"), "2");
  assert.equal(valueAfter(args, "--ulimit"), "nofile=1024:1024");
});

test("only the snapshot is mounted, and the original workspace is not referenced", () => {
  const args = argsFor();
  const mounts = args.reduce((all, arg, index) => (arg === "-v" ? [...all, args[index + 1]] : all), []);
  assert.equal(mounts.length, 1);
  assert.match(mounts[0], /\.kodevra\/sandboxes\/sbx_1\/workspace:\/workspace:rw$/);
  assert.ok(!args.some((arg) => /docker\.sock/.test(arg)));
});

test("the image and verification command are the last arguments", () => {
  const args = argsFor();
  assert.deepEqual(args.slice(-4), ["node:22-alpine", "sh", "-lc", "npm test"]);
  assert.equal(DOCKER_DEFAULTS.image, "node:22-alpine");
});
