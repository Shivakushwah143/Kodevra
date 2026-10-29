import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { LIMITS } from "./chatgpt-web.js";
import {
  isInside,
  realpathOfExisting,
  resolveWorkspacePath,
  SENSITIVE_FILE,
  SENSITIVE_SUFFIX,
} from "./chatgpt-web-paths.js";

/**
 * The `shell` action: one bounded developer command inside the workspace.
 *
 * It is not an OS sandbox on the host. What it does guarantee is that the
 * command line itself is parsed - quotes, redirections, operators, globs,
 * tilde and command substitution - and every path it names is resolved and
 * confined. A credential file cannot be named directly, reached through a
 * redirect (`cat</etc/passwd`), expanded by a glob (`cat .env*`), printed
 * through a revision path (`git show HEAD:.env`) or produced by a destructive
 * `find`/`git` form.
 *
 * With `--executor docker` the command runs in the executor's ephemeral
 * snapshot instead of on the host. Files changed there are discarded, so that
 * mode is reported honestly and never counted as a workspace mutation.
 */

const CREDENTIAL_ENV = /(_TOKEN|_API_KEY|_SECRET|API_KEY)$/i;
const DESTRUCTIVE = /^(rm\s+-rf?\s+[\\/]|del\s+\/[sf]\b|format\s+[a-z]:|shutdown\b|reboot\b|diskpart\b|mkfs\b)/i;

/** Commands that can read or write arbitrary host paths without a path arg. */
const BLOCKED_COMMANDS = new Set([
  ".",
  "source",
  "eval",
  "exec",
  "xargs",
  "parallel",
  "env",
  "printenv",
  "set",
  "export",
  "unset",
  "declare",
  "typeset",
  "readonly",
  "command",
  "builtin",
  "alias",
  "trap",
  "nohup",
  "setsid",
  "timeout",
  "stdbuf",
  "nice",
  "ionice",
  "watch",
  "script",
  "sudo",
  "su",
  "doas",
  "chroot",
  "mount",
  "docker",
  "podman",
  "nerdctl",
  "wsl",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
  // awk and its variants can run a command from inside the program text, which
  // no argument-level path check can see.
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);

const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
  "php",
  "rscript",
  "osascript",
]);

const INLINE_FLAGS = new Set([
  "-c",
  "--command",
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "/c",
  "/k",
  "-e",
  "-E",
  "-encodedcommand",
]);

const GIT_SAFE = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "grep",
  "shortlog",
  "describe",
  "cat-file",
  "rev-list",
  "merge-base",
  "show-ref",
  "branch",
  "remote",
  "stash",
]);

/** Leading environment assignments that turn a command into code execution. */
const ENV_INJECTION =
  /^(PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|SHELLOPTS|PROMPT_COMMAND|GIT_[A-Z0-9_]+)=/i;

const MUTATION_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".kodevra",
  ".tmp",
]);

function refusal(code, detail) {
  return { ok: false, code, detail };
}

function syntaxError(detail) {
  const error = new Error(detail);
  error.code = "SHELL_SYNTAX_UNSAFE";
  return error;
}

function isNullDevice(value) {
  return value === "/dev/null" || /^nul$/i.test(value);
}

function isAbsolutePath(value) {
  // A drive-relative `C:file` is as much outside the workspace as `C:\file`.
  return path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value);
}

/** Any path component (or revision path part) that names a credential file. */
function referencesSensitive(value) {
  const text = `${value ?? ""}`;
  // A quoted glob still expands inside tools (rg -g, find -name), so judge the
  // pattern with its glob characters removed as well as the literal text.
  const patterns = [text, text.replace(/[*?\[\]]/g, "")];
  // A pattern like `*env*` or `*key*` expands onto credential files even though
  // its basename is not one; judge glob patterns by what they can select.
  if (/[*?[]/.test(text) && /(env|secret|token|credential|passw|auth|key)/i.test(patterns[1])) return true;
  for (const pattern of patterns) {
    if (SENSITIVE_FILE.test(path.basename(pattern)) || SENSITIVE_SUFFIX.test(path.basename(pattern))) return true;
    if (
      pattern
        .split(/[:/\\]/)
        .filter(Boolean)
        .some((part) => SENSITIVE_FILE.test(part) || SENSITIVE_SUFFIX.test(part))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Read one shell word with quote handling. Unquoted glob characters are
 * rejected: a glob is how `.env` becomes reachable without naming it.
 */
// `spawn(..., { shell: true })` runs cmd.exe on Windows and /bin/sh everywhere
// else. cmd.exe treats a backslash as a path separator, not an escape, so
// unescaping it here would validate `..\..\secret` as one harmless filename.
const BACKSLASH_ESCAPES = process.platform !== "win32";

function readWord(command, start) {
  let index = start;
  let value = "";
  let quoted = false;
  let started = false;
  while (index < command.length) {
    const ch = command[index];
    if (/\s/.test(ch) || /[|&;<>()]/.test(ch)) break;
    if (ch === "'" || ch === '"') {
      quoted = true;
      started = true;
      const quote = ch;
      index += 1;
      while (index < command.length && command[index] !== quote) {
        value += command[index];
        index += 1;
      }
      if (index >= command.length) throw syntaxError(`unterminated ${quote}`);
      index += 1;
      continue;
    }
    if (ch === "\\") {
      if (!BACKSLASH_ESCAPES) {
        value += ch;
        started = true;
        index += 1;
        continue;
      }
      if (index + 1 >= command.length) throw syntaxError("a trailing backslash escapes nothing");
      value += command[index + 1];
      started = true;
      index += 2;
      continue;
    }
    // cmd.exe uses `^` to escape the next character, which can hide a separator
    // from this parser (`cat ^/etc/passwd`).
    if (ch === "^" && !BACKSLASH_ESCAPES) {
      throw syntaxError("cmd.exe '^' escapes are not allowed; quote the argument instead");
    }
    if (/[*?\[]/.test(ch)) {
      throw syntaxError(`unquoted glob "${ch}" is not allowed; quote the pattern or name the files`);
    }
    if (ch === "~") {
      throw syntaxError("tilde expansion is not allowed; use a workspace-relative path");
    }
    value += ch;
    started = true;
    index += 1;
  }
  return started ? { value, quoted, index } : null;
}

/**
 * Tokenise a command into words, redirections and operators. Nothing is
 * interpreted by a shell here: the same string is later handed to `spawn`,
 * so the validation has to parse the grammar the shell will use.
 */
function lex(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    const ch = command[index];
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      throw syntaxError("subshells and command grouping are not allowed");
    }
    if (ch === "|" || ch === "&" || ch === ";" || ch === "\n") {
      const next = command[index + 1];
      if ((ch === "|" || ch === "&") && next === ch) {
        tokens.push({ type: "op", value: `${ch}${ch}` });
        index += 2;
        continue;
      }
      tokens.push({ type: "op", value: ch });
      index += 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      let fd = null;
      const previous = tokens.at(-1);
      if (previous && previous.type === "word" && /^\d+$/.test(previous.value) && !previous.quoted && previous.end === index) {
        fd = previous.value;
        tokens.pop();
      }
      let op = ch;
      index += 1;
      if (command[index] === ch) {
        op += ch;
        index += 1;
      } else if (ch === ">" && command[index] === "|") {
        op = ">|";
        index += 1;
      } else if (command[index] === "&") {
        op += "&";
        index += 1;
      }
      if (op === "<<" || op === "<<<" || op === "<>") throw syntaxError(`${op} is not supported`);
      while (index < command.length && /\s/.test(command[index])) index += 1;
      const target = readWord(command, index);
      if (!target) throw syntaxError(`redirection ${op} has no target`);
      index = target.index;
      tokens.push({ type: "redirect", op, fd, target: target.value, targetQuoted: target.quoted });
      continue;
    }
    const word = readWord(command, index);
    if (!word) throw syntaxError(`unexpected character "${ch}"`);
    tokens.push({ type: "word", value: word.value, quoted: word.quoted, end: word.index });
    index = word.index;
  }
  return tokens;
}

function segmentsOf(tokens) {
  const segments = [];
  let current = { words: [], redirects: [], next: null };
  for (const token of tokens) {
    if (token.type === "op") {
      if (token.value === "&") throw syntaxError("background jobs are not allowed");
      current.next = token.value;
      segments.push(current);
      current = { words: [], redirects: [], next: null };
      continue;
    }
    if (token.type === "redirect") current.redirects.push(token);
    else current.words.push(token);
  }
  segments.push(current);
  return segments;
}

/** Resolve a model-supplied command path against the workspace and the cwd. */
function resolveCommandPath(value, { workspace, cwd, forWrite = false }) {
  if (isNullDevice(value)) return { nullDevice: true };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return { error: refusal("SHELL_OUTSIDE_WORKSPACE", `URLs are not accepted here: ${value}`) };
  }
  if (value.startsWith("~")) {
    return { error: refusal("SHELL_OUTSIDE_WORKSPACE", `paths outside the workspace are not allowed: ${value}`) };
  }
  if (isAbsolutePath(value)) {
    return { error: refusal("SHELL_OUTSIDE_WORKSPACE", `absolute paths are not allowed: ${value}`) };
  }
  const absolute = path.resolve(cwd, value);
  const root = path.resolve(workspace);
  const relative = path.relative(root, absolute);
  if (relative === "") return { absolute: root };
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { error: refusal("SHELL_OUTSIDE_WORKSPACE", `path leaves the workspace: ${value}`) };
  }
  try {
    const resolved = resolveWorkspacePath(root, relative, { forWrite });
    if (!isInside(realpathOfExisting(root), realpathOfExisting(resolved))) {
      return { error: refusal("SHELL_OUTSIDE_WORKSPACE", `path resolves outside the workspace: ${value}`) };
    }
    return { absolute: resolved };
  } catch (error) {
    return { error: refusal(error.code || "PATH_INVALID", error.message) };
  }
}

/**
 * Validate one argument. Flags, `KEY=value`, curl's `@file`, and attached flag
 * values (`-o/tmp/x`) are all reduced to the path they name.
 */
function validateArgument(word, { workspace, cwd }) {
  if (!`${word ?? ""}`.trim()) return null;
  if (referencesSensitive(word)) {
    return refusal("PATH_SENSITIVE", `that command references a sensitive file: ${word}`);
  }

  const check = (value) => {
    if (!value || value === "-") return null;
    if (referencesSensitive(value)) {
      return refusal("PATH_SENSITIVE", `that command references a sensitive file: ${value}`);
    }
    if (isNullDevice(value)) return null;
    // `git show HEAD:src/x.js` names a revision path, not a file called
    // `HEAD:src/x.js`; judge the path part against the workspace.
    const revision = /^([^:\\/]+):(.+)$/.exec(value);
    if (revision && !/^[A-Za-z]:/.test(value)) return check(revision[2]);
    const pathLike =
      isAbsolutePath(value) ||
      value.startsWith("~") ||
      value === "." ||
      value === ".." ||
      /[\\/]/.test(value) ||
      value.startsWith(".");
    if (pathLike) {
      const resolved = resolveCommandPath(value, { workspace, cwd, forWrite: true });
      return resolved.error ?? null;
    }
    return null;
  };

  if (word.startsWith("-")) {
    const equals = word.indexOf("=");
    if (equals !== -1) {
      const value = word.slice(equals + 1);
      const error = check(value.startsWith("@") ? value.slice(1) : value);
      if (error) return error;
    }
    const slash = word.search(/[\\/]/);
    if (slash !== -1) {
      const error = check(word.slice(slash));
      if (error) return error;
    }
    return null;
  }

  if (word.startsWith("@")) {
    return check(word.slice(1));
  }

  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(word);
  if (assignment) {
    return check(assignment[1]);
  }

  return check(word);
}

function validateRedirect(redirect, { workspace, cwd }) {
  const target = redirect.target;
  if (!target) return refusal("SHELL_SYNTAX_UNSAFE", "a redirection needs a target");
  if (redirect.op.endsWith("&")) {
    if (!/^\d+$|^-$/.test(target)) {
      return refusal("SHELL_SYNTAX_UNSAFE", `only file-descriptor duplication is allowed after ${redirect.op}`);
    }
    return null;
  }
  if (isNullDevice(target)) return null;
  if (referencesSensitive(target)) {
    return refusal("PATH_SENSITIVE", `that redirection references a sensitive file: ${target}`);
  }
  const resolved = resolveCommandPath(target, {
    workspace,
    cwd,
    forWrite: redirect.op.startsWith(">"),
  });
  return resolved.error ?? null;
}

function commandPolicy(words) {
  if (words.some((word) => ENV_INJECTION.test(word))) {
    return refusal("SHELL_BLOCKED_COMMAND", "environment assignments that load code or redirect git are not allowed");
  }
  const name = `${words[0] ?? ""}`;
  const base = path.basename(name).toLowerCase().replace(/\.exe$/, "");
  if (BLOCKED_COMMANDS.has(name) || BLOCKED_COMMANDS.has(base)) {
    return refusal("SHELL_BLOCKED_COMMAND", `"${name}" can reach files or commands outside the workspace and is not allowed`);
  }
  const interpreter =
    INTERPRETERS.has(base) || /^(python|node|ruby|perl|php|bash|sh|zsh|dash)\d+(?:\.\d+)*$/.test(base);
  if (interpreter) {
    const inline = words.slice(1).some((arg) => {
      const value = `${arg}`.toLowerCase();
      // Long forms can carry the code as `--eval=<code>`; judge the flag name.
      const flag = value.split("=", 1)[0];
      return INLINE_FLAGS.has(value) || INLINE_FLAGS.has(flag) || /^-[a-zA-Z]*[ceE][a-zA-Z]*$/.test(value);
    });
    if (inline || (base === "deno" && `${words[1] ?? ""}`.toLowerCase() === "eval")) {
      return refusal(
        "SHELL_BLOCKED_COMMAND",
        `inline ${base} code is not allowed; write the code to a workspace file and run that file`,
      );
    }
  }

  if (base === "git") {
    const sub = `${words[1] ?? ""}`.toLowerCase();
    if (!GIT_SAFE.has(sub)) {
      return refusal("SHELL_BLOCKED_COMMAND", `git ${sub || "(no subcommand)"} is not an inspection command`);
    }
    if (sub === "branch" && words.slice(2).some((arg) => /^-(d|D|m|M|c|C|f|u|set-upstream)/.test(arg))) {
      return refusal("SHELL_BLOCKED_COMMAND", "git branch may only list branches");
    }
    if (sub === "remote" && words[2] && !["-v", "--verbose", "show", "get-url"].includes(words[2])) {
      return refusal("SHELL_BLOCKED_COMMAND", "git remote may only list or show remotes");
    }
    if (sub === "stash" && words[2] !== "list") {
      return refusal("SHELL_BLOCKED_COMMAND", "git stash is only allowed as `git stash list`");
    }
    if (sub === "cat-file" && !words.slice(2).some((arg) => ["-p", "-t", "-s"].includes(arg))) {
      return refusal("SHELL_BLOCKED_COMMAND", "git cat-file is only allowed with -p, -t or -s");
    }
  }

  if (base === "find") {
    for (const arg of words.slice(1)) {
      if (/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls|L|H)$/.test(arg)) {
        return refusal("SHELL_BLOCKED_COMMAND", `find ${arg} can run commands, delete files or follow links outside the workspace`);
      }
    }
  }
  if (base === "rg") {
    for (const arg of words.slice(1)) {
      if (/^--pre(-glob)?(=|$)/.test(arg)) {
        return refusal("SHELL_BLOCKED_COMMAND", "ripgrep preprocessors are not allowed (they execute a command)");
      }
      if (arg === "--hidden" || /^--no-ignore/.test(arg) || /^-u+$/.test(arg)) {
        return refusal(
          "SHELL_BLOCKED_COMMAND",
          "recursive searches that include hidden or ignored files can read credential files; use the search action or an explicit path",
        );
      }
    }
  }
  if (base === "grep") {
    const recursive = words.slice(1).some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === "--recursive" || arg === "--dereference-recursive");
    if (recursive) {
      return refusal(
        "SHELL_BLOCKED_COMMAND",
        "recursive grep reads hidden credential files; use rg (which skips them) or the search action",
      );
    }
  }
  if (base === "fd") {
    for (const arg of words.slice(1)) {
      if (["-x", "--exec", "-X", "--exec-batch"].includes(arg)) {
        return refusal("SHELL_BLOCKED_COMMAND", "fd exec forms are not allowed (they execute a command)");
      }
    }
  }
  if (base === "findstr" && words.slice(1).some((arg) => /^\/s/i.test(arg))) {
    return refusal(
      "SHELL_BLOCKED_COMMAND",
      "recursive findstr reads hidden credential files; use rg or the search action",
    );
  }
  if (base === "sed") {
    for (const arg of words.slice(1)) {
      if (arg.startsWith("-")) continue;
      // GNU sed's `e` command (and the `e`/`s///e` substitution flag) runs its
      // argument through the shell.
      if (/(^|[;{}\n0-9])\s*e(\s|$)/.test(arg) || /\/[0-9gpiImM]*e[0-9gpiImM]*$/.test(arg.trim())) {
        return refusal("SHELL_BLOCKED_COMMAND", "sed's e command executes a shell command and is not allowed");
      }
    }
  }
  return null;
}

/**
 * Validate the whole command line. `cd` is tracked so later relative paths are
 * judged against the directory the shell will actually be in.
 */
function inspectCommand(command, { workspace, cwd }) {
  if (DESTRUCTIVE.test(command)) {
    return refusal("SHELL_REFUSED", "that command is destructive at the system level and is not allowed");
  }
  if (/\$|`/.test(command)) {
    return refusal(
      "SHELL_EXPANSION_REFUSED",
      "shell variable/substitution expansion is not allowed; pass the literal path instead",
    );
  }
  // cmd.exe expands %VAR% and !VAR! before the command sees the argument.
  if (
    process.platform === "win32" &&
    (/%[A-Za-z_][A-Za-z0-9_]*%/.test(command) || /![A-Za-z_][A-Za-z0-9_]*!/.test(command))
  ) {
    return refusal(
      "SHELL_EXPANSION_REFUSED",
      "shell variable expansion is not allowed; pass the literal path instead",
    );
  }
  if (/[<>]\(/.test(command)) {
    return refusal("SHELL_SYNTAX_UNSAFE", "process substitution is not allowed");
  }

  let tokens;
  try {
    tokens = lex(command);
  } catch (error) {
    return refusal(error.code || "SHELL_SYNTAX_UNSAFE", error.message);
  }

  let currentCwd = cwd;
  let segments;
  try {
    segments = segmentsOf(tokens);
  } catch (error) {
    return refusal(error.code || "SHELL_SYNTAX_UNSAFE", error.message);
  }

  for (const segment of segments) {
    const words = segment.words.map((word) => word.value);
    if (!words.length) {
      if (segment.redirects.length) {
        return refusal("SHELL_SYNTAX_UNSAFE", "a redirection without a command is not allowed");
      }
      continue;
    }

    if (words[0] === "cd") {
      // `cd` only persists across `&&` (or at the end of the command). A piped
      // or `;`-separated cd runs in a subshell or may fail, and tracking it
      // would validate later paths against a directory the shell is not in.
      if (segment.next && segment.next !== "&&") {
        return refusal("SHELL_SYNTAX_UNSAFE", "cd is only allowed at the start of an && chain");
      }
      if (words.length !== 2) return refusal("SHELL_BAD_CWD", "cd needs exactly one workspace-relative directory");
      const resolved = resolveCommandPath(words[1], { workspace, cwd: currentCwd });
      if (resolved.error) return resolved.error;
      try {
        if (!fs.statSync(resolved.absolute).isDirectory()) {
          return refusal("SHELL_BAD_CWD", `cwd is not a directory: ${words[1]}`);
        }
      } catch {
        return refusal("SHELL_BAD_CWD", `cwd does not exist: ${words[1]}`);
      }
      currentCwd = resolved.absolute;
      continue;
    }

    const policy = commandPolicy(words);
    if (policy) return policy;

    for (const word of words) {
      const invalid = validateArgument(word, { workspace, cwd: currentCwd });
      if (invalid) return invalid;
    }
    for (const redirect of segment.redirects) {
      const invalid = validateRedirect(redirect, { workspace, cwd: currentCwd });
      if (invalid) return invalid;
    }
  }
  return null;
}

function shellTimeoutMs(requested, limits) {
  const seconds = Number(requested);
  const wanted = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : limits.shellTimeoutMs;
  return Math.min(Math.max(1_000, Math.round(wanted)), limits.shellTimeoutMaxMs);
}

function bounded(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `[first ${text.length - max} characters omitted]\n${text.slice(-max)}`, truncated: true };
}

function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
    return;
  }
  child.kill("SIGKILL");
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (CREDENTIAL_ENV.test(key) || key === "KODEVRA_CHATGPT_BRIDGE_TOKEN") delete env[key];
  }
  return env;
}

/** Size + mtime for every workspace file the shell could change. */
function workspaceFingerprint(workspace, limit = 20_000) {
  const root = path.resolve(workspace);
  const files = new Map();
  const stack = [root];
  let truncated = false;
  while (stack.length && !truncated) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.size >= limit) {
        truncated = true;
        break;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (MUTATION_SKIP.has(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        continue;
      }
      files.set(path.relative(root, absolute).split(path.sep).join("/"), `${stat.size}:${stat.mtimeMs}`);
    }
  }
  return { files, truncated };
}

function fingerprintChanges(before, after) {
  const changed = [];
  for (const [file, signature] of after.files) {
    if (before.files.get(file) !== signature) changed.push(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.push(file);
  }
  return changed.sort();
}

function bodyOf({ executorName, sandboxed, status, duration, timedOut, timeoutMs, stdout, stderr, output, truncated, changedFiles, changesKnown }) {
  const lines = [
    `executor: ${executorName}${sandboxed ? " (ephemeral snapshot; workspace changes are discarded)" : " (not sandboxed)"}`,
    `exit code: ${Number.isFinite(status) ? status : "unknown"}`,
    `duration: ${duration} ms`,
  ];
  if (timedOut) lines.push(`timed out: yes (${timeoutMs} ms)`);
  if (changesKnown) lines.push(`workspace changes: ${changedFiles.length ? changedFiles.slice(0, 20).join(", ") : "none"}`);
  lines.push("", "stdout:", stdout.trim() || "(no output)");
  if (stderr.trim()) lines.push("", "stderr:", stderr.trim());
  if (truncated) lines.push("", "[output truncated; the tail is kept]");
  return lines.join("\n");
}

export async function runShellTool(workspace, action, { mode = "workspace-write", limits = LIMITS, executor = null } = {}) {
  const budget = { ...LIMITS, ...limits };
  limits = budget;
  if (mode === "read-only") {
    return refusal(
      "MODE_REFUSES_SHELL",
      "this run is read-only; a shell could change files. Use read/list/search/inspect instead.",
    );
  }
  const command = `${action.command ?? ""}`.trim();
  if (!command) return refusal("SHELL_EMPTY", "command is required");

  let cwd;
  try {
    const root = path.resolve(workspace);
    const requested = action.cwd ? path.resolve(root, `${action.cwd}`) : root;
    if (!isInside(root, requested)) {
      return refusal("SHELL_OUTSIDE_WORKSPACE", `cwd leaves the workspace: ${action.cwd}`);
    }
    if (!fs.statSync(requested).isDirectory()) {
      return refusal("SHELL_BAD_CWD", `cwd is not a directory: ${action.cwd}`);
    }
    const realRoot = realpathOfExisting(root);
    if (!isInside(realRoot, realpathOfExisting(requested))) {
      return refusal("SHELL_OUTSIDE_WORKSPACE", `cwd resolves outside the workspace: ${action.cwd}`);
    }
    cwd = requested;
  } catch (error) {
    return refusal(error.code || "SHELL_BAD_CWD", `${error.message}`);
  }

  const blocked = inspectCommand(command, { workspace, cwd });
  if (blocked) return blocked;

  const timeoutMs = shellTimeoutMs(action.timeout, limits);
  const sandboxed = Boolean(executor?.sandboxed);

  // Docker: the executor stages a private snapshot and discards whatever the
  // command writes. Nothing here can touch the developer's workspace.
  if (sandboxed) {
    let result;
    try {
      result = await executor.run(command, { cwd, timeoutMs, forward: false });
    } catch (error) {
      return refusal(error.code || "EXECUTOR_UNAVAILABLE", `${error.message}`);
    }
    const status = Number.isFinite(result?.status) ? result.status : null;
    const timedOut = Boolean(result?.timedOut);
    const duration = Number.isFinite(result?.durationMs) ? result.durationMs : 0;
    const raw = `${result?.output ?? `${result?.stdout ?? ""}${result?.stderr ?? ""}`}`;
    const out = bounded(raw, limits.shellOutputChars);
    const ok = status === 0 && !timedOut;
    return {
      ok,
      code: timedOut ? "SHELL_TIMED_OUT" : ok ? null : "SHELL_EXIT_NONZERO",
      detail: timedOut
        ? `executor ${executor.name} timed out after ${timeoutMs} ms`
        : `executor ${executor.name} · exit ${status === null ? "unknown" : status} in ${duration} ms`,
      body: bodyOf({
        executorName: executor.name,
        sandboxed: true,
        status,
        duration,
        timedOut,
        timeoutMs,
        stdout: out.text,
        stderr: "",
        truncated: out.truncated,
        changedFiles: [],
        changesKnown: false,
      }),
      mutated: false,
      changedFiles: [],
      executor: executor.name,
    };
  }

  const before = workspaceFingerprint(workspace);
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child;

    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (spawnError) {
        resolve(refusal("SHELL_SPAWN_FAILED", `${spawnError.message}`));
        return;
      }
      const duration = Date.now() - startedAt;
      const after = workspaceFingerprint(workspace);
      const changedFiles = fingerprintChanges(before, after);
      const changesKnown = !before.truncated && !after.truncated;
      const mutated = changesKnown ? changedFiles.length > 0 : true;
      const out = bounded(stdout, limits.shellOutputChars);
      const err = bounded(stderr, limits.shellOutputChars);
      const exitCode = typeof code === "number" ? code : null;
      resolve({
        ok: exitCode === 0 && !timedOut,
        code: timedOut ? "SHELL_TIMED_OUT" : exitCode === 0 ? null : "SHELL_EXIT_NONZERO",
        detail: timedOut
          ? `timed out after ${timeoutMs} ms`
          : `exit ${exitCode === null ? "unknown" : exitCode} in ${duration} ms${
              mutated ? ` · ${changesKnown ? `${changedFiles.length} file(s) changed` : "workspace changed"}` : ""
            }`,
        body: bodyOf({
          executorName: "host",
          sandboxed: false,
          status: exitCode,
          duration,
          timedOut,
          timeoutMs,
          stdout: out.text,
          stderr: err.text,
          truncated: out.truncated || err.truncated,
          changedFiles,
          changesKnown,
        }),
        mutated,
        changedFiles,
        executor: "host",
      });
    };

    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, error);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > limits.shellOutputChars * 8) stdout = stdout.slice(-limits.shellOutputChars * 4);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > limits.shellOutputChars * 8) stderr = stderr.slice(-limits.shellOutputChars * 4);
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}
