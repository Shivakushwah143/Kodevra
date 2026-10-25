import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Staging for the Docker executor.
 *
 * The container never sees the developer's workspace. Kodevra copies the
 * workspace into a private directory, leaving behind anything that looks like a
 * credential, auth store or local secret, and mounts only that copy.
 *
 * Deliberately not an allowlist of project types: this is a defensive filter
 * over a Node project tree, not a security scanner. A secret with an unexpected
 * name inside a project file can still be copied; the container has no network
 * and no host mount, and the report says what was staged.
 */

const EXCLUDED_DIRS = new Set([
  ".git",
  ".kodevra",
  ".tmp",
  "integrations",
  ".ssh",
  ".aws",
  ".gnupg",
  ".venv",
  "venv",
  "__pycache__",
]);

const EXCLUDED_FILE = new RegExp(
  [
    "^\\.env(\\..*)?$",
    "^auth\\.json$",
    "^deepseek-auth\\.json$",
    "^credentials(\\..*)?\\.json$",
    "^opencode\\.jsonc?$",
    "^\\.npmrc$",
    "^\\.netrc$",
    "^\\.git-credentials$",
    "^id_rsa.*$",
    "^id_ed25519.*$",
    ".*\\.(pem|key|p12|pfx|log)$",
    ".*\\.kodevra-backup$",
  ].join("|"),
  "i",
);

export const DEFAULT_STAGE_LIMITS = { maxFiles: 20_000, maxBytes: 512 * 1024 * 1024 };

/** Additional exclusions, comma separated, from KODEVRA_SANDBOX_EXCLUDE. */
export function customExclusions(env = process.env) {
  return `${env.KODEVRA_SANDBOX_EXCLUDE || ""}`
    .split(",")
    .map((entry) => entry.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function matchesExtra(relative, extra) {
  return extra.some((pattern) => relative === pattern || relative.startsWith(`${pattern}/`) || relative.split("/").pop() === pattern);
}

/** Whether a path relative to the workspace must not enter the snapshot. */
export function isExcluded(relative, extra = []) {
  const name = relative.split("/").pop();
  if (!name) return true;
  if (EXCLUDED_DIRS.has(name)) return true;
  if (matchesExtra(relative, extra)) return true;
  return EXCLUDED_FILE.test(name);
}

export function sandboxRoot({ base = path.join(os.homedir(), ".kodevra", "sandboxes") } = {}) {
  const root = path.join(base, `sbx_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function copyTree(source, destination, relative, stats, limits) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;

    if (isExcluded(relativePath, stats.extra)) {
      stats.excluded += 1;
      if (matchesExtra(relativePath, stats.extra)) stats.excludedExtra += 1;
      continue;
    }
    // Symlinks are never followed: a link is how a "workspace file" escapes.
    if (entry.isSymbolicLink()) {
      stats.excluded += 1;
      continue;
    }

    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        stats.excluded += 1;
        continue;
      }
      if (entry.name === "node_modules") stats.stagedDependencies = true;
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to, relativePath, stats, limits);
      continue;
    }
    if (!entry.isFile()) {
      stats.excluded += 1;
      continue;
    }

    const size = fs.statSync(from).size;
    stats.files += 1;
    stats.bytes += size;
    if (stats.files > limits.maxFiles || stats.bytes > limits.maxBytes) {
      const error = new Error(
        `Workspace is too large to stage safely (${stats.files} files, ${stats.bytes} bytes) with limits ${limits.maxFiles} files / ${limits.maxBytes} bytes.`,
      );
      error.code = "SNAPSHOT_TOO_LARGE";
      throw error;
    }
    fs.copyFileSync(from, to);
  }
}

/**
 * Copy the workspace into a fresh snapshot directory.
 * Returns counts so the report can say exactly what ran in the container.
 */
export function stageWorkspace({ workspace, destination, limits = DEFAULT_STAGE_LIMITS, exclude = customExclusions() }) {
  const root = path.resolve(workspace);
  const target = path.resolve(destination);
  fs.mkdirSync(target, { recursive: true });

  const stats = { files: 0, bytes: 0, excluded: 0, excludedExtra: 0, stagedDependencies: false, extra: exclude };
  copyTree(root, target, "", stats, limits);

  const warnings = [];
  if (stats.stagedDependencies) {
    warnings.push(
      "node_modules was staged from the host: the container has no network, so missing or platform-specific dependencies cannot be installed there.",
    );
  }
  if (stats.excludedExtra > 0) {
    warnings.push(`KODEVRA_SANDBOX_EXCLUDE removed ${stats.excludedExtra} entr${stats.excludedExtra === 1 ? "y" : "ies"} from the snapshot.`);
  }
  warnings.push("files created inside the container are discarded; build output is never imported into the workspace.");

  return { directory: target, ...stats, warnings };
}

/** Remove a staging directory. Junction/symlink targets are never copied into it. */
export function removeSandbox(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // a leftover snapshot is local, private and git-ignored by location
  }
}
