import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/kodevra.js", import.meta.url));

function runCli(args, { cwd, state, config, engineBin, input = "exit\n" }) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${engineBin}${path.delimiter}${process.env.PATH || ""}`,
      KODEVRA_STATE: state,
      OPENCODE_CONFIG: config,
      KODEVRA_SKIP_DOCTOR: "1",
      KODEVRA_MODEL: "",
      KODEVRA_CHATGPT_BRIDGE_URL: "",
      KODEVRA_RUN_TIMEOUT_MS: "1000",
      KODEVRA_RUN_IDLE_MS: "1000",
    },
  });
}

/** A test-owned engine so these entry-point tests do not depend on OpenCode being installed. */
function makeFakeEngine(root) {
  const dir = path.join(root, "fake-bin");
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "opencode.cmd"), "@echo off\r\nif \"%1\"==\"--version\" echo 1.0.0\r\n");
  } else {
    const file = path.join(dir, "opencode");
    fs.writeFileSync(file, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.0.0; fi\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kodevra-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engineBin = makeFakeEngine(dir);
  return { dir, engineBin };
}

function runCliAsync(args, { cwd, env = {}, engineBin } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: {
        ...process.env,
        ...(engineBin ? { PATH: `${engineBin}${path.delimiter}${process.env.PATH || ""}` } : {}),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function fakeBridge(t) {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, clients: 1, selectedClientId: "tab-1" }));
      return;
    }
    if (request.url === "/setup/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, bridgeVersion: "test" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not implemented by the test bridge" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("bare kodevra uses the current directory and opens the prompt", (t) => {
  const root = makeWorkspace(t);
  const workspace = path.join(root.dir, "project with spaces");
  const state = path.join(workspace, ".kodevra-state.json");
  const config = path.join(workspace, "opencode.json");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(config, "{}\n");

  const result = runCli([], { cwd: workspace, state, config, engineBin: root.engineBin });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, new RegExp(`Workspace\\s+${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(output, /> /);
  assert.equal(fs.existsSync(path.join(workspace, ".kodevra-state.json")), false);
});

test("an explicit provider runs in the current directory and becomes the saved default", (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");

  const first = runCli(["--provider", "deepseek"], { cwd: workspace, state, config, engineBin: root.engineBin });
  const firstOutput = `${first.stdout}\n${first.stderr}`;
  assert.equal(first.status, 0, firstOutput);
  assert.match(firstOutput, /Provider\s+DeepSeek/);
  assert.match(firstOutput, /> /);

  const saved = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.equal(saved.provider, "deepseek");
  assert.equal(saved.chatgptBridge, undefined, "DeepSeek must not start or record the ChatGPT bridge");

  const second = runCli([], { cwd: workspace, state, config, engineBin: root.engineBin });
  const secondOutput = `${second.stdout}\n${second.stderr}`;
  assert.equal(second.status, 0, secondOutput);
  assert.match(secondOutput, /Provider\s+DeepSeek/);
  assert.match(secondOutput, new RegExp(`Workspace\\s+${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("kodevra \"task\" runs immediately in the current directory", (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");

  const result = runCli(["fix the login bug"], {
    cwd: workspace,
    state,
    config,
    engineBin: root.engineBin,
    input: "",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /kodevra -> opencode run/);
  assert.match(output, /TASK COMPLETE/);
  assert.doesNotMatch(output, /^> /m);
});

test("kodevra --provider deepseek \"task\" runs through DeepSeek", (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");

  const result = runCli(["--provider", "deepseek", "fix the login bug"], {
    cwd: workspace,
    state,
    config,
    engineBin: root.engineBin,
    input: "",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /Provider\s+DeepSeek/);
  assert.match(output, /TASK COMPLETE/);
  assert.doesNotMatch(output, /^> /m);
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).provider, "deepseek");
});

test("kodevra --provider chatgpt-web \"task\" starts the bridge path, not the prompt", async (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");
  const bridgeURL = await fakeBridge(t);

  const result = await runCliAsync(["--provider", "chatgpt-web", "list the files and finish"], {
    cwd: workspace,
    engineBin: root.engineBin,
    env: {
      OPENCODE_CONFIG: config,
      KODEVRA_STATE: state,
      KODEVRA_CHATGPT_BRIDGE_URL: bridgeURL,
      KODEVRA_SKIP_DOCTOR: "1",
      KODEVRA_NO_OPEN_BROWSER: "1",
      KODEVRA_BRIDGE_BROWSER_WAIT_MS: "0",
      KODEVRA_RUN_TIMEOUT_MS: "1000",
      KODEVRA_RUN_IDLE_MS: "1000",
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, /Engine\s+chatgpt-bridge/);
  assert.match(output, /BRIDGE_ERROR|ChatGPT/);
  assert.doesNotMatch(output, /^> /m);
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).provider, "chatgpt-web");
});

test("kodevra <existing-directory> keeps the legacy workspace launch", (t) => {
  const root = makeWorkspace(t);
  const workspace = path.join(root.dir, "existing project");
  const state = path.join(root.dir, "state.json");
  const config = path.join(root.dir, "opencode.json");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(config, "{}\n");

  const result = runCli([workspace], {
    cwd: root.dir,
    state,
    config,
    engineBin: root.engineBin,
    input: "",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /kodevra -> opencode/);
  assert.doesNotMatch(output, /^> /m);
});

test("kodevra run \"task\" keeps the explicit run behavior", (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");

  const result = runCli(["run", "fix the login bug"], {
    cwd: workspace,
    state,
    config,
    engineBin: root.engineBin,
    input: "",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /kodevra -> opencode run/);
  assert.match(output, /TASK COMPLETE/);
  assert.doesNotMatch(output, /^> /m);
});

test("explicit run --provider chatgpt-web keeps working with a running bridge", async (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");
  const bridgeURL = await fakeBridge(t);

  const result = await runCliAsync(["run", "-p", "chatgpt-web", "list the files and finish"], {
    cwd: workspace,
    env: {
      OPENCODE_CONFIG: config,
      KODEVRA_STATE: state,
      KODEVRA_CHATGPT_BRIDGE_URL: bridgeURL,
      KODEVRA_SKIP_DOCTOR: "1",
      KODEVRA_NO_OPEN_BROWSER: "1",
      KODEVRA_BRIDGE_BROWSER_WAIT_MS: "0",
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;

  // The fake bridge has no durable-request endpoint, so the task fails after it
  // starts; the point is that the explicit command and bridge path still run.
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Engine\s+chatgpt-bridge/);
  assert.match(output, /BRIDGE_ERROR|ChatGPT/);
  assert.doesNotMatch(output, /^> /m);
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).provider, "chatgpt-web");
});

test("a free-text argument is a one-shot task, not an interactive prompt", (t) => {
  const root = makeWorkspace(t);
  const workspace = root.dir;
  const state = path.join(workspace, "state.json");
  const config = path.join(workspace, "opencode.json");
  fs.writeFileSync(config, "{}\n");

  const result = runCli(["--provider", "not-a-provider", "inspect this repo and fix the bug"], {
    cwd: workspace,
    state,
    config,
    engineBin: root.engineBin,
    input: "",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  // The unknown provider is rejected before an engine starts; reaching that
  // validation (rather than the prompt) proves the free text was parsed as a task.
  assert.equal(result.status, 2, output);
  assert.match(output, /No model known for provider "not-a-provider"/);
  assert.doesNotMatch(output, /^> /m);
});
