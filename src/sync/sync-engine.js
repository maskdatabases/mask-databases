'use strict';

/**
 * Generic LWW + tombstone sync for prompt-keyed slices (queries / models).
 * Used by Mask CLI fetch/push and Mask Databases ProjectData merge.
 */

/** @typedef {{ version?: number, lastModified?: number, isDeleted?: boolean, isSynced?: boolean, syncedAt?: number }} SyncMetaEntry */

function num(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

/**
 * Compare sync metadata: positive if a is newer than b, negative if older, 0 if tie.
 * @param {SyncMetaEntry|null|undefined} a
 * @param {SyncMetaEntry|null|undefined} b
 */
function compareRecord(a, b) {
  const va = num(a && a.version, 0);
  const vb = num(b && b.version, 0);
  if (va !== vb) return va - vb;
  const ta = num(a && a.lastModified, 0);
  const tb = num(b && b.lastModified, 0);
  if (ta !== tb) return ta - tb;
  return 0;
}

/** @returns {'local'|'remote'} — remote wins on tie (pull). */
function resolvePullWinner(localMeta, remoteMeta) {
  const cmp = compareRecord(localMeta, remoteMeta);
  if (cmp > 0) return 'local';
  return 'remote';
}

/** @returns {'existing'|'incoming'} — incoming wins on tie (push). */
function resolvePushWinner(existingMeta, incomingMeta) {
  const cmp = compareRecord(existingMeta, incomingMeta);
  if (cmp > 0) return 'existing';
  return 'incoming';
}

/**
 * @param {'system'|'local'} layer
 * @param {string} promptKey
 * @param {Record<string, string>} sysPm
 * @param {Record<string, string>} locPm
 */
function defaultSyncMetaForKey(layer, promptKey, sysPm, locPm) {
  const inSys = sysPm && Object.prototype.hasOwnProperty.call(sysPm, promptKey);
  const inLoc = locPm && Object.prototype.hasOwnProperty.call(locPm, promptKey);
  if (layer === 'system') {
    return { version: 1, lastModified: 0, isDeleted: false, isSynced: true };
  }
  if (inLoc && inSys && sysPm[promptKey] === locPm[promptKey]) {
    return { version: 1, lastModified: 0, isDeleted: false, isSynced: true };
  }
  if (inLoc) {
    return { version: 1, lastModified: 0, isDeleted: false, isSynced: false };
  }
  return { version: 1, lastModified: 0, isDeleted: false, isSynced: true };
}

/**
 * Fill missing syncMeta entries; coerce types.
 * @param {{ promptMap?: Record<string,string>, metadata?: Record<string,unknown>, syncMeta?: Record<string,SyncMetaEntry> }} slice
 * @param {'system'|'local'} layer
 * @param {Record<string,string>} [refSysPm]
 * @param {Record<string,string>} [refLocPm]
 */
function normalizeSlice(slice, layer, refSysPm, refLocPm) {
  const promptMap = { ...(slice && slice.promptMap) || {} };
  const metadata = { ...(slice && slice.metadata) || {} };
  const syncMeta = { ...(slice && slice.syncMeta) || {} };
  const sysPm = refSysPm || (layer === 'system' ? promptMap : {});
  const locPm = refLocPm || (layer === 'local' ? promptMap : {});

  const keys = new Set([
    ...Object.keys(promptMap),
    ...Object.keys(syncMeta)
  ]);
  for (const k of keys) {
    const cur = syncMeta[k];
    if (!cur || typeof cur !== 'object') {
      syncMeta[k] = defaultSyncMetaForKey(layer, k, sysPm, locPm);
      continue;
    }
    syncMeta[k] = {
      version: num(cur.version, 1),
      lastModified: num(cur.lastModified, 0),
      isDeleted: !!cur.isDeleted,
      isSynced: cur.isSynced !== false,
      syncedAt: cur.syncedAt != null ? num(cur.syncedAt, 0) : undefined
    };
  }
  return { promptMap, metadata, syncMeta };
}

function copyPromptAndMeta(targetPm, targetMeta, sourcePm, sourceMeta, promptKey) {
  const h = sourcePm[promptKey];
  if (h === undefined) {
    delete targetPm[promptKey];
    return;
  }
  targetPm[promptKey] = h;
  if (sourceMeta && sourceMeta[h] !== undefined) targetMeta[h] = sourceMeta[h];
}

function removePromptAndMeta(pm, meta, promptKey) {
  const h = pm[promptKey];
  delete pm[promptKey];
  if (h != null) delete meta[h];
}

/**
 * Merge one slice after fetch: remote vs local disk, with system as reference for backfill.
 * @param {{ remote: object, system: object, local: object }} args
 * @returns {{ system: { promptMap, metadata, syncMeta }, localPatch: { promptMap, metadata, syncMeta } }}
 */
function mergePullSlice({ remote, system, local }, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const forceRemoteUnsynced = opts.forceRemoteUnsynced === true;
  const sysPm0 = (system && system.promptMap) || {};
  const locPm0 = (local && local.promptMap) || {};
  const r = normalizeSlice(remote || {}, 'system', sysPm0, locPm0);
  const s = normalizeSlice(system || {}, 'system', sysPm0, locPm0);
  const l = normalizeSlice(local || {}, 'local', sysPm0, locPm0);

  const allKeys = new Set([
    ...Object.keys(r.promptMap),
    ...Object.keys(r.syncMeta),
    ...Object.keys(s.promptMap),
    ...Object.keys(s.syncMeta),
    ...Object.keys(l.promptMap),
    ...Object.keys(l.syncMeta)
  ]);

  const outSystem = { promptMap: {}, metadata: {}, syncMeta: {} };
  const outLocalPatch = { promptMap: {}, metadata: {}, syncMeta: {} };
  const patchKeys = new Set();

  for (const P of allKeys) {
    const rM = r.syncMeta[P];
    const lM = l.syncMeta[P];
    const remDeleted = rM && rM.isDeleted;
    const localUnsynced = !forceRemoteUnsynced && lM && lM.isSynced === false;

    if (remDeleted) {
      outSystem.syncMeta[P] = { ...rM };
      delete outSystem.promptMap[P];
      const rh = r.promptMap[P];
      if (rh != null) delete outSystem.metadata[rh];

      if (localUnsynced) {
        continue;
      }
      patchKeys.add(P);
      outLocalPatch.syncMeta[P] = { ...rM };
      outLocalPatch.promptMap[P] = undefined;
      continue;
    }

    const winner = (() => {
      if (localUnsynced && l.promptMap[P] !== undefined) return 'local';
      return resolvePullWinner(lM, rM);
    })();

    if (winner === 'remote') {
      copyPromptAndMeta(outSystem.promptMap, outSystem.metadata, r.promptMap, r.metadata, P);
      outSystem.syncMeta[P] = rM ? { ...rM } : defaultSyncMetaForKey('system', P, r.promptMap, l.promptMap);

      patchKeys.add(P);
      copyPromptAndMeta(outLocalPatch.promptMap, outLocalPatch.metadata, r.promptMap, r.metadata, P);
      outLocalPatch.syncMeta[P] = rM ? { ...rM } : defaultSyncMetaForKey('local', P, r.promptMap, l.promptMap);
    } else {
      const remoteKnows = rM != null || r.promptMap[P] !== undefined;
      if (remoteKnows) {
        copyPromptAndMeta(outSystem.promptMap, outSystem.metadata, r.promptMap, r.metadata, P);
        outSystem.syncMeta[P] = rM ? { ...rM } : defaultSyncMetaForKey('system', P, r.promptMap, l.promptMap);
      } else {
        delete outSystem.promptMap[P];
        delete outSystem.syncMeta[P];
        const sh = s.promptMap[P];
        if (sh != null) delete outSystem.metadata[sh];
      }
    }
  }

  return { system: outSystem, localPatch: outLocalPatch, patchKeys };
}

/**
 * Server / push merge: existing document slice vs incoming slice.
 * @returns {{ merged: { promptMap, metadata, syncMeta }, accepted: string[], skipped: string[] }}
 */
function mergePushSlice(existing, incoming) {
  const exPm = (existing && existing.promptMap) || {};
  const inPm = (incoming && incoming.promptMap) || {};
  const ex0 = normalizeSlice(existing || {}, 'system', exPm, inPm);
  const inc = normalizeSlice(incoming || {}, 'local', exPm, inPm);

  const merged = { promptMap: { ...ex0.promptMap }, metadata: { ...ex0.metadata }, syncMeta: { ...ex0.syncMeta } };
  const accepted = [];
  const skipped = [];

  const keys = new Set([
    ...Object.keys(inc.promptMap),
    ...Object.keys(inc.syncMeta),
    ...Object.keys(ex0.promptMap),
    ...Object.keys(ex0.syncMeta)
  ]);

  for (const P of keys) {
    const inMeta = inc.syncMeta[P];
    const exMeta = ex0.syncMeta[P];
    const hasIncoming = inc.promptMap[P] !== undefined && !(inMeta && inMeta.isDeleted);
    const incDeleted = inMeta && inMeta.isDeleted;

    if (incDeleted) {
      if (
        exMeta &&
        exMeta.isDeleted &&
        compareRecord(exMeta, inMeta) === 0
      ) {
        skipped.push(P);
        continue;
      }
      const winner = resolvePushWinner(exMeta, inMeta);
      if (winner === 'existing') {
        skipped.push(P);
        continue;
      }
      merged.syncMeta[P] = { ...inMeta };
      removePromptAndMeta(merged.promptMap, merged.metadata, P);
      accepted.push(P);
      continue;
    }

    if (!hasIncoming) {
      continue;
    }

    // Remote tombstone must not block re-pushing the same prompt after a dashboard delete + local recompile.
    if (exMeta && exMeta.isDeleted) {
      copyPromptAndMeta(merged.promptMap, merged.metadata, inc.promptMap, inc.metadata, P);
      merged.syncMeta[P] = inMeta
        ? { ...inMeta, isDeleted: false }
        : defaultSyncMetaForKey('local', P, merged.promptMap, inc.promptMap);
      accepted.push(P);
      continue;
    }

    const winner = resolvePushWinner(exMeta, inMeta);
    if (winner === 'existing') {
      skipped.push(P);
      continue;
    }

    const eh = ex0.promptMap[P];
    const ih = inc.promptMap[P];
    if (
      compareRecord(exMeta, inMeta) === 0 &&
      eh === ih &&
      JSON.stringify(ex0.metadata[eh] || null) === JSON.stringify(inc.metadata[ih] || null)
    ) {
      skipped.push(P);
      continue;
    }

    copyPromptAndMeta(merged.promptMap, merged.metadata, inc.promptMap, inc.metadata, P);
    merged.syncMeta[P] = inMeta ? { ...inMeta } : defaultSyncMetaForKey('local', P, merged.promptMap, inc.promptMap);
    accepted.push(P);
  }

  // Garbage-collect metadata entries whose hash is no longer referenced by any live prompt key.
  // This prevents orphaned entries from accumulating when a prompt's content (hash) changes on update.
  const referencedHashes = new Set(Object.values(merged.promptMap));
  for (const h of Object.keys(merged.metadata)) {
    if (!referencedHashes.has(h)) delete merged.metadata[h];
  }

  return { merged, accepted, skipped };
}

function applyLocalPatchToSlice(localSlice, patch) {
  const pm = { ...(localSlice.promptMap || {}) };
  const meta = { ...(localSlice.metadata || {}) };
  const syncMeta = { ...(localSlice.syncMeta || {}) };

  for (const [k, v] of Object.entries(patch.syncMeta || {})) {
    if (v && v.isDeleted) {
      removePromptAndMeta(pm, meta, k);
      syncMeta[k] = { ...v };
      continue;
    }
  }

  for (const P of Object.keys(patch.promptMap || {})) {
    const h = patch.promptMap[P];
    if (h === undefined) {
      removePromptAndMeta(pm, meta, P);
      if (patch.syncMeta[P]) syncMeta[P] = { ...patch.syncMeta[P] };
      continue;
    }
    copyPromptAndMeta(pm, meta, patch.promptMap, patch.metadata, P);
    if (patch.syncMeta[P]) syncMeta[P] = { ...patch.syncMeta[P] };
  }

  for (const [k, v] of Object.entries(patch.syncMeta || {})) {
    if (v && !v.isDeleted && patch.promptMap[k] === undefined && pm[k] !== undefined) {
      syncMeta[k] = { ...v };
    }
  }

  return { promptMap: pm, metadata: meta, syncMeta };
}

function emptyBranchSlice() {
  return { promptMap: {}, metadata: {}, syncMeta: {} };
}

/**
 * Normalize API/disk snapshots for mergeFetchReconcile (queries + models branches).
 * @param {object} [branch]
 */
function normalizeBranch(branch) {
  if (!branch || typeof branch !== 'object') {
    return {
      queries: { ...emptyBranchSlice(), failedPrompts: [], needsReview: [] },
      models: { ...emptyBranchSlice(), failedPrompts: [] }
    };
  }
  const q = branch.queries || {};
  const m = branch.models || {};
  return {
    queries: {
      promptMap: q.promptMap && typeof q.promptMap === 'object' ? q.promptMap : {},
      metadata: q.metadata && typeof q.metadata === 'object' ? q.metadata : {},
      syncMeta: q.syncMeta && typeof q.syncMeta === 'object' ? q.syncMeta : {},
      failedPrompts: Array.isArray(q.failedPrompts) ? q.failedPrompts : [],
      needsReview: Array.isArray(q.needsReview) ? q.needsReview : []
    },
    models: {
      promptMap: m.promptMap && typeof m.promptMap === 'object' ? m.promptMap : {},
      metadata: m.metadata && typeof m.metadata === 'object' ? m.metadata : {},
      syncMeta: m.syncMeta && typeof m.syncMeta === 'object' ? m.syncMeta : {},
      failedPrompts: Array.isArray(m.failedPrompts) ? m.failedPrompts : []
    }
  };
}

/**
 * Pure three-way merge for fetch/reconcile (queries + models). Same logic as mergeAfterFetch in sync-data (without FS).
 * @param {object} remotePayload - GET /sync/fetch body
 * @param {object} systemBranch - .mask/system snapshot
 * @param {object} localBranch - .mask/local snapshot
 */
function mergeFetchReconcile(remotePayload, systemBranch, localBranch, options) {
  const remote = remotePayload && typeof remotePayload === 'object' ? remotePayload : {};
  const sys = normalizeBranch(systemBranch);
  const loc = normalizeBranch(localBranch);

  const rq = remote.queries || {};
  const rm = remote.models || {};

  const qPull = mergePullSlice({
    remote: {
      promptMap: rq.promptMap || {},
      metadata: rq.metadata || {},
      syncMeta: rq.syncMeta || {}
    },
    system: {
      promptMap: sys.queries.promptMap,
      metadata: sys.queries.metadata,
      syncMeta: sys.queries.syncMeta
    },
    local: {
      promptMap: loc.queries.promptMap,
      metadata: loc.queries.metadata,
      syncMeta: loc.queries.syncMeta
    }
  }, options);

  const mPull = mergePullSlice({
    remote: {
      promptMap: rm.promptMap || {},
      metadata: rm.metadata || {},
      syncMeta: rm.syncMeta || {}
    },
    system: {
      promptMap: sys.models.promptMap,
      metadata: sys.models.metadata,
      syncMeta: sys.models.syncMeta
    },
    local: {
      promptMap: loc.models.promptMap,
      metadata: loc.models.metadata,
      syncMeta: loc.models.syncMeta
    }
  }, options);

  const sysQ = sys.queries;
  const failedPrompts = rq.failedPrompts || sysQ.failedPrompts || [];
  const needsReview = rq.needsReview || sysQ.needsReview || [];

  const sysM = sys.models;
  const failedModelPrompts = rm.failedPrompts || sysM.failedPrompts || [];

  return {
    queries: qPull,
    models: mPull,
    systemQueriesToWrite: {
      promptMap: qPull.system.promptMap,
      metadata: qPull.system.metadata,
      syncMeta: qPull.system.syncMeta,
      failedPrompts,
      needsReview
    },
    systemModelsToWrite: {
      promptMap: mPull.system.promptMap,
      metadata: mPull.system.metadata,
      syncMeta: mPull.system.syncMeta,
      failedPrompts: failedModelPrompts
    }
  };
}

/**
 * Mark prompts as synced after successful push (local files).
 * @param {object} localSlice
 * @param {string[]} acceptedKeys
 * @param {number} [now]
 */
function markLocalSliceSynced(localSlice, acceptedKeys, now) {
  const t = now != null ? now : Date.now();
  const pm = { ...(localSlice.promptMap || {}) };
  const meta = { ...(localSlice.metadata || {}) };
  const syncMeta = { ...(localSlice.syncMeta || {}) };
  for (const P of acceptedKeys || []) {
    if (!Object.prototype.hasOwnProperty.call(pm, P)) continue;
    const cur = syncMeta[P] || {};
    syncMeta[P] = {
      ...cur,
      isSynced: true,
      syncedAt: t
    };
  }
  return { promptMap: pm, metadata: meta, syncMeta };
}

module.exports = {
  compareRecord,
  resolveConflicts: resolvePullWinner,
  resolvePullWinner,
  resolvePushWinner,
  normalizeSlice,
  mergePullSlice,
  mergePushSlice,
  applyLocalPatchToSlice,
  markLocalSliceSynced,
  defaultSyncMetaForKey,
  normalizeBranch,
  mergeFetchReconcile
};
