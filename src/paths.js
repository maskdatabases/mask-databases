'use strict';

const path = require('path');
const fs = require('fs');

/** Persisted snapshot of overrideConfig (written by compile); users edit mask.compile.cjs only. */
const MASK_COMPILE_CONFIG_FILE = 'compile-config.json';
/** Single supported compile entry: project root. */
const MASK_COMPILE = 'mask.compile.cjs';

function hasProjectMarker(dir) {
  return (
    fs.existsSync(path.join(dir, MASK_COMPILE)) ||
    fs.existsSync(path.join(dir, '.mask', MASK_COMPILE_CONFIG_FILE)) ||
    fs.existsSync(path.join(dir, '.mask', 'generated', 'queries.js'))
  );
}

/**
 * Walk upward from startDir; return first directory containing mask.compile.cjs,
 * .mask/compile-config.json, or .mask/generated/queries.js.
 */
function findProjectRootFrom(startDir) {
  let dir = path.resolve(startDir);
  const stop = path.parse(dir).root;
  while (dir && dir !== stop) {
    if (hasProjectMarker(dir)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolve the project root for Mask (where mask.compile.cjs lives, or .mask).
 * - Walk up from process.cwd().
 * - Else walk up from require.main (app entry or CLI inside node_modules).
 * - Else process.cwd().
 */
function getProjectRoot() {
  const fromCwd = findProjectRootFrom(process.cwd());
  if (fromCwd) return fromCwd;
  if (typeof require.main !== 'undefined' && require.main && require.main.filename) {
    const fromMain = findProjectRootFrom(path.dirname(require.main.filename));
    if (fromMain) return fromMain;
  }
  return process.cwd();
}

/**
 * Path to persisted compile snapshot JSON under .mask/ (runtime / codegen; derived from mask.compile.cjs).
 */
function resolveConfigPath(projectRoot) {
  const root = path.resolve(projectRoot);
  return path.join(root, '.mask', MASK_COMPILE_CONFIG_FILE);
}

function resolveMaskConfigJsonPath(projectRoot) {
  return resolveConfigPath(projectRoot);
}

function resolveMaskCompilePath(projectRoot) {
  return path.join(path.resolve(projectRoot), MASK_COMPILE);
}

/**
 * Standard .mask folder layout (generated/sync state).
 *
 *   mask.compile.cjs          (compile entry — you edit overrideConfig here)
 *   .mask/
 */
function getPaths(projectRoot) {
  const root = path.join(projectRoot, '.mask');
  const systemRoot = path.join(root, 'system');
  const localRoot = path.join(root, 'local');
  return {
    root,
    config: resolveConfigPath(projectRoot),
    profile: path.join(root, 'profile.json'),
    /** Legacy single dirs (used when sync is not configured). */
    queries: {
      dir: path.join(root, 'queries'),
      promptMap: path.join(root, 'queries', 'prompt-map.json'),
      metadata: path.join(root, 'queries', 'metadata.json'),
      failedPrompts: path.join(root, 'queries', 'failed-prompts.json'),
      needsReview: path.join(root, 'queries', 'needs-review.json')
    },
    models: {
      dir: path.join(root, 'models'),
      promptMap: path.join(root, 'models', 'prompt-map.json'),
      metadata: path.join(root, 'models', 'metadata.json'),
      failedPrompts: path.join(root, 'models', 'failed-model-prompts.json')
    },
    /** Sync layout: fetched from Mask Databases. */
    system: {
      root: systemRoot,
      queries: {
        dir: path.join(systemRoot, 'queries'),
        promptMap: path.join(systemRoot, 'queries', 'prompt-map.json'),
        metadata: path.join(systemRoot, 'queries', 'metadata.json'),
        syncMeta: path.join(systemRoot, 'queries', 'sync-meta.json'),
        failedPrompts: path.join(systemRoot, 'queries', 'failed-prompts.json'),
        needsReview: path.join(systemRoot, 'queries', 'needs-review.json')
      },
      models: {
        dir: path.join(systemRoot, 'models'),
        promptMap: path.join(systemRoot, 'models', 'prompt-map.json'),
        metadata: path.join(systemRoot, 'models', 'metadata.json'),
        syncMeta: path.join(systemRoot, 'models', 'sync-meta.json'),
        failedPrompts: path.join(systemRoot, 'models', 'failed-model-prompts.json')
      }
    },
    /** Sync layout: locally compiled; push sends this to central. */
    local: {
      root: localRoot,
      queries: {
        dir: path.join(localRoot, 'queries'),
        promptMap: path.join(localRoot, 'queries', 'prompt-map.json'),
        metadata: path.join(localRoot, 'queries', 'metadata.json'),
        syncMeta: path.join(localRoot, 'queries', 'sync-meta.json'),
        failedPrompts: path.join(localRoot, 'queries', 'failed-prompts.json'),
        needsReview: path.join(localRoot, 'queries', 'needs-review.json')
      },
      models: {
        dir: path.join(localRoot, 'models'),
        promptMap: path.join(localRoot, 'models', 'prompt-map.json'),
        metadata: path.join(localRoot, 'models', 'metadata.json'),
        syncMeta: path.join(localRoot, 'models', 'sync-meta.json'),
        failedPrompts: path.join(localRoot, 'models', 'failed-model-prompts.json')
      }
    },
    generated: {
      dir: path.join(root, 'generated'),
      queries: path.join(root, 'generated', 'queries.js'),
      models: path.join(root, 'generated', 'models.js')
    },
    schemaSql: path.join(projectRoot, 'sql', 'schema.sql'),
    /** MySQL/Postgres: sequential migration files and manifest (definition order). */
    migrations: {
      dir: path.join(root, 'migrations'),
      manifest: path.join(root, 'migrations', 'manifest.json')
    }
  };
}

module.exports = {
  getPaths,
  getProjectRoot,
  resolveConfigPath,
  resolveMaskConfigJsonPath,
  resolveMaskCompilePath,
  MASK_COMPILE_CONFIG_FILE,
  MASK_COMPILE
};
