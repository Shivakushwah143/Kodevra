import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/escape.js";
import { renderComment } from "../src/comment.js";

test("escapeHtml covers markup characters", () => {
  assert.equal(escapeHtml(`<b class="x">&</b>`), "&lt;b class=&quot;x&quot;&gt;&amp;&lt;/b&gt;");
});

test("renderComment escapes author and body", () => {
  const html = renderComment({ author: "A&B", body: "<script>alert(1)</script>" });
  assert.equal(html, "<article><h3>A&amp;B</h3><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></article>");
});
