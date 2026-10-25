import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { header, PRODUCT, TAGLINE, VERSION, verdict } from "../lib/brand.js";
import { resultLines } from "../lib/verify.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

test("the startup panel carries brand, workspace, model, sandbox and mode", () => {
  const text = header({
    workspace: path.join(process.cwd(), "examples", "agent-smoke"),
    model: "freedeepseek/deepseek-v4-flash",
    provider: "DeepSeek (FreeDeepseekAPI)",
    auth: "ready · local proxy",
    sandbox: "Docker ready",
    mode: "workspace-write - workspace edits allowed",
  });

  assert.match(text, /KODEVRA/);
  assert.match(text, new RegExp(TAGLINE.replace(/\./g, "\\.")));
  assert.match(text, /Workspace\s+\.\/examples\/agent-smoke|Workspace\s+\.\\examples\\agent-smoke/);
  assert.match(text, /Model\s+freedeepseek\/deepseek-v4-flash/);
  assert.match(text, /Sandbox\s+Docker ready/);
  assert.match(text, /Mode\s+workspace-write/);
  assert.match(text, /kodevra run/);
  assert.equal(PRODUCT, "Kodevra");
});

test("the version constant matches the package manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(pkg.version, VERSION);
});

test("the status word is never optimistic", () => {
  assert.match(verdict("verified"), /^VERIFIED$/);
  assert.equal(verdict("unverified"), "UNVERIFIED");
  assert.notEqual(verdict("unverified"), "VERIFIED");
  assert.match(verdict("failed"), /FAILED/);
  assert.match(verdict("refused"), /REFUSED/);
});

test("a failed verification is reported as FAILED, not VERIFIED", () => {
  const text = resultLines({
    model: "m",
    durationMs: 2000,
    verification: { command: "npm test", ok: false, status: 2, timedOut: false },
    sandboxCommands: 2,
    changes: { isGit: true, files: ["src/a.js"], stat: null },
  }).join("\n");

  assert.match(text, /Status\s+FAILED/);
  assert.doesNotMatch(text, /VERIFIED/);
  assert.match(text, /Sandbox commands 2/);
});
