import { baselineFromGates, evaluateGates, isBlocking, summarizeContract } from "./verification-contract.js";
import { openRuntimeEnvironment, runAcceptance } from "./verification-runtime.js";
import { failureSignature } from "./verify.js";

/**
 * The contract runner: cheapest-first execution of the frozen contract.
 *
 *   cheap repository gates -> the developer's --verify -> runtime -> acceptance
 *
 * A blocking failure stops the ladder immediately, so a browser or a server is
 * never launched when a typecheck already failed, and the aggregate result keeps
 * the shape the existing verification state machine, repair prompt, outcome and
 * summary already consume (`ok`, `status`, `output`, `durationMs`).
 */

export const DEFAULT_CONTRACT_LIMITS = Object.freeze({
  repositoryTimeoutMs: 180_000,
  cheapTimeoutMs: 90_000,
  evidenceChars: 3_500,
  runtime: {},
});

/** Cheap gates first, the developer's command last: worst case it is not needed. */
export function orderedRepositoryGates(contract) {
  return [...(contract?.repository ?? [])].sort((a, b) => Number(Boolean(b.cheap)) - Number(Boolean(a.cheap)));
}

function publicGate(gate) {
  return {
    id: gate.id,
    layer: gate.layer,
    source: gate.source ?? null,
    command: gate.command ?? null,
    required: gate.required !== false,
    ok: Boolean(gate.ok),
    skipped: Boolean(gate.skipped),
    blocking: Boolean(gate.blocking),
    status: gate.status ?? null,
    timedOut: Boolean(gate.timedOut),
    code: gate.code ?? null,
    durationMs: gate.durationMs ?? null,
    // Kept so a baseline can tell "same pre-existing failure" from "a new one".
    signature: gate.signature ?? null,
  };
}

function commandFor(contract) {
  const user = (contract.repository ?? []).find((gate) => gate.source === "user");
  if (user) return user.command;
  const first = contract.repository?.[0];
  if (first) return first.command;
  return contract.runtime ? `runtime:${contract.runtime.adapter}` : "verification contract";
}

function describeProject(contract) {
  const framework = contract.project?.framework ? ` (${contract.project.framework})` : "";
  return `${contract.project?.kind ?? "unknown"}${framework}`;
}

/**
 * Compact, structured evidence. The same text is printed, stored in the outcome
 * and handed to the existing repair loop, so the model sees WHICH gate failed and
 * the one line that explains it - not a build log.
 */
export function buildEvidence(contract, gates, evaluation, maxChars = DEFAULT_CONTRACT_LIMITS.evidenceChars) {
  const passed = gates.filter((gate) => gate.ok && !gate.skipped).length;
  const failed = gates.filter((gate) => !gate.ok && !gate.skipped).length;
  const skipped = gates.filter((gate) => gate.skipped).length;
  const lines = [
    `VERIFICATION CONTRACT ${contract.schema}`,
    `project: ${describeProject(contract)} - ${contract.project?.reason ?? ""}`,
    `gates: ${gates.length} (${passed} passed, ${failed} failed, ${skipped} skipped)`,
  ];
  for (const gate of gates) {
    const state = gate.skipped ? "SKIPPED" : gate.ok ? "PASS" : "FAIL";
    const command = gate.command ? ` (${gate.command})` : "";
    const blocking = !gate.ok && !gate.skipped && gate.blocking ? " [blocking]" : "";
    lines.push(`- ${gate.layer}:${gate.id} ${state}${command}${blocking}`);
  }

  const failedGate = evaluation.blockingFailed[0] ?? null;
  if (failedGate?.evidence) {
    lines.push("", failedGate.evidence);
    if (failedGate.output) {
      const tail = `${failedGate.output}`.trim();
      lines.push("", "output tail:", tail.length > 1_200 ? `...${tail.slice(-1_200)}` : tail);
    }
  } else if (evaluation.ok) {
    lines.push("", "all required gates passed");
  }

  if (evaluation.preExisting.length) {
    lines.push(
      "",
      `pre-existing failures (unchanged from the pre-run baseline, not counted against this run): ${evaluation.preExisting
        .map((gate) => gate.id)
        .join(", ")}`,
    );
  }
  if (evaluation.skipped.length) {
    lines.push(`skipped gates: ${evaluation.skipped.map((gate) => gate.id).join(", ")}`);
  }

  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[verification evidence truncated]` : text;
}

function repositoryGateResult(gate, result) {
  return {
    id: gate.id,
    layer: "repository",
    source: gate.source,
    command: gate.command,
    required: gate.required !== false,
    ok: Boolean(result.ok),
    skipped: false,
    status: result.status ?? null,
    timedOut: Boolean(result.timedOut),
    durationMs: result.durationMs ?? null,
    signature: result.ok ? null : failureSignature(result.output ?? ""),
    output: `${result.output ?? ""}`,
    code: result.ok ? null : result.timedOut ? "REPOSITORY_GATE_TIMEOUT" : "REPOSITORY_VERIFY_FAILED",
    evidence: result.ok
      ? `REPOSITORY_GATE_PASSED\ncommand: ${gate.command}\nexit: 0`
      : `REPOSITORY_VERIFY_FAILED\ncommand: ${gate.command}\nexit: ${result.status ?? "unknown"}`,
  };
}

/**
 * Execute the contract. With `repositoryOnly` only the cheap repository gates
 * run - that is how the pre-mutation baseline is captured without paying for a
 * second build or browser launch.
 */
export async function runContractVerification({
  contract,
  workspace,
  executor,
  limits = {},
  includeRuntime = true,
  repositoryOnly = false,
  onlyCheap = false,
  onGate = null,
}) {
  if (!contract) throw new Error("runContractVerification needs a contract");
  const budget = { ...DEFAULT_CONTRACT_LIMITS, ...limits };
  const startedAt = Date.now();
  const gates = [];
  const baseline = contract.baseline?.gates ?? null;
  const announce = (gate) => {
    if (typeof onGate === "function") onGate(gate);
  };

  const repositoryGates = orderedRepositoryGates(contract).filter((gate) => !onlyCheap || gate.cheap);
  for (const gate of repositoryGates) {
    const timeoutMs = gate.cheap ? budget.cheapTimeoutMs : budget.repositoryTimeoutMs;
    const result = await executor.run(gate.command, { cwd: workspace, timeoutMs, forward: false });
    const evaluated = repositoryGateResult(gate, result);
    gates.push(evaluated);
    announce(evaluated);
    if (!evaluated.ok && isBlocking(evaluated, baseline)) break;
  }

  const blockedEarly = gates.some((gate) => !gate.ok && isBlocking(gate, baseline));
  if (!repositoryOnly && includeRuntime && contract.runtime && !blockedEarly) {
    const runtime = await openRuntimeEnvironment({
      contract,
      workspace,
      executor,
      limits: budget.runtime ?? {},
    });
    try {
      const gateResult = {
        id: contract.runtime.adapter,
        layer: "runtime",
        source: contract.runtime.source ?? "detected",
        command: contract.runtime.command ?? null,
        required: true,
        ok: Boolean(runtime.ok),
        skipped: Boolean(runtime.skipped),
        code: runtime.code ?? null,
        durationMs: null,
        evidence: runtime.evidence ?? "",
      };
      gates.push(gateResult);
      announce(gateResult);

      if (runtime.ok && !runtime.skipped && contract.acceptance.length) {
        const acceptance = await runAcceptance({
          criteria: contract.acceptance,
          env: runtime.env ?? null,
          workspace,
          executor,
          limits: budget.runtime ?? {},
        });
        for (const criterion of acceptance) {
          gates.push(criterion);
          announce(criterion);
        }
      }
    } finally {
      // Cleanup on pass, fail, exception and cancellation: the same call.
      await runtime.cleanup?.();
    }
  }

  const evaluation = evaluateGates(contract, gates);
  const failedGate = evaluation.blockingFailed[0] ?? null;
  const evidence = buildEvidence(contract, gates, evaluation, budget.evidenceChars);

  return {
    // Existing shape: the verification state machine, repair prompt, outcome and
    // summary read these fields unchanged.
    command: commandFor(contract),
    ok: evaluation.ok,
    refused: false,
    status: failedGate ? (failedGate.layer === "repository" ? failedGate.status ?? 1 : null) : 0,
    timedOut: Boolean(failedGate?.timedOut),
    output: evidence,
    durationMs: Date.now() - startedAt,
    // Contract detail: additive, so older consumers can ignore it.
    code: evaluation.code,
    verdict: evaluation.verdict,
    gates: evaluation.gates.map(publicGate),
    failedGates: evaluation.blockingFailed.map((gate) => gate.id),
    preExistingGates: evaluation.preExisting.map((gate) => gate.id),
    skippedGates: evaluation.skipped.map((gate) => gate.id),
    contract: summarizeContract(contract, gates),
  };
}

/** Pre-mutation baseline: cheap repository gates only. */
export async function captureContractBaseline({ contract, workspace, executor, limits = {}, onGate = null }) {
  const cheap = orderedRepositoryGates(contract).filter((gate) => gate.cheap);
  if (!cheap.length) return { baseline: null, gates: [] };
  const run = await runContractVerification({
    contract,
    workspace,
    executor,
    limits,
    repositoryOnly: true,
    onlyCheap: true,
    onGate,
  });
  return { baseline: baselineFromGates(run.gates.map((gate) => ({ ...gate, layer: "repository" })), {}), gates: run.gates };
}
