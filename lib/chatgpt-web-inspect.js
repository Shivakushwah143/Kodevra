import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isSensitive, walk } from "./chatgpt-web-paths.js";

/**
 * The `inspect` action: one compact repository view instead of a dozen
 * list/read/search turns.
 *
 * Everything here is deterministic and local: a bounded filesystem walk, the
 * manifests that are actually present, git status, focus ranking over paths and
 * file contents, and light regex symbol/import extraction. No index, no model
 * call, no network, no dependency on a language server.
 */

const LANGUAGE_BY_EXT = {
  ".js": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".jsx": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".hpp": "C++",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".sh": "Shell",
  ".css": "CSS",
  ".scss": "CSS",
  ".html": "HTML",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

const FRAMEWORKS = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["vite", "Vite"],
  ["electron", "Electron"],
  ["@playwright/test", "Playwright"],
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["typescript", "TypeScript"],
];

const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w!?]*)\s*\(/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+([A-Za-z_]\w*)\s*\(/,
];

const IMPORT_PATTERNS = [
  /^\s*import\s+(?:[^"']*?\bfrom\s+)?["']([^"']+)["']/,
  /require\(\s*["']([^"']+)["']\s*\)/,
  /^\s*from\s+([\w.]+)\s+import\b/,
  /^\s*import\s+([\w.]+)\s*$/,
];

const TEST_PATH = /(^|\/)(test|tests|__tests__|spec|e2e)\//i;
const TEST_FILE = /\.(test|spec)\.[A-Za-z0-9]+$/i;
const CODE_FILE = /\.(js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|rb|php|cs|c|h|cpp|hpp|sh)$/i;

function readJson(absolute) {
  try {
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch {
    return null;
  }
}

function safeText(absolute, max = 40_000) {
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > max) return null;
    const text = fs.readFileSync(absolute, "utf8");
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

/**
 * Git evidence is only about this workspace. A workspace nested inside some
 * other checkout would otherwise report that parent's files (as `../../...`),
 * which is neither relevant nor confined.
 */
function isRepoRoot(workspace) {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return false;
    return path.resolve(result.stdout.trim()).toLowerCase() === path.resolve(workspace).toLowerCase();
  } catch {
    return false;
  }
}

function gitStatus(workspace, limit, git) {
  if (!git) return [];
  try {
    const result = spawnSync("git", ["status", "--short"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        const file = line.slice(3).trim();
        return file && !file.includes("../") && !path.isAbsolute(file);
      })
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Tracked plus untracked-but-not-ignored files when git can answer, so an
 * ignored dependency checkout does not crowd out the project. A greenfield or
 * non-git workspace falls back to the bounded walk.
 */
function collectFiles(workspace, limits, git) {
  try {
    const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (git && result.status === 0 && result.stdout) {
      const listed = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((file) => !file.split("/").some((part) => part.startsWith(".")))
        .filter((file) => !isSensitive(path.join(workspace, file)))
        .slice(0, limits.inspectFiles);
      if (listed.length) return listed.sort();
    }
  } catch {
    // fall through to the filesystem walk
  }
  const files = [];
  walk(workspace, path.resolve(workspace), (absolute) => {
    files.push(path.relative(path.resolve(workspace), absolute).split(path.sep).join("/"));
    return files.length < limits.inspectFiles;
  });
  return files.filter((file) => !file.split("/").some((part) => part.startsWith("."))).sort();
}

function languageSummary(files) {
  const counts = new Map();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT[path.extname(file).toLowerCase()];
    if (!language) continue;
    counts.set(language, (counts.get(language) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

function directorySummary(files, limit) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length < 2) continue;
    const top = parts[0];
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function focusTerms(focus) {
  const terms = [...new Set(`${focus || ""}`.toLowerCase().split(/[^a-z0-9_$]+/).filter((term) => term.length >= 2))];
  // Cheap stemming for repository discovery: `authentication` should still find
  // `auth/`, `auth.js` and `authenticate` without a model turn or an index.
  const prefixes = terms.filter((term) => term.length >= 6).map((term) => term.slice(0, 4));
  return [...new Set([...terms, ...prefixes])];
}

function pathScore(file, terms) {
  const lower = file.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += 8;
    if (path.basename(lower).startsWith(term)) score += 4;
  }
  return score;
}

function contentScore(workspace, file, terms, max) {
  const text = safeText(path.join(workspace, file), max);
  if (text === null) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let index = haystack.indexOf(term);
    let hits = 0;
    while (index !== -1 && hits < 8) {
      hits += 1;
      index = haystack.indexOf(term, index + term.length);
    }
    score += Math.min(6, hits);
  }
  return score;
}

/**
 * Path matches are scanned first, then the rest of the tree, so a source file
 * whose name matches the focus is never lost to a chatty README that happened
 * to be read earlier in the budget.
 */
function rankByFocus(workspace, files, terms, limits) {
  if (!terms.length) return [];
  const scored = files.map((file) => ({ file, score: pathScore(file, terms) }));
  const byFile = new Map(scored.map((entry) => [entry.file, entry]));
  const ordered = [...scored].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const pathMatches = ordered.filter((entry) => entry.score > 0);
  const rest = ordered.filter((entry) => entry.score === 0);
  let scanned = 0;
  for (const entry of [...pathMatches, ...rest]) {
    if (scanned >= limits.inspectScanFiles) break;
    let stat;
    try {
      stat = fs.statSync(path.join(workspace, entry.file));
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > limits.inspectScanBytes) continue;
    scanned += 1;
    entry.score += contentScore(workspace, entry.file, terms, limits.inspectScanBytes);
  }
  return [...byFile.values()]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limits.inspectFocusFiles);
}

function symbolsIn(text, relative, remaining) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && found.length < remaining; index += 1) {
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(lines[index]);
      if (!match) continue;
      found.push(`${relative}:${index + 1} ${match[1]}`);
      break;
    }
  }
  return found;
}

function importsIn(text, remaining) {
  const found = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (found.length >= remaining) break;
    for (const pattern of IMPORT_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const source = match[1].trim();
      if (!source || seen.has(source)) break;
      seen.add(source);
      found.push(source);
      break;
    }
  }
  return found;
}

const MANIFEST_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "Makefile",
  "deno.json",
];

function verifyHints(workspace, files, pkg) {
  const hints = [];
  const scripts = pkg?.scripts ?? {};
  for (const name of ["test", "typecheck", "type-check", "lint", "build"]) {
    if (!scripts[name]) continue;
    hints.push(name === "test" ? "npm test" : `npm run ${name}`);
  }
  const has = (name) => fs.existsSync(path.join(workspace, name));
  if (has("go.mod")) hints.push("go test ./...");
  if (has("Cargo.toml")) hints.push("cargo test");
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    const pytest = files.some((file) => /(^|\/)test_[^/]*\.py$/.test(file) || /_test\.py$/.test(file));
    if (pytest) hints.push("python -m pytest");
  }
  if (has("Makefile") && files.some((file) => file.startsWith("test"))) hints.push("make test");
  return [...new Set(hints)].slice(0, 4);
}

function entryPoints(workspace, pkg, files) {
  const entries = [];
  if (pkg) {
    if (typeof pkg.main === "string") entries.push(pkg.main);
    if (typeof pkg.module === "string") entries.push(pkg.module);
    if (typeof pkg.bin === "string") entries.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === "object") entries.push(...Object.values(pkg.bin));
  }
  for (const candidate of [
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
    "index.js",
    "index.ts",
    "app/page.tsx",
    "src/app/page.tsx",
    "main.py",
    "cmd/main.go",
  ]) {
    if (files.includes(candidate)) entries.push(candidate);
  }
  return [...new Set(entries.filter((entry) => typeof entry === "string"))].slice(0, 5);
}

export function inspectTool(workspace, action, limits) {
  const root = path.resolve(workspace);
  const focus = `${action.focus ?? ""}`.trim();
  const git = isRepoRoot(root);
  const files = collectFiles(workspace, limits, git);
  const pkg = readJson(path.join(root, "package.json"));
  const terms = focusTerms(focus);
  const ranked = rankByFocus(workspace, files, terms, limits);
  const languages = languageSummary(files);
  const directories = directorySummary(files, 8);
  const tests = files.filter((file) => CODE_FILE.test(file) && (TEST_PATH.test(file) || TEST_FILE.test(file))).slice(0, 8);
  const changed = gitStatus(workspace, 15, git);
  const entries = entryPoints(workspace, pkg, files);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const frameworks = FRAMEWORKS.filter(([key]) => deps[key]).map(([, label]) => label);
  const verify = verifyHints(workspace, files, pkg);
  const manifests = MANIFEST_FILES.filter((name) => fs.existsSync(path.join(root, name))).slice(0, 8);

  const lines = [];
  const section = (title, values) => {
    if (!values.length) return;
    lines.push(title);
    for (const value of values) lines.push(`  ${value}`);
  };

  section("REPO", [`${files.length} file(s)${files.length >= limits.inspectFiles ? " (walk limit reached)" : ""}`]);
  if (pkg) {
    const name = pkg.name ? `${pkg.name}${pkg.version ? `@${pkg.version}` : ""}` : "package.json";
    lines.push(`PROJECT ${name}${pkg.type ? ` · type=${pkg.type}` : ""}`);
  }
  if (languages.length) lines.push(`LANGUAGES ${languages.map(([name, count]) => `${name} (${count})`).join(", ")}`);
  if (frameworks.length) lines.push(`STACK ${frameworks.join(", ")}`);
  section("MANIFESTS", manifests);
  section("LAYOUT", directories.map(([name, count]) => `${name}/ ${count} file(s)`));
  section("ENTRY", entries);
  section("TESTS", tests);
  if (changed.length) lines.push(`CHANGED git status --short (${changed.length}): ${changed.map((line) => line.trim()).join(" · ")}`);
  // Verification commands sit before the symbol dump: they are small, and both
  // the bootstrap packet and a model-requested inspect need them even when the
  // view is truncated.
  section("VERIFY", verify);

  if (focus) {
    lines.push(`FOCUS "${focus}"`);
    if (!ranked.length) lines.push("  no matching files");
    for (const entry of ranked) lines.push(`  ${entry.file} (score ${entry.score})`);
  }

  const targets = [...new Set([...ranked.map((entry) => entry.file), ...entries, ...tests])].slice(0, 12);
  const symbols = [];
  const imports = [];
  for (const file of [...new Set(targets)]) {
    if (symbols.length >= limits.inspectSymbols) break;
    const text = safeText(path.join(root, file));
    if (text === null) continue;
    symbols.push(...symbolsIn(text, file, limits.inspectSymbols - symbols.length));
    for (const source of importsIn(text, 4)) imports.push(`${file} -> ${source}`);
  }
  section("SYMBOLS", symbols.slice(0, limits.inspectSymbols));
  section("IMPORTS", imports.slice(0, 24));

  let body = lines.join("\n").trim();
  if (body.length > limits.inspectChars) {
    body = `${body.slice(0, limits.inspectChars)}\n[inspect truncated at ${limits.inspectChars} characters]`;
  }
  return {
    ok: true,
    detail: `${files.length} file(s), ${ranked.length} focus match(es)${focus ? ` for "${focus}"` : ""}`,
    body,
  };
}
