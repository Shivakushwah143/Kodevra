import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readCodexCatalog } from "./codex.js";

/**
 * Codex's model catalog, as Codex itself reports it.
 *
 * `codex debug models` is the CLI's own read-only renderer for the catalog it is
 * actually using; `--bundled` renders the catalog compiled into the installed
 * binary. Kodevra reads those two views and never parses, edits or rewrites the
 * user's `config.toml`, `auth.json` or custom catalog.
 *
 * A custom `model_catalog_json` replaces the bundled catalog, so a model Codex
 * knows about (with its service tiers) can appear "unknown" and lose its fast
 * tier. For `--speed fast` Kodevra therefore passes a merged catalog to that one
 * child invocation only: the user's entries first, then every bundled entry the
 * user's catalog does not already define. Nothing is deleted and no global
 * setting is touched.
 */

export const SPEED_MODES = ["default", "fast"];

/** Where the version-keyed bundled catalog is remembered between runs. */
export function catalogCacheDir(env = process.env) {
  if (env.KODEVRA_CACHE_DIR) return path.resolve(env.KODEVRA_CACHE_DIR);
  return path.join(os.homedir(), ".kodevra", "cache");
}

/**
 * Identity of the catalog inside a Codex binary: the path, the file's size and
 * modification time, and the version the CLI reports. Replacing the binary or
 * upgrading it changes the first three, so a stale cache cannot survive it.
 */
export function catalogCacheKey(probe, { stat = fs.statSync } = {}) {
  if (!probe?.command) return null;
  let file = "";
  try {
    const info = stat(probe.command);
    file = `${info.size}:${info.mtimeMs}`;
  } catch {
    file = "unknown";
  }
  return JSON.stringify([probe.command, probe.version ?? null, file, probe.prefixArgs ?? []]);
}

/**
 * The bundled catalog, cached on disk because it is version-derived data that no
 * run can change: `codex debug models --bundled` prints 315 kB for this build and
 * costs a process launch every time. The cache holds model metadata only - no
 * credential, token or environment value is ever written to it - and a miss or a
 * corrupt file simply falls back to asking the CLI again.
 *
 * @returns {{catalog: object|null, source: "cache"|"codex"|"none", file: string|null}}
 */
export function bundledCatalog(probe, { env = process.env, readCatalog, stat } = {}) {
  if (!probe?.ok) return { catalog: null, source: "none", file: null };
  const read = readCatalog ?? (() => catalogFromCli(probe, env));
  const key = catalogCacheKey(probe, stat ? { stat } : {});
  const dir = catalogCacheDir(env);
  const file = key ? path.join(dir, `codex-bundled-catalog-${sha1(key).slice(0, 16)}.json`) : null;

  if (file) {
    const cached = readCache(file, key);
    if (cached) return { catalog: cached, source: "cache", file };
  }

  const catalog = read();
  if (!catalog) return { catalog: null, source: "none", file: null };
  if (file) writeCache(file, key, catalog);
  return { catalog, source: "codex", file };
}

function readCache(file, key) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.key !== key || !Array.isArray(parsed?.catalog?.models)) return null;
    return parsed.catalog;
  } catch {
    return null;
  }
}

function writeCache(file, key, catalog) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key, catalog }), { encoding: "utf8", mode: 0o600 });
  } catch {
    // A cache that cannot be written is not a reason to refuse a run.
  }
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function catalogFromCli(probe, env) {
  return readCodexCatalog(probe, { bundled: true, env });
}

/** The service tier Codex advertises for a "fast" run. */
export const FAST_SERVICE_TIER = "priority";

export function normalizeSpeed(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return SPEED_MODES.includes(key) ? key : null;
}

/** Service tier ids a catalog entry advertises, from either tier field. */
export function serviceTierIds(model) {
  if (!model) return [];
  const tiers = Array.isArray(model.service_tiers) ? model.service_tiers.map((tier) => tier?.id).filter(Boolean) : [];
  const speeds = Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers.filter(Boolean) : [];
  return [...new Set([...tiers, ...speeds, model.default_service_tier].filter(Boolean).map(String))];
}

/** Whether this catalog entry can run on the fast tier. */
export function supportsPriority(model) {
  if (!model) return false;
  const ids = Array.isArray(model.service_tiers) ? model.service_tiers.map((tier) => tier?.id) : [];
  return ids.includes(FAST_SERVICE_TIER) || model.default_service_tier === FAST_SERVICE_TIER;
}

export function findModel(catalog, slug) {
  if (!catalog || !Array.isArray(catalog.models) || !slug) return null;
  return catalog.models.find((model) => model?.slug === slug) ?? null;
}

/**
 * User models first (their order is theirs), then every bundled model whose slug
 * the user catalog does not define. Built-in entries are never dropped.
 */
export function mergeCatalogs({ bundled = null, user = null } = {}) {
  const bundledModels = Array.isArray(bundled?.models) ? bundled.models : [];
  const userModels = Array.isArray(user?.models) ? user.models : [];
  const seen = new Set(userModels.map((model) => model?.slug).filter(Boolean));
  return { models: [...userModels, ...bundledModels.filter((model) => model?.slug && !seen.has(model.slug))] };
}

/** True when the merge adds entries the bundled catalog already had - i.e. no file is needed. */
export function isBundledOnly(merged, bundled) {
  const bundledSlugs = new Set(((bundled?.models) ?? []).map((model) => model?.slug));
  return merged.models.every((model) => bundledSlugs.has(model?.slug));
}

export function catalogSource({ bundled = null, user = null, merged = null } = {}) {
  const bundledCount = bundled?.models?.length ?? 0;
  const userCount = user?.models?.length ?? 0;
  if (!merged) return "none";
  if (userCount === 0) return "bundled";
  return isBundledOnly(merged, bundled) ? "bundled" : "bundled+user";
}

/**
 * Write the merged catalog to a private temporary file that only the child
 * invocation sees. It holds model metadata only - no credential, token or
 * environment value is copied into it.
 */
export function writeCatalogFile(catalog, { baseDir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(baseDir, "kodevra-codex-catalog-"));
  const file = path.join(dir, "models.json");
  // Compact: Codex parses this file, so indentation is pure cost - the merged
  // catalog is ~700 kB pretty-printed and is written and read on every fast run.
  fs.writeFileSync(file, JSON.stringify(catalog), { encoding: "utf8", mode: 0o600 });
  return {
    dir,
    file,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // a temp file that outlived the run is not worth failing the run over
      }
    },
  };
}

/**
 * Decide what `--speed fast` has to do, or why it cannot.
 *
 * @returns {{ok: true, evidence: object, config: string[], cleanup: Function}}
 *        or {{ok: false, code: "FAST_TIER_UNAVAILABLE", message: string, hint: string}}
 */
export function planFastSpeed({ model, bundled, user, env = process.env }) {
  const slug = model ? String(model) : null;
  if (!slug) {
    return {
      ok: false,
      code: "FAST_TIER_UNAVAILABLE",
      message: "Codex did not resolve a model id, so its fast tier cannot be verified.",
      hint: "Pin the model explicitly: kodevra run --engine codex --speed fast -m openai/gpt-5.6-terra \"<task>\"",
    };
  }

  const merged = mergeCatalogs({ bundled, user });
  const entry = findModel(merged, slug);
  if (!entry) {
    return {
      ok: false,
      code: "FAST_TIER_UNAVAILABLE",
      message: `Codex's model catalog does not describe "${slug}", so no fast tier can be claimed for it.`,
      hint: "Run `codex debug models --bundled` to see the models this Codex build knows, then pick one with a priority tier.",
    };
  }
  if (!supportsPriority(entry)) {
    const tiers = serviceTierIds(entry);
    return {
      ok: false,
      code: "FAST_TIER_UNAVAILABLE",
      message: `"${slug}" advertises no fast/priority service tier${tiers.length ? ` (it advertises: ${tiers.join(", ")})` : ""}.`,
      hint: "Use --speed default, or choose a model whose catalog entry lists a priority tier.",
    };
  }

  const source = catalogSource({ bundled, user, merged });
  const config = ["-c", `service_tier="${FAST_SERVICE_TIER}"`];
  let cleanup = () => {};
  let catalogFile = null;

  if (source === "bundled+user") {
    let written;
    try {
      written = writeCatalogFile(merged, { baseDir: env.KODEVRA_TMPDIR || os.tmpdir() });
    } catch (error) {
      return {
        ok: false,
        code: "FAST_TIER_UNAVAILABLE",
        message: `The catalog for the fast tier could not be written: ${error.message}`,
        hint: "Check that the temporary directory is writable, or run with --speed default.",
      };
    }
    catalogFile = written.file;
    cleanup = written.cleanup;
    config.push("-c", `model_catalog_json="${written.file.replace(/\\/g, "/")}"`);
  }

  return {
    ok: true,
    evidence: {
      requested: "fast",
      effective_service_tier: FAST_SERVICE_TIER,
      model: slug,
      model_supports_priority: true,
      catalog_source: source,
      catalog_models: merged.models.length,
      catalog_file: catalogFile,
    },
    config,
    cleanup,
  };
}
