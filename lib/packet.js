import fs from "node:fs";
import path from "node:path";

/**
 * The workspace facts Kodevra hands to Codex before it starts.
 *
 * Native `codex exec` discovers the workspace itself, and on Windows that
 * discovery is where most of a short task goes: the sandbox refuses the shell's
 * own working directory, `npm` resolves to a blocked `.ps1` shim, and the
 * `apply_patch` helper rejects a PowerShell here-string. None of that is
 * reasoning about the task, and every wrong guess costs a full model round trip.
 *
 * This module produces *observations*, never instructions: the task text is
 * passed through untouched, Codex keeps its own system prompt, tools, sandbox
 * and agent loop, and nothing here changes the verification gate. The block is
 * bounded, deterministic and free of environment variables or credentials. It
 * also carries a short excerpt of the files the failing output named, because
 * that is the read the model would otherwise spend a turn on.
 */

export const PACKET_LIMITS = {
  files: 40,
  mentions: 8,
  head: 16,
  tail: 16,
  line: 180,
  // The failing output already names the files that matter. Reading them once
  // here removes the two read turns the model otherwise spends confirming what
  // the output said, so the first edit can be the first write.
  excerpts: 2,
  excerptLines: 40,
  excerptLine: 160,
  excerptBytes: 64_000,
};

/**
 * The block is deliberately one line.
 *
 * On Windows the Codex CLI is reached through a `.cmd` shim, which means the
 * prompt travels as part of a `cmd.exe` command line. A line break there ends
 * the command: everything after the first newline is dropped and the remainder
 * is executed as separate shell commands. A single-line block survives intact.
 */
const LINE_JOIN = " || ";

const FILE_EXTENSION =
  /[A-Za-z0-9_./\\-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|rb|go|rs|java|php|sh|ps1|txt|toml|yaml|yml)/g;

function clipLine(line, maxLine) {
  const text = String(line ?? "").replace(/\s+$/, "");
  return text.length > maxLine ? `${text.slice(0, maxLine - 1)}…` : text;
}

/**
 * Keep the head and the tail of a command's output: the first lines say what
 * failed, the last lines say why. The omission is stated with a count so the
 * model can ask for the rest instead of assuming it saw everything.
 */
export function clipOutput(text, { head = PACKET_LIMITS.head, tail = PACKET_LIMITS.tail, maxLine = PACKET_LIMITS.line } = {}) {
  // Blank lines carry no evidence once the block is one line long.
  const lines = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");

  if (lines.length <= head + tail) {
    return { text: lines.map((line) => clipLine(line, maxLine)).join("\n"), omitted: 0 };
  }

  const kept = [...lines.slice(0, head), `... ${lines.length - head - tail} lines omitted ...`, ...lines.slice(-tail)];
  return { text: kept.map((line) => clipLine(line, maxLine)).join("\n"), omitted: lines.length - head - tail };
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Paths that both appear in the output and exist in the workspace. */
export function referencedFiles(output, files = [], { limit = PACKET_LIMITS.mentions } = {}) {
  const known = files.map(normalizePath);
  const found = [];

  for (const match of String(output ?? "").matchAll(FILE_EXTENSION)) {
    const candidate = normalizePath(match[0]);
    const hit =
      known.find((file) => file === candidate) ??
      known.find((file) => file.endsWith(`/${candidate}`)) ??
      known.find((file) => file.split("/").pop() === candidate.split("/").pop());
    if (hit && !found.includes(hit)) found.push(hit);
    if (found.length >= limit) break;
  }

  return found;
}

function shellFacts(platform, workspace) {
  if (platform !== "win32") return [];
  return [
    "- shell: Codex's PowerShell starts in C:\\ and the sandbox denies Set-Location into the workspace, " +
      'so every command must use absolute paths - e.g. Get-Content "<ws>\\src\\file.js", ' +
      'npm.cmd --prefix "<ws>" test, git -C "<ws>" status. The npm.ps1 shim is ' +
      'blocked by execution policy; npm.cmd works. git may refuse the workspace as unsafe - ' +
      `git -c safe.directory="${workspace}" works. apply_patch must receive the whole patch as ONE quoted ` +
      'argument (apply_patch "*** Begin Patch ... *** End Patch"); a PowerShell here-string ' +
      "($patch = @'...'@) or piped stdin is rejected.",
  ].map((line) => line.replace(/\s+/g, " "));
}

const TEXT_FILE = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|rb|go|rs|java|php|sh|ps1|txt|toml|ya?ml)$/i;

function insideWorkspace(workspace, relative) {
  const root = path.resolve(workspace);
  const target = path.resolve(root, relative);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * A bounded, read-only excerpt of one file the failing output named. Returns
 * null for anything that is not a small text file inside the workspace, so a
 * crafted path cannot make the packet read outside the project.
 */
export function fileExcerpt(workspace, relative, limits = PACKET_LIMITS) {
  const normalized = normalizePath(relative);
  if (!TEXT_FILE.test(normalized) || !insideWorkspace(workspace, normalized)) return null;

  const absolute = path.resolve(workspace, normalized);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > limits.excerptBytes) return null;

  let text;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }

  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const kept = lines.slice(0, limits.excerptLines).map((line) => clipLine(line.trimStart(), limits.excerptLine));
  const omitted = lines.length - kept.length;
  const extent = omitted > 0 ? `first ${kept.length} of ${lines.length} lines` : "complete";
  return `${normalized} (${extent}): ${kept.join(LINE_JOIN)}${omitted > 0 ? `${LINE_JOIN}... ${omitted} more lines` : ""}`;
}

function readText(workspace, relative, limits = PACKET_LIMITS) {
  if (!insideWorkspace(workspace, relative)) return null;
  const absolute = path.resolve(workspace, relative);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > limits.excerptBytes) return null;
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/**
 * Source files a mentioned file imports, resolved against the workspace file
 * list. A failing test names its subject that way, which makes it the file the
 * edit will land in - the one excerpt the model would otherwise read first.
 */
export function importedFiles(workspace, relative, files = [], limits = PACKET_LIMITS) {
  const text = readText(workspace, relative, limits);
  if (!text) return [];
  const known = new Set(files.map(normalizePath));
  const found = [];
  for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(normalizePath(relative)), match[1]));
    const hit = [`${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}/index.js`, base].find((candidate) =>
      known.has(candidate),
    );
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/**
 * @param {object} input
 * @param {string} input.workspace absolute workspace root
 * @param {string} [input.verify] the verification command the run will gate on
 * @param {{ok?: boolean, status?: number, output?: string, durationMs?: number}} [input.verification]
 *   the pre-flight result: the real failing output *before* the agent touched anything
 * @param {string[]} [input.files] workspace-relative paths already discovered
 * @param {string} [input.platform]
 * @returns {string|null}
 */
export function buildWorkspacePacket({
  workspace,
  verify = null,
  verification = null,
  files = [],
  platform = process.platform,
  limits = PACKET_LIMITS,
} = {}) {
  if (!workspace) return null;

  const parts = ["<kodevra_context>"];
  parts.push(
    "Facts Kodevra measured in this workspace before the task started; observations only, the task follows.",
  );
  parts.push(`root: ${workspace}.`);

  const listed = files.slice(0, limits.files).map(normalizePath);
  if (listed.length) {
    const more = files.length - listed.length;
    parts.push(`files: ${listed.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`);
  }

  if (verify && verification) {
    const state = verification.ok ? "exits 0" : `exits ${verification.status ?? "non-zero"}`;
    const clipped = clipOutput(verification.output ?? "", limits);
    const output = clipped.text ? clipped.text.split("\n").join(LINE_JOIN) : "(no output)";
    parts.push(`verify: \`${verify}\` ${state} before any change; output: ${output}`);
    const mentioned = referencedFiles(verification.output ?? "", files, { limit: limits.mentions });
    if (mentioned.length) {
      parts.push(`mentioned by that output: ${mentioned.join(", ")}.`);
      // Reading the files the failure already named is what the model would do
      // next; doing it here costs no model turn. Bounded, read-only and only for
      // files inside the workspace.
      const chosen = [];
      const push = (file) => {
        if (chosen.length >= limits.excerpts || chosen.includes(file)) return;
        const excerpt = fileExcerpt(workspace, file, limits);
        if (!excerpt) return;
        chosen.push(file);
        parts.push(`excerpt ${excerpt}`);
      };
      for (const file of mentioned) push(file);
      // The files a mentioned file imports are the edit targets in practice
      // (a failing test imports its subject), so the remaining budget goes there.
      for (const file of [...chosen]) {
        for (const imported of importedFiles(workspace, file, files, limits)) push(imported);
      }
    }
  } else if (verify) {
    parts.push(`verify: \`${verify}\` (not run yet; its exit code decides the result).`);
  }

  parts.push(...shellFacts(platform, workspace));
  parts.push("</kodevra_context>");
  return parts.join(" ").replace(/\s+/g, " ").replace(/\. \|\|/g, ". ||").trim();
}

/**
 * Packet first, task verbatim after it - on one line, so a `.cmd` shim cannot
 * cut the prompt in half. Never rewrites or summarises the task.
 */
export function withWorkspacePacket(packet, task) {
  const text = String(task ?? "").trim();
  if (!packet) return text;
  return `${packet} ${text}`;
}
