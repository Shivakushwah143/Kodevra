import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Installation of Kodevra's trusted OpenCode tool.
 *
 * OpenCode loads custom tools from `~/.config/opencode/tools/` (globally) or
 * `.opencode/tools/` (project). Kodevra uses the global directory on purpose:
 * the workspace-scoped permission overlay denies the agent writes outside the
 * project, so a project-local tool file would be editable by the model. The
 * installed file refuses to run unless Kodevra explicitly enables the sandbox
 * for this run.
 */

export const TOOL_MARKER = "kodevra-managed-tool: sandbox_exec";

const SOURCE = path.resolve(import.meta.dirname, "..", "tools", "sandbox_exec.js");

export function sandboxToolPath({ configDir = path.join(os.homedir(), ".config", "opencode") } = {}) {
  return path.join(configDir, "tools", "sandbox_exec.js");
}

export function installSandboxTool({ configDir, source = SOURCE } = {}) {
  const target = sandboxToolPath({ configDir });
  const content = fs.readFileSync(source, "utf8");
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, "utf8");
    if (!existing.includes(TOOL_MARKER)) {
      const error = new Error(`A different tool already exists at ${target}.`);
      error.code = "TOOL_CONFLICT";
      error.hint = "Move that file away and re-run; Kodevra will not overwrite a tool it does not own.";
      throw error;
    }
    if (existing === content) return { file: target, changed: false };
  }

  fs.writeFileSync(target, content, "utf8");
  return { file: target, changed: true };
}

export function sandboxToolInstalled({ configDir } = {}) {
  const target = sandboxToolPath({ configDir });
  try {
    return fs.readFileSync(target, "utf8").includes(TOOL_MARKER);
  } catch {
    return false;
  }
}
