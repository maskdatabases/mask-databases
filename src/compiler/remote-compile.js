'use strict';

const axios = require('axios');
const {
  CompilationFailedError,
  NonsensicalPromptError,
  MaskDatabasesRateLimitedError,
  MaskDatabasesPlanLimitError
} = require('./errors');
const { assertPromptSize } = require('./prompt-size');

/** Drop internal backend-only headers so errors and return values never expose provider names to CLI users. */
function stripInternalMaskBackendHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  let plain;
  try {
    plain = typeof headers.toJSON === 'function' ? headers.toJSON() : { ...headers };
  } catch (_) {
    return headers;
  }
  const out = { ...plain };
  for (const k of Object.keys(out)) {
    if (String(k).toLowerCase() === 'x-mask-compile-provider') {
      delete out[k];
    }
  }
  return out;
}

function parseRetryAfterMs(headers, fallbackMs) {
  const h = headers || {};

  // HTTP standard: Retry-After (seconds)
  const retryAfterRaw = h['retry-after'] || h['Retry-After'];
  if (retryAfterRaw != null) {
    const n = Number.parseFloat(String(retryAfterRaw));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  }

  // RateLimit-Reset (often unix timestamp)
  const resetRaw = h['ratelimit-reset'] || h['RateLimit-Reset'];
  if (resetRaw != null) {
    const n = Number.parseFloat(String(resetRaw));
    if (Number.isFinite(n) && n > 0) {
      // Heuristic: seconds since epoch vs ms since epoch
      const resetMs = n > 1e12 ? n : n * 1000;
      const ms = resetMs - Date.now();
      if (ms > 0) return Math.round(ms);
    }
  }

  return fallbackMs;
}

function getMaskDatabasesErrorMessage(err) {
  const data = err && err.response && err.response.data;
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
    if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  }
  return (err && err.message) || 'Mask Databases request failed.';
}

/**
 * When more than this many models are in scope, the Mask client splits compile calls:
 * query → `POST /compile/query/relevant-models` then trimmed `POST /compile/query`;
 * model → `POST /compile/model/relevant-existing` then trimmed `POST /compile/model`.
 * Keep in sync with SCHEMA_FILTER_MODEL_THRESHOLD in mask-databases `maskCompilerApi.js`.
 */
const COMPILE_RELEVANT_CATALOG_THRESHOLD = 5;
const COMPILE_QUERY_TIMEOUT_MS = 100_000;
const COMPILE_MODEL_TIMEOUT_MS = 100_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mask Databases compile traffic uses `POST /compile/jobs` + poll `GET /compile/jobs/:jobId`
 * (short HTTP requests on the server). The compiler still awaits the full result before returning.
 */
function pathToCompileJobKind(path) {
  if (path === '/compile/query/relevant-models') return 'query-relevant-models';
  if (path === '/compile/query') return 'query';
  if (path === '/compile/model/relevant-existing') return 'model-relevant-existing';
  if (path === '/compile/model') return 'model';
  if (path === '/compile/ddl') return 'ddl';
  return null;
}

async function pollCompileJobUntilComplete(syncConfig, baseUrl, jobId, deadlineMs, compilePath) {
  const deadline = Date.now() + deadlineMs;
  const pollEvery = 1000;
  const headers = { 'X-Api-Key': syncConfig.apiKey };

  while (Date.now() < deadline) {
    const res = await axios.get(`${baseUrl}/compile/jobs/${encodeURIComponent(jobId)}`, {
      headers,
      timeout: 30_000,
      validateStatus: () => true
    });

    if (res.status !== 200) {
      const err = new Error(getMaskDatabasesErrorMessage({ response: res }));
      err.response = { status: res.status, data: res.data, headers: stripInternalMaskBackendHeaders(res.headers) };
      throwIfCompileQueryTransportError(err, { path: compilePath });
      throw err;
    }

    const d = res.data;
    if (!d || typeof d !== 'object') {
      throw new Error('[Mask] Invalid compile job poll response.');
    }

    if (d.jobStatus === 'failed') {
      const sc = d.statusCode != null ? d.statusCode : 500;
      const mergedHeaders = stripInternalMaskBackendHeaders({
        ...stripInternalMaskBackendHeaders(res.headers),
        ...(d.headers && typeof d.headers === 'object' ? d.headers : {})
      });
      const synthetic = { response: { status: sc, data: d.data || {}, headers: mergedHeaders } };
      const err = new Error(getMaskDatabasesErrorMessage(synthetic));
      err.response = synthetic.response;
      throwIfCompileQueryTransportError(err, { path: compilePath });
      throw err;
    }

    if (d.jobStatus === 'completed') {
      const sc = d.statusCode != null ? d.statusCode : 200;
      const syncHeaders = d.headers && typeof d.headers === 'object' ? d.headers : {};
      if (sc >= 400) {
        const mergedHeaders = stripInternalMaskBackendHeaders({
          ...stripInternalMaskBackendHeaders(res.headers),
          ...syncHeaders
        });
        const synthetic = { response: { status: sc, data: d.data, headers: mergedHeaders } };
        const err = new Error(getMaskDatabasesErrorMessage(synthetic));
        err.response = synthetic.response;
        throwIfCompileQueryTransportError(err, { path: compilePath });
        throw err;
      }
      return {
        data: d.data,
        headers: stripInternalMaskBackendHeaders({ ...stripInternalMaskBackendHeaders(res.headers), ...syncHeaders })
      };
    }

    await sleep(pollEvery);
  }

  throw new Error('[Mask] Compile job polling timed out.');
}

async function postCompileJobThenPoll(syncConfig, baseUrl, kind, body, timeoutMs, compilePath) {
  const started = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': syncConfig.apiKey
  };
  const postTimeout = Math.min(30_000, Math.max(5_000, timeoutMs));
  const createRes = await axios.post(`${baseUrl}/compile/jobs`, { kind, ...body }, {
    headers,
    timeout: postTimeout,
    validateStatus: () => true
  });

  if (createRes.status !== 202) {
    const err = new Error(getMaskDatabasesErrorMessage({ response: createRes }));
    err.response = {
      status: createRes.status,
      data: createRes.data,
      headers: stripInternalMaskBackendHeaders(createRes.headers)
    };
    throwIfCompileQueryTransportError(err, { path: compilePath });
    throw err;
  }

  const jobId = createRes.data && createRes.data.jobId;
  if (!jobId) {
    throw new Error('[Mask] Async compile did not return a jobId.');
  }

  const elapsed = Date.now() - started;
  const remaining = Math.max(5_000, timeoutMs - elapsed);
  return pollCompileJobUntilComplete(syncConfig, baseUrl, String(jobId), remaining, compilePath);
}

function throwIfCompileQueryTransportError(err, opts = {}) {
  const path = opts && opts.path;
  const responseCode =
    err.response && err.response.data && typeof err.response.data.code === 'string'
      ? String(err.response.data.code).trim()
      : '';
  const responseMessage = getMaskDatabasesErrorMessage(err);
  if (err.response && (err.response.status === 429 || err.response.status === 403)) {
    const status = err.response.status;
    const message = getMaskDatabasesErrorMessage(err);
    const retryAfterMs = parseRetryAfterMs(
      err.response.headers,
      status === 429 ? 60_000 : 10 * 60_000
    );
    if (status === 429) {
      throw new MaskDatabasesRateLimitedError(message, retryAfterMs);
    }
    throw new MaskDatabasesPlanLimitError(message, retryAfterMs);
  }
  const centralErr =
    err.response && err.response.data && typeof err.response.data.error === 'string'
      ? err.response.data.error
      : '';
  if (err.response && err.response.status === 401 && responseCode === 'SUBSCRIPTION_REQUIRED') {
    throw new Error(`[Mask] ${responseMessage}`);
  }
  if (
    (err.response && (err.response.status === 401 || err.response.status === 404)) ||
    centralErr === 'Invalid API key or project not found.'
  ) {
    throw new Error(
      '[Mask] Invalid sync API key or project not found. Check syncApiKey (mask.compile.cjs / MASK_SYNC_API_KEY) and your Mask Databases project.'
    );
  }
  if (err.response && err.response.status === 503) {
    if (path === '/compile/ddl') {
      throw new Error('[Mask] [0107] Something went wrong!');
    }
    throw new Error('[Mask] [0101] Something went wrong!');
  }
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    throw new Error('[Mask] [0102] Cannot reach Mask Databases.');
  }
  throw err;
}

async function axiosPostCompileJson(syncConfig, baseUrl, path, body, timeoutMs) {
  try {
    const kind = pathToCompileJobKind(path);
    if (kind) {
      const { data, headers } = await postCompileJobThenPoll(syncConfig, baseUrl, kind, body, timeoutMs, path);
      return { data, headers };
    }
    return await axios.post(`${baseUrl}${path}`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': syncConfig.apiKey
      },
      timeout: timeoutMs
    });
  } catch (err) {
    throwIfCompileQueryTransportError(err, { path });
  }
}

function interpretCompileQueryResponse(data, promptText) {
  if (data.spec) return data.spec;
  if (data.type === 'needs_review') {
    throw new NonsensicalPromptError(data.warning || 'Prompt is unclear or nonsensical.', promptText);
  }
  if (data.type === 'failed') {
    throw new CompilationFailedError(data.message || 'Compilation failed after retries.', promptText);
  }
  throw new Error('[Mask] [0103] Something went wrong!');
}

/**
 * Compile a query prompt via Mask Databases.
 * @param {{ baseUrl: string, apiKey: string }} syncConfig
 * @param {string} database
 * @param {string} promptText
 * @param {Record<string, object>} modelMeta
 * @param {Set<string>} schemaHashes
 * @param {{ database: string }} profile
 * @returns {Promise<object>}
 */
async function callCentralCompileQuery(syncConfig, database, promptText, modelMeta, schemaHashes, profile) {
  const baseUrl = (syncConfig && syncConfig.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl || !syncConfig.apiKey) {
    throw new Error(
      '[Mask] Compilation runs on Mask Databases. Set syncApiKey in mask.compile.cjs (overrideConfig) or MASK_SYNC_API_KEY when compiling (`node mask.compile.cjs`).'
    );
  }

  const currentModelHashes = schemaHashes instanceof Set ? [...schemaHashes] : (Array.isArray(schemaHashes) ? schemaHashes : []);
  assertPromptSize(promptText, 'query-prompt');

  const resolvedDb = database || (profile && profile.database) || 'mongodb';
  const meta = modelMeta && typeof modelMeta === 'object' ? modelMeta : {};

  let queryBody = {
    promptText,
    modelMeta: meta,
    currentModelHashes,
    database: resolvedDb
  };

  if (
    currentModelHashes.length > COMPILE_RELEVANT_CATALOG_THRESHOLD &&
    Object.keys(meta).length > 0
  ) {
    const names = [];
    for (const h of currentModelHashes) {
      const spec = meta[h];
      if (spec && typeof spec.collection === 'string' && spec.collection.trim()) {
        names.push(spec.collection.trim());
      }
    }
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length > COMPILE_RELEVANT_CATALOG_THRESHOLD) {
      const relRes = await axiosPostCompileJson(
        syncConfig,
        baseUrl,
        '/compile/query/relevant-models',
        {
          promptText,
          modelNames: uniqueNames,
          database: resolvedDb
        },
        COMPILE_QUERY_TIMEOUT_MS
      );
      const relevantModelNames = Array.isArray(relRes.data.relevantModelNames)
        ? relRes.data.relevantModelNames
        : [];
      const nameSet = new Set(relevantModelNames.map((n) => String(n).trim()).filter(Boolean));

      const filteredHashes = currentModelHashes.filter((h) => {
        const spec = meta[h];
        return spec && spec.collection && nameSet.has(String(spec.collection).trim());
      });
      const effectiveHashes = filteredHashes.length > 0 ? filteredHashes : currentModelHashes;

      const filteredMeta = {};
      for (const h of effectiveHashes) {
        if (meta[h]) filteredMeta[h] = meta[h];
      }

      queryBody = {
        promptText,
        modelMeta: filteredMeta,
        currentModelHashes: effectiveHashes,
        database: resolvedDb,
        skipRelevantModelsAi: true
      };
    }
  }

  const response = await axiosPostCompileJson(
    syncConfig,
    baseUrl,
    '/compile/query',
    queryBody,
    COMPILE_QUERY_TIMEOUT_MS
  );
  return interpretCompileQueryResponse(response.data, promptText);
}

function interpretCompileModelResponse(data, promptText) {
  if (data.type === 'needs_review') {
    throw new NonsensicalPromptError(data.warning || 'Prompt is unclear or nonsensical.', promptText);
  }
  if (data.type === 'failed') {
    throw new CompilationFailedError(data.message || 'Model compilation failed.', promptText);
  }
  if (data && typeof data.collection === 'string' && data.fields && typeof data.fields === 'object') {
    const out = {
      collection: data.collection,
      ...(typeof data.modelName === 'string' && data.modelName.trim() ? { modelName: data.modelName.trim() } : {}),
      fields: data.fields,
      relations: Array.isArray(data.relations) ? data.relations : []
    };
    if (data.schemaOptions != null && typeof data.schemaOptions === 'object' && !Array.isArray(data.schemaOptions)) {
      out.schemaOptions = data.schemaOptions;
    }
    return out;
  }
  throw new Error('[Mask] Unexpected response from Mask Databases compile/model.');
}

/**
 * Compile a model prompt via Mask Databases.
 * @param {{ baseUrl: string, apiKey: string }} syncConfig
 * @param {string} promptText
 * @param {string} [database]
 * @param {Record<string, object>} [existingModelMeta]
 * @returns {Promise<{ collection: string, fields: object, relations: array, modelName?: string }>}
 */
async function callCentralCompileModel(syncConfig, promptText, database, existingModelMeta) {
  const baseUrl = (syncConfig && syncConfig.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl || !syncConfig.apiKey) {
    throw new Error(
      '[Mask] Compilation runs on Mask Databases. Set syncApiKey in mask.compile.cjs (overrideConfig) or MASK_SYNC_API_KEY when compiling (`node mask.compile.cjs`).'
    );
  }

  assertPromptSize(promptText, 'model-prompt');

  const resolvedDb = database || 'mongodb';
  const body = { promptText, database: resolvedDb };

  const meta = existingModelMeta && typeof existingModelMeta === 'object' ? existingModelMeta : {};
  const metaKeys = Object.keys(meta);
  if (metaKeys.length > 0) {
    const names = [];
    for (const spec of Object.values(meta)) {
      const n = spec && (spec.modelName || spec.collection);
      if (n && String(n).trim()) names.push(String(n).trim());
    }
    const uniqueNames = [...new Set(names)];

    if (metaKeys.length > COMPILE_RELEVANT_CATALOG_THRESHOLD && uniqueNames.length > COMPILE_RELEVANT_CATALOG_THRESHOLD) {
      const relRes = await axiosPostCompileJson(
        syncConfig,
        baseUrl,
        '/compile/model/relevant-existing',
        {
          promptText,
          existingModelNames: uniqueNames,
          database: resolvedDb
        },
        COMPILE_MODEL_TIMEOUT_MS
      );
      const relevantModelNames = Array.isArray(relRes.data.relevantModelNames)
        ? relRes.data.relevantModelNames
        : [];
      const nameSet = new Set(relevantModelNames.map((n) => String(n).toLowerCase().trim()));

      const filtered = {};
      for (const [h, spec] of Object.entries(meta)) {
        const mn = String(spec.modelName || '').toLowerCase().trim();
        const coll = String(spec.collection || '').toLowerCase().trim();
        if ((mn && nameSet.has(mn)) || (coll && nameSet.has(coll))) filtered[h] = spec;
      }
      const effectiveMeta = Object.keys(filtered).length > 0 ? filtered : meta;
      body.existingModelMeta = effectiveMeta;
      body.skipRelevantExistingModelsAi = true;
    } else {
      body.existingModelMeta = meta;
    }
  }

  const response = await axiosPostCompileJson(syncConfig, baseUrl, '/compile/model', body, COMPILE_MODEL_TIMEOUT_MS);
  return interpretCompileModelResponse(response.data, promptText);
}

/**
 * Compile DDL via Mask Databases for a given database engine.
 * @param {{ baseUrl: string, apiKey: string }} syncConfig
 * @param {string} database
 * @param {{ tableName: string, columns: array }} canonicalSpec
 * @returns {Promise<{ sql: string }>}
 */
async function callCentralCompileDdl(syncConfig, database, canonicalSpec) {
  const baseUrl = (syncConfig && syncConfig.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl || !syncConfig.apiKey) {
    throw new Error(
      '[Mask] DDL compilation runs on Mask Databases. Set syncApiKey in mask.compile.cjs (overrideConfig) or MASK_SYNC_API_KEY when compiling (`node mask.compile.cjs`).'
    );
  }
  try {
    const response = await axiosPostCompileJson(
      syncConfig,
      baseUrl,
      '/compile/ddl',
      { database: database || 'mysql', canonicalSpec: canonicalSpec || {} },
      30_000
    );
    const data = response.data;
    if (data && typeof data.sql === 'string') return { sql: data.sql.trim() };
    throw new Error('[Mask] Unexpected response from Mask Databases compile/ddl.');
  } catch (err) {
    if (err.response && (err.response.status === 429 || err.response.status === 403)) {
      const status = err.response.status;
      const message = getMaskDatabasesErrorMessage(err);
      const retryAfterMs = parseRetryAfterMs(
        err.response.headers,
        status === 429 ? 60_000 : 10 * 60_000
      );
      if (status === 429) {
        throw new MaskDatabasesRateLimitedError(message, retryAfterMs);
      }
      throw new MaskDatabasesPlanLimitError(message, retryAfterMs);
    }
    if (err.response && (err.response.status === 401 || err.response.status === 404)) {
      throw new Error(
        '[Mask] Invalid sync API key or project not found. Check syncApiKey (mask.compile.cjs / MASK_SYNC_API_KEY) and your Mask Databases project.'
      );
    }
    if (err.response && err.response.status === 503) {
      throw new Error('[Mask] [0107] Something went wrong!');
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      throw new Error('[Mask] Cannot reach Mask Databases.');
    }
    throw err;
  }
}

module.exports = {
  callCentralCompileQuery,
  callCentralCompileModel,
  callCentralCompileDdl,
  /** @internal tests */
  pathToCompileJobKind
};
