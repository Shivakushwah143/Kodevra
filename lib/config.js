import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Kodevra config is intentionally thin: it reads the OpenCode config that is
 * already on this machine and only ever *adds* a missing provider block.
 * Existing provider settings are never rewritten.
 */

export const DEFAULT_PROVIDER = "freedeepseek";
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "http://127.0.0.1:9655/v1";

/**
 * Provider presets. Adding Gemini or ChatGPT later means adding one entry here
 * (plus whatever the launcher passes to OpenCode) - nothing else changes.
 */
export const PROVIDER_PRESETS = {
  [DEFAULT_PROVIDER]: {
    label: "DeepSeek via FreeDeepseekAPI",
    baseURLEnv: "KODEVRA_DEEPSEEK_BASE_URL",
    baseURL: DEFAULT_BASE_URL,
    apiKeyEnv: "KODEVRA_DEEPSEEK_API_KEY",
    apiKey: "local",
    models: {
      [DEFAULT_MODEL_ID]: {
        name: "DeepSeek 4.1 Flash",
        tool_call: true,
        reasoning: false,
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1048576, output: 8192 },
      },
    },
  },
};

export function providerBlock(key = DEFAULT_PROVIDER) {
  const preset = PROVIDER_PRESETS[key];
  if (!preset) throw new Error(`Unknown provider preset: ${key}`);
  return {
    npm: "@ai-sdk/openai-compatible",
    name: preset.label,
    options: {
      baseURL: process.env[preset.baseURLEnv] || preset.baseURL,
      apiKey: process.env[preset.apiKeyEnv] || preset.apiKey,
    },
    models: preset.models,
  };
}

export function configFile() {
  if (process.env.OPENCODE_CONFIG) return path.resolve(process.env.OPENCODE_CONFIG);
  const dir = process.env.KODEVRA_OPENCODE_DIR
    ? path.resolve(process.env.KODEVRA_OPENCODE_DIR)
    : path.join(os.homedir(), ".config", "opencode");
  return path.join(dir, "opencode.json");
}

export function readConfig() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    return { file, exists: false, data: null, error: null };
  }
  try {
    return { file, exists: true, data: JSON.parse(fs.readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { file, exists: true, data: null, error: error.message };
  }
}

export function splitModel(model) {
  const value = model || `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`;
  const index = value.indexOf("/");
  if (index === -1) return { provider: DEFAULT_PROVIDER, model: value };
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

export function providerEntry(config, provider) {
  return config && config.provider ? config.provider[provider] : undefined;
}

/**
 * Give one model a conservative output budget using OpenCode's supported
 * model-level config. Context limits, capabilities and every other model stay
 * untouched; a backup is written before the first change.
 */
export function ensureModelLimit({ providerId, modelId, output, context }) {
  const current = readConfig();
  const data = current.data && typeof current.data === "object" ? current.data : {};
  if (!data.$schema) data.$schema = "https://opencode.ai/config.json";

  data.provider = data.provider || {};
  data.provider[providerId] = data.provider[providerId] || {};
  const provider = data.provider[providerId];
  provider.models = provider.models || {};

  const existing = provider.models[modelId] || {};
  const desiredLimit = {};
  const keepContext = existing.limit?.context ?? context;
  if (keepContext) desiredLimit.context = keepContext;
  desiredLimit.output = output;

  if (existing.limit && JSON.stringify(existing.limit) === JSON.stringify(desiredLimit)) {
    return { file: current.file, changed: false, backup: null, limit: desiredLimit };
  }

  provider.models[modelId] = { ...existing, limit: desiredLimit };

  let backup = null;
  if (current.exists) {
    backup = `${current.file}.kodevra-backup`;
    fs.copyFileSync(current.file, backup);
  }
  fs.mkdirSync(path.dirname(current.file), { recursive: true });
  fs.writeFileSync(current.file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { file: current.file, changed: true, backup, limit: desiredLimit };
}

/**
 * Merge-add the default provider block. Returns changed=false when the provider
 * already exists, so a working configuration is left byte-for-byte untouched.
 */
export function ensureDefaultProvider(key = DEFAULT_PROVIDER) {
  const current = readConfig();
  const data = current.data && typeof current.data === "object" ? current.data : {};
  if (!data.$schema) data.$schema = "https://opencode.ai/config.json";
  data.provider = data.provider || {};
  if (data.provider[key]) {
    return { file: current.file, changed: false, backup: null };
  }
  data.provider[key] = providerBlock(key);
  if (!data.model) data.model = `${key}/${DEFAULT_MODEL_ID}`;

  let backup = null;
  if (current.exists) {
    backup = `${current.file}.kodevra-backup`;
    fs.copyFileSync(current.file, backup);
  }
  fs.mkdirSync(path.dirname(current.file), { recursive: true });
  fs.writeFileSync(current.file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return { file: current.file, changed: true, backup };
}
