import path from "node:path";

/**
 * Approval policy for the ChatGPT-web harness (H6).
 *
 * This is the one place that decides whether a model-requested action may run
 * unattended. It never replaces the tool layer's workspace boundary: path
 * confinement, sensitive-file refusal and shell argument checks stay in
 * `chatgpt-web-paths.js` / `chatgpt-web-shell.js` and remain authoritative.
 *
 * `require_approval` means "a human has to say yes". Headless runs have no such
 * channel, so the harness reports APPROVAL_REQUIRED and the model must choose a
 * different approach instead of the action being silently widened.
 */

export const APPROVAL_MODES = Object.freeze(["strict", "balanced", "autonomous"]);
export const DEFAULT_APPROVAL_MODE = "balanced";

const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "requirements.txt",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

const HARD_BLOCKS = [
  {
    code: "POLICY_DESTRUCTIVE",
    pattern: /\brm\s+-[a-z]*[rf][a-z]*\s+(\*|\.|\/|~|[A-Za-z]:)/i,
    reason: "recursive deletion outside a named workspace path",
  },
  { code: "POLICY_DESTRUCTIVE", pattern: /\b(del|rmdir)\s+\/[sfq]\b/i, reason: "filesystem-wide deletion" },
  { code: "POLICY_DESTRUCTIVE", pattern: /\b(format\s+[a-z]:|diskpart\b|mkfs\b)\b/i, reason: "disk formatting" },
  { code: "POLICY_SYSTEM", pattern: /\b(shutdown|reboot|halt)\b/i, reason: "system power control" },
  {
    code: "POLICY_REGISTRY",
    pattern: /\b(npm|yarn|pnpm)\s+config\s+set\b|\bgit\s+config\s+--(global|system)\b|\b(pip|python)\s+config\b/i,
    reason: "registry or global tool configuration",
  },
  { code: "POLICY_REGISTRY", pattern: /\breg(add|\.exe)?\b|\bsetx\b|\bchoco\s+install\b|\bwinget\s+install\b/i, reason: "system configuration or package manager" },
  {
    code: "POLICY_PRIVILEGE",
    pattern: /\b(sudo|runas|su)\b|Start-Process[^\n]*-Verb\s+RunAs/i,
    reason: "privilege escalation",
  },
  {
    code: "POLICY_REMOTE_EXEC",
    pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sh|bash|node|python|iex|Invoke-Expression)\b/i,
    reason: "piping a remote download into an interpreter",
  },
  {
    code: "POLICY_CREDENTIALS",
    pattern: /\b(printenv|env)\s*($|[|>])|\b(Get-ChildItem|dir)\s+Env:|\bcat\s+[^\n]*\.(ssh|aws|gnupg)\b/i,
    reason: "credential or environment extraction",
  },
];

const INSPECTION =
  /^(git\s+(status|diff|log|show|rev-parse|branch|remote|ls-files|blame)|ls|dir|rg|grep|ag|find|fd|cat|type|head|tail|wc|pwd|where|which|node\s+--version|npm\s+(ls|--version)|npx\s+tsc\b[^\n]*--noEmit)/i;
const BUILD =
  /\b(npm\s+(test|t|run\s+(build|test|lint|typecheck|type-check|check|dev|start|serve))|npx\s+(tsc|vitest|jest|eslint|prettier)|pytest|python\s+-m\s+(pytest|unittest)|go\s+(test|build|vet)|cargo\s+(test|build|check|clippy)|make\b|mvn\b|gradle\b|dotnet\s+(build|test|run)|(node|tsx|ts-node|deno|bun|python3?)\s+(-e|--eval|[^\s-]))/i;
const INSTALL =
  /\b(npm\s+(install|i|ci|add)|yarn\s+(add|install)|pnpm\s+(add|install)|pip\s+install|poetry\s+add|uv\s+add|cargo\s+add|go\s+get|gem\s+install|composer\s+(require|install))/i;
const SCAFFOLD =
  /\b(npx\s+(create-|@?[a-z0-9-]+\s+create)|npm\s+init|ng\s+new|vite\s+create|dotnet\s+new|cargo\s+new|go\s+mod\s+init|nest\s+new)/i;

const MATRIX = {
  strict: {
    mutation: "allow",
    manifest: "require_approval",
    inspection: "allow",
    build: "require_approval",
    install: "require_approval",
    scaffold: "require_approval",
    unknown: "require_approval",
  },
  balanced: {
    mutation: "allow",
    manifest: "allow",
    inspection: "allow",
    build: "allow",
    install: "allow",
    scaffold: "require_approval",
    unknown: "require_approval",
  },
  autonomous: {
    mutation: "allow",
    manifest: "allow",
    inspection: "allow",
    build: "allow",
    install: "allow",
    scaffold: "allow",
    unknown: "allow",
  },
};

export function normalizeApprovalMode(value) {
  const mode = `${value ?? ""}`.trim().toLowerCase();
  return APPROVAL_MODES.includes(mode) ? mode : null;
}

export function approvalModes() {
  return [...APPROVAL_MODES];
}

export function isManifestPath(relative) {
  return MANIFESTS.has(path.basename(`${relative ?? ""}`));
}

/** Paths a mutating action will touch, for policy classification. */
export function mutationTargets(action) {
  if (action.action === "write" || action.action === "edit") return action.path ? [action.path] : [];
  if (action.action === "apply_patch") {
    const targets = [];
    let previous = null;
    for (const line of `${action.patch ?? ""}`.split(/\r?\n/)) {
      if (line.startsWith("--- ")) {
        const value = line.slice(4).trim().split("\t")[0];
        previous = !value || value === "/dev/null" ? null : value.replace(/^a\//, "");
        continue;
      }
      if (!line.startsWith("+++ ")) continue;
      const value = line.slice(4).trim().split("\t")[0];
      if (!value) continue;
      targets.push(value === "/dev/null" ? previous : value.replace(/^b\//, ""));
    }
    return targets.filter(Boolean);
  }
  return [];
}

function hardBlock(command) {
  for (const rule of HARD_BLOCKS) {
    if (rule.pattern.test(command)) return { code: rule.code, reason: rule.reason };
  }
  return null;
}

function shellClass(command) {
  const text = `${command ?? ""}`.trim();
  if (INSPECTION.test(text)) return "inspection";
  if (BUILD.test(text)) return "build";
  if (INSTALL.test(text)) return "install";
  if (SCAFFOLD.test(text)) return "scaffold";
  return "unknown";
}

/**
 * One decision per action. Returns the class, the policy used and the reason so
 * the run log can show exactly why something ran or was refused.
 */
export function decideApproval({ mode = DEFAULT_APPROVAL_MODE, action } = {}) {
  const policy = normalizeApprovalMode(mode);
  if (!policy) {
    return { decision: "deny", policy: `${mode}`, kind: "invalid", reason: `unknown approval mode "${mode}"` };
  }
  if (!action || typeof action !== "object") {
    return { decision: "allow", policy, kind: "none", reason: "no action to classify" };
  }

  if (action.action === "shell") {
    const blocked = hardBlock(`${action.command ?? ""}`);
    if (blocked) {
      return { decision: "deny", policy, kind: "blocked", code: blocked.code, reason: blocked.reason };
    }
    const kind = shellClass(action.command);
    const decision = MATRIX[policy][kind];
    return {
      decision,
      policy,
      kind: `shell:${kind}`,
      reason:
        decision === "allow"
          ? `"${kind}" command allowed by ${policy} policy`
          : `"${kind}" command needs approval under ${policy} policy`,
    };
  }

  if (action.action === "write" || action.action === "edit" || action.action === "apply_patch") {
    const targets = mutationTargets(action);
    const manifests = targets.filter(isManifestPath);
    const kind = manifests.length ? "manifest" : "mutation";
    const decision = MATRIX[policy][kind];
    return {
      decision,
      policy,
      kind: manifests.length ? `manifest:${manifests.join(",")}` : "mutation",
      reason:
        decision === "allow"
          ? `${kind} change allowed by ${policy} policy`
          : `${kind} change needs approval under ${policy} policy`,
    };
  }

  return { decision: "allow", policy, kind: `${action.action ?? "action"}`, reason: "action is not mutation or execution" };
}
