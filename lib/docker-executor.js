import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import { removeSandbox, sandboxRoot, stageWorkspace } from "./sandbox.js";

/**
 * Docker verification executor.
 *
 * One ephemeral Linux container per verification, built from a private snapshot
 * of the workspace. Isolation controls are Docker's own documented ones:
 *
 * - only the snapshot is mounted, never the developer's workspace;
 * - no Docker socket, no host credentials, no network;
 * - all Linux capabilities dropped, no-new-privileges, non-root user;
 * - CPU, memory, PID and wall-clock limits;
 * - read-only root filesystem with small tmpfs scratch areas.
 *
 * This reduces risk; it is not a claim of perfect containment. The kernel, the
 * container runtime and Docker Desktop remain in the trusted computing base.
 */

export const DOCKER_DEFAULTS = {
  image: process.env.KODEVRA_DOCKER_IMAGE || "node:22-alpine",
  cpus: process.env.KODEVRA_DOCKER_CPUS || "2",
  memory: process.env.KODEVRA_DOCKER_MEMORY || "2g",
  pids: Number(process.env.KODEVRA_DOCKER_PIDS || 256),
  timeoutMs: Number(process.env.KODEVRA_DOCKER_TIMEOUT_MS || 180_000),
};

let cachedAvailability = null;

function setupError(message, hint) {
  const error = new Error(message);
  error.code = "EXECUTOR_UNAVAILABLE";
  error.hint = hint;
  return error;
}

/**
 * Cheap engine probe used by the startup panel and `kodevra doctor`: no image
 * pull, no model run, short timeout. Never throws.
 */
export function probeDocker({ timeoutMs = 4_000 } = {}) {
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Os}}"], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (version.error?.code === "ENOENT") {
    return { ok: false, detail: "Docker CLI is not installed", hint: "Install Docker Desktop with the WSL2 backend: https://docs.docker.com/desktop/setup/install/" };
  }
  if (version.status !== 0) {
    const detail = `${version.stderr || version.stdout || ""}`.trim().split("\n")[0] || "docker version failed";
    return { ok: false, detail: `Docker engine is not reachable (${detail})`, hint: "Start Docker Desktop and wait until it shows 'Engine running'." };
  }
  const serverOs = `${version.stdout || ""}`.trim();
  if (serverOs && serverOs.toLowerCase() !== "linux") {
    return { ok: false, detail: `Docker is serving ${serverOs} containers`, hint: "Switch Docker Desktop to Linux containers (Settings > General)." };
  }
  return { ok: true, detail: "docker ready · linux engine", hint: null };
}

/**
 * Docker Desktop / Linux engine availability, checked before the model runs so a
 * missing engine costs nothing. The image is pulled once if it is absent.
 */
export function checkDocker({ image = DOCKER_DEFAULTS.image, refresh = false } = {}) {
  if (cachedAvailability && !refresh && cachedAvailability.image === image) return cachedAvailability;

  const probe = probeDocker({ timeoutMs: 20_000 });
  if (!probe.ok) throw setupError(`${probe.detail}.`, probe.hint);

  const inspect = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", timeout: 20_000 });
  if (inspect.status !== 0) {
    const pull = spawnSync("docker", ["pull", image], { encoding: "utf8", timeout: 240_000 });
    if (pull.status !== 0) {
      throw setupError(
        `Docker image ${image} is not available and could not be pulled.`,
        `Pull it once with an active network: docker pull ${image}`,
      );
    }
  }

  cachedAvailability = { image, serverOs: "linux" };
  return cachedAvailability;
}

/** Test seam: forget the cached availability probe. */
export function resetDockerAvailability() {
  cachedAvailability = null;
}

export function buildDockerArgs({
  image,
  snapshot,
  command,
  name,
  cpus = DOCKER_DEFAULTS.cpus,
  memory = DOCKER_DEFAULTS.memory,
  pids = DOCKER_DEFAULTS.pids,
}) {
  const mount = `${path.resolve(snapshot).replace(/\\/g, "/")}:/workspace:rw`;
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(pids),
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--cpus",
    String(cpus),
    "--user",
    "1000:1000",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "--tmpfs",
    "/home/node:rw,size=64m",
    "--ulimit",
    "nofile=1024:1024",
    "-v",
    mount,
    "-w",
    "/workspace",
    "-e",
    "CI=1",
    "-e",
    "HOME=/home/node",
    "-e",
    "npm_config_cache=/tmp/npm",
    "--label",
    "kodevra.executor=docker",
    "--label",
    `kodevra.container=${name}`,
    image,
    "sh",
    "-lc",
    command,
  ];
}

export function runInDocker(command, { cwd, timeoutMs = DOCKER_DEFAULTS.timeoutMs, forward = true } = {}) {
  const startedAt = Date.now();
  let availability;
  try {
    availability = checkDocker();
  } catch (error) {
    return {
      command,
      ok: false,
      status: 125,
      timedOut: false,
      output: `${error.message}${error.hint ? `\n-> ${error.hint}` : ""}`,
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: error.code ?? "EXECUTOR_UNAVAILABLE",
    };
  }

  const root = sandboxRoot();
  const snapshot = path.join(root, "workspace");
  let staged;
  try {
    staged = stageWorkspace({ workspace: cwd, destination: snapshot });
  } catch (error) {
    removeSandbox(root);
    return {
      command,
      ok: false,
      status: 1,
      timedOut: false,
      output: `Snapshot staging failed: ${error.message}`,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - startedAt,
      error: error.code ?? "SNAPSHOT_FAILED",
    };
  }

  const name = `kodevra-${randomUUID().slice(0, 8)}`;
  const args = buildDockerArgs({ image: availability.image, snapshot, command, name });
  const details = {
    image: availability.image,
    container: name,
    snapshot,
    staged_files: staged.files,
    staged_bytes: staged.bytes,
    excluded: staged.excluded,
    network: "none",
    user: "1000:1000",
  };

  return new Promise((resolve) => {
    let output = "";
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child = null;

    const cleanup = () => {
      try {
        spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 20_000 });
      } catch {
        // the container is also started with --rm
      }
      removeSandbox(root);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      cleanup();
      resolve({ command, durationMs: Date.now() - startedAt, details, ...result });
    };

    const onSignal = () => {
      finish({ ok: false, status: 130, timedOut: false, signal: "SIGINT", output, stdout, stderr });
      process.exit(130);
    };

    timer = setTimeout(() => {
      timedOut = true;
      try {
        spawnSync("docker", ["kill", name], { stdio: "ignore", timeout: 20_000 });
      } catch {
        // finish() still removes the container
      }
    }, timeoutMs);

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({
        ok: false,
        status: 1,
        timedOut,
        signal: null,
        output: error.message,
        stdout,
        stderr,
        error: error.message,
      });
      return;
    }

    const cap = (value) => (value.length > 200_000 ? value.slice(-200_000) : value);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output = cap(output + text);
      stdout = cap(stdout + text);
      if (forward) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output = cap(output + text);
      stderr = cap(stderr + text);
      if (forward) process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        status: 1,
        timedOut,
        signal: null,
        output: `${output}\n${error.message}`,
        stdout,
        stderr,
        error: error.message,
      });
    });

    child.on("close", (status, signal) => {
      const code = timedOut ? 124 : status ?? 1;
      finish({ ok: code === 0, status: code, timedOut, signal, output, stdout, stderr });
    });
  });
}
