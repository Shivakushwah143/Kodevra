import fs from "node:fs";

/**
 * Live progress from the run's own event file.
 *
 * Kodevra does not orchestrate the agent, so it cannot hook a tool callback.
 * But the sandbox tool already appends structured events to the run's JSONL
 * file, so Kodevra tails that file and turns sandbox activity into one honest
 * line per command. No second event system, no polling of the engine.
 */
export function watchRunEvents(file, { onEvent, intervalMs = 400 } = {}) {
  if (!file) return () => {};

  let offset = 0;
  let pending = "";
  let stopped = false;

  const read = () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (stat.size <= offset) return;

    let chunk;
    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buffer, 0, length, offset);
      } finally {
        fs.closeSync(fd);
      }
      offset = stat.size;
      chunk = buffer.toString("utf8");
    } catch {
      return;
    }

    const lines = `${pending}${chunk}`.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent?.(JSON.parse(line));
      } catch {
        // a partially written line is retried on the next tick of the writer
      }
    }
  };

  const timer = setInterval(read, intervalMs);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    read();
  };
}
