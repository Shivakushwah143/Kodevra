import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { LIMITS } from "./chatgpt-web.js";
import { inspectTool } from "./chatgpt-web-inspect.js";
import { applyPatchTool } from "./chatgpt-web-patch.js";
import { isSensitive, relativeName, resolveWorkspacePath, walk } from "./chatgpt-web-paths.js";
import { runShellTool } from "./chatgpt-web-shell.js";

/**
 * Repository tools for the experimental ChatGPT-web loop.
 *
 * Every path is resolved against the selected workspace and refused if it
 * leaves it - including through a symlink/junction - so ChatGPT never gets more
 * reach than the developer granted for the run. `shell` is the one primitive
 * that runs a process; it keeps the workspace as its cwd and is bounded by time
 * and output, but it is not an OS sandbox - the Docker executor remains the
 * isolated path for project code.
 */

export { resolveWorkspacePath } from "./chatgpt-web-paths.js";

function refusal(code, detail) {
  return { ok: false, code, detail };
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

/**
 * Bounded line range. Reads in chunks and stops as soon as the range is full,
 * so a huge file costs one pass only up to the requested region. `hasMore` and
 * `nextOffset` are what let the model continue instead of re-reading the head.
 */
function readRange(absolute, { offset = 1, limit = LIMITS.readLines, maxChars = LIMITS.readChars } = {}) {
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "NOT_A_FILE" });
  const descriptor = fs.openSync(absolute, "r");
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(64 * 1024);
  const lines = [];
  let pending = "";
  let lineNumber = 0;
  let chars = 0;
  let stopped = false;
  let binary = false;
  try {
    while (!stopped) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      const bytes = chunk.subarray(0, read);
      if (bytes.includes(0)) binary = true;
      pending += decoder.write(bytes);
      // A single line larger than 1 MB must not grow this buffer until OOM.
      if (pending.length > 1_000_000 && pending.indexOf("\n") === -1) {
        if (!lines.length && offset === 1) {
          lines.push(`${pending.slice(0, maxChars)}\n[line truncated at ${maxChars} characters]`);
        }
        lineNumber = Math.max(lineNumber, 1);
        stopped = true;
        break;
      }
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const raw = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lineNumber += 1;
        if (lineNumber < offset) continue;
        if (lines.length >= limit || chars >= maxChars) {
          stopped = true;
          break;
        }
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line.length + 1 > maxChars && !lines.length) {
          lines.push(`${line.slice(0, maxChars)}\n[line truncated at ${maxChars} characters]`);
          stopped = true;
          break;
        }
        if (lines.length && chars + line.length + 1 > maxChars) {
          stopped = true;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
      }
    }
    if (!stopped) {
      pending += decoder.end();
      if (pending.length) {
        lineNumber += 1;
        if (lineNumber >= offset) {
          if (lines.length >= limit || chars >= maxChars) stopped = true;
          else {
            const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
            if (line.length + 1 > maxChars && !lines.length) {
              lines.push(`${line.slice(0, maxChars)}\n[line truncated at ${maxChars} characters]`);
              stopped = true;
            } else if (lines.length && chars + line.length + 1 > maxChars) {
              stopped = true;
            } else {
              lines.push(line);
              chars += line.length + 1;
            }
          }
        }
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }

  if (binary) throw Object.assign(new Error("binary file"), { code: "BINARY_FILE" });
  if (!lineNumber) return { text: "", detail: "empty file (0 lines)", startLine: null, endLine: null, hasMore: false, nextOffset: null };
  if (!lines.length) {
    throw Object.assign(new Error(`offset ${offset} is past the end of the file (${lineNumber} lines)`), {
      code: "READ_RANGE_EMPTY",
    });
  }

  const startLine = offset;
  const endLine = offset + lines.length - 1;
  const hasMore = stopped;
  const size = `${stat.size}`;
  return {
    text: lines.join("\n"),
    startLine,
    endLine,
    hasMore,
    nextOffset: hasMore ? endLine + 1 : null,
    detail: hasMore
      ? `lines ${startLine}-${endLine} · more available · next offset ${endLine + 1} · file ${size} bytes`
      : `lines ${startLine}-${endLine} of ${lineNumber} (complete) · file ${size} bytes`,
  };
}

export function readFileTool(workspace, action) {
  try {
    const absolute = resolveWorkspacePath(workspace, action.path);
    const range = readRange(absolute, {
      offset: action.offset ?? 1,
      limit: action.limit ?? LIMITS.readLines,
      maxChars: LIMITS.readChars,
    });
    return { ok: true, detail: range.detail, body: range.text };
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
    const content = `${action.content ?? ""}`;
    // Rewriting identical bytes is not a workspace mutation; counting it would
    // invalidate a passing verification for nothing.
    try {
      const stat = fs.statSync(absolute);
      if (stat.isFile() && stat.size === Buffer.byteLength(content) && fs.readFileSync(absolute, "utf8") === content) {
        return { ok: true, detail: `no change to ${action.path}`, body: "", mutated: false, changedFiles: [] };
      }
    } catch {
      // a new file has nothing to compare against
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
    return {
      ok: true,
      detail: `wrote ${Buffer.byteLength(content)} byte(s)`,
      body: "",
      mutated: true,
      changedFiles: [relativeName(workspace, absolute)],
    };
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
    if (action.old === action.new) {
      return { ok: true, detail: `no change to ${action.path}`, body: "", mutated: false, changedFiles: [] };
    }
    fs.writeFileSync(absolute, text.replace(action.old, action.new), "utf8");
    return {
      ok: true,
      detail: `replaced 1 occurrence in ${action.path}`,
      body: "",
      mutated: true,
      changedFiles: [relativeName(workspace, absolute)],
    };
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

/** Actions allowed inside one batch; each is accounted exactly like a direct action. */
const BATCH_ACTIONS = new Set(["read", "list", "search", "inspect", "shell"]);

function description(operation) {
  const name = `${operation?.action ?? "?"}`;
  if (operation?.path) return `${name} ${operation.path}`;
  if (operation?.query) return `${name} "${operation.query}"`;
  if (operation?.focus) return `${name} "${operation.focus}"`;
  if (operation?.command) return `${name} ${operation.command}`;
  return name;
}

function clip(text, max) {
  const value = `${text ?? ""}`;
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

async function batchTool(workspace, action, { mode = "workspace-write", limits = LIMITS, authorize = null, executor = null } = {}) {
  const operations = action.operations;
  if (!Array.isArray(operations) || !operations.length) {
    return refusal("BATCH_EMPTY", "operations must be a non-empty array");
  }
  if (operations.length > limits.batchOperations) {
    return refusal("BATCH_TOO_LARGE", `batch has ${operations.length} operations; the limit is ${limits.batchOperations}`);
  }

  const sections = [];
  const changedFiles = new Set();
  let used = 0;
  let succeeded = 0;
  let mutated = false;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const name = `${operation?.action ?? ""}`.trim().toLowerCase();
    let result;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      result = refusal("BATCH_OP_INVALID", "each operation must be an object with an action");
    } else if (!BATCH_ACTIONS.has(name)) {
      result = refusal(
        "BATCH_OP_UNSUPPORTED",
        `"${name}" is not allowed inside a batch (allowed: ${[...BATCH_ACTIONS].join(", ")}); use apply_patch for multi-file edits`,
      );
    } else {
      // A nested operation is judged exactly like a direct one: the approval
      // policy is consulted before execution, so a batch cannot smuggle a
      // reviewed action past strict/balanced/autonomous modes.
      const nested = { ...operation, action: name };
      const approval = typeof authorize === "function" ? authorize(nested) : null;
      if (approval && approval.decision !== "allow") {
        result = refusal(
          approval.decision === "deny" ? "POLICY_DENIED" : "APPROVAL_REQUIRED",
          `${approval.reason} (approval mode: ${approval.policy})`,
        );
      } else {
        result = await executeAction(workspace, nested, { mode, limits, executor });
      }
    }
    if (result.ok) succeeded += 1;
    if (result.ok && result.mutated) {
      mutated = true;
      for (const file of result.changedFiles ?? []) changedFiles.add(file);
    }

    const header = `[${index + 1}] ${description(operation)} -> ${
      result.ok ? "ok" : `${result.code || "ERROR"}: ${result.detail}`
    }`;
    sections.push(header);
    if (result.ok && result.body) {
      const remaining = limits.batchChars - used;
      if (remaining <= 0) {
        sections.push("[output omitted: batch output limit reached]");
      } else {
        const body = clip(result.body, Math.min(limits.batchOpChars, remaining));
        used += body.length;
        sections.push(body);
      }
    }
  }

  const ok = succeeded === operations.length;
  return {
    ok,
    code: ok ? null : "BATCH_PARTIAL",
    detail: `${succeeded}/${operations.length} operation(s) succeeded`,
    body: sections.join("\n"),
    // A batch reports the union of what its operations really changed, so the
    // agent loop never has to guess from the top-level action name.
    mutated,
    changedFiles: [...changedFiles].sort(),
  };
}

/**
 * The async entry point used by the agent loop: dispatch one parsed action,
 * including the primitives that spawn a process or aggregate several results.
 */
export async function executeAction(workspace, action, { mode = "workspace-write", limits = LIMITS, authorize = null, executor = null } = {}) {
  // Callers may pass a partial budget (the agent's loop tests do); fill in the
  // defaults so a missing key cannot turn into an undefined bound.
  const budget = { ...LIMITS, ...limits };
  if (action.action === "shell") return runShellTool(workspace, action, { mode, limits: budget, executor });
  if (action.action === "apply_patch") return applyPatchTool(workspace, action, { mode, limits: budget });
  if (action.action === "inspect") return inspectTool(workspace, action, budget);
  if (action.action === "batch") return batchTool(workspace, action, { mode, limits: budget, authorize, executor });
  return executeTool(workspace, action, { mode });
}
