import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv } from "../src/argv.js";

test("acceptance: short flags work for values and booleans", () => {
  const withValue = parseArgv(["-n", "3", "build"]);
  assert.equal(withValue.flags.n, "3");
  assert.deepEqual(withValue._, ["build"]);

  const boolean = parseArgv(["-v"]);
  assert.equal(boolean.flags.v, true);
});

test("acceptance: a flag followed by another flag is boolean", () => {
  const result = parseArgv(["--verbose", "--name=value"]);
  assert.equal(result.flags.verbose, true);
  assert.equal(result.flags.name, "value");

  const trailing = parseArgv(["build", "--count"]);
  assert.equal(trailing.flags.count, true);
  assert.deepEqual(trailing._, ["build"]);
});

test("acceptance: -- stops flag parsing", () => {
  const result = parseArgv(["run", "--", "--literal", "-x"]);
  assert.deepEqual(result._, ["run", "--literal", "-x"]);
  assert.deepEqual(result.flags, {});
});

test("acceptance: an empty value is preserved", () => {
  const result = parseArgv(["--name=", "--empty"]);
  assert.equal(result.flags.name, "");
  assert.equal(result.flags.empty, true);
  assert.deepEqual(result._, []);
});
