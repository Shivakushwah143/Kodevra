import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  authorizationDrift,
  createVerificationAuthorization,
  isVerificationFile,
  renewAuthorization,
  verificationSurface,
} from "../lib/authorization.js";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-auth-"));
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "test", "slug.test.js"), "assert.equal(1, 1);\n");
  fs.writeFileSync(path.join(dir, "src", "app.js"), "export const x = 1;\n");
  fs.writeFileSync(path.join(dir, "scripts", "check.js"), "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  return dir;
}

test("verification-relevant files are recognised", () => {
  assert.equal(isVerificationFile("package.json"), true);
  assert.equal(isVerificationFile("test/slug.test.js"), true);
  assert.equal(isVerificationFile("src/slug.test.ts"), true);
  assert.equal(isVerificationFile("vitest.config.ts"), true);
  assert.equal(isVerificationFile("pytest.ini"), true);
  assert.equal(isVerificationFile("src/app.js"), false);
});

test("the surface covers scripts, tests and config, but not source or node_modules", () => {
  const dir = workspace();
  const surface = verificationSurface(dir, "npm test");
  const paths = surface.files.map((file) => file.path);

  assert.ok(paths.includes("package.json"));
  assert.ok(paths.includes("test/slug.test.js"));
  assert.ok(!paths.includes("vitest.config.ts"));
  assert.ok(!paths.includes("src/app.js"));
  assert.ok(!paths.some((file) => file.startsWith("node_modules/")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a file named by the command is part of the surface", () => {
  const dir = workspace();
  const surface = verificationSurface(dir, "node scripts/check.js");
  assert.ok(surface.files.map((file) => file.path).includes("scripts/check.js"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("editing a test file invalidates the developer's authorization", () => {
  const dir = workspace();
  const authorization = createVerificationAuthorization({ workspace: dir, command: "npm test" });

  const clean = authorizationDrift(authorization, { workspace: dir, command: "npm test" });
  assert.equal(clean.ok, true);

  fs.writeFileSync(path.join(dir, "test", "slug.test.js"), "assert.equal(2, 2);\n");
  const drift = authorizationDrift(authorization, { workspace: dir, command: "npm test" });
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.changed, ["test/slug.test.js"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("added verification files also require reapproval", () => {
  const dir = workspace();
  const authorization = createVerificationAuthorization({ workspace: dir, command: "npm test" });
  fs.writeFileSync(path.join(dir, "test", "new.test.js"), "assert.equal(1, 1);\n");

  const drift = authorizationDrift(authorization, { workspace: dir, command: "npm test" });
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.added, ["test/new.test.js"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bare renewal cannot approve changes nobody has seen", () => {
  const dir = workspace();
  const authorization = createVerificationAuthorization({ workspace: dir, command: "npm test" });
  fs.writeFileSync(path.join(dir, "test", "slug.test.js"), "assert.equal(3, 3);\n");

  const bare = renewAuthorization(authorization, { workspace: dir, command: "npm test" });
  assert.equal(bare.renewed, false);

  const drift = authorizationDrift(authorization, { workspace: dir, command: "npm test" });
  const wrong = renewAuthorization(authorization, { workspace: dir, command: "npm test", fingerprint: "0".repeat(64) });
  assert.equal(wrong.renewed, false);

  const approved = renewAuthorization(authorization, {
    workspace: dir,
    command: "npm test",
    fingerprint: drift.fingerprint,
  });
  assert.equal(approved.renewed, true);
  assert.equal(approved.authorization.source, "developer --reapprove <fingerprint>");
  assert.equal(authorizationDrift(approved.authorization, { workspace: dir, command: "npm test" }).ok, true);

  // Renewal binds to that exact surface: a further edit needs a new approval.
  fs.writeFileSync(path.join(dir, "test", "slug.test.js"), "assert.equal(4, 4);\n");
  assert.equal(authorizationDrift(approved.authorization, { workspace: dir, command: "npm test" }).ok, false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a same-size content change still changes the fingerprint", () => {
  const dir = workspace();
  const file = path.join(dir, "test", "slug.test.js");
  fs.writeFileSync(file, "assert.equal(1, 1);\n");
  const before = verificationSurface(dir, "npm test");

  fs.writeFileSync(file, "assert.equal(2, 2);\n");
  assert.equal(fs.statSync(file).size, "assert.equal(1, 1);\n".length);
  const after = verificationSurface(dir, "npm test");
  assert.notEqual(after.fingerprint, before.fingerprint);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a surface over the file limit fails closed instead of hashing a prefix", () => {
  const dir = workspace();
  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(dir, "test", `extra-${index}.test.js`), "assert.equal(1, 1);\n");
  }

  assert.throws(
    () => verificationSurface(dir, "npm test", { maxFiles: 3 }),
    (error) => error.code === "AUTHORIZATION_SURFACE_TOO_LARGE",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unreadable directory fails the authorization instead of skipping it", () => {
  const dir = workspace();
  assert.throws(
    () =>
      verificationSurface(dir, "npm test", {
        readdir: (target, options) => {
          if (target === path.join(dir, "test")) {
            const error = new Error("EACCES: permission denied");
            error.code = "EACCES";
            throw error;
          }
          return fs.readdirSync(target, options);
        },
      }),
    (error) => error.code === "AUTHORIZATION_SURFACE_UNREADABLE",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
