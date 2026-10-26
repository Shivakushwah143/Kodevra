import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Workspace scoping for automated runs (FRD FR-002 / 7.9).
 *
 * OpenCode owns tool execution, so Kodevra does not intercept tools. Instead it
 * hands the engine a *permission-only* overlay through OPENCODE_CONFIG:
 *
 * - read/edit are denied by default and re-allowed only under the selected
 *   workspace, so native file tools cannot reach outside it.
 * - bash is "ask" (rejected headless) or "deny" when the Docker sandbox tool is
 *   the sanctioned shell.
 * - external_directory is "deny" as a second layer for glob/grep.
 * - a model that needs an output-token limit gets exactly that limit, and
 *   nothing else: no provider options, no key, no header.
 *
 * This module fails closed. If Kodevra cannot compute the workspace's position
 * inside its project, or cannot guarantee a permission-only write, it throws
 * WORKSPACE_POLICY_UNAVAILABLE and the caller must abort before the model runs.
 * There is no "warning and continue" path.
 *
 * Project-level OpenCode configuration (opencode.json / .opencode/) can add
 * plugins or override permissions, which would silently widen this policy. In an
 * automated run it is refused unless the developer opts in explicitly with
 * KODEVRA_TRUST_PROJECT_EXTENSIONS=1, and `opencode run --pure` is always used
 * so external plugins do not load.
 */

export const MODE_POLICIES = {
  "read-only": { edit: "deny" },
  ask: { edit: "ask" },
  "workspace-write": { edit: "allow" },
};

export const POLICY_UNAVAILABLE = "WORKSPACE_POLICY_UNAVAILABLE";
export const PROJECT_EXTENSIONS_UNTRUSTED = "PROJECT_EXTENSIONS_UNTRUSTED";

export class WorkspacePolicyError extends Error {
  constructor(message, hint, code = POLICY_UNAVAILABLE) {
    super(message);
    this.name = "WorkspacePolicyError";
    this.code = code;
    this.hint = hint ?? null;
  }
}

const PROJECT_CONFIG_NAMES = ["opencode.json", "opencode.jsonc", ".opencode", ".opencode.json", ".opencode.jsonc"];

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
}

/** Compare real paths: git reports the long Windows path, callers use the short one. */
function canonical(target) {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      return fs.realpathSync(absolute);
    } catch {
      return absolute;
    }
  }
}

/** Filesystem walk upward for a `.git` entry, used when git itself is unavailable. */
function ancestorRepo(start) {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The engine's project root for a workspace. OpenCode uses the git worktree when
 * there is one and the directory itself otherwise, so the policy must agree.
 */
const rootCache = new Map();

/** Test seam: forget memoized project roots. */
export function clearProjectRootCache() {
  rootCache.clear();
}

export function projectRoot(workspace) {
  const absolute = canonical(workspace);
  // One `git rev-parse` is ~40 ms on Windows and a single run asks for the same
  // root from the overlay, the trust gate and the extension check.
  const cached = rootCache.get(absolute);
  if (cached) return cached;
  const top = git(["rev-parse", "--show-toplevel"], absolute);
  if (top.error?.code === "ENOENT") {
    throw new WorkspacePolicyError(
      "git is not installed, so the workspace boundary cannot be proven.",
      "Install git and retry; Kodevra will not run an automated task without a provable workspace scope.",
    );
  }
  if (top.status === 0) {
    const root = `${top.stdout || ""}`.trim();
    if (root) {
      const resolved = canonical(root);
      rootCache.set(absolute, resolved);
      return resolved;
    }
  }

  const enclosing = ancestorRepo(absolute);
  if (enclosing && canonical(enclosing) !== absolute) {
    throw new WorkspacePolicyError(
      `The workspace is inside a git worktree (${enclosing}) but git could not resolve it.`,
      "Fix the repository (git rev-parse --show-toplevel) or select the repository root as the workspace.",
    );
  }
  rootCache.set(absolute, absolute);
  return absolute;
}

/** Path of the workspace relative to the engine's project root, with a trailing slash. */
export function workspacePrefix(workspace) {
  const root = projectRoot(workspace);
  const absolute = canonical(workspace);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspacePolicyError(
      `Workspace ${absolute} is outside its project root ${root}.`,
      "Select a workspace inside the project, or make the workspace its own git root.",
    );
  }
  return relative ? `${relative}/` : "";
}

/** Project-level OpenCode files that could add tools or change permissions. */
export function projectExtensions(workspace) {
  const root = projectRoot(workspace);
  const found = [];
  for (const name of PROJECT_CONFIG_NAMES) {
    if (fs.existsSync(path.join(root, name))) found.push(name);
  }
  return { root, found };
}

/**
 * Refuse automated runs when project-level extensions are present. This is a
 * trust gate, not a scanner: opting in means the developer has reviewed them.
 */
export function assertTrustedProject(workspace, { trust = process.env.KODEVRA_TRUST_PROJECT_EXTENSIONS === "1" } = {}) {
  const { root, found } = projectExtensions(workspace);
  if (!found.length || trust) return { root, found, trusted: true };
  throw new WorkspacePolicyError(
    `Project-level OpenCode configuration can change tool permissions and plugins: ${found.join(", ")} in ${root}.`,
    "Review those files and re-run with KODEVRA_TRUST_PROJECT_EXTENSIONS=1, or remove them from the workspace.",
    PROJECT_EXTENSIONS_UNTRUSTED,
  );
}

/**
 * The permission block handed to OpenCode.
 * Rule order matters: the last matching rule wins, so every allow is listed
 * after the catch-all deny.
 */
export function permissionOverlay({ workspace, mode, sandboxExec = false }) {
  const policy = MODE_POLICIES[mode];
  if (!policy) {
    throw new WorkspacePolicyError(
      `Unknown mode "${mode}". Use: ${Object.keys(MODE_POLICIES).join(" | ")}`,
      null,
      "UNKNOWN_MODE",
    );
  }

  const prefix = workspacePrefix(workspace);
  const inside = `${prefix}**`;

  const read = {
    "*": "deny",
    [inside]: "allow",
    // Keep the engine's stricter defaults for credential files.
    [`${prefix}*.env`]: "ask",
    [`${prefix}*.env.*`]: "ask",
    [`${prefix}*.env.example`]: "allow",
  };

  const edit = policy.edit === "allow" ? { "*": "deny", [inside]: "allow" } : policy.edit;

  const overlay = {
    read,
    edit,
    bash: sandboxExec ? "deny" : "ask",
    external_directory: "deny",
  };
  if (sandboxExec) overlay.sandbox_exec = "allow";
  return overlay;
}

/**
 * Keys that would turn this overlay into a credential store. Provider options,
 * API keys, headers and tokens are never copied into a run config: the engine
 * keeps reading those from the developer's own global configuration.
 */
const FORBIDDEN_KEYS = new Set(["options", "apikey", "api_key", "headers", "authorization", "auth", "token", "secret"]);

export function assertCredentialFree(node, trail = "run config") {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) {
      throw new WorkspacePolicyError(
        `The run config tried to carry ${trail}.${key}, which can hold a credential.`,
        "Only permission rules and model token limits belong here; provider options and keys stay in your OpenCode config.",
      );
    }
    assertCredentialFree(value, `${trail}.${key}`);
  }
}

/**
 * The tool this run can never execute, expressed as the one OpenCode config
 * layer that actually reaches the request.
 *
 * A headless run has nobody to approve a shell: `bash` stays on "ask", the
 * engine auto-rejects it, and the model spends a turn discovering that. OpenCode
 * 1.18.30 has a native switch for this, but only the per-agent `tools` map works
 * here: a top-level `tools.bash` resolves in `opencode debug config` and drops
 * out of the request the engine builds for `--agent <name>`. Measured, not
 * assumed - see docs/OPENCODE_OPTIMIZATION.md.
 * `KODEVRA_HIDE_TOOLS=0` restores the previous exposure.
 */
export function unavailableTools({ agent = "build", env = process.env } = {}) {
  if (env.KODEVRA_HIDE_TOOLS === "0") return null;
  // Both headless executors deny native bash: without Docker it is "ask" with
  // nobody to approve, with Docker the sanctioned shell is `sandbox_exec`.
  return { agent, tools: { bash: false } };
}

/**
 * Write the run-scoped overlay to a private file and return the env var to
 * launch with. It carries permission rules, the tools the run cannot execute and,
 * when a model needs a token limit, that single model's `limit` block - never
 * provider options, API keys or headers (`assertCredentialFree` refuses them).
 */
export function writePermissionOverlay({ workspace, mode, sandboxExec = false, modelConfig = null, hiddenTools = null, env = process.env }) {
  assertTrustedProject(workspace);
  if (modelConfig) assertCredentialFree(modelConfig);
  const overlay = {
    $schema: "https://opencode.ai/config.json",
    permission: permissionOverlay({ workspace, mode, sandboxExec }),
    ...(modelConfig ?? {}),
    // Native OpenCode `tools` map, scoped to the agent this run uses.
    ...(hiddenTools ? { agent: { [hiddenTools.agent]: { tools: hiddenTools.tools } } } : {}),
  };

  const dir = path.join(os.homedir(), ".kodevra", "run");
  const file = path.join(dir, `opencode-${process.pid}-${randomUUID().slice(0, 6)}.json`);

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify(overlay, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    throw new WorkspacePolicyError(
      `The permission overlay could not be written (${error.message}).`,
      "Fix permissions on ~/.kodevra/run; no task was started and no rule was skipped.",
    );
  }

  const warnings = [];
  if (env.OPENCODE_CONFIG) {
    warnings.push(
      "a custom OPENCODE_CONFIG is not copied into this overlay (credentials must stay out of it); provider settings come from the global OpenCode config",
    );
  }

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // the leftover file contains permission rules only
    }
  };
  // Cleanup must survive every exit path, including an unexpected throw.
  process.once("exit", cleanup);

  return { file, env: { ...env, OPENCODE_CONFIG: file }, warnings, warning: warnings[0] ?? null, cleanup };
}
