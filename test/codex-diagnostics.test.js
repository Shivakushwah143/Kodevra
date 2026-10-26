import test from "node:test";
import assert from "node:assert/strict";

import { resolveCodexRun } from "../lib/codex.js";
import { runDiagnostics } from "../lib/doctor.js";

const STATUS = {
  available: true,
  version: "0.149.1",
  source: "KODEVRA_CODEX_BIN",
  detail: "codex 0.149.1 · KODEVRA_CODEX_BIN",
  hint: null,
  auth: {
    ok: true,
    state: "chatgpt",
    detail: 'ChatGPT sign-in (codex login) · codex config provider "freedeepseek"',
    hint: null,
  },
  config: {
    file: "C:/home/.codex/config.toml",
    exists: true,
    provider: "freedeepseek",
    model: "deepseek-v4-flash",
    windowsSandbox: "elevated",
    error: null,
  },
  probe: { ok: true, command: "codex", prefixArgs: [], shell: true },
};

const CONFIG = {
  data: {
    provider: {
      freedeepseek: { options: { baseURL: "http://127.0.0.1:9655/v1" } },
    },
  },
};

const OPENAI_TARGET = {
  providerId: "openai",
  provider: "openai",
  model: "gpt-5.6-terra",
  modelLabel: "gpt-5.6-terra",
  source: "codex ChatGPT sign-in",
  note: null,
};

const DEEPSEEK_TARGET = {
  providerId: null,
  provider: "freedeepseek",
  model: "deepseek-v4-flash",
  modelLabel: "deepseek-v4-flash",
  source: "codex config",
  note: null,
};

function probes() {
  const calls = { proxy: [], docker: 0 };
  return {
    calls,
    proxy: async (baseURL, model) => {
      calls.proxy.push({ baseURL, model });
      return { ok: true, detail: `${model} served by ${baseURL}` };
    },
    docker: () => {
      calls.docker += 1;
      return { ok: true, detail: "docker 28.0.0", hint: null };
    },
  };
}

async function diagnose(overrides = {}) {
  const injected = probes();
  const result = await runDiagnostics({
    workspace: process.cwd(),
    model: "gpt-5.6-terra",
    harness: "codex",
    codexStatus: STATUS,
    codexTarget: OPENAI_TARGET,
    executor: "host",
    config: CONFIG,
    purpose: "doctor",
    probes: injected,
    ...overrides,
  });
  return { result, calls: injected.calls };
}

const check = (result, label) => result.checks.find((entry) => entry.label === label);

test("an explicit OpenAI run never probes the provider named in Codex config", async () => {
  const { result, calls } = await diagnose();

  assert.equal(calls.proxy.length, 0);
  assert.equal(check(result, "proxy"), undefined);
  assert.equal(check(result, "docker"), undefined);
  assert.equal(check(result, "auth").detail, "ChatGPT sign-in");
  assert.equal(check(result, "model/provider").detail, "OpenAI / gpt-5.6-terra");
  assert.equal(result.failed, 0);
});

test("an explicit DeepSeek run does probe the FreeDeepseekAPI endpoint", async () => {
  const { result, calls } = await diagnose({ codexTarget: DEEPSEEK_TARGET, model: "deepseek-v4-flash" });

  assert.equal(calls.proxy.length, 1);
  assert.equal(calls.proxy[0].baseURL, "http://127.0.0.1:9655/v1");
  assert.equal(calls.proxy[0].model, "deepseek-v4-flash");
  assert.equal(check(result, "proxy").ok, true);
  assert.equal(check(result, "model/provider").detail, "freedeepseek / deepseek-v4-flash");
  assert.match(check(result, "auth").detail, /freedeepseek/);
});

test("the configured default provider is still probed when no target overrides it", async () => {
  const { result, calls } = await diagnose({ codexTarget: undefined, model: "codex default" });

  assert.equal(calls.proxy.length, 1);
  assert.equal(check(result, "model/provider").detail, "freedeepseek / deepseek-v4-flash");
});

test("a native Codex run does not require Docker, but an explicit Docker executor does", async () => {
  const host = await diagnose({ executor: "host" });
  assert.equal(host.calls.docker, 0);
  assert.equal(check(host.result, "docker"), undefined);

  const docker = await diagnose({ executor: "docker" });
  assert.equal(docker.calls.docker, 1);
  assert.equal(check(docker.result, "docker").ok, true);
  assert.equal(check(docker.result, "docker").fatal, true);
});

test("a failing Docker probe blocks only a run that selected the Docker executor", async () => {
  const failing = {
    docker: () => ({ ok: false, detail: "engine unreachable", hint: "Start Docker Desktop." }),
    proxy: async () => ({ ok: true, detail: "not called" }),
  };

  const host = await diagnose({ executor: "host", probes: failing });
  assert.equal(check(host.result, "docker"), undefined);
  assert.equal(host.result.failed, 0);

  const docker = await diagnose({ executor: "docker", probes: failing });
  assert.equal(check(docker.result, "docker").ok, false);
  assert.equal(docker.result.failed, 1);
});

test("a custom Codex provider credential is not accepted for an explicit OpenAI run", async () => {
  const status = {
    ...STATUS,
    auth: { ok: true, state: "provider", detail: 'Codex config provider "freedeepseek"', hint: null },
  };

  const { result } = await diagnose({ codexStatus: status });
  assert.equal(check(result, "auth").ok, false);
  assert.match(check(result, "auth").detail, /no ChatGPT sign-in/);
  assert.ok(result.failed > 0);
});

test("run preflight keeps only launch-critical checks; doctor stays comprehensive", async () => {
  const run = await diagnose({ purpose: "run" });
  const doctor = await diagnose({ purpose: "doctor" });

  for (const label of ["node", "workspace", "codex config"]) {
    assert.equal(check(run.result, label), undefined, `${label} is not a launch-critical check`);
    assert.ok(check(doctor.result, label), `${label} belongs in the comprehensive report`);
  }
  for (const label of ["engine", "auth", "model/provider"]) {
    assert.ok(check(run.result, label), `${label} is needed before spawning Codex`);
  }
});

test("OpenCode diagnostics keep their non-fatal Docker and proxy checks", async () => {
  const calls = { proxy: 0, docker: 0 };
  const result = await runDiagnostics({
    workspace: process.cwd(),
    model: "freedeepseek/deepseek-v4-flash",
    harness: "opencode",
    executor: "host",
    engine: { command: process.execPath, prefixArgs: [], shell: false },
    config: {
      exists: true,
      file: "opencode.json",
      error: null,
      data: {
        provider: {
          freedeepseek: { options: { baseURL: "http://127.0.0.1:9655/v1" }, models: { "deepseek-v4-flash": {} } },
        },
      },
    },
    probes: {
      proxy: async () => {
        calls.proxy += 1;
        return { ok: true, detail: "stub proxy" };
      },
      docker: () => {
        calls.docker += 1;
        return { ok: false, detail: "Docker unavailable", hint: null };
      },
    },
  });

  assert.equal(calls.proxy, 1);
  assert.equal(calls.docker, 1);
  assert.equal(check(result, "sandbox").fatal, false, "Docker stays optional for OpenCode host runs");
  assert.ok(check(result, "proxy"));
});

test("the effective provider is part of the adapter's resolved target", () => {
  const explicit = resolveCodexRun({
    selection: { provider: "openai", model: "gpt-5.6-terra" },
    explicitModel: true,
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(explicit.provider, "openai");
  assert.equal(explicit.providerId, "openai");

  const configured = resolveCodexRun({
    selection: { provider: "freedeepseek", model: "deepseek-v4-flash" },
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(configured.provider, "freedeepseek");
  assert.equal(configured.providerId, null);

  const mismatched = resolveCodexRun({
    selection: { provider: "openrouter", model: "openai/gpt-5" },
    config: { provider: "freedeepseek", model: "deepseek-v4-flash" },
  });
  assert.equal(mismatched.provider, "freedeepseek", "Codex keeps its configured provider");
});
