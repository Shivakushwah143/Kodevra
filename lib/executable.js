import fs from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/**
 * Resolve a CLI binary on PATH without spawning a shell.
 *
 * Kept separate from `doctor.js` so the harness adapters can use it without
 * importing the diagnostics layer (which imports the adapters).
 */
export function findExecutable(name) {
  const override = process.env[`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`];
  if (override && fs.existsSync(override)) return { command: override, shell: false };

  const pathValue = process.env.PATH || process.env.Path || "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = isWindows
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          const shell = isWindows && /\.(cmd|bat)$/i.test(candidate);
          return { command: candidate, shell };
        }
      } catch {
        // not in this directory
      }
    }
  }
  return null;
}
