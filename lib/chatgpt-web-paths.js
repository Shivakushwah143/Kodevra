import fs from "node:fs";
import path from "node:path";

/**
 * Workspace boundary for the ChatGPT-web tool layer.
 *
 * Every model-supplied path goes through `resolveWorkspacePath`, which refuses
 * absolute paths, `..` escapes, symlink/junction jumps and sensitive files. The
 * shell, patch and inspect primitives share these helpers so a new tool cannot
 * accidentally grow a weaker boundary than the existing ones.
 */

export const SENSITIVE_FILE = /^(\.env(\..*)?|auth\.json|deepseek-auth\.json|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i;
export const SENSITIVE_SUFFIX = /\.(pem|key|p12|pfx)$/i;
export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
  ".kodevra",
]);

export function isSensitive(absolute) {
  const name = path.basename(absolute);
  if (SENSITIVE_FILE.test(name) || SENSITIVE_SUFFIX.test(name)) return true;
  return absolute.split(path.sep).includes(".git");
}

/** Real path of the deepest existing ancestor, so a symlink cannot hide a jump. */
export function realpathOfExisting(absolute) {
  let current = absolute;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

export function isInside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Resolve a model-supplied path. Throws a coded error for anything outside the
 * workspace, a sensitive file, or an absolute path - never a silent fallback.
 */
export function resolveWorkspacePath(workspace, relative, { forWrite = false } = {}) {
  if (typeof relative !== "string" || !relative.trim()) {
    const error = new Error("path is required");
    error.code = "PATH_INVALID";
    throw error;
  }
  const raw = relative.trim();
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /^[\\/]/.test(raw)) {
    const error = new Error(`absolute paths are not allowed: ${raw}`);
    error.code = "PATH_OUTSIDE_WORKSPACE";
    throw error;
  }
  const root = path.resolve(workspace);
  const target = path.resolve(root, raw);
  if (!isInside(root, target)) {
    const error = new Error(`path leaves the workspace: ${raw}`);
    error.code = "PATH_OUTSIDE_WORKSPACE";
    throw error;
  }
  const realRoot = realpathOfExisting(root);
  const realTarget = realpathOfExisting(target);
  if (!isInside(realRoot, realTarget)) {
    const error = new Error(`path resolves outside the workspace: ${raw}`);
    error.code = "PATH_OUTSIDE_WORKSPACE";
    throw error;
  }
  if (isSensitive(target) || isSensitive(realTarget)) {
    const error = new Error(`that file is excluded from the experiment: ${raw}`);
    error.code = "PATH_SENSITIVE";
    throw error;
  }
  // A file that does not exist yet has no real path of its own, so a greenfield
  // workspace (or a new nested directory) would otherwise be judged by the real
  // path of its deepest existing ancestor's parent - refusing `package.json` at
  // the workspace root. The parent chain is what must stay inside.
  if (forWrite && !isInside(realRoot, realpathOfExisting(path.dirname(target)))) {
    const error = new Error(`parent directory leaves the workspace: ${raw}`);
    error.code = "PATH_OUTSIDE_WORKSPACE";
    throw error;
  }
  return target;
}

export function relativeName(workspace, absolute) {
  return path.relative(path.resolve(workspace), absolute).split(path.sep).join("/") || ".";
}

/** Depth-first walk of regular files, skipping dependencies, VCS and secrets. */
export function walk(workspace, start, visit) {
  const root = path.resolve(workspace);
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || isSensitive(absolute)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitive(absolute)) continue;
      if (visit(absolute, entry) === false) return;
    }
  }
  return root;
}
