import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv } from "../src/argv.js";

test("long flags with a separate value and positionals", () => {
  const result = parseArgv(["--name", "value", "file.txt"]);
  assert.equal(result.flags.name, "value");
  assert.deepEqual(result._, ["file.txt"]);
});

test("long flags with = and boolean flags", () => {
  const equals = parseArgv(["--name=value"]);
  assert.equal(equals.flags.name, "value");

  const boolean = parseArgv(["build", "--verbose"]);
  assert.equal(boolean.flags.verbose, true);
  assert.deepEqual(boolean._, ["build"]);
});
