import readline from "node:readline/promises";

import { color } from "./brand.js";

/**
 * A small prompt loop, not a terminal UI.
 *
 * Kodevra keeps the process alive after a task so the next instruction does not
 * need a second launch. Each task still goes through the same run path, limits
 * and provider startup as a one-shot run.
 */
export async function runInteractiveSession({
  runTask,
  input = process.stdin,
  output = process.stdout,
  prompt = "> ",
} = {}) {
  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });

  const runLine = async (line) => {
    const task = `${line ?? ""}`.trim();
    if (!task) return true;
    if (["exit", "quit", ":q", "/exit", "/quit"].includes(task.toLowerCase())) return false;
    if (["help", "/help", "?"].includes(task.toLowerCase())) {
      output.write(`  ${color.dim("Enter a task, or type exit to leave.")}\n`);
      return true;
    }
    try {
      await runTask(task);
    } catch (error) {
      output.write(`\n  ${color.red("error")} ${error?.message || error}\n`);
    }
    output.write("\n");
    return true;
  };

  try {
    // A piped stdin is valid input too (scripts, acceptance harnesses). Read it
    // line by line instead of waiting for a TTY keypress.
    if (!input.isTTY) {
      output.write(prompt);
      for await (const line of rl) {
        if (!(await runLine(line))) break;
        output.write(prompt);
      }
      return;
    }

    for (;;) {
      let line;
      try {
        line = await rl.question(prompt);
      } catch {
        break;
      }
      if (!(await runLine(line))) break;
    }
  } finally {
    rl.close();
  }
}
