import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromePath = path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe");

const page = `<!doctype html><html><body><div id="root"></div>
<script>document.getElementById("root").textContent = "hello"; undefinedFunction();</script></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-probe-"));
const child = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
], { stdio: "ignore", windowsHide: true });
let killed = false;
const stop = () => {
  if (killed) return;
  killed = true;
  const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  tk.on("exit", () => {});
};
try {
  const portFile = path.join(profile, "DevToolsActivePort");
  let info = null;
  for (let i = 0; i < 100 && !info; i += 1) {
    await sleep(100);
    if (!fs.existsSync(portFile)) continue;
    const text = fs.readFileSync(portFile, "utf8").trim().split("\n");
    if (text.length >= 2) info = { port: Number(text[0]), wsPath: text[1] };
  }
  if (!info) throw new Error("no DevToolsActivePort");
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.wsPath}`);
  const pending = new Map();
  const events = [];
  let nextId = 1;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const waitEvent = (name, sessionId, timeoutMs) => new Promise((resolve) => {
    const found = events.find((e) => e.method === name && e.sessionId === sessionId);
    if (found) return resolve(found);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const poll = setInterval(() => {
      const hit = events.find((e) => e.method === name && e.sessionId === sessionId);
      if (hit) { clearInterval(poll); clearTimeout(timer); resolve(hit); }
    }, 50);
  });
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
      return;
    }
    events.push(data);
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws error")); });
  const target = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url }, sessionId);
  await waitEvent("Page.loadEventFired", sessionId, 5000);
  await sleep(600);
  const exceptions = events.filter((e) => e.sessionId === sessionId && e.method === "Runtime.exceptionThrown");
  const errors = events.filter((e) => e.sessionId === sessionId && e.method === "Runtime.consoleAPICalled" && e.params.type === "error");
  const evaluated = await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, sessionId);
  console.log("exceptions:", exceptions.map((e) => e.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? e.params.exceptionDetails?.text));
  console.log("console errors:", errors.length);
  console.log("dom text:", JSON.stringify(evaluated.result?.value));
  const blank = await send("Runtime.evaluate", { expression: "document.getElementById('root').innerHTML.length", returnByValue: true }, sessionId);
  console.log("root length:", blank.result?.value);
  ws.close();
} finally {
  stop();
  server.close();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  console.log("chrome pid alive:", !child.killed);
}
