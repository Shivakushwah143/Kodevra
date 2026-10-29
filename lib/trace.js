/**
 * Execution tracing over OpenCode's own event stream.
 *
 * `opencode run --format json` already emits structured events for every step,
 * tool call and token count. Kodevra does not add a second event system: with
 * `--trace` it asks the engine for that native stream, turns it into one honest
 * line per step and keeps the totals (steps, tool calls, tokens, cost) for the
 * run summary and the event log.
 *
 * Parsing is deliberately tolerant. Event names have appeared as both
 * `step-start` and `step_finish`, and tool events differ between providers, so
 * unknown events are ignored rather than failing a run. Nothing here invents a
 * number: every total comes from the engine's own `step_finish` payload.
 */

const TOOL_EVENT_TYPES = new Set(["tool", "tool_use", "tool_call", "tool-call"]);
const TEXT_EVENT_TYPES = new Set(["text", "message", "assistant"]);
const STEP_FINISH_TYPES = new Set(["step_finish"]);

function normaliseType(value) {
  return String(value || "")
    .replace(/-/g, "_")
    .toLowerCase();
}

function emptyTotals() {
  return {
    steps: 0,
    tool_calls: 0,
    tool_failures: 0,
    errors: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    first_text_ms: null,
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toolName(part) {
  return part?.tool || part?.name || part?.toolName || part?.state?.name || "tool";
}

function toolJob(part) {
  const title = part?.state?.title || part?.title || part?.input?.filePath || part?.input?.path || null;
  return typeof title === "string" ? title.split(/[\\/]/).pop() : null;
}

export function createTrace({ now = () => Date.now() } = {}) {
  const openedAt = now();
  const total = emptyTotals();
  let call = emptyTotals();
  let callStartedAt = now();
  let buffer = "";

  function merge(target, source) {
    target.steps += source.steps;
    target.tool_calls += source.tool_calls;
    target.tool_failures += source.tool_failures;
    target.errors += source.errors;
    target.cost += source.cost;
    for (const key of Object.keys(target.tokens)) target.tokens[key] += source.tokens[key];
    if (target.first_text_ms === null) target.first_text_ms = source.first_text_ms;
    return target;
  }

  /** One engine event -> zero or more human lines. */
  function handleEvent(event) {
    const lines = [];
    if (!event || typeof event !== "object") return lines;
    const type = normaliseType(event.type);
    const part = event.part ?? event;

    if (TOOL_EVENT_TYPES.has(type)) {
      call.tool_calls += 1;
      const status = part?.state?.status ?? part?.status;
      if (status === "error" || status === "failed") call.tool_failures += 1;
      const job = toolJob(part);
      lines.push(`  trace    ${toolName(part)}${job ? ` ${job}` : ""}${status ? ` (${status})` : ""}`);
      return lines;
    }

    if (STEP_FINISH_TYPES.has(type)) {
      call.steps += 1;
      const tokens = part?.tokens ?? {};
      const cache = tokens.cache ?? {};
      call.tokens.input += number(tokens.input);
      call.tokens.output += number(tokens.output);
      call.tokens.reasoning += number(tokens.reasoning);
      call.tokens.cache_read += number(cache.read);
      call.tokens.cache_write += number(cache.write);
      call.cost += number(part?.cost);
      const output = number(tokens.output) + number(tokens.reasoning);
      lines.push(
        `  trace    step ${call.steps} - ${output} output tok - $${number(part?.cost).toFixed(5)}`,
      );
      return lines;
    }

    if (TEXT_EVENT_TYPES.has(type)) {
      const text = typeof part?.text === "string" ? part.text : "";
      if (call.first_text_ms === null) call.first_text_ms = now() - callStartedAt;
      if (text.trim()) lines.push(text);
      return lines;
    }

    if (type === "error") {
      call.errors += 1;
      const message = event.error?.data?.message || event.error?.message || event.message || "engine error";
      lines.push(`  trace    engine error: ${String(message).split("\n")[0]}`);
      return lines;
    }

    return lines;
  }

  /** Feed one complete line of engine output. Text without JSON is passed through. */
  function ingestLine(line) {
    const text = String(line ?? "").trim();
    if (!text) return [];
    if (!text.startsWith("{")) return [text];
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return [text];
    }
    return handleEvent(event);
  }

  /** Feed a raw chunk; partial lines are buffered until they are complete. */
  function ingestChunk(chunk) {
    buffer += String(chunk ?? "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    const out = [];
    for (const line of lines) out.push(...ingestLine(line));
    return out;
  }

  function beginCall() {
    call = emptyTotals();
    callStartedAt = now();
  }

  /** Finish one model call: its own metrics, and folded into the run total. */
  function endCall({ forward = true } = {}) {
    if (buffer.trim()) {
      const rest = ingestLine(buffer);
      buffer = "";
      if (rest.length && forward) for (const line of rest) process.stdout.write(`${line}\n`);
    }
    const finished = { ...call, tokens: { ...call.tokens }, model_ms: now() - callStartedAt };
    merge(total, call);
    call = emptyTotals();
    return finished;
  }

  function summary() {
    return {
      ...merge(emptyTotals(), total),
      tokens: { ...total.tokens },
      run_ms: now() - openedAt,
    };
  }

  return { beginCall, ingestLine, ingestChunk, endCall, summary };
}
