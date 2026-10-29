import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { readState, stateFile, writeState } from "./providers.js";

/**
 * Kodevra owns the ChatGPT Web startup path.
 *
 * chatgpt-bridge stays a provider process: Kodevra starts it when chatgpt-web is
 * selected, reuses a healthy one, and never turns the bridge into a global
 * daemon. The bridge token is read from the bridge's own data directory and is
 * only ever used as an Authorization header - it is never printed.
 */

export const DEFAULT_BRIDGE_PORT = 8080;
export const DEFAULT_BRIDGE_URL = `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}/v1`;
export const DEFAULT_BRIDGE_DATA_DIR = path.join(os.homedir(), ".bridge-data");

const START_TIMEOUT_MS = Math.max(2_000, Number(process.env.KODEVRA_BRIDGE_START_TIMEOUT_MS || 20_000));
const BROWSER_WAIT_MS = Math.max(0, Number(process.env.KODEVRA_BRIDGE_BROWSER_WAIT_MS || 45_000));
const LOCK_STALE_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function readEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const values = {};
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      if (!key) continue;
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function isBridgeCheckout(dir) {
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    if (!fs.existsSync(path.join(dir, "src", "index.js"))) return false;
    const packageFile = path.join(dir, "package.json");
    if (!fs.existsSync(packageFile)) return true;
    const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    return /chatgpt-browser-bridge/i.test(`${pkg?.name ?? ""}`) || fs.existsSync(path.join(dir, "src", "index.js"));
  } catch {
    return false;
  }
}

function candidateDirs({ cwd = process.cwd(), env = process.env, state = null } = {}) {
  return [
    env.KODEVRA_CHATGPT_BRIDGE_DIR,
    state?.chatgptBridge?.dir,
    path.join(os.homedir(), "kodevra-provider-research", "chatgpt-bridge"),
    path.resolve(cwd, "..", "kodevra-provider-research", "chatgpt-bridge"),
    path.resolve(import.meta.dirname, "..", "..", "kodevra-provider-research", "chatgpt-bridge"),
    path.resolve(cwd, "chatgpt-bridge"),
    path.resolve(cwd, "integrations", "chatgpt-bridge"),
  ].filter(Boolean).map((value) => path.resolve(value));
}

function envFileCandidates({ dataDir, dir }) {
  return [
    path.join(dataDir, ".env"),
    ...(dir ? [path.join(dir, ".env"), path.join(dir, ".bridge-data", ".env")] : []),
  ].filter((file, index, all) => all.indexOf(file) === index);
}

function normalizeBaseURL(value, port) {
  const raw = `${value || ""}`.trim() || `http://127.0.0.1:${port}`;
  let url = raw.replace(/\/+$/, "");
  if (!/\/v1$/.test(url)) url = `${url}/v1`;
  return url;
}

function portFromURL(value, fallback) {
  try {
    const url = new URL(value);
    return Number(url.port) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve the bridge checkout and its existing local configuration without
 * reading a credential into output. Safe to call for doctor and providers.
 */
export function resolveBridgeInstallation({ cwd = process.cwd(), env = process.env, state = readState(), bridgeDir = null } = {}) {
  const candidates = [bridgeDir, ...candidateDirs({ cwd, env, state })].filter(Boolean);
  const dir = candidates.find(isBridgeCheckout) || candidates[0] || "";
  const valid = isBridgeCheckout(dir);

  // The bridge keeps durable request state under DATA_DIR. Prefer the checkout's
  // existing .bridge-data so a bridge started by Kodevra resumes the same
  // requests and token instead of silently moving to an empty directory. A
  // configured data dir still wins.
  const checkoutDataDir = dir ? path.join(dir, ".bridge-data") : "";
  const stateDataDir = state?.chatgptBridge?.dataDir;
  const configuredDataDir = env.KODEVRA_CHATGPT_BRIDGE_DATA_DIR
    || (stateDataDir && fs.existsSync(stateDataDir) ? stateDataDir : null)
    || (checkoutDataDir && fs.existsSync(checkoutDataDir) ? checkoutDataDir : null)
    || DEFAULT_BRIDGE_DATA_DIR;
  const dataDir = path.resolve(configuredDataDir);
  const envFile = envFileCandidates({ dataDir, dir }).find((file) => fs.existsSync(file)) || path.join(dataDir, ".env");
  const values = readEnvFile(envFile);

  // Explicit environment wins over a value written into the bridge's own .env:
  // otherwise changing just the port could start the process on 8099 while this
  // supervisor kept probing the old 8080 URL.
  const explicitURL = env.KODEVRA_CHATGPT_BRIDGE_URL || "";
  const explicitPort = Number(env.KODEVRA_CHATGPT_BRIDGE_PORT) || 0;
  const fileURL = values.PUBLIC_BASE_URL || "";
  const port = Number(
    explicitPort
      || (explicitURL ? portFromURL(explicitURL, 0) : 0)
      || (fileURL ? portFromURL(fileURL, 0) : 0)
      || values.PORT
      || state?.chatgptBridge?.port
      || DEFAULT_BRIDGE_PORT,
  ) || DEFAULT_BRIDGE_PORT;
  const baseURL = explicitURL
    ? normalizeBaseURL(explicitURL, port)
    : explicitPort
      ? normalizeBaseURL(`http://127.0.0.1:${port}`, port)
      : normalizeBaseURL(fileURL || `http://127.0.0.1:${port}`, port);
  const token = env.KODEVRA_CHATGPT_BRIDGE_TOKEN || values.API_TOKEN || "";
  const bridgeToken = env.BRIDGE_TOKEN || values.BRIDGE_TOKEN || "";

  return {
    dir,
    valid,
    dataDir,
    envFile,
    port,
    baseURL,
    token,
    bridgeToken,
    settings: { baseURL, token },
  };
}

function bridgeError(message, code, hint = "") {
  const error = new Error(message);
  error.code = code;
  error.hint = hint;
  return error;
}

async function fetchJSON(url, { token = "", timeoutMs = 3_000, fetchImpl = fetch, method = "GET" } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(url, {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

/**
 * One bridge readiness probe. `ready` requires a browser extension client: a
 * listening bridge with no tab is not enough to run a task.
 */
export async function probeBridgeState(settings, { timeoutMs = 3_000, fetchImpl = fetch } = {}) {
  const origin = `${settings.baseURL}`.replace(/\/+$/, "").replace(/\/v1$/, "");
  let health;
  try {
    health = await fetchJSON(`${origin}/health`, { token: settings.token, timeoutMs, fetchImpl });
  } catch (error) {
    return {
      server: false,
      ready: false,
      unauthorized: false,
      clients: 0,
      detail: `${origin} is not reachable`,
      error: `${error?.message || error}`,
    };
  }
  if (health.response.status === 401 || health.response.status === 403) {
    // /setup/status is localhost-only and unauthenticated, so it can still prove
    // that the process on this port is the bridge rather than an unrelated app.
    let identity = null;
    try {
      identity = await fetchJSON(`${origin}/setup/status`, { timeoutMs, fetchImpl });
    } catch {
      identity = null;
    }
    const isBridge = Boolean(identity?.body?.bridgeVersion || identity?.body?.setupUrl || identity?.body?.ok === true);
    return {
      server: isBridge,
      ready: false,
      unauthorized: isBridge,
      clients: 0,
      detail: isBridge ? "bridge is running but the local API token did not match" : "the port answered, but not as chatgpt-bridge",
    };
  }
  if (!health.response.ok) {
    return {
      server: true,
      ready: false,
      unauthorized: false,
      clients: 0,
      detail: `bridge /health answered HTTP ${health.response.status}`,
      health: health.body,
    };
  }
  const clients = Number(health.body?.clients) || 0;
  const ready = health.body?.ok !== false && clients > 0;
  return {
    server: true,
    ready,
    unauthorized: false,
    clients,
    detail: ready
      ? `${origin} · ${clients} browser client(s) connected`
      : `${origin} · no ChatGPT browser client connected`,
    health: health.body,
  };
}

export function checkPortOpen(port, { host = "127.0.0.1", timeoutMs = 700 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(value);
    };
    socket.setTimeout(Math.max(150, timeoutMs));
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(Number(port), host);
    } catch {
      finish(false);
    }
  });
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function kodevraDir() {
  return path.dirname(stateFile());
}

function lockFile() {
  return path.join(kodevraDir(), "bridge-start.lock");
}

function acquireStartLock() {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { ok: true, file };
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, reason: "lock_unavailable", file };
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const fresh = Number(holder?.at) > 0 && Date.now() - Number(holder.at) < LOCK_STALE_MS;
      if (fresh && (holder.pid === process.pid || isPidAlive(holder.pid))) {
        return { ok: false, reason: "another_start_in_progress", holder, file };
      }
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  return { ok: false, reason: "lock_unavailable", file };
}

function releaseStartLock(lock) {
  if (!lock?.file) return;
  try {
    const holder = JSON.parse(fs.readFileSync(lock.file, "utf8"));
    if (holder?.pid === process.pid) fs.rmSync(lock.file, { force: true });
  } catch {}
}

function bridgeLogFile() {
  return path.join(kodevraDir(), "logs", "chatgpt-bridge.log");
}

function tailLog(file, lines = 12) {
  try {
    const text = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
    return text.replace(/(api[_-]?token|bridge[_-]?token|token|authorization)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, 2_000);
  } catch {
    return "";
  }
}

function refreshSettings(layout) {
  const values = readEnvFile(layout.envFile);
  return {
    ...layout.settings,
    token: layout.token || values.API_TOKEN || "",
    bridgeToken: layout.bridgeToken || values.BRIDGE_TOKEN || "",
  };
}

function startProcess(layout, settings) {
  const entry = path.join(layout.dir, "src", "index.js");
  if (!layout.valid || !fs.existsSync(entry)) {
    throw bridgeError(
      "chatgpt-bridge was not found. Run: kodevra setup",
      "BRIDGE_NOT_INSTALLED",
      "Pass the checkout once with kodevra setup --bridge-dir <path>.",
    );
  }
  const logFile = bridgeLogFile();
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(logFile, "a", 0o600);
  const childEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(layout.port),
    DATA_DIR: layout.dataDir,
    ENV_FILE: layout.envFile,
    PUBLIC_BASE_URL: `http://127.0.0.1:${layout.port}`,
    ...(settings.token ? { API_TOKEN: settings.token } : {}),
    ...(settings.bridgeToken ? { BRIDGE_TOKEN: settings.bridgeToken } : {}),
  };
  let child;
  try {
    child = spawn(process.execPath, [entry, "--server"], {
      cwd: layout.dir,
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  if (!child?.pid) throw bridgeError("chatgpt-bridge could not be started.", "BRIDGE_START_FAILED", "Run: kodevra doctor");
  // A spawn error is reported by the readiness loop (the pid stops being
  // alive); without a listener Node would print an unhandled error first.
  child.on("error", () => {});
  child.unref();

  const previous = readState()?.chatgptBridge || {};
  writeState({
    chatgptBridge: {
      ...previous,
      dir: layout.dir,
      dataDir: layout.dataDir,
      envFile: layout.envFile,
      port: layout.port,
      pid: child.pid,
      startedAt: Date.now(),
      logFile,
    },
  });
  return { child, logFile };
}

async function waitForServer(layout, { timeoutMs, fetchImpl, onTick }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let settings = refreshSettings(layout);
  while (Date.now() < deadline) {
    last = await probeBridgeState(settings, { timeoutMs: 2_000, fetchImpl });
    if (last.server && !last.unauthorized) return { probe: last, settings };
    // The bridge generates API_TOKEN in its .env on first start. Re-read it,
    // then retry; a 401 is not a ready server until the local token matches.
    settings = refreshSettings(layout);
    await onTick?.();
    await sleep(300);
  }
  return { probe: last, settings, timedOut: true };
}

function canOpenBrowser(env = process.env) {
  return env.KODEVRA_NO_OPEN_BROWSER !== "1" && env.KODEVRA_BRIDGE_NO_BROWSER !== "1";
}

function chromeCandidates(env = process.env) {
  if (process.platform === "win32") {
    return [
      env.KODEVRA_CHROME_BIN,
      path.join(env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
  }
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return ["google-chrome", "chromium", "chromium-browser"];
}

export function openChatGPT({ env = process.env } = {}) {
  if (!canOpenBrowser(env)) return false;
  try {
    const chrome = chromeCandidates(env).find((candidate) => candidate && (candidate.includes(" ") || candidate.includes("/") || candidate.includes("\\") ? fs.existsSync(candidate) : true));
    if (chrome && (process.platform !== "win32" || fs.existsSync(chrome))) {
      const child = spawn(chrome, ["--new-tab", "https://chatgpt.com/"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      return true;
    }
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", "https://chatgpt.com/"], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
      return true;
    }
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, ["https://chatgpt.com/"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForBrowser(layout, settings, {
  timeoutMs,
  fetchImpl,
  openBrowser = true,
  allowNoBrowser = false,
  onStatus = () => {},
  initialWaitMs = 6_000,
} = {}) {
  let probe = await probeBridgeState(settings, { fetchImpl });
  if (probe.ready) return probe;
  if (probe.unauthorized) {
    throw bridgeError(
      "chatgpt-bridge is running, but its local API token did not match.",
      "BRIDGE_UNAUTHORIZED",
      "Run: kodevra setup",
    );
  }
  if (!probe.server) return probe;
  const timeout = openBrowser ? Math.max(0, timeoutMs) : Math.min(Math.max(0, timeoutMs), 8_000);
  const deadline = Date.now() + timeout;
  const openAt = Date.now() + Math.min(initialWaitMs, timeout);
  let opened = false;
  while (Date.now() < deadline) {
    probe = await probeBridgeState(settings, { fetchImpl });
    if (probe.ready) return probe;
    if (!opened && openBrowser && Date.now() >= openAt) {
      opened = true;
      onStatus("Waiting for the ChatGPT browser tab...");
      openChatGPT();
    }
    await sleep(400);
  }
  probe = await probeBridgeState(settings, { fetchImpl });
  if (probe.ready || allowNoBrowser) return probe;
  throw bridgeError(
    "ChatGPT bridge is ready, but no ChatGPT browser tab is connected.",
    "BRIDGE_NO_BROWSER",
    "Open ChatGPT in Chrome with the Bridge extension enabled, then run: kodevra doctor",
  );
}

/**
 * Reuse a healthy bridge, or start the selected checkout once and wait for its
 * browser extension. Returns the settings the agent should use.
 */
export async function ensureChatGptBridge({
  workspace = process.cwd(),
  bridgeDir = null,
  start = true,
  waitForBrowser: shouldWaitForBrowser = true,
  timeoutMs = START_TIMEOUT_MS,
  browserWaitMs = BROWSER_WAIT_MS,
  fetchImpl = fetch,
  onStatus = () => {},
  allowNoBrowser = false,
} = {}) {
  let layout = resolveBridgeInstallation({ cwd: workspace, bridgeDir });
  let settings = refreshSettings(layout);
  let readyAnnounced = false;
  let spawned = false;
  const announceReady = () => {
    if (readyAnnounced) return;
    readyAnnounced = true;
    onStatus("Ready.");
  };

  const state = readState();
  const previous = state?.chatgptBridge;
  if (previous?.pid && !isPidAlive(previous.pid)) {
    // The pid was a fact when it was written. A dead one is cleared rather than
    // trusted, so the next probe decides whether a bridge is really running.
    writeState({ chatgptBridge: { ...previous, pid: null, stoppedAt: Date.now() } });
  }

  let initial = await probeBridgeState(settings, { fetchImpl });
  if (initial.ready) {
    announceReady();
    return { settings, layout, ...initial, started: false, reused: true };
  }

  if (initial.unauthorized) {
    throw bridgeError(
      "chatgpt-bridge is running, but its local API token did not match.",
      "BRIDGE_UNAUTHORIZED",
      "Run: kodevra setup",
    );
  }

  if (!start) {
    if (!initial.server) {
      return { settings, layout, ...initial, started: false, reused: false };
    }
    if (shouldWaitForBrowser) {
      const probe = await waitForBrowser(layout, settings, {
        timeoutMs: browserWaitMs,
        fetchImpl,
        openBrowser: false,
        allowNoBrowser,
        onStatus,
      });
      return { settings, layout, ...probe, started: false, reused: true };
    }
    return { settings, layout, ...initial, started: false, reused: true };
  }

  if (!initial.server && await checkPortOpen(layout.port)) {
    // A previous Kodevra may still be bringing the bridge up. If its recorded
    // pid is alive, wait for it rather than treating the bound port as a
    // conflict. A genuinely unrelated process still fails closed.
    if (previous?.pid && isPidAlive(previous.pid)) {
      const waited = await waitForServer(layout, {
        timeoutMs: Math.min(timeoutMs, 8_000),
        fetchImpl,
        onTick: () => onStatus("Waiting for the existing ChatGPT bridge..."),
      });
      if (waited.probe?.server && !waited.probe.unauthorized) {
        initial = waited.probe;
        settings = waited.settings;
      }
    }
    if (!initial.server) {
      throw bridgeError(
        `Port ${layout.port} is already in use, but chatgpt-bridge did not answer on it.`,
        "BRIDGE_PORT_CONFLICT",
        "Close the process using that port, or set KODEVRA_CHATGPT_BRIDGE_PORT, then run: kodevra doctor",
      );
    }
  }

  if (!initial.server) {
    if (!layout.valid) {
      throw bridgeError(
        "chatgpt-bridge was not found. Run: kodevra setup",
        "BRIDGE_NOT_INSTALLED",
        "Pass the checkout once with kodevra setup --bridge-dir <path>.",
      );
    }
    const lock = acquireStartLock();
    if (!lock.ok) {
      // Another Kodevra is already starting it. Wait for that process instead of
      // spawning a duplicate.
      const waited = await waitForServer(layout, {
        timeoutMs,
        fetchImpl,
        onTick: () => onStatus("Waiting for the existing ChatGPT bridge..."),
      });
      if (waited.probe?.server) {
        initial = waited.probe;
        settings = waited.settings;
      } else {
        throw bridgeError(
          "Another Kodevra process is already starting chatgpt-bridge, but it did not become ready in time.",
          "BRIDGE_START_IN_PROGRESS",
          "Run: kodevra doctor",
        );
      }
    } else {
      let child = null;
      let logFile = "";
      try {
        initial = await probeBridgeState(settings, { fetchImpl });
        if (!initial.server) {
          onStatus("Starting provider...");
          const started = startProcess(layout, settings);
          child = started.child;
          logFile = started.logFile;
          spawned = true;
          const waited = await waitForServer(layout, {
            timeoutMs,
            fetchImpl,
            onTick: async () => {
              if (!isPidAlive(child.pid)) {
                throw bridgeError(
                  `chatgpt-bridge exited while starting.${tailLog(logFile) ? ` ${tailLog(logFile).split("\n").slice(-1)[0]}` : ""}`,
                  "BRIDGE_START_FAILED",
                  "Run: kodevra doctor",
                );
              }
            },
          });
          if (!waited.probe?.server) {
            throw bridgeError(
              "chatgpt-bridge did not become ready in time.",
              "BRIDGE_START_TIMEOUT",
              "Run: kodevra doctor",
            );
          }
          initial = waited.probe;
          settings = waited.settings;
          if (initial.ready) announceReady();
        }
      } finally {
        releaseStartLock(lock);
      }
      if (initial.ready) {
        announceReady();
        return { settings, layout, ...initial, started: spawned, reused: !spawned };
      }
    }
  }

  if (shouldWaitForBrowser) {
    const probe = await waitForBrowser(layout, settings, {
      timeoutMs: browserWaitMs,
      fetchImpl,
      openBrowser: canOpenBrowser() && Boolean(process.stdin.isTTY),
      allowNoBrowser,
      onStatus,
    });
    if (probe.ready) announceReady();
    return { settings, layout, ...probe, started: spawned, reused: !spawned && Boolean(initial.server) };
  }
  if (initial.ready) announceReady();
  return { settings, layout, ...initial, started: spawned, reused: !spawned && Boolean(initial.server) };
}
