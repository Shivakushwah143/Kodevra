import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Verification authorization.
 *
 * `--verify "<command>"` is the developer's explicit authorization to run that
 * command on this host. The authorization is bound to a fingerprint of the files
 * that decide what the command actually does: package scripts, lockfiles, test
 * runner config, test files, and any path the command names.
 *
 * If the agent edits one of those files during the run, the authorization is
 * stale and the command is not executed again until the developer renews it by
 * naming the new fingerprint.
 *
 * This module fails closed. A file whose content cannot be read, a directory
 * that cannot be listed, or a surface larger than the limit raises
 * AUTHORIZATION_SURFACE_UNREADABLE / _TOO_LARGE. A partial fingerprint is never
 * returned as if it were the whole surface.
 */

export const SURFACE_UNREADABLE = "AUTHORIZATION_SURFACE_UNREADABLE";
export const SURFACE_TOO_LARGE = "AUTHORIZATION_SURFACE_TOO_LARGE";
export const MAX_SURFACE_FILES = 5_000;

const EXACT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.json",
  "deno.lock",
  "pyproject.toml",
  "pytest.ini",
  "tox.ini",
  "setup.cfg",
  "Makefile",
  "makefile",
  "justfile",
  "Taskfile.yml",
]);

const RUNNER_CONFIG = /^(vitest|jest|playwright|cypress|mocha|ava|karma|tsconfig|babel|eslint|jasmine|wdio|nyc|webpack|rollup|vite)\.[a-z0-9.]+$/i;
const CONFIG_SUFFIX = /\.(config|conf)\.(js|cjs|mjs|ts|json|ya?ml)$/i;
const DOT_CONFIG = /^\.(mocharc|nycrc|babelrc|eslintrc)/i;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".tmp",
]);

const HASH_CHUNK = 256 * 1024;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function surfaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Whether a workspace-relative path can influence a verification command. */
export function isVerificationFile(relative) {
  const posix = toPosix(relative);
  const base = posix.split("/").pop();
  if (EXACT_FILES.has(base)) return true;
  if (CONFIG_SUFFIX.test(base) || RUNNER_CONFIG.test(base) || DOT_CONFIG.test(base)) return true;
  if (/(^|\/)(test|tests|__tests__|spec|e2e)(\/|$)/i.test(posix)) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(base)) return true;
  if (/^test_.*\.py$/i.test(base) || /_test\.(py|go|rs|rb)$/i.test(base)) return true;
  return false;
}

function isInside(workspace, target) {
  const relative = path.relative(workspace, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * List every candidate file. There is no depth cut and no silent truncation:
 * exceeding `limit` throws instead of hashing the first N files.
 */
function walk(root, { filter = () => true, limit = MAX_SURFACE_FILES, readdir = fs.readdirSync } = {}) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir } = stack.pop();
    let entries;
    try {
      entries = readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw surfaceError(
        SURFACE_UNREADABLE,
        `Cannot list ${dir} while fingerprinting the verification surface: ${error.message}`,
      );
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push({ dir: absolute });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!filter(absolute)) continue;
      found.push(absolute);
      if (found.length > limit) {
        throw surfaceError(
          SURFACE_TOO_LARGE,
          `The verification surface has more than ${limit} files. Narrow the test scope or raise the limit explicitly; Kodevra will not authorize a partial surface.`,
        );
      }
    }
  }
  return found;
}

/** Stream a file through SHA-256. Size is irrelevant; content is the identity. */
function hashFile(absolute) {
  let fd;
  try {
    fd = fs.openSync(absolute, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(HASH_CHUNK);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, HASH_CHUNK, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest("hex");
  } catch (error) {
    throw surfaceError(
      SURFACE_UNREADABLE,
      `Cannot read ${absolute} while fingerprinting the verification surface: ${error.message}`,
    );
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function commandTokens(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(command || ""))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function commandFiles(workspace, command, { limit = MAX_SURFACE_FILES } = {}) {
  const files = [];
  for (const token of commandTokens(command)) {
    if (!token || token.startsWith("-") || token.length > 260) continue;
    const absolute = path.resolve(workspace, token);
    if (!isInside(workspace, absolute) && absolute !== workspace) continue;
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      files.push(absolute);
    } else if (stat.isDirectory()) {
      files.push(...walk(absolute, { limit }));
    }
  }
  return files;
}

/**
 * Hash every file that can affect the verification command.
 * Returns `{ files: [{ path, sha256 }], fingerprint }` or throws.
 */
export function verificationSurface(workspace, command, { maxFiles = MAX_SURFACE_FILES, readdir } = {}) {
  const root = path.resolve(workspace);
  const absolute = new Set();

  for (const file of walk(root, {
    filter: (candidate) => isVerificationFile(path.relative(root, candidate)),
    limit: maxFiles,
    readdir,
  })) {
    absolute.add(file);
  }
  for (const file of commandFiles(root, command, { limit: maxFiles })) {
    absolute.add(file);
  }
  if (absolute.size > maxFiles) {
    throw surfaceError(
      SURFACE_TOO_LARGE,
      `The verification surface has ${absolute.size} files, over the ${maxFiles}-file limit. Kodevra will not authorize a partial surface.`,
    );
  }

  const files = [...absolute]
    .map((file) => ({ path: toPosix(path.relative(root, file)), sha256: hashFile(file) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const fingerprint = createHash("sha256")
    .update(`cmd:${command}\n`)
    .update(files.map((file) => `${file.path}:${file.sha256}`).join("\n"))
    .digest("hex");

  return { files, fingerprint };
}

/** The developer's authorization record for one run. */
export function createVerificationAuthorization({ workspace, command }) {
  const surface = verificationSurface(workspace, command);
  return {
    command,
    workspace: path.resolve(workspace),
    fingerprint: surface.fingerprint,
    files: surface.files,
    authorizedAt: new Date().toISOString(),
    source: "developer --verify",
  };
}

/**
 * Compare the current surface with what the developer authorized.
 * `ok: false` means the command must not run until the developer names the new
 * fingerprint explicitly.
 */
export function authorizationDrift(authorization, { workspace, command }) {
  const surface = verificationSurface(workspace, command);
  const before = new Map(authorization.files.map((file) => [file.path, file.sha256]));
  const after = new Map(surface.files.map((file) => [file.path, file.sha256]));

  const changed = [];
  const added = [];
  const removed = [];

  for (const [file, hash] of after) {
    if (!before.has(file)) added.push(file);
    else if (before.get(file) !== hash) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) removed.push(file);
  }

  const ok = surface.fingerprint === authorization.fingerprint;
  return {
    ok,
    changed,
    added,
    removed,
    fingerprint: surface.fingerprint,
    files: surface.files,
    commandChanged: command !== authorization.command,
  };
}

/**
 * The part of the verification surface normal coding is allowed to change: test
 * files and test-runner configuration. Manifests, lockfiles, build config and
 * anything the command names by path stay developer-authorized only, because
 * editing them can change what `--verify` actually proves.
 */
const TEST_CONFIG = /^(vitest|jest|playwright|cypress|mocha|ava|karma|jasmine|wdio|nyc)\.config\.[a-z0-9.]+$/i;
const TEST_DOT_CONFIG = /^\.(mocharc|nycrc|jasmine)[a-z0-9.]*$/i;
// Setup/teardown modules are part of the test run even though their names do
// not match `*.test.*`.
const TEST_SETUP = /^(vitest|jest|mocha|karma|wdio|cypress)\.(setup|teardown|global-setup|global-teardown)\.[a-z0-9.]+$/i;

/**
 * Manifest, lockfile and build-runner files stay developer-authorized: editing
 * one can change which binary `--verify` runs, not just which tests it selects.
 * Test-runner ini files are not in this set - adding `pytest.ini` is normal
 * regression work.
 */
const DEVELOPER_ONLY = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "deno.json",
  "deno.lock",
  "pyproject.toml",
  "setup.cfg",
  "Makefile",
  "makefile",
  "justfile",
  "Taskfile.yml",
]);

export function isTestSurfacePath(relative) {
  const posix = toPosix(`${relative ?? ""}`).replace(/^\.\//, "");
  if (!posix) return false;
  const base = posix.split("/").pop() ?? "";
  if (DEVELOPER_ONLY.has(base)) return false;
  if (base === "pytest.ini" || base === "tox.ini") return true;
  if (/(^|\/)(test|tests|__tests__|spec|e2e)\//i.test(posix)) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(base)) return true;
  if (/^test_.*\.py$/i.test(base) || /_test\.(py|go|rs|rb)$/i.test(base)) return true;
  if (/^tsconfig\.(spec|test|tests)\.json$/i.test(base)) return true;
  return TEST_CONFIG.test(base) || TEST_DOT_CONFIG.test(base) || TEST_SETUP.test(base);
}

/**
 * Re-authorize a verification surface that the agent itself changed, but only
 * for test/config work and only under balanced or autonomous policy. Strict
 * runs still require the developer to name the new fingerprint with
 * `--reapprove`, and a surface change outside the agent's own test edits is
 * always refused.
 */
export function renewAgentSurface({
  authorization,
  drift = null,
  workspace,
  command,
  approval = "balanced",
  changedFiles = [],
  renewals = 0,
  maxRenewals = 4,
} = {}) {
  const policy = `${approval ?? ""}`.toLowerCase();
  if (policy !== "balanced" && policy !== "autonomous") {
    return {
      ok: false,
      renewed: false,
      reason: `${policy || "strict"} policy requires the developer to re-authorize the verification surface (--reapprove <fingerprint>)`,
    };
  }
  if (renewals >= maxRenewals) {
    return {
      ok: false,
      renewed: false,
      reason: `verification was re-authorized ${maxRenewals} times in one run; review the test surface before continuing`,
    };
  }

  const current = drift ?? authorizationDrift(authorization, { workspace, command });
  if (current.ok) return { ok: true, renewed: false, authorization, drift: current };

  const touched = new Set(
    [...changedFiles]
      .map((file) => toPosix(`${file ?? ""}`).replace(/^\.\//, ""))
      .filter(Boolean),
  );
  const drifted = [...current.changed, ...current.added, ...current.removed].map((file) =>
    toPosix(file).replace(/^\.\//, ""),
  );
  if (!drifted.length) {
    return {
      ok: false,
      renewed: false,
      reason: "the verification fingerprint changed but no file drift was reported",
      drift: current,
    };
  }
  const outside = drifted.filter((file) => !isTestSurfacePath(file) || !touched.has(file));
  if (outside.length) {
    return {
      ok: false,
      renewed: false,
      reason: `verification surface changed outside the agent's test/config edits: ${outside.slice(0, 5).join(", ")}`,
      files: outside,
      drift: current,
    };
  }

  let next;
  try {
    next = createVerificationAuthorization({ workspace, command });
  } catch (error) {
    return {
      ok: false,
      renewed: false,
      reason: `the updated test surface could not be hashed: ${error.message}`,
      drift: current,
    };
  }
  next.source = `agent:${policy} tests`;
  next.renewedFrom = authorization.fingerprint;
  next.renewedAt = new Date().toISOString();
  return { ok: true, renewed: true, authorization: next, drift: current };
}

/**
 * Bind an authorization to the current surface, but only when the developer
 * named exactly that fingerprint. A bare `--reapprove` is not enough.
 */
export function renewAuthorization(authorization, { workspace, command, fingerprint }) {
  const drift = authorizationDrift(authorization, { workspace, command });
  if (!fingerprint || fingerprint !== drift.fingerprint) {
    return { renewed: false, drift, authorization };
  }
  const surface = verificationSurface(workspace, command);
  return {
    renewed: true,
    drift,
    authorization: {
      ...authorization,
      command,
      fingerprint: surface.fingerprint,
      files: surface.files,
      renewedAt: new Date().toISOString(),
      source: "developer --reapprove <fingerprint>",
    },
  };
}
