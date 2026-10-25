import { runCommand } from "./engine.js";
import { checkDocker, runInDocker } from "./docker-executor.js";

/**
 * Verification executors.
 *
 * `--verify` project code has to run somewhere. `host` runs it directly on this
 * machine and says it is not sandboxed. `docker` runs it in an ephemeral Linux
 * container built from a private workspace snapshot.
 *
 * An executor is:
 *   name        stable id used by --executor and the event log
 *   sandboxed   true only if project code cannot reach the host workspace
 *   description human-readable honesty about what it does
 *   check()     optional async probe; throws EXECUTOR_UNAVAILABLE with a hint
 *   run(command, { cwd, timeoutMs }) -> { ok, status, output, durationMs, timedOut, details? }
 */
const HOST = {
  name: "host",
  sandboxed: false,
  description: "runs project code directly on this machine",
  run: (command, options) => runCommand(command, options),
};

const DOCKER = {
  name: "docker",
  sandboxed: true,
  description: "ephemeral Linux container, private workspace snapshot",
  check: () => checkDocker(),
  run: (command, options) => runInDocker(command, options),
};

const REGISTRY = { host: HOST, docker: DOCKER };

export function listExecutors() {
  return Object.keys(REGISTRY);
}

export function resolveExecutor(name = "host") {
  const key = `${name || "host"}`.toLowerCase();
  const executor = REGISTRY[key];
  if (!executor) {
    const error = new Error(`Unknown executor "${name}". Available: ${listExecutors().join(", ")}`);
    error.code = "EXECUTOR_UNAVAILABLE";
    throw error;
  }
  return executor;
}

/** Registration point for another isolated executor without touching the loop. */
export function registerExecutor(executor) {
  if (!executor || typeof executor.run !== "function" || !executor.name) {
    throw new Error("An executor needs a name and a run(command, options) function.");
  }
  REGISTRY[executor.name] = { sandboxed: false, description: "", ...executor };
  return REGISTRY[executor.name];
}
