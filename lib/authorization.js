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
 * stale and the command is not executed again until the developer renews it
 * (`--reapprove`). This is what stops a repair loop from "fixing" the test.
 */

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

const MAX_FILES = 400;
const MAX_DEPTH = 8;
const MAX_BYTES = 1024 * 1024;

function toPosix(value) {
  return value.split(path.sep).join("/");
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

function walk(root, { filter = () => true, limit = MAX_FILES } = {}) {
  const found = [];
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length && found.length < limit) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue;
        stack.push({ dir: absolute, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (filter(absolute)) found.push(absolute);
      if (found.length >= limit) break;
    }
  }
  return found;
}

function hashFile(absolute) {
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_BYTES) return `large:${stat.size}`;
    return createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
  } catch {
    return "unreadable";
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

function commandFiles(workspace, command) {
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
      files.push(...walk(absolute, { limit: 100 }));
    }
  }
  return files;
}

/**
 * Hash every file that can affect the verification command.
 * Returns `{ files: [{ path, sha256 }], fingerprint }`.
 */
export function verificationSurface(workspace, command) {
  const root = path.resolve(workspace);
  const absolute = new Set();

  for (const file of walk(root, { filter: (candidate) => isVerificationFile(path.relative(root, candidate)) })) {
    absolute.add(file);
  }
  for (const file of commandFiles(root, command)) {
    absolute.add(file);
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
 * `ok: false` means the command must not run until it is reapproved.
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
    // A changed command is also a changed authorization, even if files match.
    commandChanged: command !== authorization.command,
  };
}

/** Rename an authorization onto the current surface (after explicit reapproval). */
export function renewAuthorization(authorization, { workspace, command }) {
  const surface = verificationSurface(workspace, command);
  return {
    ...authorization,
    command,
    fingerprint: surface.fingerprint,
    files: surface.files,
    renewedAt: new Date().toISOString(),
    source: "developer --reapprove",
  };
}
