#!/usr/bin/env node

'use strict';

/**
 * Push local compiled data to Mask Databases.
 * Requires syncApiKey (from mask.compile.cjs overrideConfig after compile).
 */

const axios = require('axios');
const { getPaths, getProjectRoot } = require('../paths');
const {
  getSyncConfig,
  readLocalData,
  moveAcceptedToSystem,
  markPushAcceptedLocal,
  ensureSyncDirs,
  splitLocalDataIntoChunks,
  CHUNK_THRESHOLD_BYTES
} = require('./sync-data');
const { ensureMaskDirs } = require('./fs-utils');

function parseRetryAfterMs(headers, fallbackMs) {
  const h = headers || {};
  const retryAfterRaw = h['retry-after'] || h['Retry-After'];
  if (retryAfterRaw != null) {
    const n = Number.parseFloat(String(retryAfterRaw));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }
  return fallbackMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateBatchId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

async function pushSinglePayload(sync, payload, extraHeaders) {
  const maxAttempts = 5;
  const maxRetryDelayMs = 10 * 60_000;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await axios.post(
        `${sync.baseUrl}/sync/push`,
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': sync.apiKey,
            ...extraHeaders
          },
          timeout: 60_000
        }
      );
      return res.data;
    } catch (err) {
      const status = err.response && err.response.status;
      const isLimit = status === 429 || status === 403;
      if (isLimit && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(err.response.headers, 60_000);
        if (retryAfterMs > maxRetryDelayMs) {
          throw new Error(
            `Sync push blocked by Mask Databases limits. Cooldown is ~${Math.ceil(retryAfterMs / 1000)}s (too long for auto-retry). Please wait for reset / upgrade and try again.`
          );
        }
        // eslint-disable-next-line no-console
        console.warn(`[Mask] Sync push paused due to Mask Databases limits. Retrying in ~${Math.ceil(retryAfterMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
        await sleep(retryAfterMs);
        continue;
      }
      const msg = err.response && err.response.data && err.response.data.error
        ? err.response.data.error
        : err.message || 'Push failed';
      throw new Error(msg);
    }
  }
}

async function run() {
  const paths = getPaths(getProjectRoot());
  ensureMaskDirs(paths);
  const sync = getSyncConfig(paths);
  if (!sync) {
    // eslint-disable-next-line no-console
    console.error(
      '[Mask] Sync not configured. Run `node mask.compile.cjs` so syncApiKey is written to compile output, or set MASK_SYNC_API_KEY when compiling.'
    );
    process.exitCode = 1;
    return;
  }
  ensureSyncDirs(paths);
  const localData = readLocalData(paths);
  const hasQueries = Object.keys(localData.queries.promptMap || {}).length > 0;
  const hasModels = Object.keys(localData.models.promptMap || {}).length > 0;
  if (!hasQueries && !hasModels) {
    // eslint-disable-next-line no-console
    console.log('[Mask] No local data to push. Run the compiler to generate prompts/models, then push.');
    return;
  }

  try {
    const chunks = splitLocalDataIntoChunks(localData, CHUNK_THRESHOLD_BYTES);

    if (chunks.length === 1) {
      const result = await pushSinglePayload(sync, chunks[0], {});
      const { accepted, skipped } = result || {};
      const aq = (accepted && accepted.queries) || [];
      const am = (accepted && accepted.models) || [];
      if (aq.length || am.length) {
        moveAcceptedToSystem(paths, accepted);
        markPushAcceptedLocal(paths, accepted);
        // eslint-disable-next-line no-console
        console.log(`[Mask] Accepted and moved to system: ${aq.length} query prompt(s), ${am.length} model(s).`);
      } else {
        // eslint-disable-next-line no-console
        console.log('[Mask] Push completed. No new prompts to store.');
      }
      return;
    }

    const batchId = generateBatchId();
    const totalAccepted = { queries: [], models: [] };
    const totalSkipped = { queries: [], models: [] };
    // eslint-disable-next-line no-console
    console.log(`[Mask] Data exceeds single-request threshold. Pushing in ${chunks.length} chunk(s)...`);

    for (let i = 0; i < chunks.length; i++) {
      const headers = {
        'X-Push-Batch-Id': batchId,
        'X-Push-Batch-Index': String(i),
        'X-Push-Batch-Total': String(chunks.length)
      };
      // eslint-disable-next-line no-console
      console.log(`[Mask] Sending chunk ${i + 1}/${chunks.length}...`);
      const result = await pushSinglePayload(sync, chunks[i], headers);
      const { accepted, skipped } = result || {};
      totalAccepted.queries.push(...((accepted && accepted.queries) || []));
      totalAccepted.models.push(...((accepted && accepted.models) || []));
      totalSkipped.queries.push(...((skipped && skipped.queries) || []));
      totalSkipped.models.push(...((skipped && skipped.models) || []));
    }

    if (totalAccepted.queries.length || totalAccepted.models.length) {
      moveAcceptedToSystem(paths, totalAccepted);
      markPushAcceptedLocal(paths, totalAccepted);
      // eslint-disable-next-line no-console
      console.log(`[Mask] Accepted and moved to system: ${totalAccepted.queries.length} query prompt(s), ${totalAccepted.models.length} model(s).`);
    } else {
      // eslint-disable-next-line no-console
      console.log('[Mask] Push completed. No new prompts to store.');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[Mask]', err.message || err);
    process.exitCode = 1;
  }
}

run();
