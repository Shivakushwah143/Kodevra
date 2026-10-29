import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cacheDir, clearCache, fileIdentity, readCache, writeCache } from "../lib/cache.js";
import { probeDocker, resetDockerAvailability } from "../lib/docker-executor.js";
import { engineVersion } from "../lib/doctor.js";

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-cache-"));
  return { env: { KODEVRA_CACHE_DIR: dir }, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a cached value is only returned for its own key and window", () => {
  const { env, dir, cleanup } = tempEnv();
  assert.equal(cacheDir(env), dir);

  writeCache("probe", { key: "binary-a", value: "1.18.30", env });
  assert.equal(readCache("probe", { key: "binary-a", maxAgeMs: 60_000, env }), "1.18.30");
  assert.equal(readCache("probe", { key: "binary-b", maxAgeMs: 60_000, env }), null);
  assert.equal(readCache("probe", { key: "binary-a", maxAgeMs: 0, env }), "1.18.30");
  assert.equal(readCache("probe", { key: "binary-a", maxAgeMs: -1, env }), "1.18.30");

  clearCache("probe", env);
  assert.equal(readCache("probe", { key: "binary-a", maxAgeMs: 60_000, env }), null);
  cleanup();
});

test("an expired entry is a miss, and KODEVRA_NO_CACHE disables both directions", () => {
  const { env, cleanup } = tempEnv();
  writeCache("stale", { key: "k", value: ["a"], env });
  // Pretend the entry was written long ago.
  const file = path.join(env.KODEVRA_CACHE_DIR, "stale.json");
  const entry = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...entry, written_at: Date.now() - 10_000 }));
  assert.equal(readCache("stale", { key: "k", maxAgeMs: 1_000, env }), null);

  const off = { ...env, KODEVRA_NO_CACHE: "1" };
  writeCache("disabled", { key: "k", value: "x", env: off });
  assert.equal(readCache("disabled", { key: "k", maxAgeMs: 60_000, env: off }), null);
  assert.equal(fs.existsSync(path.join(env.KODEVRA_CACHE_DIR, "disabled.json")), false);
  assert.equal(fileIdentity(path.join(env.KODEVRA_CACHE_DIR, "does-not-exist")), null);
  cleanup();
});

test("the engine version is asked once and then served from the cache", () => {
  const { env, cleanup } = tempEnv();
  const engine = { command: process.execPath, shell: false };

  const first = engineVersion(engine, { env, ttlMs: 60_000 });
  assert.match(first.version, /^v\d+/);
  assert.equal(first.cached, false);

  const second = engineVersion(engine, { env, ttlMs: 60_000 });
  assert.equal(second.version, first.version);
  assert.equal(second.cached, true);

  const refreshed = engineVersion(engine, { env, ttlMs: 60_000, refresh: true });
  assert.equal(refreshed.cached, false);

  const disabled = engineVersion(engine, { env, ttlMs: 0 });
  assert.equal(disabled.cached, false);
  cleanup();
});

test("the Docker probe is answered once per process", () => {
  resetDockerAvailability();
  const first = probeDocker();
  const second = probeDocker();
  assert.equal(first, second, "the second probe reuses the first answer");
  assert.equal(typeof first.ok, "boolean");
  resetDockerAvailability();
});
