import fs from "node:fs";
import path from "node:path";

import { deriveContract } from "../lib/verification-contract.js";
import { runContractVerification } from "../lib/verification-runner.js";
import { resolveExecutor } from "../lib/executors.js";

const executor = resolveExecutor("host");
const base = path.resolve(".probe-verify/stage2");
fs.rmSync(base, { recursive: true, force: true });
const project = (name, files) => {
  const root = path.join(base, name);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
};
const run = (root, verifyCommand, extra = {}) => {
  const contract = deriveContract({ workspace: root, verifyCommand, ...extra });
  return { contract, run: () => runContractVerification({ contract, workspace: root, executor }) };
};
const show = (label, result) => {
  console.log(`${label} ok=${result.ok} verdict=${result.verdict} code=${result.code} status=${result.status}`);
  console.log(`  gates: ${result.gates.map((g) => `${g.layer}:${g.id}:${g.skipped ? "skip" : g.ok ? "pass" : "fail"}`).join(" ")}`);
  const key = result.output.split("\n").filter((l) => /^(ACCEPTANCE_FAILED|criterion|expected|observed|error|API_|CLI_|LIBRARY_)/.test(l));
  if (key.length) console.log("  evidence: " + key.slice(0, 4).join(" | "));
};

// ---- acceptance ------------------------------------------------------------
const webFiles = {
  "package.json": JSON.stringify({ name: "web", scripts: { build: "node -e 0" }, dependencies: { react: "^18" } }),
  "dist/index.html": '<!doctype html><div id="root"></div><script src="./app.js"></script>',
  "dist/app.js": 'document.getElementById("root").textContent = "Tasks";',
};
const acceptPass = project("accept-pass", {
  ...webFiles,
  "kodevra.verification.json": JSON.stringify({ acceptance: [{ id: "tasks-visible", kind: "web", check: "text-present", expect: "Tasks" }] }),
});
show("acceptance pass:", await run(acceptPass, "node -e 0").run());

const acceptFail = project("accept-fail", {
  ...webFiles,
  "kodevra.verification.json": JSON.stringify({ acceptance: [{ id: "tasks-visible", kind: "web", check: "text-present", expect: "No such task" }] }),
});
show("acceptance fail:", await run(acceptFail, "node -e 0").run());

// ---- web-api ---------------------------------------------------------------
const apiHealthy = project("api-ok", {
  "package.json": JSON.stringify({ name: "api", scripts: { start: "node server.js" }, dependencies: { express: "^4" } }),
  "server.js": `const http = require("node:http");
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "probe" })); return; }
  res.writeHead(404); res.end("nope");
}).listen(port, "127.0.0.1");
`,
  "kodevra.verification.json": JSON.stringify({
    acceptance: [{ id: "health", kind: "api", path: "/health", expect: { status: 200, jsonField: "ok", jsonValue: true } }],
  }),
});
show("web-api healthy:", await run(apiHealthy, "node -e 0").run());

const apiCrash = project("api-crash", {
  "package.json": JSON.stringify({ name: "api", scripts: { start: "node crash.js" }, dependencies: { express: "^4" } }),
  "crash.js": 'console.error("boom: missing config"); process.exit(1);\n',
});
show("web-api crash:", await run(apiCrash, "node -e 0").run());

const api500 = project("api-500", {
  "package.json": JSON.stringify({ name: "api", scripts: { start: "node server.js" }, dependencies: { express: "^4" } }),
  "server.js": `require("node:http").createServer((req, res) => { res.writeHead(500); res.end("internal error"); }).listen(Number(process.env.PORT), "127.0.0.1");\n`,
});
show("web-api 5xx:", await run(api500, "node -e 0").run());

// ---- cli -------------------------------------------------------------------
const cliGood = project("cli-ok", {
  "package.json": JSON.stringify({ name: "tool", bin: { tool: "./cli.js" } }),
  "cli.js": 'console.log("tool 1.0.0 - usage"); process.exit(0);\n',
});
show("cli ok:", await run(cliGood, "node -e 0").run());

const cliBad = project("cli-bad", {
  "package.json": JSON.stringify({ name: "tool", bin: { tool: "./cli.js" } }),
  "cli.js": 'throw new Error("cannot start");\n',
});
show("cli crash:", await run(cliBad, "node -e 0").run());

// ---- library ---------------------------------------------------------------
const libBad = project("lib-bad", {
  "package.json": JSON.stringify({ name: "lib", main: "index.js" }),
  "index.js": 'throw new Error("broken export");\n',
});
show("library import fail:", await run(libBad, "node -e 0").run());

const libGood = project("lib-ok", {
  "package.json": JSON.stringify({ name: "lib", main: "index.js" }),
  "index.js": 'module.exports = { value: 1 };\n',
});
show("library import ok:", await run(libGood, "node -e 0").run());

// ---- generic-process -------------------------------------------------------
const generic = project("generic", {
  "package.json": JSON.stringify({ name: "worker", scripts: { start: "node worker.js" } }),
  "worker.js": 'console.log("worker up"); setInterval(() => {}, 1000);\n',
});
show("generic-process alive:", await run(generic, "node -e 0").run());

// ---- cheapest-first short-circuit -----------------------------------------
const shortCircuit = project("short", {
  ...webFiles,
  "kodevra.verification.json": JSON.stringify({ repository: [{ id: "typecheck", command: "node -e process.exit(3)", required: true, cheap: true }] }),
});
const circuit = await run(shortCircuit, "node -e 0").run();
show("cheap gate fails first:", circuit);
console.log("  runtime gate attempted:", circuit.gates.some((g) => g.layer === "runtime"));
