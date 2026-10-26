import path from "node:path";

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
  inverse: wrap("7", "27"),
};

export const PRODUCT = "Kodevra";
export const TAGLINE = "Your Models. Your Code. Your Agent.";
export const VERSION = "0.3.0-alpha.1";

const LABEL = 11;

/** A labelled row, aligned for every panel Kodevra prints. */
export function row(label, value) {
  return `  ${color.dim(label.padEnd(LABEL))}${value}`;
}

/** Workspace relative to the current directory when it is nested inside it. */
export function displayPath(workspace, cwd = process.cwd()) {
  if (!workspace) return ".";
  const relative = path.relative(cwd, workspace);
  if (!relative || relative.startsWith("..")) return workspace;
  return `.${path.sep}${relative}`;
}

/**
 * The Kodevra startup panel.
 *
 * It is deliberately a thin identity layer over the engine: brand, workspace,
 * provider/model, authentication readiness, sandbox availability, mode and the
 * commands worth knowing. No fake prompt, no animation, no ASCII art beyond the
 * single mark - the OpenCode terminal is still where work happens.
 */
export function header({
  workspace,
  model,
  provider,
  auth,
  sandbox,
  mode,
  engine,
  hints = true,
  version = VERSION,
}) {
  const lines = [""];
  lines.push(`  ${color.cyan("◆")} ${color.bold(PRODUCT.toUpperCase())} ${color.dim(version)}`);
  lines.push(`  ${color.dim(TAGLINE)}`);
  lines.push("");

  if (workspace) lines.push(row("Workspace", displayPath(workspace)));
  if (model) lines.push(row("Model", color.green(model)));
  if (provider) lines.push(row("Provider", provider));
  if (auth) lines.push(row("Auth", auth));
  if (sandbox) lines.push(row("Sandbox", sandbox));
  if (mode) lines.push(row("Mode", mode));
  if (engine) lines.push(row("Engine", engine));

  if (hints) {
    lines.push("");
    lines.push(`  ${color.dim("run     ")} kodevra run "<task>" --verify "npm test" --executor docker`);
    lines.push(`  ${color.dim("check   ")} kodevra doctor  ·  kodevra providers  ·  kodevra sessions`);
    lines.push(`  ${color.dim("resume  ")} kodevra run -c "<follow-up>"  ·  kodevra auth status`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Compact alias kept for the smaller command surfaces (providers, auth, help). */
export function banner({ model, workspace, engine, auth, mode, provider, sandbox, version } = {}) {
  return header({ model, workspace, engine, auth, mode, provider, sandbox, hints: false, version });
}

export function mark(ok) {
  return ok ? color.green("PASS") : color.red("FAIL");
}

/** The one-word verdict printed at the end of a task. */
export function verdict(kind) {
  if (kind === "verified") return color.green("VERIFIED");
  if (kind === "failed") return color.red("FAILED");
  if (kind === "refused") return color.yellow("REFUSED");
  return color.yellow("UNVERIFIED");
}
