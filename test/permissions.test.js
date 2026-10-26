import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertCredentialFree,
  assertTrustedProject,
  clearProjectRootCache,
  permissionOverlay,
  projectExtensions,
  projectRoot,
  workspacePrefix,
  writePermissionOverlay,
} from "../lib/permissions.js";

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

test("the overlay never copies provider credentials, even from a custom OPENCODE_CONFIG", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  const userFile = path.join(dir, "user.json");
  fs.writeFileSync(
    userFile,
    JSON.stringify({
      provider: { freedeepseek: { options: { apiKey: "sk-should-never-be-copied", baseURL: "http://127.0.0.1:9655/v1" } } },
      permission: { webfetch: "deny" },
    }),
  );

  const overlay = writePermissionOverlay({
    workspace: nested,
    mode: "workspace-write",
    env: { OPENCODE_CONFIG: userFile },
  });
  const raw = fs.readFileSync(overlay.file, "utf8");
  const data = JSON.parse(raw);

  assert.equal(data.provider, undefined);
  assert.equal(raw.includes("sk-should-never-be-copied"), false);
  assert.equal(data.permission.bash, "ask");
  assert.ok(overlay.warnings.some((warning) => /not copied/.test(warning)));

  overlay.cleanup();
  assert.equal(fs.existsSync(overlay.file), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a model token limit may ride along, but provider options and keys may not", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  const modelConfig = {
    provider: { openrouter: { models: { "openai/gpt-5.6-terra": { limit: { output: 8192, context: 1050000 } } } } },
  };

  const overlay = writePermissionOverlay({
    workspace: nested,
    mode: "workspace-write",
    modelConfig,
    env: { PATH: process.env.PATH },
  });
  const data = JSON.parse(fs.readFileSync(overlay.file, "utf8"));
  assert.equal(data.provider.openrouter.models["openai/gpt-5.6-terra"].limit.output, 8192);
  assert.equal(data.provider.openrouter.options, undefined);
  assert.equal(data.permission.bash, "ask");
  overlay.cleanup();

  assert.throws(
    () => writePermissionOverlay({ workspace: nested, mode: "workspace-write", modelConfig: { provider: { openrouter: { options: { apiKey: "sk-x" } } } }, env: { PATH: process.env.PATH } }),
    /can hold a credential/,
  );
  assert.throws(() => assertCredentialFree({ provider: { openrouter: { headers: {} } } }), /headers/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("project-level OpenCode configuration is refused unless explicitly trusted", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ plugin: ["some-plugin"] }));

  assert.deepEqual(projectExtensions(dir).found, ["opencode.json"]);
  assert.throws(() => assertTrustedProject(dir), /PROJECT_EXTENSIONS_UNTRUSTED|Project-level OpenCode configuration/);
  assert.throws(() => writePermissionOverlay({ workspace: nested, mode: "workspace-write", env: { PATH: process.env.PATH } }), /Project-level/);
  assert.equal(assertTrustedProject(dir, { trust: true }).trusted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the project root is resolved once per process, and can be re-resolved", () => {
  const dir = tempRepo();
  const nested = path.join(dir, "nested", "workspace");
  clearProjectRootCache();
  assert.equal(projectRoot(nested), fs.realpathSync.native(dir));

  // Making the nested directory its own repository must not change a cached
  // answer, because a run cannot change it mid-flight either.
  spawnSync("git", ["init", "-q"], { cwd: nested });
  assert.equal(projectRoot(nested), fs.realpathSync.native(dir));

  clearProjectRootCache();
  assert.equal(projectRoot(nested), fs.realpathSync.native(nested));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a malformed permission mode fails instead of diverging from the policy", () => {
  const dir = tempRepo();
  assert.throws(() => permissionOverlay({ workspace: dir, mode: "yolo" }), /Unknown mode/);
  fs.rmSync(dir, { recursive: true, force: true });
});
