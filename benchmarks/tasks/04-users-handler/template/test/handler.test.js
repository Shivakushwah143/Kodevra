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

test("GET /users answers with the users as JSON", () => {
  const handler = createUsersHandler([{ id: 1, name: "Ada" }]);
  const response = call(handler);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(response.body), [{ id: 1, name: "Ada" }]);
});
