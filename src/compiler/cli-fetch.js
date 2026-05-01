#!/usr/bin/env node

'use strict';

/**
 * Fetch compiled data from Mask Databases.
 * Requires syncApiKey (from mask.compile.cjs overrideConfig after compile).
 */

const axios = require('axios');
const { getPaths, getProjectRoot } = require('../paths');
const { getSyncConfig, mergeAfterFetch, ensureSyncDirs } = require('./sync-data');
const { ensureMaskDirs } = require('./fs-utils');

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    forceRemoteUnsynced: args.includes('--override-local-unsynced')
  };
}

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

async function run() {
  const parsed = parseArgs(process.argv);
  const projectRoot = process.cwd();
  const paths = getPaths(projectRoot);
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
  const maxAttempts = 5;
  const maxRetryDelayMs = 10 * 60_000;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await axios.get(`${sync.baseUrl}/sync/fetch`, {
        headers: { 'X-Api-Key': sync.apiKey },
        timeout: 120_000
      });
      const payload = res.data;
      if (!payload || (typeof payload !== 'object')) {
        // eslint-disable-next-line no-console
        console.error('[Mask] Invalid response from sync server.');
        process.exitCode = 1;
        return;
      }
      mergeAfterFetch(paths, payload, { forceRemoteUnsynced: parsed.forceRemoteUnsynced });
      // eslint-disable-next-line no-console
      if (parsed.forceRemoteUnsynced) {
        console.log('[Mask] Fetched data successfully (forced remote overwrite for unsynced local prompts).');
      } else {
        console.log('[Mask] Fetched data from Mask Databases successfully');
      }
      return;
    } catch (err) {
      const status = err.response && err.response.status;
      const isLimit = status === 429 || status === 403;
      if (isLimit && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(err.response.headers, 60_000);
        if (retryAfterMs > maxRetryDelayMs) {
          // eslint-disable-next-line no-console
          console.error(
            `[Mask] Sync fetch blocked by Mask Databases limits. Cooldown is ~${Math.ceil(retryAfterMs / 1000)}s (too long for auto-retry). Please wait for reset / upgrade and try again.`
          );
          process.exitCode = 1;
          return;
        }
        // eslint-disable-next-line no-console
        console.warn(`[Mask] Sync fetch paused due to Mask Databases limits. Retrying in ~${Math.ceil(retryAfterMs / 1000)}s (attempt ${attempt}/${maxAttempts})...`);
        await sleep(retryAfterMs);
        continue;
      }

      const msg = err.response && err.response.data && err.response.data.error
        ? err.response.data.error
        : err.message || 'Fetch failed';
      // eslint-disable-next-line no-console
      console.error('[Mask]', msg);
      process.exitCode = 1;
      return;
    }
  }
}

run();
