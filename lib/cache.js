import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A very small on-disk cache for facts that cost a subprocess to learn.
 *
 * Kodevra starts the engine before every run, and asking the engine anything
 * (`opencode --version`, `opencode models <provider>`) costs seconds. Those
 * answers only change when the binary or the credential store changes, so they
 * are cached against that identity: a new engine build or a new sign-in
 * invalidates the entry by itself, and a short TTL covers everything else.
 *
 * This is a cache, never a source of truth: a miss, an unreadable file or a
 * stale entry simply means the caller asks the engine again. Nothing here holds
 * a credential - only versions and model ids that the engine prints in public.
 */

const DEFAULT_MAX_AGE_MS = 0;

export function cacheDir(env = process.env) {
  if (env.KODEVRA_CACHE_DIR) return path.resolve(env.KODEVRA_CACHE_DIR);
  return path.join(os.homedir(), ".kodevra", "cache");
}

/** `KODEVRA_NO_CACHE=1` turns every read and write into a miss. */
export function cacheEnabled(env = process.env) {
  return env.KODEVRA_NO_CACHE !== "1";
}

function entryFile(name, env = process.env) {
  return path.join(cacheDir(env), `${String(name).replace(/[^a-z0-9._-]/gi, "_")}.json`);
}

/**
 * Read a cached value. A value is only returned when its `key` matches (when a
 * key is supplied) and it is younger than `maxAgeMs`.
 */
export function readCache(name, { key = null, maxAgeMs = DEFAULT_MAX_AGE_MS, env = process.env } = {}) {
  if (!cacheEnabled(env)) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(entryFile(name, env), "utf8"));
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") return null;
  if (key !== null && entry.key !== key) return null;
  if (maxAgeMs > 0 && !(Date.now() - Number(entry.written_at) < maxAgeMs)) return null;
  return entry.value ?? null;
}

/** Best-effort write: a cache that cannot be written must not fail the run. */
export function writeCache(name, { key = null, value, env = process.env } = {}) {
  if (!cacheEnabled(env)) return null;
  const file = entryFile(name, env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ key, written_at: Date.now(), value })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return file;
  } catch {
    return null;
  }
}

export function clearCache(name, env = process.env) {
  try {
    fs.rmSync(entryFile(name, env), { force: true });
  } catch {
    // nothing to remove
  }
}

/** Identity of a file on disk, so a cache entry follows the file it describes. */
export function fileIdentity(target) {
  try {
    const stat = fs.statSync(target);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}
