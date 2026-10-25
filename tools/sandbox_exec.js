// kodevra-managed-tool: sandbox_exec — Kodevra owns and reinstalls this file; local edits are overwritten.
import { tool } from "@opencode-ai/plugin";
import { pathToFileURL } from "node:url";

const DISABLED = [
  "sandbox_exec is not enabled for this run.",
  "Kodevra enables it only for `kodevra run --executor docker`; native bash is denied in unattended runs.",
  "No command was executed.",
].join("\n");

export default tool({
  description:
    "Run a shell command in Kodevra's disposable Docker sandbox. Use this for tests, builds, type checks and inspecting command output. " +
    "Every call starts from a fresh snapshot of the workspace; real stdout, stderr and the exit code are returned. " +
    "Files created inside the sandbox are discarded and never imported into the workspace. Native bash is disabled in this run.",
  args: {
    command: tool.schema.string().describe("Shell command to run inside the sandbox, for example: npm test"),
    timeout_ms: tool.schema
      .number()
      .optional()
      .describe("Wall-clock timeout in milliseconds (default 120000, max 300000)"),
  },
  async execute(args) {
    if (process.env.KODEVRA_SANDBOX_EXEC !== "1" || !process.env.KODEVRA_HOME) {
      return DISABLED;
    }

    const workspace = process.env.KODEVRA_WORKSPACE;
    if (!workspace) return "sandbox_exec has no workspace for this run. No command was executed.";

    const home = process.env.KODEVRA_HOME.replace(/[\\/]+$/, "");
    const { runSandboxCommand } = await import(pathToFileURL(`${home}/lib/sandbox-command.js`).href);
    const result = await runSandboxCommand({
      command: args.command,
      workspace,
      timeoutMs: args.timeout_ms,
      runId: process.env.KODEVRA_RUN_ID,
      runFile: process.env.KODEVRA_RUN_FILE,
    });

    return {
      title: `sandbox_exec exit ${result.metadata.exit_code}${result.metadata.timed_out ? " (timed out)" : ""}`,
      output: result.output,
      metadata: result.metadata,
    };
  },
});
