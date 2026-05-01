'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths, MASK_COMPILE_CONFIG_FILE } = require('../paths');

function resolveExistingConfigFilePath(paths) {
  if (!paths || !paths.config || !fs.existsSync(paths.config)) return null;
  return paths.config;
}
const { BUILT_IN_PROFILES, SUPPORTED_LANGUAGE } = require('../package-config');

const CUSTOM_CLASS_KEYS = ['MaskDatabase', 'MaskModels'];

/** @typedef {'materialized'|'injected'} MaskConfigSource */

/**
 * Parse optional customClassNames from mask config object.
 * @returns {Record<string, { customOnly: boolean, customNames: string[] }>|null}
 */
function parseCustomClassNames(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const out = {};
  for (const key of CUSTOM_CLASS_KEYS) {
    const block = raw[key];
    if (block == null) continue;
    if (typeof block !== 'object' || Array.isArray(block)) {
      throw new Error(
        `[Mask] customClassNames.${key} must be an object with optional "customOnly" (boolean) and "customNames" (string array).`
      );
    }
    const customOnly = block.customOnly === true;
    const namesRaw = block.customNames;
    const customNames = Array.isArray(namesRaw)
      ? namesRaw
          .filter((n) => typeof n === 'string' && n.trim())
          .map((n) => n.trim())
      : [];
    out[key] = { customOnly, customNames };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Merge custom import names into profile.promptCallNames / profile.modelDefineNames.
 * @param {object} profile — shallow clone recommended; this mutates and returns the same object.
 */
function applyCustomClassNames(profile, customClassNames) {
  if (!customClassNames || typeof customClassNames !== 'object') {
    return profile;
  }
  const BUILT = { MaskDatabase: 'MaskDatabase', MaskModels: 'MaskModels' };
  const PROP = { MaskDatabase: 'promptCallNames', MaskModels: 'modelDefineNames' };

  for (const key of CUSTOM_CLASS_KEYS) {
    const block = customClassNames[key];
    if (!block) continue;
    const prop = PROP[key];
    const builtInName = BUILT[key];
    const names = block.customNames;
    const customOnly = block.customOnly === true;

    if (names.length === 0) {
      if (customOnly) {
        throw new Error(
          `[Mask] customClassNames.${key}: customOnly is true but customNames is empty or missing. Add at least one identifier used in source code.`
        );
      }
      continue;
    }

    if (customOnly) {
      profile[prop] = names.slice();
    } else {
      const existing = profile[prop];
      const baseArr =
        Array.isArray(existing) && existing.length > 0 ? [...existing] : [builtInName];
      const seen = new Set(baseArr);
      for (const n of names) {
        if (!seen.has(n)) {
          baseArr.push(n);
          seen.add(n);
        }
      }
      profile[prop] = baseArr;
    }
  }

  return profile;
}

/**
 * Read persisted project config JSON from project root (no validation).
 * @param {string} configPath
 * @returns {object}
 */
function readMaskConfigJsonFile(configPath) {
  const rawText = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(rawText || '{}');
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[Mask] ${path.basename(configPath)} must contain a JSON object.`);
  }
  return parsed;
}

/**
 * Normalize and validate fields required for compilation.
 * @param {object} c - Raw config object
 * @param {string} pathLabel - File path or label for errors
 */
function normalizeAndValidateConfig(c, pathLabel) {
  const database = c.database || 'mongodb';
  const dbModulePath = typeof c.dbModulePath === 'string' && c.dbModulePath.trim() ? c.dbModulePath.trim() : null;
  const syncApiKeyRaw = c.syncApiKey;
  const syncApiKey = typeof syncApiKeyRaw === 'string' && syncApiKeyRaw.trim() ? syncApiKeyRaw.trim() : null;

  if (!dbModulePath) {
    throw new Error(
      `[Mask] Config must include "dbModulePath" (path to your DB module, e.g. "src/db"). The compiler cannot run without it. (${pathLabel})`
    );
  }
  if (!syncApiKey) {
    throw new Error(
      `[Mask] Set syncApiKey (Mask Databases project API key). The compiler cannot run without it. (${pathLabel})`
    );
  }

  const modelPaths = c.modelPaths ?? c.model_paths;
  const modelPathsArr = Array.isArray(modelPaths)
    ? modelPaths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : null;

  const queryPaths = c.queryPaths ?? c.query_paths;
  const queryPathsArr = Array.isArray(queryPaths)
    ? queryPaths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    : null;

  const customClassNames = parseCustomClassNames(c.customClassNames);

  /** @type {Record<string, unknown>} */
  const out = {
    language: SUPPORTED_LANGUAGE,
    database,
    dbModulePath,
    syncApiKey,
    modelPaths: modelPathsArr,
    queryPaths: queryPathsArr,
    ...(customClassNames ? { customClassNames } : {})
  };

  if (typeof c.syncBaseUrl === 'string' && c.syncBaseUrl.trim()) {
    out.syncBaseUrl = c.syncBaseUrl.trim().replace(/\/$/, '');
  }

  if (c.registery != null && typeof c.registery === 'object' && !Array.isArray(c.registery)) {
    /** @type {Record<string, string>} */
    const reg = {};
    for (const [key, value] of Object.entries(c.registery)) {
      if (typeof value === 'string' && value.trim()) reg[key] = value.trim();
    }
    if (Object.keys(reg).length > 0) {
      out.registery = reg;
    }
  }

  return out;
}

/**
 * JSON-serializable object written by compile for runtime/codegen (project root snapshot).
 * @param {ReturnType<typeof normalizeAndValidateConfig>} normalized
 */
function toMaterializedMaskConfigJson(normalized) {
  /** @type {Record<string, unknown>} */
  const o = {
    database: normalized.database,
    dbModulePath: normalized.dbModulePath,
    syncApiKey: normalized.syncApiKey
  };
  if (normalized.modelPaths && normalized.modelPaths.length) o.modelPaths = normalized.modelPaths;
  if (normalized.queryPaths && normalized.queryPaths.length) o.queryPaths = normalized.queryPaths;
  if (normalized.customClassNames) o.customClassNames = normalized.customClassNames;
  if (normalized.syncBaseUrl) o.syncBaseUrl = normalized.syncBaseUrl;
  if (normalized.registery) o.registery = normalized.registery;
  return o;
}

/**
 * Read persisted compile output from paths.config. Does not validate required fields.
 * @param {{ config: string }} paths
 * @returns {object|null}
 */
function readMaskConfigRawObject(paths) {
  const configPath = resolveExistingConfigFilePath(paths);
  if (!configPath) return null;
  try {
    return readMaskConfigJsonFile(configPath);
  } catch (_) {
    return null;
  }
}

/**
 * @param {{ config: string }} paths
 * @param {{ overrideConfig?: object }} [options]
 * @returns {{ config: object, meta: { source: MaskConfigSource, configPath: string } }}
 */
function loadConfigWithMeta(paths, options) {
  const p = paths || getPaths(process.cwd());
  const opts = options || {};
  const pathLabel = p.config || path.join('.mask', MASK_COMPILE_CONFIG_FILE);

  if (opts.overrideConfig != null) {
    if (typeof opts.overrideConfig !== 'object' || Array.isArray(opts.overrideConfig)) {
      throw new Error('[Mask] overrideConfig must be a plain object.');
    }
    const config = normalizeAndValidateConfig(opts.overrideConfig, 'overrideConfig');
    return {
      config,
      meta: { source: /** @type {MaskConfigSource} */ ('injected'), configPath: pathLabel }
    };
  }

  const configPath = resolveExistingConfigFilePath(p);
  if (!configPath) {
    throw new Error(
      '[Mask] Missing compile output (.mask/compile-config.json). Run `node mask.compile.cjs` first (from the directory that contains mask.compile.cjs).'
    );
  }

  let c;
  try {
    c = readMaskConfigJsonFile(configPath);
  } catch (err) {
    if (err.message && err.message.startsWith('[Mask]')) throw err;
    throw new Error(`Failed to read compile output (${configPath}): ${err.message}`);
  }

  try {
    const config = normalizeAndValidateConfig(c, configPath);
    return { config, meta: { source: 'materialized', configPath } };
  } catch (err) {
    if (err.message && err.message.startsWith('[Mask]')) throw err;
    throw new Error(`Failed to parse compile output (${configPath}): ${err.message}`);
  }
}

function loadConfig(paths, options) {
  return loadConfigWithMeta(paths, options).config;
}

function getBuiltInProfile(adapter) {
  if (adapter && BUILT_IN_PROFILES[adapter]) {
    return BUILT_IN_PROFILES[adapter];
  }
  return null;
}

async function loadOrCreateProjectProfile(paths, options) {
  const p = paths || getPaths(process.cwd());
  const { config } = loadConfigWithMeta(p, options);
  const adapter = `${config.language}-${config.database}`;
  const builtIn = getBuiltInProfile(adapter);
  const base = builtIn || {};
  const optional = {};
  if (config.modelPaths && config.modelPaths.length > 0) {
    optional.modelPaths = config.modelPaths;
  }
  if (config.queryPaths && config.queryPaths.length > 0) {
    optional.queryPaths = config.queryPaths;
  }

  function finalize(profile) {
    return applyCustomClassNames({ ...profile }, config.customClassNames);
  }

  if (Object.keys(optional).length > 0) {
    return finalize({ ...base, ...optional });
  }
  if (builtIn) {
    return finalize({ ...builtIn });
  }
  if (fs.existsSync(p.profile)) {
    const raw = fs.readFileSync(p.profile, 'utf8');
    try {
      const parsed = JSON.parse(raw || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        delete parsed.promptCallNames;
        delete parsed.modelDefineNames;
        delete parsed.promptCallPattern;
        delete parsed.modelDefinePattern;
      }
      return finalize({ ...base, ...parsed });
    } catch (_) {
      // fall through
    }
  }
  throw new (require('./errors').UnsupportedDbsError)(config.database);
}

module.exports = {
  loadConfig,
  loadConfigWithMeta,
  loadOrCreateProjectProfile,
  getBuiltInProfile,
  parseCustomClassNames,
  applyCustomClassNames,
  readMaskConfigRawObject,
  normalizeAndValidateConfig,
  toMaterializedMaskConfigJson
};
