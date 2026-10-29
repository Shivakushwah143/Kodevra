import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { killTree } from "./engine.js";

/**
 * Runtime and acceptance adapters.
 *
 * Repository gates prove that a command exited 0. They cannot prove that the
 * software still works: `npm run build` passes while the built application
 * throws on first render. This module owns the HOW for that second question:
 *
 *   openRuntimeEnvironment()  one adapter starts what it needs, probes it, and
 *                             hands back an environment acceptance can use
 *   runAcceptance()           observable criteria evaluated inside that
 *                             environment (DOM, HTTP, CLI)
 *
 * Every process Kodevra starts is owned here: tracked, bounded by a timeout,
 * loopback-only, and stopped on pass, fail, exception and cancellation. Nothing
 * outside the processes this module spawned is ever signalled.
 *
 * The browser probe speaks the Chrome DevTools Protocol directly over Node's
 * built-in WebSocket, so no dependency is added. When no Chrome/Edge binary is
 * available the gate reports `skipped` instead of guessing.
 */

export const DEFAULT_RUNTIME_LIMITS = Object.freeze({
  startupTimeoutMs: 25_000,
  pageTimeoutMs: 15_000,
  renderWaitMs: 4_000,
  acceptanceTimeoutMs: 10_000,
  processSurvivalMs: 3_000,
  commandTimeoutMs: 60_000,
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/** Processes Kodevra started in this run, so a hard exit still kills them. */
const OWNED = new Set();
let exitHookInstalled = false;

function trackProcess(handle) {
  OWNED.add(handle);
  if (exitHookInstalled) return handle;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const owned of OWNED) {
      try {
        owned.stop();
      } catch {
        // nothing left to do at exit
      }
    }
  });
  return handle;
}

function untrackProcess(handle) {
  OWNED.delete(handle);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Spawn one process Kodevra owns. `stop()` kills that process and its children
 * only - never a process it did not start.
 */
export function startOwnedProcess({ command, cwd, env = {}, outputLimit = 12_000 }) {
  let child;
  try {
    child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    return {
      pid: null,
      output: () => error.message,
      exit: () => ({ code: null, signal: null, error: error.message }),
      alive: () => false,
      stop: () => {},
    };
  }

  let output = "";
  const collect = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-outputLimit);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  let exit = null;
  child.on("close", (code, signal) => {
    exit = { code, signal };
  });
  child.on("error", (error) => {
    exit = { code: null, signal: null, error: error.message };
  });

  const handle = {
    pid: child.pid ?? null,
    child,
    output: () => output,
    exit: () => exit,
    alive: () => exit === null,
    stop: () => {
      if (exit !== null) {
        untrackProcess(handle);
        return;
      }
      try {
        killTree(child);
      } catch {
        // the process was already gone
      }
      untrackProcess(handle);
    },
  };
  return trackProcess(handle);
}

/** In-process static server for a built artifact. No child, no port guessing. */
export async function startStaticServer({ root, dir = "." }) {
  const base = path.resolve(root, dir);
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("bad request");
      return;
    }
    const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const target = path.resolve(base, `.${relative}`);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("forbidden");
      return;
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        // Single-page builds route client-side; an unknown path is the shell.
        fs.readFile(path.join(base, "index.html"), (fallbackError, fallback) => {
          if (fallbackError) {
            response.writeHead(404, { "content-type": "text/plain" });
            response.end("not found");
            return;
          }
          response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
          response.end(fallback);
        });
        return;
      }
      response.writeHead(200, {
        "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(data);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Poll one loopback URL until it answers at all (any status means "running"). */
export async function waitForHttp(url, { timeoutMs = DEFAULT_RUNTIME_LIMITS.startupTimeoutMs, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(500, deadline - Date.now());
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(4_000, remaining)),
      });
      const body = await response.text().catch(() => "");
      return { ok: true, status: response.status, body: `${body}`.slice(0, 2_000), url };
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  return { ok: false, status: null, url, error: lastError?.message ?? "no response before the timeout" };
}

/** A Chrome/Edge binary, or null. Only real files count; no PATH guessing. */
export function chromeExecutable(env = process.env) {
  const candidates = [];
  if (env.KODEVRA_CHROME_PATH) candidates.push(env.KODEVRA_CHROME_PATH);
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
  if (process.platform === "win32") {
    for (const base of [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]) {
      if (!base) continue;
      candidates.push(
        path.join(base, "Google/Chrome/Application/chrome.exe"),
        path.join(base, "Microsoft/Edge/Application/msedge.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Synchronous pause: profile deletion happens inside an async close, but the
 * retry loop itself is not worth a promise. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeTempTree(dir) {
  // Node retries EPERM/EBUSY internally; Chrome releases the profile a moment
  // after the process is gone, so give it about two seconds before giving up.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      return;
    } catch {
      // Last resort: the OS cleans its own temp directory later.
      if (attempt === 0) pause(250);
    }
  }
}

const PAGE_STATE = `JSON.stringify((() => {
  const body = document.body;
  const text = body ? body.innerText.trim() : "";
  const root = document.querySelector("#root, #app, #main, main, body");
  return {
    text: text.slice(0, 200),
    textLength: text.length,
    rootChildren: root ? root.children.length : 0,
    title: document.title || "",
    readyState: document.readyState || "",
  };
})())`;

/**
 * One headless page session, driven over CDP. Returns an object the frontend
 * adapter and web acceptance checks share, and `close()` always disposes the
 * browser process and its temporary profile.
 */
export async function openBrowserSession({ chromePath, limits = DEFAULT_RUNTIME_LIMITS }) {
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-browser-"));
  const owned = startOwnedProcess({
    command: `"${chromePath}" --headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking --mute-audio --hide-scrollbars --disable-dev-shm-usage --user-data-dir="${profile}" --remote-debugging-port=0 about:blank`,
    cwd: os.tmpdir(),
  });

  const events = [];
  const waiters = [];
  const pending = new Map();
  let nextId = 1;
  let ws = null;
  let sessionId = null;
  let closed = false;

  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      // socket already closed
    }
    if (sessionId) {
      try {
        ws?.send?.(JSON.stringify({ id: 0, method: "Browser.close" }));
      } catch {
        // best effort: the process kill below is authoritative
      }
    }
    owned.stop();
    // Wait for the process to actually disappear before deleting its profile:
    // Chrome keeps the directory open for a moment after the kill.
    const deadline = Date.now() + 3_000;
    while (owned.exit() === null && Date.now() < deadline) await sleep(100);
    await sleep(120);
    removeTempTree(profile);
    if (fs.existsSync(profile)) {
      // A Windows Chrome child can release the profile slightly later; retry in
      // the background rather than holding the run open. Unref'd, so it never
      // keeps the CLI alive.
      const timer = setTimeout(() => removeTempTree(profile), 2_000);
      timer.unref?.();
    }
  };

  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    let info = null;
    const deadline = Date.now() + budget.startupTimeoutMs;
    while (!info && Date.now() < deadline) {
      await sleep(100);
      if (!fs.existsSync(portFile)) continue;
      const lines = fs.readFileSync(portFile, "utf8").trim().split("\n");
      if (lines.length >= 2) info = { port: Number(lines[0]), wsPath: lines[1] };
    }
    if (!info) throw fail("BROWSER_START_FAILED", `headless browser did not expose a debug port: ${owned.output().slice(-400) || "no output"}`);

    ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.wsPath}`);
    ws.onmessage = (message) => {
      let data;
      try {
        data = JSON.parse(message.data);
      } catch {
        return;
      }
      if (data.id && pending.has(data.id)) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) entry.reject(fail("BROWSER_PROTOCOL", data.error.message));
        else entry.resolve(data.result);
        return;
      }
      events.push(data);
      for (const waiter of [...waiters]) {
        if (!waiter.match(data)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(data);
      }
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail("BROWSER_START_FAILED", "browser websocket did not open")), budget.startupTimeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(fail("BROWSER_START_FAILED", "browser websocket failed"));
      };
    });

    const request = (method, params = {}, target = undefined) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(fail("BROWSER_TIMEOUT", `${method} timed out`));
        }, budget.pageTimeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        ws.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }));
      });

    const waitFor = (method, target, timeoutMs) => {
      const hit = events.find((event) => event.method === method && event.sessionId === target);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const waiter = { match: (event) => event.method === method && event.sessionId === target, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
      });
    };

    const target = await request("Target.createTarget", { url: "about:blank" });
    const attached = await request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    sessionId = attached.sessionId;
    await request("Runtime.enable", {}, sessionId);
    await request("Page.enable", {}, sessionId);
    await request("Log.enable", {}, sessionId);

    const evaluate = async (expression) => {
      const result = await request(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (result?.exceptionDetails) {
        return { ok: false, error: result.exceptionDetails.text ?? "evaluation failed" };
      }
      return { ok: true, value: result?.result?.value };
    };

    const navigate = async (url) => {
      events.length = 0;
      const result = await request("Page.navigate", { url }, sessionId);
      if (result?.errorText) return { ok: false, error: result.errorText };
      const loaded = await waitFor("Page.loadEventFired", sessionId, budget.pageTimeoutMs);
      if (!loaded) return { ok: false, error: "page did not finish loading" };
      return { ok: true, error: null };
    };

    const reload = async () => {
      events.length = 0;
      await request("Page.reload", { ignoreCache: false }, sessionId);
      const loaded = await waitFor("Page.loadEventFired", sessionId, budget.pageTimeoutMs);
      return { ok: Boolean(loaded), error: loaded ? null : "reload did not finish" };
    };

    const pageState = async () => {
      const result = await evaluate(PAGE_STATE);
      if (!result.ok || typeof result.value !== "string") return null;
      try {
        return JSON.parse(result.value);
      } catch {
        return null;
      }
    };

    /** Wait for the application to paint something rather than a fixed sleep. */
    const waitForRender = async () => {
      const deadline = Date.now() + budget.renderWaitMs;
      let state = await pageState();
      while (Date.now() < deadline) {
        if (state && (state.textLength > 0 || state.rootChildren > 0)) break;
        await sleep(150);
        state = await pageState();
      }
      return state;
    };

    const fatal = () => {
      const exception = events.find((event) => event.method === "Runtime.exceptionThrown");
      if (exception) {
        const details = exception.params?.exceptionDetails ?? {};
        const description = `${details.exception?.description ?? details.text ?? "uncaught exception"}`;
        const frame = details.stackTrace?.callFrames?.[0] ?? null;
        const source = frame?.url || details.url || null;
        const location = frame ? `${source ?? ""}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}` : source;
        const promise = /\bin promise\b/i.test(`${details.text ?? ""} ${description}`);
        return {
          kind: promise ? "unhandled promise rejection" : "uncaught JavaScript exception",
          error: description.split("\n")[0].slice(0, 300),
          source: location ? location.slice(0, 300) : null,
        };
      }
      const consoleError = events.find(
        (event) =>
          event.method === "Runtime.consoleAPICalled" &&
          event.params?.type === "error" &&
          !/^warning:/i.test(`${event.params.args?.[0]?.value ?? ""}`),
      );
      if (consoleError) {
        const message = consoleError.params.args
          .map((arg) => `${arg.value ?? arg.description ?? ""}`)
          .join(" ")
          .split("\n")[0]
          .slice(0, 300);
        return { kind: "fatal console error", error: message, source: null };
      }
      const logEntry = events.find(
        (event) => event.method === "Log.entryAdded" && event.params?.entry?.level === "error",
      );
      if (logEntry) {
        return { kind: "page error", error: `${logEntry.params.entry.text ?? ""}`.slice(0, 300), source: logEntry.params.entry.url ?? null };
      }
      return null;
    };

    return { sessionId, navigate, reload, evaluate, pageState, waitForRender, fatal, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function evidenceLines(code, fields) {
  const lines = [code];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

function outputTail(text, max = 900) {
  const value = `${text ?? ""}`.trim();
  if (!value) return "";
  return value.length > max ? `...${value.slice(-max)}` : value;
}

/**
 * Start whatever the frontend gate needs and prove the page executes.
 * The returned `env.browser` is what acceptance checks reuse.
 */
async function frontendWebAdapter({ gate, workspace, limits, cleanup }) {
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  let url = null;
  let server = null;
  let process = null;

  if (gate.mode === "external") {
    url = gate.url;
  } else if (gate.mode === "static") {
    server = await startStaticServer({ root: workspace, dir: gate.dir ?? "." });
    cleanup.push(() => server.close());
    url = server.url;
  } else {
    const port = await findFreePort();
    process = startOwnedProcess({
      command: gate.command,
      cwd: workspace,
      env: { PORT: String(port), BROWSER: "none", CI: "1", HOST: "127.0.0.1" },
    });
    cleanup.push(() => process.stop());
    url = `http://127.0.0.1:${port}/`;
    const ready = await waitForHttp(url, { timeoutMs: budget.startupTimeoutMs });
    if (!ready.ok) {
      const exit = process.exit();
      return {
        ok: false,
        code: "FRONTEND_SERVER_FAILED",
        evidence: evidenceLines("FRONTEND_SERVER_FAILED", {
          url,
          command: gate.command,
          exit: exit ? `exit ${exit.code ?? "unknown"}${exit.signal ? ` (${exit.signal})` : ""}` : null,
          error: ready.error,
          output: outputTail(process.output()),
        }),
        details: { url, command: gate.command },
      };
    }
  }

  const chrome = chromeExecutable();
  if (!chrome) {
    return {
      ok: true,
      skipped: true,
      code: "FRONTEND_NO_BROWSER",
      evidence: evidenceLines("FRONTEND_NO_BROWSER", {
        url,
        note: "no Chrome/Edge binary found (set KODEVRA_CHROME_PATH to enable page execution checks)",
      }),
      details: { url },
    };
  }

  let session;
  try {
    session = await openBrowserSession({ chromePath: chrome, limits: budget });
  } catch (error) {
    // A browser binary exists, so this is a real failure to run the check, not
    // an environment where page verification is impossible.
    return {
      ok: false,
      code: "FRONTEND_BROWSER_FAILED",
      evidence: evidenceLines("FRONTEND_BROWSER_FAILED", { url, error: error.message }),
      details: { url },
    };
  }
  cleanup.push(() => session.close());

  const loaded = await session.navigate(url);
  if (!loaded.ok) {
    return {
      ok: false,
      code: "FRONTEND_PAGE_LOAD_FAILED",
      evidence: evidenceLines("FRONTEND_PAGE_LOAD_FAILED", { url, error: loaded.error }),
      details: { url },
    };
  }

  const state = await session.waitForRender();
  const failure = session.fatal();
  if (failure) {
    return {
      ok: false,
      code: "FRONTEND_RUNTIME_FAILED",
      evidence: evidenceLines("FRONTEND_RUNTIME_FAILED", {
        url,
        error: failure.error,
        kind: failure.kind,
        source: failure.source,
      }),
      details: { url, kind: failure.kind },
      env: { browser: session, url },
    };
  }

  const rendered = Boolean(state && (state.textLength > 0 || state.rootChildren > 0));
  if (!rendered) {
    return {
      ok: false,
      code: "FRONTEND_BLANK",
      evidence: evidenceLines("FRONTEND_BLANK", {
        url,
        error: "the page loaded but rendered no text and no root children",
        title: state?.title || null,
        readyState: state?.readyState || null,
      }),
      details: { url },
      env: { browser: session, url },
    };
  }

  const probe = await session.evaluate("1 + 1");
  if (!probe.ok || probe.value !== 2) {
    return {
      ok: false,
      code: "FRONTEND_SCRIPT_FAILED",
      evidence: evidenceLines("FRONTEND_SCRIPT_FAILED", { url, error: "page JavaScript could not be evaluated" }),
      details: { url },
    };
  }

  return {
    ok: true,
    code: null,
    evidence: evidenceLines("FRONTEND_RUNTIME_PASSED", {
      url,
      rendered: `${state.textLength} char(s), ${state.rootChildren} root child(ren)`,
      title: state.title || null,
    }),
    details: { url, textLength: state.textLength, rootChildren: state.rootChildren },
    env: { browser: session, url },
  };
}

async function webApiAdapter({ gate, workspace, limits, cleanup }) {
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  let url = gate.mode === "external" ? gate.url : null;
  let process = null;

  if (gate.mode !== "external") {
    const port = await findFreePort();
    process = startOwnedProcess({
      command: gate.command,
      cwd: workspace,
      env: { PORT: String(port), CI: "1", HOST: "127.0.0.1" },
    });
    cleanup.push(() => process.stop());
    url = `http://127.0.0.1:${port}/`;
  }

  const base = url.replace(/\/$/, "");
  const healthPaths = [...new Set([...(gate.health ?? []), "/health", "/healthz", "/"])];
  let reachable = null;
  let serverError = null;
  const deadline = Date.now() + budget.startupTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline && !reachable && !serverError) {
    if (process && !process.alive()) break;
    for (const healthPath of healthPaths) {
      const probe = await waitForHttp(`${base}${healthPath}`, { timeoutMs: 1_200, intervalMs: 0 });
      if (!probe.ok) {
        lastError = probe.error;
        continue;
      }
      // A 5xx on a discovered endpoint is a real runtime failure; a 4xx on a
      // specific health path just means that path does not exist here.
      if (probe.status >= 500) {
        serverError = { ...probe, path: healthPath };
        break;
      }
      if (probe.status >= 400 && healthPath !== "/") continue;
      reachable = { ...probe, path: healthPath };
      break;
    }
    if (!reachable && !serverError) await sleep(250);
  }

  if (serverError) {
    return {
      ok: false,
      code: "API_RUNTIME_FAILED",
      evidence: evidenceLines("API_RUNTIME_FAILED", {
        endpoint: serverError.path,
        status: serverError.status,
        error: serverError.body.slice(0, 400) || "(no body)",
      }),
      details: { url, endpoint: serverError.path, status: serverError.status },
    };
  }

  if (!reachable) {
    const exit = process?.exit();
    return {
      ok: false,
      code: "API_RUNTIME_UNREACHABLE",
      evidence: evidenceLines("API_RUNTIME_UNREACHABLE", {
        url,
        endpoint: healthPaths[0],
        error: exit ? `process exited with ${exit.code ?? exit.error ?? "no code"}` : lastError,
        output: outputTail(process?.output()),
      }),
      details: { url },
    };
  }

  if (process && !process.alive()) {
    const exit = process.exit();
    return {
      ok: false,
      code: "API_RUNTIME_CRASHED",
      evidence: evidenceLines("API_RUNTIME_CRASHED", {
        endpoint: reachable.path,
        status: reachable.status,
        error: `the server exited after responding (exit ${exit?.code ?? "unknown"})`,
        output: outputTail(process.output()),
      }),
      details: { url },
    };
  }

  return {
    ok: true,
    code: null,
    evidence: evidenceLines("API_RUNTIME_PASSED", {
      endpoint: reachable.path,
      status: reachable.status,
    }),
    details: { url, endpoint: reachable.path, status: reachable.status },
    env: {
      url,
      fetch: async (target = "/", options = {}) => {
        const route = /^https?:\/\//.test(target) ? target : `${base}${target.startsWith("/") ? target : `/${target}`}`;
        try {
          const response = await fetch(route, {
            method: options.method ?? "GET",
            signal: AbortSignal.timeout(budget.acceptanceTimeoutMs),
          });
          const body = await response.text().catch(() => "");
          return { ok: true, status: response.status, body: `${body}`.slice(0, 4_000), route };
        } catch (error) {
          return { ok: false, status: null, body: "", route, error: error.message };
        }
      },
    },
  };
}

async function cliAdapter({ gate, workspace, executor, limits }) {
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  if (!gate.command) {
    return { ok: true, skipped: true, code: "CLI_NO_COMMAND", evidence: "no CLI invocation was discoverable" };
  }
  const started = Date.now();
  const result = await executor.run(gate.command, { cwd: workspace, timeoutMs: budget.commandTimeoutMs, forward: false });
  const durationMs = Date.now() - started;
  if (result.timedOut) {
    return {
      ok: false,
      code: "CLI_RUNTIME_TIMEOUT",
      evidence: evidenceLines("CLI_RUNTIME_TIMEOUT", { command: gate.command, timeoutMs: budget.commandTimeoutMs }),
      details: { command: gate.command, durationMs },
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      code: "CLI_RUNTIME_FAILED",
      evidence: evidenceLines("CLI_RUNTIME_FAILED", {
        command: gate.command,
        exit: result.status ?? "unknown",
        output: outputTail(result.output),
      }),
      details: { command: gate.command, exit: result.status ?? null, durationMs },
    };
  }
  return {
    ok: true,
    code: null,
    evidence: evidenceLines("CLI_RUNTIME_PASSED", { command: gate.command, exit: result.status ?? 0 }),
    details: { command: gate.command, durationMs },
    env: {
      run: async (args = []) => {
        const base = gate.entry ? `node "${path.resolve(workspace, gate.entry)}"` : gate.command;
        return executor.run(`${base} ${args.join(" ")}`.trim(), {
          cwd: workspace,
          timeoutMs: budget.acceptanceTimeoutMs,
          forward: false,
        });
      },
    },
  };
}

/** Safest ecosystem-appropriate load check: import the entry, nothing else. */
async function libraryAdapter({ gate, workspace, executor, limits, cleanup }) {
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  if (gate.mode !== "import" || !gate.entry) {
    return { ok: true, skipped: true, code: "LIBRARY_NO_ENTRY", evidence: "no importable entry point was discoverable" };
  }

  const stamp = `${process.pid}-${Date.now()}`;
  if (gate.runtime === "python") {
    const probe = path.join(os.tmpdir(), `kodevra-import-${stamp}.py`);
    fs.writeFileSync(probe, "import importlib, sys\nimportlib.import_module(sys.argv[1])\n", "utf8");
    cleanup.push(() => fs.rmSync(probe, { force: true }));
    const python = process.platform === "win32" ? "python" : "python3";
    const result = await executor.run(`${python} "${probe}" "${gate.entry}"`, {
      cwd: workspace,
      timeoutMs: budget.commandTimeoutMs,
      forward: false,
    });
    return result.ok
      ? {
          ok: true,
          code: null,
          evidence: evidenceLines("LIBRARY_IMPORT_PASSED", { module: gate.entry, runtime: "python" }),
          details: { entry: gate.entry },
        }
      : {
          ok: false,
          code: "LIBRARY_IMPORT_FAILED",
          evidence: evidenceLines("LIBRARY_IMPORT_FAILED", {
            module: gate.entry,
            runtime: "python",
            error: outputTail(result.output),
          }),
          details: { entry: gate.entry },
        };
  }

  const probe = path.join(os.tmpdir(), `kodevra-import-${stamp}.mjs`);
  fs.writeFileSync(
    probe,
    [
      'import { pathToFileURL } from "node:url";',
      "const target = process.argv[2];",
      "if (!target) { console.error('no entry'); process.exit(2); }",
      "await import(pathToFileURL(target).href);",
      "",
    ].join("\n"),
    "utf8",
  );
  cleanup.push(() => fs.rmSync(probe, { force: true }));
  const entry = path.resolve(workspace, gate.entry);
  const result = await executor.run(`node "${probe}" "${entry}"`, {
    cwd: workspace,
    timeoutMs: budget.commandTimeoutMs,
    forward: false,
  });
  return result.ok
    ? {
        ok: true,
        code: null,
        evidence: evidenceLines("LIBRARY_IMPORT_PASSED", { entry: gate.entry, runtime: "node" }),
        details: { entry: gate.entry },
      }
    : {
        ok: false,
        code: "LIBRARY_IMPORT_FAILED",
        evidence: evidenceLines("LIBRARY_IMPORT_FAILED", {
          entry: gate.entry,
          runtime: "node",
          error: outputTail(result.output),
        }),
        details: { entry: gate.entry },
      };
}

/** Start it, watch it survive a bounded window, stop it. No deep claims. */
async function genericProcessAdapter({ gate, workspace, limits, cleanup }) {
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  if (!gate.command) {
    return { ok: true, skipped: true, code: "PROCESS_NO_COMMAND", evidence: "no start command was discoverable" };
  }
  const process = startOwnedProcess({ command: gate.command, cwd: workspace, env: { CI: "1" } });
  cleanup.push(() => process.stop());
  await sleep(budget.processSurvivalMs);
  const exit = process.exit();
  if (exit) {
    return {
      ok: false,
      code: "PROCESS_EXITED",
      evidence: evidenceLines("PROCESS_EXITED", {
        command: gate.command,
        survivedMs: budget.processSurvivalMs,
        error: `process exited with ${exit.code ?? exit.error ?? "no code"}${exit.signal ? ` (${exit.signal})` : ""}`,
        output: outputTail(process.output()),
      }),
      details: { command: gate.command },
    };
  }
  return {
    ok: true,
    code: null,
    evidence: evidenceLines("PROCESS_ALIVE", {
      command: gate.command,
      survivedMs: budget.processSurvivalMs,
      note: "startup survived; this proves no immediate crash, not correctness",
    }),
    details: { command: gate.command },
  };
}

export const RUNTIME_ADAPTERS = Object.freeze({
  "frontend-web": frontendWebAdapter,
  "web-api": webApiAdapter,
  cli: cliAdapter,
  library: libraryAdapter,
  "generic-process": genericProcessAdapter,
});

/**
 * Run the contract's runtime gate. Returns the gate result plus the environment
 * acceptance checks can use; `cleanup` is always safe to call (and is).
 */
export async function openRuntimeEnvironment({ contract, workspace, executor, limits = {} }) {
  const gate = contract?.runtime;
  const cleanup = [];
  const cleanupAll = async () => {
    for (const dispose of cleanup.splice(0).reverse()) {
      try {
        await dispose();
      } catch {
        // cleanup is best-effort; the process registry already killed children
      }
    }
  };

  if (!gate) {
    return {
      ok: true,
      skipped: true,
      code: "RUNTIME_NOT_CONFIGURED",
      evidence: "runtime verification is not configured for this workspace",
      cleanup: cleanupAll,
    };
  }
  const adapter = RUNTIME_ADAPTERS[gate.adapter];
  if (!adapter) {
    return {
      ok: true,
      skipped: true,
      code: "RUNTIME_UNSUPPORTED",
      evidence: `no runtime adapter named "${gate.adapter}"`,
      cleanup: cleanupAll,
    };
  }

  try {
    const result = await adapter({ gate, contract, workspace, executor, limits, cleanup });
    return { ...result, cleanup: cleanupAll };
  } catch (error) {
    await cleanupAll();
    return {
      ok: false,
      code: "RUNTIME_ADAPTER_ERROR",
      evidence: evidenceLines("RUNTIME_ADAPTER_ERROR", { adapter: gate.adapter, error: error.message }),
      cleanup: async () => {},
    };
  }
}

function failedCriterion(criterion, { expected, observed, error = null }) {
  return {
    id: criterion.id,
    layer: "acceptance",
    ok: false,
    skipped: false,
    required: criterion.required !== false,
    code: "ACCEPTANCE_FAILED",
    evidence: evidenceLines("ACCEPTANCE_FAILED", {
      criterion: `${criterion.id} (${criterion.kind}:${criterion.check ?? criterion.path ?? ""})`,
      expected,
      observed,
      error,
    }),
  };
}

async function pollUntil(fn, { timeoutMs, intervalMs = 150 }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last?.ok) return last;
    await sleep(intervalMs);
  }
  return last ?? { ok: false };
}

async function webAcceptance(criterion, { env, limits }) {
  const browser = env?.browser;
  if (!browser) {
    return {
      id: criterion.id,
      layer: "acceptance",
      ok: true,
      skipped: true,
      required: criterion.required !== false,
      code: "ACCEPTANCE_NO_BROWSER",
      evidence: `acceptance "${criterion.id}" skipped: no page session was available`,
    };
  }
  const budget = { ...DEFAULT_RUNTIME_LIMITS, ...limits };
  const selector = criterion.selector ? JSON.stringify(criterion.selector) : "null";
  const expect = criterion.expect === null ? "null" : JSON.stringify(criterion.expect);

  if (criterion.check === "text-present") {
    const result = await browser.evaluate(
      `(() => { const body = document.body; return Boolean(body && body.innerText.includes(${expect})); })()`,
    );
    return result.ok && result.value === true
      ? { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` }
      : failedCriterion(criterion, { expected: `page text contains ${expect}`, observed: result.ok ? "not found" : result.error });
  }

  if (criterion.check === "selector-present") {
    const result = await browser.evaluate(`(() => Boolean(document.querySelector(${selector})))()`);
    return result.ok && result.value === true
      ? { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` }
      : failedCriterion(criterion, { expected: `selector ${selector} exists`, observed: result.ok ? "not found" : result.error });
  }

  if (criterion.check === "click-changes") {
    const clicked = await browser.evaluate(
      `(() => { const el = document.querySelector(${selector}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!clicked.ok || clicked.value !== true) {
      return failedCriterion(criterion, { expected: `click ${selector}`, observed: clicked.ok ? "element not found" : clicked.error });
    }
    const changed = await pollUntil(
      async () => {
        const result = await browser.evaluate(
          `(() => { const body = document.body; return Boolean(body && body.innerText.includes(${expect})); })()`,
        );
        return { ok: result.ok && result.value === true };
      },
      { timeoutMs: budget.acceptanceTimeoutMs },
    );
    return changed.ok
      ? { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` }
      : failedCriterion(criterion, { expected: `click ${selector} reveals ${expect}`, observed: "text never appeared" });
  }

  if (criterion.check === "navigates") {
    const clicked = await browser.evaluate(
      `(() => { const el = document.querySelector(${selector}); if (!el) return false; el.click(); return true; })()`,
    );
    if (!clicked.ok || clicked.value !== true) {
      return failedCriterion(criterion, { expected: `navigate via ${selector}`, observed: clicked.ok ? "element not found" : clicked.error });
    }
    const expectUrl = criterion.expectUrl ?? criterion.expect ?? "";
    const moved = await pollUntil(
      async () => {
        const result = await browser.evaluate(`(() => location.href.includes(${JSON.stringify(expectUrl)}))()`);
        return { ok: result.ok && result.value === true };
      },
      { timeoutMs: budget.acceptanceTimeoutMs },
    );
    return moved.ok
      ? { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` }
      : failedCriterion(criterion, { expected: `location contains ${expectUrl}`, observed: "location never changed" });
  }

  if (criterion.check === "reload-persists") {
    const reloaded = await browser.reload();
    if (!reloaded.ok) {
      return failedCriterion(criterion, { expected: "page reloads", observed: reloaded.error });
    }
    await browser.waitForRender();
    const result = await browser.evaluate(
      `(() => { const body = document.body; return Boolean(body && body.innerText.includes(${expect})); })()`,
    );
    return result.ok && result.value === true
      ? { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` }
      : failedCriterion(criterion, { expected: `state survived reload (${expect})`, observed: result.ok ? "not found after reload" : result.error });
  }

  return failedCriterion(criterion, { expected: "supported web check", observed: criterion.check });
}

async function apiAcceptance(criterion, { env, limits }) {
  if (!env?.fetch) {
    return {
      id: criterion.id,
      layer: "acceptance",
      ok: true,
      skipped: true,
      required: criterion.required !== false,
      code: "ACCEPTANCE_NO_SERVER",
      evidence: `acceptance "${criterion.id}" skipped: no server session was available`,
    };
  }
  const expected = criterion.expect ?? {};
  const response = await env.fetch(criterion.path, { method: criterion.method });
  if (!response.ok) {
    return failedCriterion(criterion, {
      expected: `${criterion.method} ${criterion.path}`,
      observed: response.error ?? "no response",
    });
  }
  const expectedStatus = expected.status ?? 200;
  if (response.status !== expectedStatus) {
    return failedCriterion(criterion, {
      expected: `status ${expectedStatus}`,
      observed: `status ${response.status}`,
    });
  }
  if (expected.bodyContains) {
    const found = response.body.includes(expected.bodyContains);
    if (!found) {
      return failedCriterion(criterion, {
        expected: `body contains ${JSON.stringify(expected.bodyContains)}`,
        observed: `${response.body.slice(0, 200)}`,
      });
    }
  }
  if (expected.jsonField) {
    let parsed = null;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return failedCriterion(criterion, {
        expected: `JSON field ${expected.jsonField}`,
        observed: "body is not JSON",
      });
    }
    const value = expected.jsonField.split(".").reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), parsed);
    if (expected.jsonValue !== null && JSON.stringify(value) !== JSON.stringify(expected.jsonValue)) {
      return failedCriterion(criterion, {
        expected: `${expected.jsonField} = ${JSON.stringify(expected.jsonValue)}`,
        observed: `${expected.jsonField} = ${JSON.stringify(value)}`,
      });
    }
  }
  return { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` };
}

async function cliAcceptance(criterion, { env, limits }) {
  if (!env?.run) {
    return {
      id: criterion.id,
      layer: "acceptance",
      ok: true,
      skipped: true,
      required: criterion.required !== false,
      code: "ACCEPTANCE_NO_CLI",
      evidence: `acceptance "${criterion.id}" skipped: no CLI session was available`,
    };
  }
  const expected = criterion.expect ?? {};
  const result = await env.run(criterion.args);
  if (result.timedOut) {
    return failedCriterion(criterion, { expected: `exit ${expected.exit ?? 0}`, observed: "timed out" });
  }
  const wanted = Number.isInteger(expected.exit) ? expected.exit : 0;
  if ((result.status ?? 1) !== wanted) {
    return failedCriterion(criterion, {
      expected: `exit ${wanted}`,
      observed: `exit ${result.status ?? "?"}`,
      error: outputTail(result.output, 400),
    });
  }
  if (expected.stdoutContains && !`${result.output ?? ""}`.includes(expected.stdoutContains)) {
    return failedCriterion(criterion, {
      expected: `output contains ${JSON.stringify(expected.stdoutContains)}`,
      observed: outputTail(result.output, 200),
    });
  }
  return { id: criterion.id, layer: "acceptance", ok: true, skipped: false, required: criterion.required !== false, code: null, evidence: `acceptance "${criterion.id}" passed` };
}

/** Evaluate every configured acceptance criterion against the runtime env. */
export async function runAcceptance({ criteria = [], env = null, workspace, executor, limits = {} }) {
  const results = [];
  for (const criterion of criteria) {
    try {
      if (criterion.kind === "web") results.push(await webAcceptance(criterion, { env, limits }));
      else if (criterion.kind === "api") results.push(await apiAcceptance(criterion, { env, limits }));
      else if (criterion.kind === "cli") results.push(await cliAcceptance(criterion, { env, workspace, executor, limits }));
      else {
        results.push(
          failedCriterion(criterion, { expected: "supported acceptance kind", observed: criterion.kind }),
        );
      }
    } catch (error) {
      results.push({
        id: criterion.id,
        layer: "acceptance",
        ok: false,
        skipped: false,
        required: criterion.required !== false,
        code: "ACCEPTANCE_ERROR",
        evidence: `ACCEPTANCE_FAILED\ncriterion: ${criterion.id}\nerror: ${error.message}`,
      });
    }
  }
  return results;
}
