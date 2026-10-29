import fs from "node:fs";
import path from "node:path";

import { isVerificationFile } from "./authorization.js";
import { resolveWorkspacePath } from "./chatgpt-web-paths.js";

/**
 * The `apply_patch` action: one unified diff, many files, validated up front.
 *
 * Every hunk is applied in memory first; if any hunk does not match, nothing is
 * written and the model gets the file, hunk number and the context it needs to
 * retry. That keeps a multi-file patch from landing half-applied. Paths go
 * through the same workspace boundary as every other tool, and a patch can only
 * create, update or delete regular files inside the workspace.
 */

function failure(code, detail) {
  return { ok: false, code, detail };
}

function coded(code, detail) {
  const error = new Error(detail);
  error.code = code;
  return error;
}

function headerPath(line, prefix) {
  let value = line.slice(prefix.length).trim();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
  value = value.split("\t")[0].trim();
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  return value || null;
}

/**
 * Parse one unified diff. Supported headers: `diff --git`, `index`, mode lines,
 * `---`/`+++`, `@@ -l,s +l,s @@`, and the `\ No newline at end of file` marker.
 * Anything else that is not hunk content is an error rather than being ignored,
 * so a malformed patch never silently loses a file.
 */
export function parsePatch(text) {
  const source = `${text ?? ""}`;
  if (!source.trim()) throw coded("PATCH_EMPTY", "patch is empty");
  const lines = source.split(/\r?\n/);
  const files = [];
  let current = null;
  let hunk = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  const closeHunk = () => {
    if (!hunk) return;
    if (oldRemaining !== 0 || newRemaining !== 0) {
      throw coded(
        "PATCH_INVALID",
        `hunk at line ${hunk.headerLine} declares ${hunk.oldLines}/${hunk.newLines} lines but only ${hunk.oldSeen}/${hunk.newSeen} were present`,
      );
    }
    current.hunks.push(hunk);
    hunk = null;
    oldRemaining = 0;
    newRemaining = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (line.startsWith("diff --git")) {
      closeHunk();
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("Binary files")) {
      throw coded("PATCH_BINARY", `binary diffs are not supported (line ${lineNumber})`);
    }
    if (line.startsWith("--- ")) {
      closeHunk();
      const next = lines[index + 1] ?? "";
      if (!next.startsWith("+++ ")) {
        throw coded("PATCH_INVALID", `line ${lineNumber}: "---" header has no matching "+++" header`);
      }
      current = { oldPath: headerPath(line, "--- "), newPath: headerPath(next, "+++ "), hunks: [] };
      files.push(current);
      index += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!current) throw coded("PATCH_INVALID", `line ${lineNumber}: hunk before any file header`);
      closeHunk();
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw coded("PATCH_INVALID", `line ${lineNumber}: unreadable hunk header`);
      hunk = {
        headerLine: lineNumber,
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        oldSeen: 0,
        newSeen: 0,
        noNewline: false,
        lines: [],
      };
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
      continue;
    }
    // A trailing blank produced by the patch's own final newline is not a
    // context line once the hunk has consumed its declared counts.
    if (line === "" && hunk && oldRemaining === 0 && newRemaining === 0) {
      closeHunk();
      continue;
    }
    if (!hunk) {
      if (!line.trim()) continue;
      throw coded("PATCH_INVALID", `line ${lineNumber}: unexpected content outside a hunk`);
    }
    if (line.startsWith("\\")) {
      hunk.noNewline = true;
      continue;
    }
    const tag = line[0];
    if (tag !== " " && tag !== "-" && tag !== "+" && line !== "") {
      // A new file header can start without consuming the rest of a hunk only
      // when the hunk was already complete; otherwise this is malformed.
      if (oldRemaining === 0 && newRemaining === 0) {
        closeHunk();
        index -= 1;
        continue;
      }
      throw coded("PATCH_INVALID", `line ${lineNumber}: "${tag}" is not a hunk line`);
    }
    const text = line === "" ? "" : line.slice(1);
    if (tag === " " || line === "") {
      hunk.lines.push({ tag: " ", text });
      hunk.oldSeen += 1;
      hunk.newSeen += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    } else if (tag === "-") {
      hunk.lines.push({ tag: "-", text });
      hunk.oldSeen += 1;
      oldRemaining -= 1;
    } else {
      hunk.lines.push({ tag: "+", text });
      hunk.newSeen += 1;
      newRemaining -= 1;
    }
  }
  closeHunk();

  if (!files.length) throw coded("PATCH_NO_FILES", "the patch contains no file headers");
  for (const file of files) {
    if (!file.oldPath && !file.newPath) {
      throw coded("PATCH_INVALID", "a file header names neither an old nor a new path");
    }
  }
  return files;
}

function splitText(text) {
  if (text === "") return { lines: [], eol: "\n", finalNewline: true };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

/** Find the hunk's pre-image: at the declared line when possible, else uniquely. */
function locate(lines, preImage, expected) {
  if (!preImage.length) return { index: Math.min(Math.max(0, expected), lines.length), ambiguous: false };
  const matches = [];
  for (let index = 0; index + preImage.length <= lines.length; index += 1) {
    let same = true;
    for (let offset = 0; offset < preImage.length; offset += 1) {
      if (lines[index + offset] !== preImage[offset]) {
        same = false;
        break;
      }
    }
    if (same) matches.push(index);
  }
  if (!matches.length) return { index: -1, ambiguous: false };
  if (matches.includes(expected)) return { index: expected, ambiguous: false };
  if (matches.length === 1) return { index: matches[0], ambiguous: false };
  return { index: -1, ambiguous: true };
}

function hunkFailure(file, hunkIndex, hunk, ambiguous) {
  const context = hunk.lines
    .filter((line) => line.tag !== "+")
    .slice(0, 4)
    .map((line) => `  ${line.tag}${line.text}`)
    .join("\n");
  return failure(
    "PATCH_HUNK_FAILED",
    `${file}: hunk ${hunkIndex + 1} at declared line ${hunk.oldStart} ${
      ambiguous ? "matches more than one place" : "does not match the current file"
    }.\n${context}`,
  );
}

function planFile(workspace, file, limits) {
  const kind = !file.oldPath ? "create" : !file.newPath ? "delete" : "update";
  const relative = file.newPath || file.oldPath;
  let absolute;
  try {
    absolute = resolveWorkspacePath(workspace, relative, { forWrite: true });
  } catch (error) {
    return { error: failure(error.code || "PATCH_PATH", `${error.message}`) };
  }

  if (kind === "create" && fs.existsSync(absolute)) {
    return { error: failure("PATCH_FILE_EXISTS", `${relative} already exists; use an update hunk for it`) };
  }
  if (kind !== "create" && !fs.existsSync(absolute)) {
    return { error: failure("PATCH_FILE_MISSING", `${relative} does not exist`) };
  }
  if (kind !== "create") {
    try {
      if (!fs.statSync(absolute).isFile()) return { error: failure("PATCH_TARGET_DIRECTORY", `${relative} is not a file`) };
    } catch (error) {
      return { error: failure("PATCH_READ_FAILED", `${relative}: ${error.message}`) };
    }
  }

  if (kind === "delete") return { kind, relative, absolute, text: null, summary: `D ${relative}` };

  let original = "";
  if (kind === "update") {
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > limits.patchFileBytes) {
        return { error: failure("PATCH_FILE_TOO_LARGE", `${relative} is larger than ${limits.patchFileBytes} bytes`) };
      }
      original = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      return { error: failure("PATCH_READ_FAILED", `${relative}: ${error.message}`) };
    }
  }

  const { lines, eol, finalNewline } = splitText(original);
  let delta = 0;
  let noNewline = false;
  let added = 0;
  let removed = 0;

  for (let index = 0; index < file.hunks.length; index += 1) {
    const hunk = file.hunks[index];
    const preImage = hunk.lines.filter((line) => line.tag !== "+").map((line) => line.text);
    const postImage = hunk.lines.filter((line) => line.tag !== "-").map((line) => line.text);
    const expected = hunk.oldLines === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1) + delta;
    const found = locate(lines, preImage, expected);
    if (found.index === -1) return { error: hunkFailure(relative, index, hunk, found.ambiguous) };
    lines.splice(found.index, preImage.length, ...postImage);
    delta += postImage.length - preImage.length;
    added += hunk.lines.filter((line) => line.tag === "+").length;
    removed += hunk.lines.filter((line) => line.tag === "-").length;
    if (hunk.noNewline) noNewline = true;
  }

  const wantsNewline = noNewline ? false : kind === "create" ? true : finalNewline;
  const text = `${lines.join(eol)}${wantsNewline && lines.length ? eol : ""}`;
  const marker = kind === "create" ? "A" : "M";
  return { kind, relative, absolute, text, summary: `${marker} ${relative} (+${added} -${removed})` };
}

export function applyPatchTool(workspace, action, { mode = "workspace-write", limits } = {}) {
  if (mode === "read-only") {
    return failure("MODE_REFUSES_WRITE", "this run is read-only, so the patch was not applied");
  }
  const text = `${action.patch ?? ""}`;
  if (!text.trim()) return failure("PATCH_EMPTY", "patch is required");
  if (Buffer.byteLength(text) > limits.patchBytes) {
    return failure("PATCH_TOO_LARGE", `patch is larger than ${limits.patchBytes} bytes`);
  }

  let files;
  try {
    files = parsePatch(text);
  } catch (error) {
    return failure(error.code || "PATCH_INVALID", `${error.message}`);
  }
  if (files.length > limits.patchFiles) {
    return failure("PATCH_TOO_MANY_FILES", `patch touches ${files.length} files; the limit is ${limits.patchFiles}`);
  }

  const plans = [];
  for (const file of files) {
    const plan = planFile(workspace, file, limits);
    if (plan.error) return plan.error;
    plans.push(plan);
  }

  try {
    for (const plan of plans) {
      if (plan.kind === "delete") {
        fs.rmSync(plan.absolute);
        continue;
      }
      fs.mkdirSync(path.dirname(plan.absolute), { recursive: true });
      fs.writeFileSync(plan.absolute, plan.text, "utf8");
    }
  } catch (error) {
    return failure("PATCH_WRITE_FAILED", `${error.message}`);
  }

  const surface = plans.map((plan) => plan.relative).filter((file) => isVerificationFile(file));
  return {
    ok: true,
    detail: `${plans.length} file(s) patched${surface.length ? ` · execution surface touched` : ""}`,
    body: [
      ...plans.map((plan) => plan.summary),
      ...(surface.length ? [`execution surface: ${surface.join(", ")}`] : []),
    ].join("\n"),
    mutated: true,
    changedFiles: plans.map((plan) => plan.relative),
  };
}
