import test from "node:test";
import assert from "node:assert/strict";
import { createTrafficLight } from "../src/light.js";

test("acceptance: full cycle returns to red", () => {
  const light = createTrafficLight();
  assert.equal(light.next(), "green");
  assert.equal(light.next(), "yellow");
  assert.equal(light.next(), "red");
  assert.equal(light.next(), "green");
});

test("acceptance: current reflects the last transition", () => {
  const light = createTrafficLight();
  light.next();
  light.next();
  assert.equal(light.current(), "yellow");
});

test("acceptance: reset returns to red and instances are independent", () => {
  const first = createTrafficLight();
  const second = createTrafficLight();
  first.next();
  second.next();
  second.next();
  first.reset();
  assert.equal(first.current(), "red");
  assert.equal(second.current(), "yellow");
});
