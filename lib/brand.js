const supportsColor =
  !process.env.NO_COLOR &&
  (process.env.FORCE_COLOR === "1" || process.stdout.isTTY === true);

const wrap = (open, close) => (text) =>
  supportsColor ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const color = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  cyan: wrap("36", "39"),
  blue: wrap("34", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  red: wrap("31", "39"),
  magenta: wrap("35", "39"),
};

export const PRODUCT = "Kodevra";
export const TAGLINE = "Your Models. Your Code. Your Agent.";
export const VERSION = "0.1.0";

const WORDMARK = [
  "█▄▀ █▀█ █▀▄ █▀▀ █ █ █▀█ ▄▀█",
  "█ █ █▄█ █▄▀ ██▄ ▀▄▀ █▀▄ █▀█",
];

/**
 * Branded header. Deliberately thin: Kodevra is an identity layer over the
 * existing OpenCode terminal experience, not a replacement UI.
 */
export function banner({ model, workspace, engine }) {
  const lines = [];
  lines.push("");
  for (const line of WORDMARK) {
    lines.push(`  ${color.cyan(line)}`);
  }
  lines.push(`  ${color.dim(TAGLINE)}`);
  lines.push("");
  if (engine) lines.push(`  ${color.dim("engine ")}${engine}`);
  if (model) lines.push(`  ${color.dim("model  ")}${color.green(model)}`);
  if (workspace) lines.push(`  ${color.dim("cwd    ")}${workspace}`);
  lines.push("");
  return lines.join("\n");
}

export function mark(ok) {
  return ok ? color.green("PASS") : color.red("FAIL");
}
