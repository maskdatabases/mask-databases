'use strict';

const fs = require('fs');
const { readMaskConfigRawObject } = require('./config');
const { loadJsonFile, saveJsonFile } = require('./fs-utils');
const { MASK_DATABASES_DEFAULT_URL } = require('../package-config');
const {
  mergeFetchReconcile,
  applyLocalPatchToSlice,
  markLocalSliceSynced
} = require('../sync/sync-engine');

function getSyncConfig(paths) {
  if (!paths || !paths.config || !fs.existsSync(paths.config)) return null;
  const config = readMaskConfigRawObject(paths);
  if (!config) return null;
  const apiKey = config.syncApiKey;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) return null;
  const baseUrl = (config.syncBaseUrl && typeof config.syncBaseUrl === 'string' && config.syncBaseUrl.trim())
    ? config.syncBaseUrl.trim().replace(/\/$/, '')
    : MASK_DATABASES_DEFAULT_URL;
  return { apiKey: apiKey.trim(), baseUrl };
}

/**
 * Prompts registery: keyed full prompt texts for MaskDatabase.prompt('mask-<key>').
 * Lives under overrideConfig.registery in mask.compile.cjs (resolved at compile time; persisted for tooling/runtime alongside .mask/).
 * @returns {Record<string, string>|null} normalized map, or null if missing/empty
 */
function loadPromptsRegisteryFromMaskConfig(paths) {
  const configPath = paths && paths.config;
  if (!configPath || !fs.existsSync(configPath)) return null;
  const config = readMaskConfigRawObject(paths);
  if (!config) return null;
  const reg = config.registery;
  if (reg == null) return null;
  if (typeof reg !== 'object' || Array.isArray(reg)) return null;
  const obj = {};
  for (const [key, value] of Object.entries(reg)) {
    if (typeof value === 'string' && value.trim()) obj[key] = value.trim();
  }
  return Object.keys(obj).length ? obj : null;
}

/** Merge two objects; values from b overwrite a. For arrays, merge and dedupe by JSON string. */
function mergeObjects(a, b) {
  if (!b || typeof b !== 'object') return a || {};
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function mergeArrays(a, b) {
  const set = new Set();
  for (const x of a || []) set.add(JSON.stringify(x));
  for (const x of b || []) set.add(JSON.stringify(x));
  return [...set].map((s) => JSON.parse(s));
}

function loadQueriesSyncLayers(paths) {
  return {
    sys: loadJsonFile(paths.system.queries.syncMeta, {}),
    loc: loadJsonFile(paths.local.queries.syncMeta, {})
  };
}

function loadModelsSyncLayers(paths) {
  return {
    sys: loadJsonFile(paths.system.models.syncMeta, {}),
    loc: loadJsonFile(paths.local.models.syncMeta, {})
  };
}

/** Drop tombstoned prompts unless local has unsynced edits (isSynced === false). */
function filterTombstonedPromptMap(mergedPm, locSm, sysSm) {
  const out = { ...mergedPm };
  for (const p of Object.keys(out)) {
    const loc = locSm[p];
    if (loc && loc.isSynced === false && !loc.isDeleted) continue;
    if ((loc && loc.isDeleted) || (sysSm[p] && sysSm[p].isDeleted)) {
      delete out[p];
    }
  }
  return out;
}

/** Load merged queries prompt-map (system + local; local overwrites); omit soft-deleted unless unsynced local. */
function loadMergedQueriesPromptMap(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.queries.promptMap, {});
  const sys = loadJsonFile(paths.system.queries.promptMap, {});
  const loc = loadJsonFile(paths.local.queries.promptMap, {});
  const merged = mergeObjects(sys, loc);
  const { sys: sysSm, loc: locSm } = loadQueriesSyncLayers(paths);
  return filterTombstonedPromptMap(merged, locSm, sysSm);
}

function loadMergedQueriesMetadata(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.queries.metadata, {});
  return mergeObjects(
    loadJsonFile(paths.system.queries.metadata, {}),
    loadJsonFile(paths.local.queries.metadata, {})
  );
}

function loadMergedQueriesFailedPrompts(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.queries.failedPrompts, []);
  const sys = loadJsonFile(paths.system.queries.failedPrompts, []);
  const loc = loadJsonFile(paths.local.queries.failedPrompts, []);
  return mergeArrays(sys, loc);
}

function loadMergedModelsFailedPrompts(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.models.failedPrompts, []);
  const sys = loadJsonFile(paths.system.models.failedPrompts, []);
  const loc = loadJsonFile(paths.local.models.failedPrompts, []);
  return mergeArrays(sys, loc);
}

function loadMergedQueriesNeedsReview(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.queries.needsReview, []);
  const loc = loadJsonFile(paths.local.queries.needsReview, []);
  const sys = loadJsonFile(paths.system.queries.needsReview, []);
  return loc.length ? loc : sys;
}

function loadMergedModelsPromptMap(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.models.promptMap, {});
  const sys = loadJsonFile(paths.system.models.promptMap, {});
  const loc = loadJsonFile(paths.local.models.promptMap, {});
  const merged = mergeObjects(sys, loc);
  const { sys: sysSm, loc: locSm } = loadModelsSyncLayers(paths);
  return filterTombstonedPromptMap(merged, locSm, sysSm);
}

function loadMergedModelsMetadata(paths, useSync) {
  if (!useSync) return loadJsonFile(paths.models.metadata, {});
  return mergeObjects(
    loadJsonFile(paths.system.models.metadata, {}),
    loadJsonFile(paths.local.models.metadata, {})
  );
}

/** Effective sync meta for compile: prefer local entry, then system. */
function loadMergedQueriesSyncMeta(paths, useSync) {
  if (!useSync) return {};
  const { sys, loc } = loadQueriesSyncLayers(paths);
  const keys = new Set([...Object.keys(sys), ...Object.keys(loc)]);
  const out = {};
  for (const k of keys) {
    out[k] = loc[k] != null ? { ...loc[k] } : sys[k] != null ? { ...sys[k] } : undefined;
    if (out[k] == null) delete out[k];
  }
  return out;
}

function loadMergedModelsSyncMeta(paths, useSync) {
  if (!useSync) return {};
  const { sys, loc } = loadModelsSyncLayers(paths);
  const keys = new Set([...Object.keys(sys), ...Object.keys(loc)]);
  const out = {};
  for (const k of keys) {
    out[k] = loc[k] != null ? { ...loc[k] } : sys[k] != null ? { ...sys[k] } : undefined;
    if (out[k] == null) delete out[k];
  }
  return out;
}

/** Ensure sync directory structure exists. */
function ensureSyncDirs(paths) {
  for (const dir of [
    paths.system.queries.dir,
    paths.system.models.dir,
    paths.local.queries.dir,
    paths.local.models.dir
  ]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function saveQueriesPromptMap(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.queries.promptMap, data);
  else saveJsonFile(paths.queries.promptMap, data);
}

function saveQueriesMetadata(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.queries.metadata, data);
  else saveJsonFile(paths.queries.metadata, data);
}

function saveQueriesSyncMeta(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.queries.syncMeta, data);
}

function saveQueriesFailedPrompts(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.queries.failedPrompts, data);
  else saveJsonFile(paths.queries.failedPrompts, data);
}

function saveModelsFailedPrompts(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.models.failedPrompts, data);
  else saveJsonFile(paths.models.failedPrompts, data);
}

function saveQueriesNeedsReview(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.queries.needsReview, data);
  else saveJsonFile(paths.queries.needsReview, data);
}

function saveModelsPromptMap(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.models.promptMap, data);
  else saveJsonFile(paths.models.promptMap, data);
}

function saveModelsMetadata(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.models.metadata, data);
  else saveJsonFile(paths.models.metadata, data);
}

function saveModelsSyncMeta(paths, data, useSync) {
  if (useSync) saveJsonFile(paths.local.models.syncMeta, data);
}

const CHUNK_THRESHOLD_BYTES = 4 * 1024 * 1024;

/** Split local data into chunks for upload. */
function splitLocalDataIntoChunks(localData, maxBytes) {
  if (!maxBytes) maxBytes = CHUNK_THRESHOLD_BYTES;
  const serialized = JSON.stringify(localData);
  if (serialized.length <= maxBytes) return [localData];

  const qEntries = Object.entries(localData.queries.promptMap || {});
  const mEntries = Object.entries(localData.models.promptMap || {});
  const qMeta = localData.queries.metadata || {};
  const mMeta = localData.models.metadata || {};
  const qSm = localData.queries.syncMeta || {};
  const mSm = localData.models.syncMeta || {};

  const totalEntries = qEntries.length + mEntries.length;
  if (totalEntries === 0) return [localData];

  const avgBytesPerEntry = Math.ceil(serialized.length / totalEntries);
  const entriesPerChunk = Math.max(1, Math.floor(maxBytes * 0.85 / avgBytesPerEntry));

  const chunks = [];
  let qi = 0;
  let mi = 0;

  while (qi < qEntries.length || mi < mEntries.length) {
    const chunk = {
      queries: { promptMap: {}, metadata: {}, syncMeta: {}, failedPrompts: [], needsReview: [] },
      models: { promptMap: {}, metadata: {}, syncMeta: {}, failedPrompts: [] }
    };
    if (chunks.length === 0) {
      chunk.queries.failedPrompts = localData.queries.failedPrompts || [];
      chunk.queries.needsReview = localData.queries.needsReview || [];
      chunk.models.failedPrompts = localData.models.failedPrompts || [];
    }
    let count = 0;
    while (qi < qEntries.length && count < entriesPerChunk) {
      const [prompt, hash] = qEntries[qi++];
      chunk.queries.promptMap[prompt] = hash;
      if (qMeta[hash]) chunk.queries.metadata[hash] = qMeta[hash];
      if (qSm[prompt]) chunk.queries.syncMeta[prompt] = qSm[prompt];
      count++;
    }
    while (mi < mEntries.length && count < entriesPerChunk) {
      const [prompt, hash] = mEntries[mi++];
      chunk.models.promptMap[prompt] = hash;
      if (mMeta[hash]) chunk.models.metadata[hash] = mMeta[hash];
      if (mSm[prompt]) chunk.models.syncMeta[prompt] = mSm[prompt];
      count++;
    }
    chunks.push(chunk);
  }
  return chunks;
}

/** Read all local data (for push). */
function readLocalData(paths) {
  return {
    queries: {
      promptMap: loadJsonFile(paths.local.queries.promptMap, {}),
      metadata: loadJsonFile(paths.local.queries.metadata, {}),
      syncMeta: loadJsonFile(paths.local.queries.syncMeta, {}),
      failedPrompts: loadJsonFile(paths.local.queries.failedPrompts, []),
      needsReview: loadJsonFile(paths.local.queries.needsReview, [])
    },
    models: {
      promptMap: loadJsonFile(paths.local.models.promptMap, {}),
      metadata: loadJsonFile(paths.local.models.metadata, {}),
      syncMeta: loadJsonFile(paths.local.models.syncMeta, {}),
      failedPrompts: paths.local.models.failedPrompts
        ? loadJsonFile(paths.local.models.failedPrompts, [])
        : []
    }
  };
}

function readSystemData(paths) {
  return {
    queries: {
      promptMap: loadJsonFile(paths.system.queries.promptMap, {}),
      metadata: loadJsonFile(paths.system.queries.metadata, {}),
      syncMeta: loadJsonFile(paths.system.queries.syncMeta, {}),
      failedPrompts: loadJsonFile(paths.system.queries.failedPrompts, []),
      needsReview: loadJsonFile(paths.system.queries.needsReview, [])
    },
    models: {
      promptMap: loadJsonFile(paths.system.models.promptMap, {}),
      metadata: loadJsonFile(paths.system.models.metadata, {}),
      syncMeta: loadJsonFile(paths.system.models.syncMeta, {}),
      failedPrompts: paths.system.models.failedPrompts
        ? loadJsonFile(paths.system.models.failedPrompts, [])
        : []
    }
  };
}

/** Write system slice only (used after merge). */
function writeSystemDataSlice(paths, payload) {
  ensureSyncDirs(paths);
  const q = payload.queries || {};
  const m = payload.models || {};
  saveJsonFile(paths.system.queries.promptMap, q.promptMap || {});
  saveJsonFile(paths.system.queries.metadata, q.metadata || {});
  saveJsonFile(paths.system.queries.syncMeta, q.syncMeta || {});
  saveJsonFile(paths.system.queries.failedPrompts, q.failedPrompts || []);
  saveJsonFile(paths.system.queries.needsReview, q.needsReview || []);
  saveJsonFile(paths.system.models.promptMap, m.promptMap || {});
  saveJsonFile(paths.system.models.metadata, m.metadata || {});
  saveJsonFile(paths.system.models.syncMeta, m.syncMeta || {});
  if (paths.system.models.failedPrompts) {
    saveJsonFile(paths.system.models.failedPrompts, m.failedPrompts || []);
  }
}

/**
 * Legacy: overwrite system from remote payload (no merge). Prefer mergeAfterFetch.
 */
function writeSystemData(paths, payload) {
  writeSystemDataSlice(paths, payload);
}

/**
 * Two-way merge after GET /sync/fetch: updates system + patches local for remote-won keys.
 */
function mergeAfterFetch(paths, remotePayload, options) {
  ensureSyncDirs(paths);
  const remote = remotePayload && typeof remotePayload === 'object' ? remotePayload : {};
  const sys = readSystemData(paths);
  const loc = readLocalData(paths);

  const merged = mergeFetchReconcile(remote, sys, loc, options);
  const qPull = merged.queries;
  const mPull = merged.models;

  const nextSys = {
    queries: merged.systemQueriesToWrite,
    models: merged.systemModelsToWrite
  };
  writeSystemDataSlice(paths, nextSys);

  const locQ = applyLocalPatchToSlice(
    {
      promptMap: loc.queries.promptMap,
      metadata: loc.queries.metadata,
      syncMeta: loc.queries.syncMeta
    },
    qPull.localPatch
  );
  const locM = applyLocalPatchToSlice(
    {
      promptMap: loc.models.promptMap,
      metadata: loc.models.metadata,
      syncMeta: loc.models.syncMeta
    },
    mPull.localPatch
  );

  saveJsonFile(paths.local.queries.promptMap, locQ.promptMap);
  saveJsonFile(paths.local.queries.metadata, locQ.metadata);
  saveJsonFile(paths.local.queries.syncMeta, locQ.syncMeta);
  saveJsonFile(paths.local.models.promptMap, locM.promptMap);
  saveJsonFile(paths.local.models.metadata, locM.metadata);
  saveJsonFile(paths.local.models.syncMeta, locM.syncMeta);
}

/** Move accepted prompts to system store (includes syncMeta). */
function moveAcceptedToSystem(paths, accepted) {
  const sysQ = { ...loadJsonFile(paths.system.queries.promptMap, {}) };
  const sysQM = { ...loadJsonFile(paths.system.queries.metadata, {}) };
  const sysQSm = { ...loadJsonFile(paths.system.queries.syncMeta, {}) };
  const locQ = loadJsonFile(paths.local.queries.promptMap, {});
  const locQM = loadJsonFile(paths.local.queries.metadata, {});
  const locQSm = loadJsonFile(paths.local.queries.syncMeta, {});
  for (const p of accepted.queries || []) {
    const h = locQ[p];
    if (h !== undefined) {
      sysQ[p] = h;
      if (locQM[h]) sysQM[h] = locQM[h];
    }
    if (locQSm[p]) sysQSm[p] = { ...locQSm[p] };
  }
  const sysP = { ...loadJsonFile(paths.system.models.promptMap, {}) };
  const sysPM = { ...loadJsonFile(paths.system.models.metadata, {}) };
  const sysPSm = { ...loadJsonFile(paths.system.models.syncMeta, {}) };
  const locP = loadJsonFile(paths.local.models.promptMap, {});
  const locPM = loadJsonFile(paths.local.models.metadata, {});
  const locPSm = loadJsonFile(paths.local.models.syncMeta, {});
  for (const p of accepted.models || []) {
    const h = locP[p];
    if (h !== undefined) {
      sysP[p] = h;
      if (locPM[h]) sysPM[h] = locPM[h];
    }
    if (locPSm[p]) sysPSm[p] = { ...locPSm[p] };
  }
  saveJsonFile(paths.system.queries.promptMap, sysQ);
  saveJsonFile(paths.system.queries.metadata, sysQM);
  saveJsonFile(paths.system.queries.syncMeta, sysQSm);
  saveJsonFile(paths.system.models.promptMap, sysP);
  saveJsonFile(paths.system.models.metadata, sysPM);
  saveJsonFile(paths.system.models.syncMeta, sysPSm);
}

/**
 * After push: mark accepted keys synced in local sync-meta; optional align from server truth in loc files.
 */
function markPushAcceptedLocal(paths, accepted, _serverSnapshot) {
  const loc = readLocalData(paths);
  const qMarked = markLocalSliceSynced(
    { promptMap: loc.queries.promptMap, metadata: loc.queries.metadata, syncMeta: loc.queries.syncMeta },
    accepted.queries || []
  );
  const mMarked = markLocalSliceSynced(
    { promptMap: loc.models.promptMap, metadata: loc.models.metadata, syncMeta: loc.models.syncMeta },
    accepted.models || []
  );
  saveJsonFile(paths.local.queries.syncMeta, qMarked.syncMeta);
  saveJsonFile(paths.local.models.syncMeta, mMarked.syncMeta);
}

module.exports = {
  MASK_DATABASES_DEFAULT_URL,
  CHUNK_THRESHOLD_BYTES,
  getSyncConfig,
  splitLocalDataIntoChunks,
  loadMergedQueriesPromptMap,
  loadMergedQueriesMetadata,
  loadMergedQueriesFailedPrompts,
  loadMergedModelsFailedPrompts,
  loadMergedQueriesNeedsReview,
  loadPromptsRegisteryFromMaskConfig,
  loadMergedModelsPromptMap,
  loadMergedModelsMetadata,
  loadMergedQueriesSyncMeta,
  loadMergedModelsSyncMeta,
  ensureSyncDirs,
  saveQueriesPromptMap,
  saveQueriesMetadata,
  saveQueriesSyncMeta,
  saveQueriesFailedPrompts,
  saveModelsFailedPrompts,
  saveQueriesNeedsReview,
  saveModelsPromptMap,
  saveModelsMetadata,
  saveModelsSyncMeta,
  readLocalData,
  readSystemData,
  writeSystemData,
  writeSystemDataSlice,
  mergeAfterFetch,
  moveAcceptedToSystem,
  markPushAcceptedLocal
};
