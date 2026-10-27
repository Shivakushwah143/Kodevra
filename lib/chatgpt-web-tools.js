import fs from "node:fs";
import path from "node:path";

import { LIMITS } from "./chatgpt-web.js";

/**
 * Repository tools for the experimental ChatGPT-web loop.
 *
 * Every path is resolved against the selected workspace and refused if it
 * leaves it - including through a symlink/junction - so ChatGPT never gets more
 * reach than the developer granted for the run. There is no shell here at all:
 * the only process this experiment runs is the developer's own `--verify`
 * command, through the executor Kodevra already resolved.
 */

const SENSITIVE_FILE = /^(\.env(\..*)?|auth\.json|deepseek-auth\.json|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i;
const SENSITIVE_SUFFIX = /\.(pem|key|p12|pfx)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__", ".kodevra"]);

function refusal(code, detail) {
  return { ok: false, code, detail };
}

function isSensitive(absolute) {
  const name = path.basename(absolute);
  if (SENSITIVE_FILE.test(name) || SENSITIVE_SUFFIX.test(name)) return true;
  return absolute.split(path.sep).includes(".git");
}

/** Real path of the deepest existing ancestor, so a symlink cannot hide a jump. */
function realpathOfExisting(absolute) {
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

function isInside(root, target) {
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

function relativeName(workspace, absolute) {
  return path.relative(path.resolve(workspace), absolute).split(path.sep).join("/") || ".";
}

function readBounded(absolute) {
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "NOT_A_FILE" });
  const size = Math.min(stat.size, LIMITS.readBytes);
  const buffer = Buffer.alloc(size);
  const descriptor = fs.openSync(absolute, "r");
  try {
    fs.readSync(descriptor, buffer, 0, size, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (buffer.includes(0)) throw Object.assign(new Error("binary file"), { code: "BINARY_FILE" });
  const text = buffer.toString("utf8");
  return {
    text,
    truncated: stat.size > size,
    bytes: stat.size,
  };
}

function walk(workspace, start, visit) {
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

export function readFileTool(workspace, action) {
  try {
    const absolute = resolveWorkspacePath(workspace, action.path);
    const { text, truncated, bytes } = readBounded(absolute);
    return {
      ok: true,
      detail: truncated ? `showing the first ${LIMITS.readBytes} of ${bytes} bytes` : `${bytes} bytes`,
      body: text,
    };
  } catch (error) {
    return refusal(error.code || "READ_FAILED", `${error.message}`);
  }
}

export function listTool(workspace, action) {
  try {
    const absolute = resolveWorkspacePath(workspace, action.path || ".");
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) return refusal("NOT_A_DIRECTORY", `${action.path} is not a directory`);
    const entries = fs
      .readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => !isSensitive(path.join(absolute, entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, LIMITS.listEntries);
    const body = shown
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n");
    return {
      ok: true,
      detail: entries.length > shown.length ? `${shown.length} of ${entries.length} entries` : `${entries.length} entries`,
      body,
    };
  } catch (error) {
    return refusal(error.code || "LIST_FAILED", `${error.message}`);
  }
}

export function searchTool(workspace, action) {
  let start;
  try {
    start = resolveWorkspacePath(workspace, action.path || ".");
  } catch (error) {
    return refusal(error.code || "SEARCH_FAILED", `${error.message}`);
  }
  const needle = `${action.query}`.toLowerCase();
  if (!needle) return refusal("SEARCH_EMPTY", "query is empty");
  const hits = [];
  let scanned = 0;
  try {
    const root = fs.statSync(start).isFile() ? path.dirname(start) : start;
    walk(workspace, root, (absolute) => {
      if (hits.length >= LIMITS.searchResults) return false;
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        return true;
      }
      if (stat.size > LIMITS.searchFileBytes) return true;
      let buffer;
      try {
        buffer = fs.readFileSync(absolute);
      } catch {
        return true;
      }
      if (buffer.includes(0)) return true;
      scanned += 1;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        const text = lines[index].trim();
        hits.push(`${relativeName(workspace, absolute)}:${index + 1}: ${text.length > 180 ? `${text.slice(0, 180)}...` : text}`);
        if (hits.length >= LIMITS.searchResults) return false;
      }
      return true;
    });
  } catch (error) {
    return refusal("SEARCH_FAILED", `${error.message}`);
  }
  if (!hits.length) return { ok: true, detail: `no match in ${scanned} file(s)`, body: "" };
  return {
    ok: true,
    detail: `${hits.length} match(es) in ${scanned} file(s)${hits.length >= LIMITS.searchResults ? " (limit reached)" : ""}`,
    body: hits.join("\n"),
  };
}

export function writeFileTool(workspace, action) {
  try {
    const absolute = resolveWorkspacePath(workspace, action.path, { forWrite: true });
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${action.content ?? ""}`, "utf8");
    return { ok: true, detail: `wrote ${Buffer.byteLength(`${action.content ?? ""}`)} byte(s)`, body: "" };
  } catch (error) {
    return refusal(error.code || "WRITE_FAILED", `${error.message}`);
  }
}

export function editFileTool(workspace, action) {
  try {
    const absolute = resolveWorkspacePath(workspace, action.path, { forWrite: true });
    const { text, bytes } = readBounded(absolute);
    if (bytes > LIMITS.readBytes) {
      return refusal("FILE_TOO_LARGE", `${action.path} is larger than ${LIMITS.readBytes} bytes; use write with the full content`);
    }
    const occurrences = text.split(action.old).length - 1;
    if (occurrences === 0) return refusal("EDIT_NO_MATCH", `the old text does not occur in ${action.path}`);
    if (occurrences > 1) {
      return refusal("EDIT_AMBIGUOUS", `the old text occurs ${occurrences} times in ${action.path}; include more context`);
    }
    fs.writeFileSync(absolute, text.replace(action.old, action.new), "utf8");
    return { ok: true, detail: `replaced 1 occurrence in ${action.path}`, body: "" };
  } catch (error) {
    return refusal(error.code || "EDIT_FAILED", `${error.message}`);
  }
}

/**
 * Execute one non-verify action. `mode` is the run's automation mode: read-only
 * refuses writes instead of quietly downgrading them.
 */
export function executeTool(workspace, action, { mode = "workspace-write" } = {}) {
  if (action.action === "read") return readFileTool(workspace, action);
  if (action.action === "list") return listTool(workspace, action);
  if (action.action === "search") return searchTool(workspace, action);
  if (action.action === "write" || action.action === "edit") {
    if (mode === "read-only") {
      return refusal("MODE_REFUSES_WRITE", "this run is read-only, so the edit was not applied");
    }
    return action.action === "write" ? writeFileTool(workspace, action) : editFileTool(workspace, action);
  }
  return refusal("UNSUPPORTED_ACTION", `Kodevra has no tool for "${action.action}"`);
}
