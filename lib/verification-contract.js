import fs from "node:fs";
import path from "node:path";

/**
 * The verification contract: WHAT must be proven, separated from HOW.
 *
 * A `--verify` command proves one thing - that command exited 0. It cannot tell
 * the difference between "the build succeeded" and "the built application
 * actually runs". This module derives a small, deterministic, serializable
 * contract from the workspace itself:
 *
 *   repository  cheap deterministic gates (the developer's --verify, plus
 *               discovered typecheck/lint scripts)
 *   runtime     one adapter that proves the produced software starts and works
 *   acceptance  explicit observable criteria from workspace configuration
 *
 * Everything here is local and offline: manifests, config file names and known
 * entry points. The model is never asked what kind of project this is, and the
 * contract is derived once, before implementation begins, then frozen - so a
 * coding model cannot weaken or remove a required gate mid-run.
 *
 * Optional workspace override: `kodevra.verification.json` at the workspace root
 * (see `loadContractConfig`). It can pin the project kind, the runtime command,
 * or add acceptance criteria; it can never be edited into the contract after the
 * run has started.
 */

export const CONTRACT_SCHEMA = "kodevra.verification-contract/1";
export const CONFIG_FILE = "kodevra.verification.json";
export const PROJECT_KINDS = Object.freeze([
  "frontend-web",
  "web-api",
  "cli",
  "library",
  "generic-process",
  "none",
]);

const MAX_ACCEPTANCE = 8;
const MAX_CONFIG_REPOSITORY = 4;
const MAX_TEXT = 240;
const STATIC_DIRS = ["dist", "build", "out", ".output/public", "public", "."];
const SERVER_SCRIPTS = {
  "frontend-web": ["preview", "start", "dev", "serve"],
  "web-api": ["start", "serve", "preview", "dev"],
  "generic-process": ["start", "preview", "dev", "serve"],
};
const UI_DEPS = ["react", "react-dom", "vue", "svelte", "@angular/core", "preact", "solid-js", "lit"];
// A UI build tool with no framework dependency is still a web UI: `vite` alone,
// or a scaffolded project whose framework package is pulled in transitively.
const UI_BUILD_DEPS = ["vite", "next", "nuxt", "astro", "parcel", "webpack", "@sveltejs/kit", "@angular/cli"];
const SERVER_DEPS = ["express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hapi", "restify"];
const UI_FRAMEWORKS = [
  ["next", "Next.js"],
  ["vite", "Vite"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
];
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

function text(value, max = MAX_TEXT) {
  const raw = `${value ?? ""}`.trim();
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function readText(file, { max = 400_000 } = {}) {
  try {
    if (fs.statSync(file).size > max) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  const raw = readText(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fileExists(workspace, relative) {
  try {
    return fs.statSync(path.join(workspace, relative)).isFile();
  } catch {
    return false;
  }
}

function dirExists(workspace, relative) {
  try {
    return fs.statSync(path.join(workspace, relative)).isDirectory();
  } catch {
    return false;
  }
}

/** The package manager implied by a lockfile, so `run <script>` matches the repo. */
function packageManager(workspace) {
  for (const [lockfile, manager] of LOCKFILES) {
    if (fileExists(workspace, lockfile)) return manager;
  }
  return "npm";
}

function scriptCommand(manager, name) {
  return manager === "yarn" ? `yarn run ${name}` : `${manager} run ${name}`;
}

/** Deterministic, local facts about the workspace. No model, no network. */
export function readProjectFacts(workspace) {
  const root = path.resolve(workspace);
  const pkg = readJsonFile(path.join(root, "package.json"));
  const scripts = pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
  };
  const configFiles = {};
  for (const name of [
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "svelte.config.js",
    "angular.json",
    "astro.config.mjs",
    "tsconfig.json",
    "eslint.config.js",
    ".eslintrc",
    ".eslintrc.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "Makefile",
    "index.html",
  ]) {
    if (fileExists(root, name)) configFiles[name] = true;
  }
  const pyproject = readText(path.join(root, "pyproject.toml"), { max: 60_000 });
  const goMod = readText(path.join(root, "go.mod"), { max: 60_000 });
  const cargo = readText(path.join(root, "Cargo.toml"), { max: 60_000 });

  return {
    root,
    pkg,
    scripts,
    deps,
    configFiles,
    hasIndexHtml: Boolean(configFiles["index.html"]),
    hasSrcDir: dirExists(root, "src"),
    manager: packageManager(root),
    staticDir: STATIC_DIRS.find((dir) => fileExists(root, path.join(dir, "index.html"))) ?? null,
    pyproject,
    pythonName: /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject ?? "")?.[1] ?? null,
    goModule: /^\s*module\s+(\S+)/m.exec(goMod ?? "")?.[1] ?? null,
    rustMain: Boolean(fileExists(root, "src/main.rs") || fileExists(root, "main.rs")),
    cargoPackage: /^\s*name\s*=\s*["']([^"']+)["']/m.exec(cargo ?? "")?.[1] ?? null,
    tests: dirExists(root, "test") || dirExists(root, "tests") || dirExists(root, "__tests__"),
  };
}

function hasDep(deps, name) {
  return Object.prototype.hasOwnProperty.call(deps, name);
}

function frameworkLabel(deps) {
  const hit = UI_FRAMEWORKS.find(([name]) => hasDep(deps, name));
  return hit ? hit[1] : null;
}

function preferredServerScript(scripts, kind) {
  for (const name of SERVER_SCRIPTS[kind] ?? []) {
    const value = scripts[name];
    if (typeof value === "string" && value.trim()) return name;
  }
  return null;
}

/**
 * Project kind from local evidence only. The rules are deliberately narrow:
 * when nothing is clearly detectable the answer is `none`, not a guess.
 */
export function detectProject(facts) {
  const { deps, scripts, configFiles } = facts;
  const ui = frameworkLabel(deps);
  const isUiFramework =
    UI_DEPS.some((name) => hasDep(deps, name)) ||
    UI_BUILD_DEPS.some((name) => hasDep(deps, name)) ||
    ["vite.config.js", "vite.config.mjs", "vite.config.ts", "next.config.js", "next.config.mjs", "next.config.ts", "svelte.config.js", "angular.json", "astro.config.mjs"].some(
      (name) => configFiles[name],
    ) ||
    // A served index.html is a web surface even when the manifest says nothing.
    Boolean(facts.staticDir);

  if (isUiFramework || facts.hasIndexHtml) {
    const framework = ui ?? (configFiles["next.config.js"] || configFiles["next.config.mjs"] || configFiles["next.config.ts"] ? "Next.js" : null);
    return {
      kind: "frontend-web",
      reason: `web UI detected (${framework ?? "static index.html"})`,
      framework,
    };
  }

  const startScript = typeof scripts.start === "string" ? scripts.start : "";
  // `node worker.js` is a process, not necessarily an HTTP server; the shape has
  // to be named before Kodevra claims it can probe endpoints.
  const serverLikeStart = /\b(server|serve|api|http|listen|uvicorn|gunicorn)\b/i.test(startScript);
  if (SERVER_DEPS.some((name) => hasDep(deps, name)) || serverLikeStart) {
    return { kind: "web-api", reason: "server dependency or a server-shaped start script", framework: frameworkLabel(deps) };
  }

  const bin = facts.pkg?.bin;
  if (typeof bin === "string" || (bin && typeof bin === "object" && Object.keys(bin).length)) {
    return { kind: "cli", reason: "package.json bin entry", framework: null };
  }

  const entry = facts.pkg?.exports ?? facts.pkg?.module ?? facts.pkg?.main;
  if (facts.pkg && (entry || facts.hasSrcDir)) {
    return { kind: "library", reason: "package entry point", framework: null };
  }

  if (facts.pythonName) return { kind: "library", reason: "pyproject project name", framework: "Python" };
  if (facts.goModule) return { kind: "none", reason: "Go module: no safe runtime probe", framework: "Go" };
  if (facts.cargoPackage) return { kind: "none", reason: "Cargo package: no safe runtime probe", framework: "Rust" };
  if (preferredServerScript(scripts, "generic-process")) {
    return { kind: "generic-process", reason: "start script without a known project shape", framework: null };
  }
  return { kind: "none", reason: "no locally detectable runtime surface", framework: null };
}

/**
 * The runtime gate: the one cheapest deterministic proof that the produced
 * software starts. `mode` tells the adapter how to obtain something to probe.
 */
export function deriveRuntimeGate({ facts, project, override = null }) {
  if (override && typeof override === "object") {
    const adapter = `${override.adapter ?? override.kind ?? ""}`.trim().toLowerCase();
    if (!PROJECT_KINDS.includes(adapter) || adapter === "none") {
      return { gate: null, warning: `runtime adapter "${adapter}" is not supported` };
    }
    return {
      gate: {
        adapter,
        required: true,
        mode: text(override.url) ? "external" : override.mode ?? "auto",
        command: override.command ? text(override.command) : null,
        dir: override.dir ? text(override.dir) : null,
        url: override.url ? text(override.url, 400) : null,
        port: Number.isInteger(override.port) ? override.port : null,
        health: Array.isArray(override.health)
          ? override.health.filter((entry) => typeof entry === "string").slice(0, 4).map((entry) => text(entry))
          : null,
        entry: override.entry ? text(override.entry) : null,
        args: Array.isArray(override.args) ? override.args.filter((a) => typeof a === "string").slice(0, 6).map((a) => text(a)) : null,
        source: "config",
        reason: "runtime configured in workspace config",
      },
      warning: null,
    };
  }

  if (project.kind === "none") return { gate: null, warning: null };

  if (project.kind === "frontend-web") {
    const script = preferredServerScript(facts.scripts, "frontend-web");
    // A build artifact is the most faithful and most framework-neutral thing to
    // load: no dev-server flags, no HMR, exactly what `npm run build` produced.
    if (facts.staticDir) {
      return {
        gate: {
          adapter: "frontend-web",
          required: true,
          mode: "static",
          dir: facts.staticDir,
          command: null,
          source: "detected",
          reason: `static build artifact (${facts.staticDir === "." ? "workspace root" : facts.staticDir})`,
        },
        warning: null,
      };
    }
    if (script) {
      return {
        gate: {
          adapter: "frontend-web",
          required: true,
          mode: "server",
          command: scriptCommand(facts.manager, script),
          source: "detected",
          reason: `no build artifact; serving with "${script}"`,
        },
        warning: null,
      };
    }
    return { gate: null, warning: "frontend-web detected but no build artifact and no start script" };
  }

  if (project.kind === "web-api" || project.kind === "generic-process") {
    const script = preferredServerScript(facts.scripts, project.kind);
    if (!script) return { gate: null, warning: `${project.kind} detected but no start script` };
    return {
      gate: {
        adapter: project.kind,
        required: true,
        mode: "server",
        command: scriptCommand(facts.manager, script),
        health: project.kind === "web-api" ? ["/health", "/healthz", "/api/health", "/"] : null,
        source: "detected",
        reason: `"${script}" script`,
      },
      warning: null,
    };
  }

  if (project.kind === "cli") {
    const bin = facts.pkg?.bin;
    const entry = typeof bin === "string" ? bin : bin && typeof bin === "object" ? Object.values(bin)[0] : null;
    if (typeof entry !== "string" || !entry.trim()) {
      return { gate: null, warning: "cli detected without a resolvable bin entry" };
    }
    return {
      gate: {
        adapter: "cli",
        required: true,
        mode: "cli",
        command: `node ${text(entry, 200)} --help`,
        args: ["--help"],
        entry: text(entry, 200),
        source: "detected",
        reason: "package.json bin entry",
      },
      warning: null,
    };
  }

  if (project.kind === "library") {
    if (facts.pyproject || facts.pythonName) {
      if (!facts.pythonName) return { gate: null, warning: "python project without a detectable module name" };
      return {
        gate: {
          adapter: "library",
          required: true,
          mode: "import",
          runtime: "python",
          entry: text(facts.pythonName, 200),
          source: "detected",
          reason: "pyproject project name",
        },
        warning: null,
      };
    }
    const entry = facts.pkg?.exports ?? facts.pkg?.module ?? facts.pkg?.main;
    if (!entry) return { gate: null, warning: "library detected without an entry point" };
    return {
      gate: {
        adapter: "library",
        required: true,
        mode: "import",
        runtime: "node",
        entry: typeof entry === "string" ? text(entry, 200) : text(entry?.["."]?.import ?? entry?.["."]?.default ?? "", 200),
        source: "detected",
        reason: "package entry point",
      },
      warning: null,
    };
  }

  return { gate: null, warning: null };
}

function normalizeCommand(command) {
  return `${command ?? ""}`.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Repository gates, cheapest and most static first. `--verify` stays exactly the
 * gate the developer named; discovered gates are static analysers only, and they
 * block on a *regression* (baseline said pass, now fails) instead of blaming the
 * agent for pre-existing failures.
 */
export function discoverRepositoryGates({ facts, verifyCommand, config = null }) {
  const gates = [];
  const seen = new Set();
  const add = (gate) => {
    const key = normalizeCommand(gate.command);
    if (!key || seen.has(key)) return;
    seen.add(key);
    gates.push(gate);
  };

  const scripts = facts.scripts ?? {};
  const typecheckScript = scripts.typecheck ?? scripts["type-check"] ?? scripts["typecheck:ci"];
  if (typeof typecheckScript === "string" && typecheckScript.trim()) {
    add({ id: "typecheck", command: scriptCommand(facts.manager, scripts.typecheck ? "typecheck" : scripts["type-check"] ? "type-check" : "typecheck:ci"), source: "discovered", required: false, cheap: true });
  } else if (facts.configFiles["tsconfig.json"] && hasDep(facts.deps, "typescript")) {
    add({ id: "typecheck", command: "npx --no-install tsc --noEmit", source: "discovered", required: false, cheap: true });
  }
  if (typeof scripts.lint === "string" && scripts.lint.trim()) {
    add({ id: "lint", command: scriptCommand(facts.manager, "lint"), source: "discovered", required: false, cheap: true });
  }

  for (const entry of (Array.isArray(config?.repository) ? config.repository : []).slice(0, MAX_CONFIG_REPOSITORY)) {
    if (!entry || typeof entry.command !== "string" || !entry.command.trim()) continue;
    add({
      id: text(entry.id ?? `config-${gates.length + 1}`, 60),
      command: text(entry.command),
      source: "config",
      required: entry.required !== false,
      cheap: entry.cheap === true,
    });
  }

  if (verifyCommand) {
    add({ id: "verify", command: text(verifyCommand, 400), source: "user", required: true, cheap: false });
  }
  return gates;
}

function normalizeAcceptance(raw, warnings) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_ACCEPTANCE) : [];
  const criteria = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      warnings.push("acceptance entry is not an object");
      continue;
    }
    const id = text(entry.id ?? `acceptance-${criteria.length + 1}`, 80);
    const kind = `${entry.kind ?? ""}`.trim().toLowerCase();
    if (kind === "web") {
      const check = `${entry.check ?? ""}`.trim().toLowerCase();
      if (!["text-present", "selector-present", "click-changes", "navigates", "reload-persists"].includes(check)) {
        warnings.push(`acceptance "${id}" has unsupported web check "${check}"`);
        continue;
      }
      criteria.push({
        id,
        kind: "web",
        check,
        required: entry.required !== false,
        url: entry.url ? text(entry.url, 400) : null,
        selector: entry.selector ? text(entry.selector, 200) : null,
        expect: entry.expect === undefined ? null : text(entry.expect, 200),
        expectUrl: entry.expectUrl ? text(entry.expectUrl, 200) : null,
      });
      continue;
    }
    if (kind === "api") {
      criteria.push({
        id,
        kind: "api",
        required: entry.required !== false,
        method: `${entry.method ?? "GET"}`.trim().toUpperCase().slice(0, 10),
        path: text(entry.path ?? "/", 300),
        expect: {
          status: Number.isInteger(entry.expect?.status) ? entry.expect.status : null,
          bodyContains: entry.expect?.bodyContains ? text(entry.expect.bodyContains, 200) : null,
          jsonField: entry.expect?.jsonField ? text(entry.expect.jsonField, 120) : null,
          jsonValue: entry.expect?.jsonValue === undefined ? null : entry.expect.jsonValue,
        },
      });
      continue;
    }
    if (kind === "cli") {
      criteria.push({
        id,
        kind: "cli",
        required: entry.required !== false,
        args: Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === "string").slice(0, 6).map((a) => text(a, 80)) : [],
        expect: {
          exit: Number.isInteger(entry.expect?.exit) ? entry.expect.exit : 0,
          stdoutContains: entry.expect?.stdoutContains ? text(entry.expect.stdoutContains, 200) : null,
        },
      });
      continue;
    }
    warnings.push(`acceptance "${id}" has unsupported kind "${kind}"`);
  }
  return criteria;
}

/**
 * Workspace configuration. Defensive by design: a malformed file produces
 * warnings and is ignored, never a crash or a silently different contract.
 */
export function loadContractConfig(workspace) {
  const file = path.join(path.resolve(workspace), CONFIG_FILE);
  const raw = readText(file, { max: 120_000 });
  const warnings = [];
  if (!raw) return { config: null, file: fileExists(path.resolve(workspace), CONFIG_FILE) ? file : null, warnings };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warnings.push(`${CONFIG_FILE} is not valid JSON: ${error.message}`);
    return { config: null, file, warnings };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${CONFIG_FILE} must contain a JSON object`);
    return { config: null, file, warnings };
  }
  return {
    config: {
      project: parsed.project && typeof parsed.project === "object" ? parsed.project : null,
      runtime: parsed.runtime && typeof parsed.runtime === "object" ? parsed.runtime : null,
      repository: parsed.repository ?? null,
      acceptance: parsed.acceptance ?? null,
    },
    file,
    warnings,
  };
}

/**
 * Derive the frozen contract for one run. Returns a plain serializable object;
 * nothing in it is a function, a path we cannot print, or a value that depends
 * on the model.
 */
export function deriveContract({ workspace, verifyCommand = null, runtime = true } = {}) {
  const facts = readProjectFacts(workspace);
  const loaded = loadContractConfig(workspace);
  const warnings = [...loaded.warnings];
  const config = loaded.config;

  let project = detectProject(facts);
  const overrideKind = `${config?.project?.kind ?? ""}`.trim().toLowerCase();
  if (overrideKind) {
    if (PROJECT_KINDS.includes(overrideKind)) {
      project = { ...project, kind: overrideKind, reason: `configured in ${CONFIG_FILE}` };
    } else {
      warnings.push(`config project kind "${overrideKind}" is not supported`);
    }
  }

  const repository = discoverRepositoryGates({ facts, verifyCommand, config });
  let runtimeGate = null;
  if (runtime) {
    const derived = deriveRuntimeGate({ facts, project, override: config?.runtime ?? null });
    runtimeGate = derived.gate;
    if (derived.warning) warnings.push(derived.warning);
  }

  return {
    schema: CONTRACT_SCHEMA,
    workspace: facts.root,
    project: { kind: project.kind, framework: project.framework ?? null, reason: project.reason },
    repository,
    runtime: runtimeGate,
    acceptance: config ? normalizeAcceptance(config.acceptance, warnings) : [],
    baseline: null,
    configFile: loaded.file,
    warnings,
  };
}

/** The contract's serializable summary for events, outcomes and the summary. */
export function summarizeContract(contract, gates = []) {
  if (!contract) return null;
  return {
    schema: contract.schema,
    project: contract.project,
    gates: gates.map((gate) => ({
      id: gate.id,
      layer: gate.layer,
      command: gate.command ?? null,
      ok: Boolean(gate.ok),
      skipped: Boolean(gate.skipped),
      blocking: Boolean(gate.blocking),
      status: gate.status ?? null,
      code: gate.code ?? null,
    })),
    runtime: contract.runtime
      ? { adapter: contract.runtime.adapter, mode: contract.runtime.mode, source: contract.runtime.source }
      : null,
    acceptance: contract.acceptance?.map((criterion) => ({ id: criterion.id, kind: criterion.kind, required: criterion.required })) ?? [],
    baseline: contract.baseline
      ? {
          capturedAt: contract.baseline.capturedAt,
          gates: Object.fromEntries(
            Object.entries(contract.baseline.gates ?? {}).map(([id, entry]) => [id, { ok: Boolean(entry.ok), status: entry.status ?? null }]),
          ),
        }
      : null,
    warnings: contract.warnings ?? [],
  };
}

/** Baseline record from cheap repository gate results (pre-mutation evidence). */
export function baselineFromGates(gates, { now = () => new Date() } = {}) {
  const entries = {};
  for (const gate of gates ?? []) {
    if (gate.layer !== "repository" || gate.skipped) continue;
    entries[gate.id] = { ok: Boolean(gate.ok), status: gate.status ?? null, signature: gate.signature ?? null };
  }
  return { capturedAt: now().toISOString(), gates: entries };
}

/**
 * Whether one evaluated gate blocks VERIFIED.
 *
 * User/config gates and every runtime or acceptance gate block when they fail. A
 * discovered repository gate blocks only on a regression: the pre-run baseline
 * passed it, or it now fails a different way than it did before the run. An
 * unchanged pre-existing failure is reported without being blamed on the agent.
 */
export function isBlocking(gate, baseline = null) {
  if (gate.skipped) return false;
  if (gate.layer === "repository" && gate.source === "discovered") {
    const entry = baseline?.[gate.id];
    if (!entry) return false;
    if (entry.ok === true) return true;
    if (!entry.signature || !gate.signature) return false;
    return entry.signature !== gate.signature;
  }
  return gate.required !== false;
}

/**
 * The single VERIFIED decision. Every blocking gate must pass; skipped gates
 * never count as a pass. `verified_with_pre_existing_failures` is a pass that
 * also reports failures the baseline already had.
 */
export function evaluateGates(contract, gates) {
  const baseline = contract?.baseline?.gates ?? null;
  const evaluated = (gates ?? []).map((gate) => ({ ...gate, blocking: isBlocking(gate, baseline) }));
  const blockingFailed = evaluated.filter((gate) => gate.blocking && !gate.ok);
  const preExisting = evaluated.filter(
    (gate) => !gate.ok && !gate.blocking && gate.layer === "repository" && gate.source === "discovered",
  );
  const skipped = evaluated.filter((gate) => gate.skipped);
  const ok = blockingFailed.length === 0;
  const failed = blockingFailed[0] ?? null;
  return {
    ok,
    verdict: ok ? (preExisting.length ? "verified_with_pre_existing_failures" : "verified") : "failed",
    code: failed?.code ?? null,
    failed,
    blockingFailed,
    preExisting,
    skipped,
    gates: evaluated,
  };
}
