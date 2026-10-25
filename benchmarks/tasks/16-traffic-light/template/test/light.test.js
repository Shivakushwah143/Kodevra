import test from "node:test";
import assert from "node:assert/strict";
import { createTrafficLight } from "../src/light.js";

test("starts at red", () => {
  assert.equal(createTrafficLight().current(), "red");
});

test("moves from red to green", () => {
  const light = createTrafficLight();
  assert.equal(light.next(), "green");
});
