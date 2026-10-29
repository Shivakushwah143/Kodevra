import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { ensureChatGptBridge } from "../lib/bridge-supervisor.js";
import { runInteractiveSession } from "../lib/interactive.js";
import { activeSelection } from "../lib/providers.js";
import { runSetup } from "../lib/setup.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function fakeBridge({ clients = 1 } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: clients > 0, clients, selectedClientId: clients ? "tab-1" : "" }));
      return;
    }
    if (request.url === "/setup/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, bridgeVersion: "test" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a healthy bridge with a browser client is reused, not spawned", async (t) => {
  const bridge = await fakeBridge({ clients: 1 });
  const state = path.join(tempDir("kodevra-startup-state-"), "state.json");
  t.after(async () => {
    await bridge.close();
    fs.rmSync(path.dirname(state), { recursive: true, force: true });
  });

  const result = await withEnv(
    {
      KODEVRA_STATE: state,
      KODEVRA_CHATGPT_BRIDGE_URL: `http://127.0.0.1:${bridge.port}/v1`,
    },
    () => ensureChatGptBridge({ workspace: process.cwd(), onStatus: () => {} }),
  );

  assert.equal(result.ready, true);
  assert.equal(result.reused, true);
  assert.equal(result.started, false);
  assert.equal(result.settings.baseURL, `http://127.0.0.1:${bridge.port}/v1`);
  assert.equal(fs.existsSync(state), false);
});

test("a running bridge without a browser tab is not duplicated", async (t) => {
  const bridge = await fakeBridge({ clients: 0 });
  const stateDir = tempDir("kodevra-startup-nobrowser-");
  const state = path.join(stateDir, "state.json");
  t.after(async () => {
    await bridge.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const result = await withEnv(
    {
      KODEVRA_STATE: state,
      KODEVRA_CHATGPT_BRIDGE_URL: `http://127.0.0.1:${bridge.port}/v1`,
    },
    () => ensureChatGptBridge({
      workspace: process.cwd(),
      waitForBrowser: false,
      onStatus: () => {},
    }),
  );

  assert.equal(result.server, true);
  assert.equal(result.ready, false);
  assert.equal(result.started, false);
  assert.equal(result.reused, true);
  assert.equal(fs.existsSync(state), false);
});

test("interactive mode runs another task in the same session and stops on exit", async () => {
  const tasks = [];
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });

  await runInteractiveSession({
    input: Readable.from(["first task\n", "second task\n", "exit\n"]),
    output,
    runTask: async (task) => {
      tasks.push(task);
    },
  });

  assert.deepEqual(tasks, ["first task", "second task"]);
  assert.match(text, /> /);
});

test("saved provider wins without a flag and a flag still overrides it", () => {
  const dir = tempDir("kodevra-startup-selection-");
  const state = path.join(dir, "state.json");
  try {
    fs.writeFileSync(state, JSON.stringify({ provider: "chatgpt-web", model: "chatgpt-web/chatgpt" }));
    withEnv({ KODEVRA_STATE: state, KODEVRA_MODEL: undefined }, () => {
      assert.equal(activeSelection({ config: {} }).provider, "chatgpt-web");
      assert.equal(activeSelection({ config: {}, flagProvider: "deepseek" }).provider, "deepseek");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setup saves the default provider and never prints the bridge token", async () => {
  const root = tempDir("kodevra-startup-setup-");
  const bridgeDir = path.join(root, "chatgpt-bridge");
  const dataDir = path.join(root, "bridge-data");
  const configFile = path.join(root, "opencode.json");
  const state = path.join(root, "state.json");
  const secret = "startup-test-secret-token-4f7c1a";
  fs.mkdirSync(path.join(bridgeDir, "src"), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "src", "index.js"), "// fake checkout for setup\n");
  fs.writeFileSync(path.join(bridgeDir, "package.json"), JSON.stringify({ name: "chatgpt-browser-bridge" }));
  fs.writeFileSync(path.join(dataDir, ".env"), `API_TOKEN=${secret}\nBRIDGE_TOKEN=${secret}\n`);
  fs.writeFileSync(configFile, "{}\n");

  let output = "";
  try {
    const code = await withEnv(
      {
        KODEVRA_STATE: state,
        KODEVRA_CHATGPT_BRIDGE_DIR: bridgeDir,
        KODEVRA_CHATGPT_BRIDGE_DATA_DIR: dataDir,
        KODEVRA_CHATGPT_BRIDGE_PORT: "1",
        OPENCODE_CONFIG: configFile,
      },
      () => runSetup({
        requestedProvider: "chatgpt-web",
        yes: true,
        interactive: false,
        output: { write: (chunk) => { output += chunk; } },
      }),
    );

    assert.equal(code, 0);
    assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).provider, "chatgpt-web");
    assert.equal(output.includes(secret), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
