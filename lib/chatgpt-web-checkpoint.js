import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { snapshotTree, workspaceChanges } from "./verify.js";

/**
 * H6 - lightweight workspace checkpoints.
 *
 * This is metadata, not a snapshot system. In a git worktree the checkpoint is
 * the working-tree state git already tracks (status + diff --stat + HEAD); in a
 * plain directory it is size/mtime metadata from the existing tree snapshot.
 * Nothing is copied, nothing is written, and no rollback is executed
 * automatically - the record says what changed and how a developer could undo it.
 */

const MANIFEST_NAMES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];

/**
 * `git status` prints paths relative to the repository root, which is not the
 * workspace when the workspace is nested. Keep only entries that really are
 * inside the workspace, expressed workspace-relative.
 */
function gitFilesInside(workspace, files) {
  if (!files.length) return [];
  let root = null;
  try {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    });
    if (top.status === 0) root = `${top.stdout || ""}`.trim() || null;
  } catch {
    root = null;
  }
  const inside = [];
  for (const file of files) {
    const absolute = root ? path.resolve(root, file) : path.resolve(workspace, file);
    const relative = path.relative(path.resolve(workspace), absolute).split(path.sep).join("/");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    inside.push(relative);
  }
  return inside;
}

function clip(text, max) {
  const value = `${text ?? ""}`.trim();
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

function manifestState(workspace) {
  const found = [];
  for (const name of MANIFEST_NAMES) {
    const absolute = path.join(workspace, name);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      const entry = { name, bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
      if (stat.size <= 200_000) {
        entry.sha256 = createHash("sha256").update(fs.readFileSync(absolute)).digest("hex").slice(0, 12);
      }
      found.push(entry);
    } catch {
      // not present
    }
  }
  return found;
}

export function createCheckpoint({
  workspace,
  label,
  verification,
  changedFiles = [],
  fingerprint = null,
  task = null,
  limits,
  index = 0,
}) {
  const changes = workspaceChanges(workspace);
  const fromGit = changes.isGit ? gitFilesInside(workspace, changes.files ?? []) : [];
  const files = [...new Set([...(changedFiles ?? []), ...fromGit])].sort().slice(0, limits.checkpointFiles);

  let tree = null;
  if (!changes.isGit) {
    const snapshot = snapshotTree(workspace, { limit: 2_000 });
    tree = { files: snapshot.files?.size ?? 0, truncated: Boolean(snapshot.truncated) };
  }

  const quoted = files.map((file) => (/[\s"]/.test(file) ? `"${file}"` : file));
  return {
    id: `${Date.now().toString(36)}-${index}`,
    label,
    at: new Date().toISOString(),
    task: task ? `${task}`.replace(/\s+/g, " ").slice(0, 160) : null,
    workspace: path.resolve(workspace),
    changedFiles: files,
    changedFileCount: files.length,
    git: changes.isGit
      ? { isGit: true, files: fromGit.slice(0, limits.checkpointFiles), diffStat: clip(changes.stat, limits.checkpointDiffChars) || null }
      : { isGit: false, tree },
    manifests: manifestState(workspace),
    executionFingerprint: fingerprint ?? null,
    verification: {
      state: verification?.state ?? "not_configured",
      command: verification?.command ?? null,
      attempts: verification?.attempts ?? 0,
      exitCode: verification?.exitCode ?? null,
    },
    rollback: changes.isGit
      ? {
          kind: "git",
          hint: files.length
            ? `git checkout -- ${quoted.join(" ")}${(changes.files ?? []).length > files.length ? " (tracked changes truncated; see git status)" : ""}`
            : "no tracked changes at this checkpoint",
        }
      : {
          kind: "metadata",
          hint: "workspace is not a git worktree; only file metadata was recorded, so restore from your own copy",
        },
  };
}

export function checkpointSummary(checkpoint) {
  return {
    id: checkpoint.id,
    label: checkpoint.label,
    at: checkpoint.at,
    changedFileCount: checkpoint.changedFileCount,
    changedFiles: checkpoint.changedFiles.slice(0, 8),
    git: checkpoint.git.isGit,
    executionFingerprint: checkpoint.executionFingerprint,
    verification: checkpoint.verification,
    rollback: checkpoint.rollback,
  };
}
