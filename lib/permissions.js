import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Workspace scoping for automated runs (FRD FR-002 / 7.9).
 *
 * OpenCode owns tool execution, so Kodevra does not intercept tools. Instead it
 * hands the engine a small permission overlay through OPENCODE_CONFIG (which
 * OpenCode merges over the global config):
 *
 * - read/edit are denied by default and re-allowed only under the selected
 *   workspace, so native file tools cannot reach outside it.
 * - bash is "ask"; in a headless `opencode run` an unanswered ask is rejected by
 *   the engine, so unattended runs get no shell authority at all.
 * - external_directory is "deny" as a second layer for glob/grep and any tool
 *   that takes a path.
 *
 * OpenCode matches these patterns against paths relative to the *project root*
 * (the git worktree when the workspace is inside one), which is why the allow
 * patterns are built from `git rev-parse --show-prefix` rather than absolute
 * paths. Absolute patterns do not match; that was verified against 1.18.30.
 *
 * This is permission policy, not an OS sandbox: a bash call that an interactive
 * user approves is not restricted to the workspace by the engine.
 */

export const MODE_POLICIES = {
  "read-only": { edit: "deny" },
  ask: { edit: "ask" },
  "workspace-write": { edit: "allow" },
};

/** Path of the workspace relative to the engine's project root, with a trailing slash. */
export function workspacePrefix(workspace) {
  const result = spawnSync("git", ["rev-parse", "--show-prefix"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) return "";
  const prefix = `${result.stdout || ""}`.trim().replace(/\\/g, "/");
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

/**
 * The permission block handed to OpenCode.
 * Rule order matters: the last matching rule wins, so every allow is listed
 * after the catch-all deny.
 */
export function permissionOverlay({ workspace, mode, sandboxExec = false }) {
  const policy = MODE_POLICIES[mode];
  if (!policy) throw new Error(`Unknown mode "${mode}". Use: ${Object.keys(MODE_POLICIES).join(" | ")}`);

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
    // Native host bash stays denied when the Docker sandbox tool is the
    // sanctioned way to run commands. Without it, an ask is rejected by the
    // engine in an unattended run anyway.
    bash: sandboxExec ? "deny" : "ask",
    external_directory: "deny",
  };
  if (sandboxExec) overlay.sandbox_exec = "allow";
  return overlay;
}

/** OpenCode merges OPENCODE_CONFIG over the global config; merge over a user overlay too. */
function mergeOverlay(base, overlay) {
  return {
    ...base,
    ...overlay,
    permission: { ...(base.permission ?? {}), ...overlay.permission },
  };
}

/**
 * Write the overlay to a private file and return the env var to launch with.
 * Only permission keys are generated, so no provider credential is copied here.
 */
export function writePermissionOverlay({ workspace, mode, sandboxExec = false, env = process.env }) {
  const overlay = {
    $schema: "https://opencode.ai/config.json",
    permission: permissionOverlay({ workspace, mode, sandboxExec }),
  };

  let data = overlay;
  const userFile = env.OPENCODE_CONFIG;
  if (userFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(userFile), "utf8"));
      data = mergeOverlay(parsed, overlay);
    } catch (error) {
      return {
        file: null,
        env,
        warning: `OPENCODE_CONFIG (${userFile}) could not be read (${error.message}); workspace scoping not applied.`,
        cleanup: () => {},
      };
    }
  }

  const dir = path.join(os.homedir(), ".kodevra", "run");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `opencode-${process.pid}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    file,
    env: { ...env, OPENCODE_CONFIG: file },
    warning: null,
    cleanup: () => {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // a leftover overlay file only contains permission rules
      }
    },
  };
}
