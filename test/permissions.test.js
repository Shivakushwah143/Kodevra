import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { permissionOverlay, workspacePrefix, writePermissionOverlay } from "../lib/permissions.js";

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-perm-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "nested", "workspace"), { recursive: true });
  return dir;
}

test("the project prefix is empty when the workspace is the repo root", () => {
  const dir = tempRepo();
  assert.equal(workspacePrefix(dir), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a nested workspace is scoped relative to the project root", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  assert.equal(workspacePrefix(nested), "nested/workspace/");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("read is denied outside the workspace and allowed inside", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  for (const mode of ["read-only", "ask", "workspace-write"]) {
    const { read } = permissionOverlay({ workspace: nested, mode });
    assert.equal(read["*"], "deny");
    assert.equal(read["nested/workspace/**"], "allow");
    assert.equal(read["nested/workspace/*.env"], "ask");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("edit follows the mode, shell always needs approval, externals are denied", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");

  assert.equal(permissionOverlay({ workspace: nested, mode: "read-only" }).edit, "deny");
  assert.equal(permissionOverlay({ workspace: nested, mode: "ask" }).edit, "ask");
  assert.deepEqual(permissionOverlay({ workspace: nested, mode: "workspace-write" }).edit, {
    "*": "deny",
    "nested/workspace/**": "allow",
  });

  for (const mode of ["read-only", "ask", "workspace-write"]) {
    const overlay = permissionOverlay({ workspace: nested, mode });
    assert.equal(overlay.bash, "ask");
    assert.equal(overlay.external_directory, "deny");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("with the docker executor, native bash is denied and sandbox_exec is allowed", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  const overlay = permissionOverlay({ workspace: nested, mode: "workspace-write", sandboxExec: true });
  assert.equal(overlay.bash, "deny");
  assert.equal(overlay.sandbox_exec, "allow");
  assert.equal(overlay.external_directory, "deny");
  assert.equal(permissionOverlay({ workspace: nested, mode: "workspace-write" }).sandbox_exec, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the overlay file carries permission rules only and is cleaned up", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  const overlay = writePermissionOverlay({
    workspace: nested,
    mode: "workspace-write",
    env: { PATH: process.env.PATH },
  });

  assert.ok(overlay.file);
  assert.equal(overlay.env.OPENCODE_CONFIG, overlay.file);
  const data = JSON.parse(fs.readFileSync(overlay.file, "utf8"));
  assert.equal(data.permission.external_directory, "deny");
  assert.equal(data.permission.bash, "ask");
  assert.equal(data.provider, undefined);

  overlay.cleanup();
  assert.equal(fs.existsSync(overlay.file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a user-managed OPENCODE_CONFIG is merged, not replaced", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  const userFile = path.join(dir, "user.json");
  fs.writeFileSync(userFile, JSON.stringify({ model: "freedeepseek/deepseek-v4-flash", permission: { webfetch: "deny" } }));

  const overlay = writePermissionOverlay({
    workspace: nested,
    mode: "workspace-write",
    env: { OPENCODE_CONFIG: userFile },
  });
  const data = JSON.parse(fs.readFileSync(overlay.file, "utf8"));
  assert.equal(data.model, "freedeepseek/deepseek-v4-flash");
  assert.equal(data.permission.webfetch, "deny");
  assert.equal(data.permission.bash, "ask");
  assert.equal(data.permission.external_directory, "deny");

  overlay.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});
