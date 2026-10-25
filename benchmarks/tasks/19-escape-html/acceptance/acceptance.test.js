import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/escape.js";
import { renderComment } from "../src/comment.js";

test("acceptance: all five markup characters are escaped", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("acceptance: existing entities are escaped once, not decoded", () => {
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(undefined), "");
});

test("acceptance: a comment cannot inject an element or attribute", () => {
  const html = renderComment({
    author: `" onmouseover="alert(1)`,
    body: `<img src=x onerror="alert(1)">`,
  });
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes(`onmouseover="alert(1)"`));
  assert.match(html, /^<article><h3>.*<\/h3><p>.*<\/p><\/article>$/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});
