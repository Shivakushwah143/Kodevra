import test from "node:test";
import assert from "node:assert/strict";
import { createUsersHandler } from "../src/handler.js";

function call(handler, { method = "GET", url = "/users" } = {}) {
  const headers = {};
  let body = "";
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk = "") {
      body += chunk;
    },
  };
  handler({ method, url }, res);
  return { status: res.statusCode, headers, body };
}

test("acceptance: users are returned as a JSON array", () => {
  const handler = createUsersHandler([{ id: 1 }, { id: 2 }]);
  const response = call(handler);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), [{ id: 1 }, { id: 2 }]);
  assert.match(response.headers["content-type"], /application\/json/);
});

test("acceptance: an empty collection is still a JSON array", () => {
  const response = call(createUsersHandler([]));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), []);
});

test("acceptance: unknown paths answer 404 as JSON", () => {
  const response = call(createUsersHandler([]), { url: "/health" });
  assert.equal(response.status, 404);
  assert.deepEqual(JSON.parse(response.body), { error: "not found" });
});

test("acceptance: non-GET methods answer 405 as JSON", () => {
  const response = call(createUsersHandler([]), { method: "POST" });
  assert.equal(response.status, 405);
  assert.deepEqual(JSON.parse(response.body), { error: "method not allowed" });
});
