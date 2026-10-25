import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isExcluded, stageWorkspace } from "../lib/sandbox.js";

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-sandbox-"));
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "integrations", "proxy"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "test", "a.test.js"), "1;\n");
  fs.writeFileSync(path.join(dir, "src", "app.js"), "2;\n");
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=2\n");
  fs.writeFileSync(path.join(dir, "auth.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "deepseek-auth.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "id_rsa"), "key\n");
  fs.writeFileSync(path.join(dir, "server.pem"), "cert\n");
  fs.writeFileSync(path.join(dir, "integrations", "proxy", "auth.json"), "{}\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), "url\n");
  return dir;
}

test("credential and auth files never enter the snapshot", () => {
  for (const name of [".env", ".env.local", "auth.json", "deepseek-auth.json", "id_rsa", "server.pem"]) {
    assert.equal(isExcluded(name), true, name);
  }
  assert.equal(isExcluded("src/app.js"), false);
  assert.equal(isExcluded("test/a.test.js"), false);
});

test("staging copies the project and drops secrets, .git and integrations", () => {
  const dir = workspace();
  const destination = path.join(dir, "..", `${path.basename(dir)}-snapshot`);
  const staged = stageWorkspace({ workspace: dir, destination });

  assert.ok(fs.existsSync(path.join(destination, "package.json")));
  assert.ok(fs.existsSync(path.join(destination, "test", "a.test.js")));
  assert.ok(fs.existsSync(path.join(destination, "src", "app.js")));
  assert.equal(fs.existsSync(path.join(destination, ".env")), false);
  assert.equal(fs.existsSync(path.join(destination, "auth.json")), false);
  assert.equal(fs.existsSync(path.join(destination, "deepseek-auth.json")), false);
  assert.equal(fs.existsSync(path.join(destination, "server.pem")), false);
  assert.equal(fs.existsSync(path.join(destination, "integrations")), false);
  assert.equal(fs.existsSync(path.join(destination, ".git")), false);
  assert.ok(staged.files >= 3);
  assert.ok(staged.excluded >= 6);
  assert.ok(staged.bytes > 0);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a workspace that exceeds the staging budget fails instead of copying forever", () => {
  const dir = workspace();
  const destination = path.join(dir, "..", `${path.basename(dir)}-snapshot`);
  assert.throws(
    () => stageWorkspace({ workspace: dir, destination, limits: { maxFiles: 1, maxBytes: 1024 } }),
    (error) => error.code === "SNAPSHOT_TOO_LARGE",
  );
  fs.rmSync(destination, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
