'use strict';

const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { getPaths, getProjectRoot, resolveMaskConfigJsonPath } = require('../paths');
const { ensureMaskDirs, loadJsonFile } = require('./fs-utils');
const {
  getSyncConfig,
  loadMergedQueriesPromptMap,
  loadMergedQueriesMetadata,
  loadMergedQueriesFailedPrompts,
  loadMergedModelsFailedPrompts,
  loadPromptsRegisteryFromMaskConfig,
  loadMergedModelsPromptMap,
  loadMergedModelsMetadata,
  ensureSyncDirs,
  saveQueriesPromptMap,
  saveQueriesMetadata,
  saveQueriesFailedPrompts,
  saveModelsFailedPrompts,
  saveQueriesNeedsReview,
  saveModelsPromptMap,
  saveModelsMetadata,
  saveQueriesSyncMeta,
  saveModelsSyncMeta,
  loadMergedQueriesSyncMeta,
  loadMergedModelsSyncMeta
} = require('./sync-data');
const {
  CompilationFailedError,
  NonsensicalPromptError,
  MaskDatabasesRateLimitedError,
  MaskDatabasesPlanLimitError
} = require('./errors');
const { loadConfigWithMeta, loadOrCreateProjectProfile, toMaterializedMaskConfigJson } = require('./config');
const { generatePromptHash } = require('./hash');
const { discoverAllPrompts, discoverAllModelPrompts } = require('./discovery');
const { MASK_PREFIX, MASK_DATABASES_DEFAULT_URL } = require('../package-config');
const { getCompilerAdapter } = require('./get-adapter');
const { callCentralCompileQuery, callCentralCompileModel, callCentralCompileDdl } = require('./remote-compile');
const { isKnownSqlEngine } = require('./constants');
const { getMaskMigrationsCanonicalSpec } = require('./compile-ddl');
const { assertPromptSize } = require('./prompt-size');

/** Blank lines above/below so warnings and errors are easy to spot in dense terminal output. */
function logCompilerTerminalBlock(logger, ...args) {
  /* eslint-disable no-console */
  console.log('');
  logger.apply(console, args);
  console.log('');
  /* eslint-enable no-console */
}

function logCompilationFailed(kind, err) {
  const detail =
    err && typeof err.message === 'string' && err.message.trim()
      ? `\n  ${err.message.trim()}`
      : '';
  logCompilerTerminalBlock(
    console.warn,
    `[Mask] ${kind} compilation failed after backend retries.\n` +
      `  Fix the prompt or remove with mask-delete and re-run compile.${detail}`
  );
}

/** Persist resolved overrideConfig snapshot for runtime and generated modules (under .mask/). */
function materializeMaskConfigJson(projectRoot, config) {
  const jsonPath = resolveMaskConfigJsonPath(projectRoot);
  const payload = toMaterializedMaskConfigJson(config);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function mergeObjectsSync(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function normalizeSqlDialect(value) {
  const v = String(value || '').toLowerCase().trim();
  if (v === 'postgresql') return 'postgres';
  if (v === 'mariadb') return 'mysql';
  if (v === 'sqlserver') return 'mssql';
  return v;
}

function hasSqlDialectMismatch(spec, configuredDb) {
  if (!spec || typeof spec !== 'object') return false;
  const db = normalizeSqlDialect(configuredDb);
  if (!db || !isKnownSqlEngine(db)) return false;

  const query = typeof spec.query === 'string' ? spec.query : '';
  const specDialect = spec.dialect != null && spec.dialect !== ''
    ? normalizeSqlDialect(spec.dialect)
    : '';

  if (specDialect && specDialect !== db) return true;

  if ((db === 'mysql') && /\bRETURNING\b/i.test(query)) return true;
  if ((db === 'postgres') && /\bLAST_INSERT_ID\s*\(/i.test(query)) return true;
  if ((db === 'postgres') && /\b`[^`]+`\b/.test(query)) return true;

  return false;
}

let maskDatabasesPauseUntilMs = 0;
let lastMaskDatabasesLimitReason = 'Mask Databases limit reached.';

/** Extra wait after server Retry-After rate limits so the window has cleared before we retry. */
const RATE_LIMIT_PAUSE_PADDING_MS = 5000;

/** Watch mode only: schedule auto-retry when Mask Databases pauses compilation. */
let onPauseMaskDatabases = null;
/** Watch mode only: clear scheduled resume once a compile run actually starts (pause lifted). */
let clearMaskResumeSchedule = null;

function getPauseMsFromError(err) {
  const n = err && Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : null;
  const base = n != null && n > 0 ? n : 60_000;
  if (err && err.name === 'MaskDatabasesRateLimitedError') {
    return base + RATE_LIMIT_PAUSE_PADDING_MS;
  }
  return base;
}

function formatLimitReason(err) {
  const raw = err && err.message ? String(err.message).trim() : '';
  if (!raw) return 'Mask Databases limit reached.';
  if (err && err.name === 'MaskDatabasesPlanLimitError') {
    return `Plan usage limit reached: ${raw}`;
  }
  if (err && err.name === 'MaskDatabasesRateLimitedError') {
    return `Rate limit reached: ${raw}`;
  }
  return raw;
}

function pauseMaskDatabases(err) {
  const ms = getPauseMsFromError(err);
  const reason = formatLimitReason(err);
  lastMaskDatabasesLimitReason = reason;
  maskDatabasesPauseUntilMs = Math.max(maskDatabasesPauseUntilMs, Date.now() + ms);
  const seconds = Math.ceil(ms / 1000);
  logCompilerTerminalBlock(console.warn, `[Mask] ${reason} Pausing compilation for ~${seconds}s.`);
  if (typeof onPauseMaskDatabases === 'function') {
    onPauseMaskDatabases();
  }
}

async function compileOnce(compileOptions) {
  const opts = compileOptions || {};
  if (opts.overrideConfig == null) {
    throw new Error(
      '[Mask] compileOnce requires overrideConfig. Use mask.compile.cjs at the project root (run npx mask-init) or call runWithMaskConfig({ overrideConfig, projectRoot }).'
    );
  }
  if (Date.now() < maskDatabasesPauseUntilMs) {
    const secondsLeft = Math.ceil((maskDatabasesPauseUntilMs - Date.now()) / 1000);
    logCompilerTerminalBlock(
      console.warn,
      `[Mask] ${lastMaskDatabasesLimitReason} Compilation paused. Try again in ~${secondsLeft}s.`
    );
    return;
  }
  if (typeof clearMaskResumeSchedule === 'function') {
    clearMaskResumeSchedule();
  }
  const projectRoot =
    opts.projectRoot != null ? path.resolve(opts.projectRoot) : getProjectRoot();
  const paths = getPaths(projectRoot);
  const loadOpts = { overrideConfig: opts.overrideConfig };
  // Fail fast: config must have database, dbModulePath, and syncApiKey
  const { config } = loadConfigWithMeta(paths, loadOpts);
  ensureMaskDirs(paths);
  let syncConfig = getSyncConfig(paths);
  if (!syncConfig && config.syncApiKey) {
    const base =
      config.syncBaseUrl && typeof config.syncBaseUrl === 'string' && String(config.syncBaseUrl).trim()
        ? String(config.syncBaseUrl).trim().replace(/\/$/, '')
        : MASK_DATABASES_DEFAULT_URL;
    syncConfig = { apiKey: String(config.syncApiKey).trim(), baseUrl: base };
  }
  const useSync = !!syncConfig;
  if (useSync) ensureSyncDirs(paths);

  const profile = await loadOrCreateProjectProfile(paths, loadOpts);
  const adapter = getCompilerAdapter(profile.database);

  const priorQm = useSync
    ? mergeObjectsSync(
        loadJsonFile(paths.system.queries.promptMap, {}),
        loadJsonFile(paths.local.queries.promptMap, {})
      )
    : null;
  const priorMm = useSync
    ? mergeObjectsSync(
        loadJsonFile(paths.system.models.promptMap, {}),
        loadJsonFile(paths.local.models.promptMap, {})
      )
    : null;

  const promptMap = loadMergedQueriesPromptMap(paths, useSync);
  const queryMeta = loadMergedQueriesMetadata(paths, useSync);
  const failedQueryPrompts = new Set(loadMergedQueriesFailedPrompts(paths, useSync));
  const failedModelPrompts = new Set(loadMergedModelsFailedPrompts(paths, useSync));
  const modelPromptMap = loadMergedModelsPromptMap(paths, useSync);
  const modelMeta = loadMergedModelsMetadata(paths, useSync);
  const effectiveQuerySyncMeta = loadMergedQueriesSyncMeta(paths, useSync);

  const existingHashes = new Set([
    ...Object.values(promptMap),
    ...Object.values(modelPromptMap)
  ]);

  const promptsFromSource = discoverAllPrompts(projectRoot, profile);
  const registery = loadPromptsRegisteryFromMaskConfig(paths);
  const modelPromptsInSource = discoverAllModelPrompts(projectRoot, profile);

  // Build the set of prompt texts we actually compile. Resolve mask-<key> from registery.
  const toCompile = new Set();
  const registeryObj = registery && typeof registery === 'object' && !Array.isArray(registery) ? registery : null;
  for (const p of promptsFromSource) {
    if (p.startsWith(MASK_PREFIX)) {
      const key = p.slice(MASK_PREFIX.length);
      if (!key.trim()) {
        throw new Error(
          `[Mask] Invalid mask prompt: "${p}". Use mask-<key> where <key> exists in overrideConfig.registery (mask.compile.cjs).`
        );
      }
      if (!registeryObj || !(key in registeryObj) || !registeryObj[key]) {
        throw new Error(
          `[Mask] Prompt "${p}" uses mask-"${key}" but "${key}" is not in overrideConfig.registery (mask.compile.cjs). ` +
            'Add the key and full prompt text under "registery", or use a string literal prompt.'
        );
      }
      toCompile.add(registeryObj[key]);
    } else {
      toCompile.add(p);
    }
  }
  if (registeryObj) {
    for (const fullPrompt of Object.values(registeryObj)) {
      if (fullPrompt) toCompile.add(fullPrompt);
    }
  }

  if (toCompile.size === 0 && modelPromptsInSource.size === 0) {
    // eslint-disable-next-line no-console
    console.log('No prompt or model-define usages found in source. Nothing to compile.');
  }

  // Phase 1: compile ALL model definitions first.
  // This prevents query compilation from running without the model-generated schema summaries.
  let modelsChangedInThisRun = false;
  let didChange = false;
  const recompiledModels = new Set();
  const recompiledQueries = new Set();
  let hitRateLimit = false;

  function persistRawData() {
    saveQueriesPromptMap(paths, promptMap, useSync);
    saveQueriesMetadata(paths, queryMeta, useSync);
    saveModelsPromptMap(paths, modelPromptMap, useSync);
    saveModelsMetadata(paths, modelMeta, useSync);
  }

  const canWriteIncrementalMigrations =
    !!(adapter.generateSchemaSql && adapter.generateSingleTableSql && paths.migrations && paths.migrations.dir);
  let migrationsDir = null;
  let manifestPath = null;
  let migrationManifest = null;
  let migrationOrderSet = null;
  let nextMigrationIndex = 0;
  let maskMigrationsBootstrapped = false;

  async function ensureMigrationBootstrap() {
    if (!canWriteIncrementalMigrations || hitRateLimit) return;
    if (migrationManifest && migrationOrderSet) return;

    migrationsDir = paths.migrations.dir;
    manifestPath = paths.migrations.manifest;
    if (!fs.existsSync(migrationsDir)) {
      fs.mkdirSync(migrationsDir, { recursive: true });
    }

    const db = profile.database;
    const unknownEngine = !isKnownSqlEngine(db);
    if (unknownEngine && syncConfig && !maskMigrationsBootstrapped) {
      const maskMigrationsPath = path.join(migrationsDir, '000_mask_migrations.sql');
      if (!fs.existsSync(maskMigrationsPath)) {
        try {
          const { sql } = await callCentralCompileDdl(syncConfig, db, getMaskMigrationsCanonicalSpec());
          fs.writeFileSync(maskMigrationsPath, sql, 'utf8');
        } catch (err) {
          if (err instanceof MaskDatabasesRateLimitedError || err instanceof MaskDatabasesPlanLimitError) {
            pauseMaskDatabases(err);
            hitRateLimit = true;
            return;
          }
          throw err;
        }
      }
      maskMigrationsBootstrapped = true;
    }

    migrationManifest = { order: [] };
    if (fs.existsSync(manifestPath)) {
      try {
        migrationManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(migrationManifest.order)) migrationManifest.order = [];
      } catch (_) {
        migrationManifest = { order: [] };
      }
    }
    migrationOrderSet = new Set(migrationManifest.order);
    nextMigrationIndex = migrationManifest.order.length;
  }

  async function writeMigrationForModelHash(hash) {
    if (!canWriteIncrementalMigrations || hitRateLimit) return;
    await ensureMigrationBootstrap();
    if (hitRateLimit || !migrationManifest || !migrationOrderSet) return;
    if (migrationOrderSet.has(hash)) return;
    const spec = modelMeta[hash];
    if (!spec || !spec.collection || spec.type === 'failed' || spec.type === 'needs_review') return;

    const sql = await Promise.resolve(
      adapter.generateSingleTableSql(spec, profile.database, { syncConfig: syncConfig || undefined })
    );
    if (!sql) return;

    const table = spec.collection;
    const filename = `${String(++nextMigrationIndex).padStart(3, '0')}_${table}.sql`;
    const filePath = path.join(migrationsDir, filename);
    fs.writeFileSync(filePath, sql, 'utf8');
    migrationManifest.order.push(hash);
    migrationOrderSet.add(hash);
    fs.writeFileSync(manifestPath, JSON.stringify(migrationManifest, null, 2), 'utf8');
  }

  if (canWriteIncrementalMigrations) {
    await ensureMigrationBootstrap();
    if (!hitRateLimit) {
      const orderedExistingModelHashes = [...modelPromptsInSource].map((p) => modelPromptMap[p]).filter(Boolean);
      for (const hash of orderedExistingModelHashes) {
        await writeMigrationForModelHash(hash);
        if (hitRateLimit) break;
      }
    }
  }

  for (const modelPrompt of modelPromptsInSource) {
    assertPromptSize(modelPrompt, 'model-prompt');
    let modelHash = modelPromptMap[modelPrompt];
    if (!modelHash) {
      modelHash = generatePromptHash(modelPrompt, existingHashes);
      existingHashes.add(modelHash);
      modelPromptMap[modelPrompt] = modelHash;
      didChange = true;
      // eslint-disable-next-line no-console
      console.log(`New model prompt discovered -> hash: "${modelPrompt}" -> ${modelHash}`);
    }

    if (!modelMeta[modelHash]) {
      if (!syncConfig) {
        throw new Error(
          '[Mask] Compilation runs on Mask Databases. Set syncApiKey in mask.compile.cjs (overrideConfig) or MASK_SYNC_API_KEY when compiling (`node mask.compile.cjs`).'
        );
      }
      // eslint-disable-next-line no-console
      console.log(`Compiling model via Mask Databases "${modelPrompt}" (hash: ${modelHash})...`);
      try {
        const spec = await callCentralCompileModel(syncConfig, modelPrompt, profile.database, modelMeta);
        modelMeta[modelHash] = spec;
        didChange = true;
        modelsChangedInThisRun = true;
        recompiledModels.add(modelPrompt);
        failedModelPrompts.delete(modelPrompt);
        saveModelsFailedPrompts(paths, [...failedModelPrompts], useSync);
        persistRawData();
        await writeMigrationForModelHash(modelHash);
      } catch (err) {
        if (err instanceof MaskDatabasesRateLimitedError || err instanceof MaskDatabasesPlanLimitError) {
          pauseMaskDatabases(err);
          hitRateLimit = true;
          break;
        }
        if (err instanceof NonsensicalPromptError) {
          modelMeta[modelHash] = { type: 'needs_review', warning: err.warning };
          didChange = true;
          modelsChangedInThisRun = true;
          recompiledModels.add(modelPrompt);
          persistRawData();
          logCompilerTerminalBlock(
            console.warn,
            `[Mask] Model prompt needs review (unclear or nonsensical). Fix and re-run compile.\n  Prompt: "${err.promptText}"\n  Reason: ${err.warning}`
          );
        } else if (err instanceof CompilationFailedError) {
          modelMeta[modelHash] = { type: 'failed' };
          didChange = true;
          modelsChangedInThisRun = true;
          recompiledModels.add(modelPrompt);
          failedModelPrompts.add(modelPrompt);
          saveModelsFailedPrompts(paths, [...failedModelPrompts], useSync);
          persistRawData();
          logCompilationFailed('Model', err);
        } else {
          throw err;
        }
      }
    }
  }

  const currentModelHashes = new Set();

  if (!hitRateLimit) {
    // Phase 2: now that models are ready, refresh model hashes used to build the schema summary.
    for (const prompt of modelPromptsInSource) {
      const h = modelPromptMap[prompt];
      const spec = h && modelMeta[h];
      if (
        h &&
        spec &&
        spec.collection &&
        typeof spec.collection === 'string' &&
        spec.fields &&
        typeof spec.fields === 'object' &&
        spec.type !== 'failed' &&
        spec.type !== 'needs_review'
      ) {
        currentModelHashes.add(h);
      }
    }

    // Phase 3: compile query prompts using the refreshed model summaries.
    for (const promptText of toCompile) {
      assertPromptSize(promptText, 'query-prompt');
      let hash = promptMap[promptText];
      if (!hash) {
        hash = generatePromptHash(promptText, existingHashes);
        existingHashes.add(hash);
        promptMap[promptText] = hash;
        didChange = true;
        // eslint-disable-next-line no-console
        console.log(`New prompt discovered -> hash: "${promptText}" -> ${hash}`);
      }

      const existingSpec = queryMeta[hash];
      const syncMeta = effectiveQuerySyncMeta[promptText];
      const forceByLocalDelete = !!(syncMeta && syncMeta.isDeleted);
      const shouldRecompile =
        forceByLocalDelete ||
        !existingSpec ||
        ((existingSpec.type === 'needs_review' || existingSpec.type === 'failed') && modelsChangedInThisRun) ||
        hasSqlDialectMismatch(existingSpec, profile.database);

      if (!shouldRecompile) continue;

      if (failedQueryPrompts.has(promptText) && !modelsChangedInThisRun) {
        queryMeta[hash] = { type: 'failed' };
        didChange = true;
        logCompilerTerminalBlock(
          console.warn,
          `[Mask] Skipping prompt (previously failed). Remove using mask-delete and retry.`
        );
        continue;
      }

      if (!syncConfig) {
        throw new Error(
          '[Mask] Compilation runs on Mask Databases. Set syncApiKey in mask.compile.cjs (overrideConfig) or MASK_SYNC_API_KEY when compiling (`node mask.compile.cjs`).'
        );
      }

      try {
        // eslint-disable-next-line no-console
        console.log(`Compiling prompt via Mask Databases "${promptText}" (hash: ${hash})...`);
        const spec = await callCentralCompileQuery(
          syncConfig,
          profile.database,
          promptText,
          modelMeta,
          currentModelHashes,
          profile
        );

        if (hasSqlDialectMismatch(spec, profile.database)) {
          throw new CompilationFailedError(
            `Compiled SQL dialect does not match configured database "${profile.database}".`,
            promptText
          );
        }

        queryMeta[hash] = spec;
        didChange = true;
        recompiledQueries.add(promptText);
        persistRawData();
      } catch (err) {
        if (err instanceof MaskDatabasesRateLimitedError || err instanceof MaskDatabasesPlanLimitError) {
          pauseMaskDatabases(err);
          hitRateLimit = true;
          break;
        }
        if (err instanceof NonsensicalPromptError) {
          queryMeta[hash] = { type: 'needs_review', warning: err.warning };
          didChange = true;
          recompiledQueries.add(promptText);
          persistRawData();
          logCompilerTerminalBlock(
            console.warn,
            `[Mask] Prompt needs review (unclear or nonsensical). Fix the prompt and re-run compile.\n  Prompt: "${err.promptText}"\n  Reason: ${err.warning}`
          );
        } else if (err instanceof CompilationFailedError) {
          failedQueryPrompts.add(promptText);
          saveQueriesFailedPrompts(paths, [...failedQueryPrompts], useSync);
          queryMeta[hash] = { type: 'failed' };
          didChange = true;
          recompiledQueries.add(promptText);
          persistRawData();
          logCompilationFailed('Query', err);
        } else {
          throw err;
        }
      }
    }
  }

  function isPromptInSource(promptText) {
    if (promptsFromSource.has(promptText)) return true;
    if (registeryObj) {
      for (const [key, fullPrompt] of Object.entries(registeryObj)) {
        if (fullPrompt === promptText && promptsFromSource.has(MASK_PREFIX + key)) return true;
      }
    }
    return false;
  }

  const modelsNeedingReview = [];
  const failedModelsInSource = [];
  for (const modelPrompt of modelPromptsInSource) {
    const h = modelPromptMap[modelPrompt];
    if (!h) continue;
    const spec = modelMeta[h];
    if (spec && spec.type === 'needs_review') {
      modelsNeedingReview.push({
        prompt: modelPrompt,
        warning: spec.warning || 'Model prompt is unclear or nonsensical.'
      });
    } else if (spec && spec.type === 'failed') {
      failedModelsInSource.push(modelPrompt);
    }
  }

  const promptsNeedingReview = [];
  const failedPromptsInSource = [];
  for (const [promptText, h] of Object.entries(promptMap)) {
    if (!isPromptInSource(promptText)) continue;
    const spec = queryMeta[h];
    if (spec && spec.type === 'needs_review') {
      promptsNeedingReview.push({ prompt: promptText, warning: spec.warning || 'Prompt is unclear or nonsensical.' });
    } else if (spec && spec.type === 'failed') {
      failedPromptsInSource.push(promptText);
    }
  }

  const queriesModuleSource = adapter.generateQueriesModuleSource(queryMeta, profile, {
    dbModulePath: config.dbModulePath,
    modelMeta
  });

  const modelsModuleSource = adapter.generateModelsModuleSource(modelMeta, { dbModulePath: config.dbModulePath });

  if (!hitRateLimit && canWriteIncrementalMigrations) {
    // Keep an end-of-run reconciliation pass to preserve previous behavior,
    // while each successful model now also flushes its migration immediately.
    const orderedModelHashes = [...modelPromptsInSource].map((p) => modelPromptMap[p]).filter(Boolean);
    for (const hash of orderedModelHashes) {
      await writeMigrationForModelHash(hash);
      if (hitRateLimit) break;
    }
  }

  // Persist all compiled state — raw data was already saved incrementally via persistRawData()
  // after each successful AI response, but we finalize sync-meta, needs-review, and codegen here.
  if (useSync) {
    const now = Date.now();
    const prevSq = loadMergedQueriesSyncMeta(paths, true);
    const prevSm = loadMergedModelsSyncMeta(paths, true);
    const nextSq = { ...prevSq };
    for (const prompt of Object.keys(promptMap)) {
      const prevH = priorQm[prompt];
      const h = promptMap[prompt];
      const prev = prevSq[prompt] || { version: 1, lastModified: 0, isSynced: true, isDeleted: false };
      if (prevH !== h || recompiledQueries.has(prompt)) {
        nextSq[prompt] = {
          version: (prev.version || 1) + 1,
          lastModified: now,
          isSynced: false,
          isDeleted: false
        };
      } else {
        nextSq[prompt] = { ...prev, isDeleted: false };
      }
    }
    const nextSm = { ...prevSm };
    for (const prompt of Object.keys(modelPromptMap)) {
      const prevH = priorMm[prompt];
      const h = modelPromptMap[prompt];
      const prev = prevSm[prompt] || { version: 1, lastModified: 0, isSynced: true, isDeleted: false };
      if (prevH !== h || recompiledModels.has(prompt)) {
        nextSm[prompt] = {
          version: (prev.version || 1) + 1,
          lastModified: now,
          isSynced: false,
          isDeleted: false
        };
      } else {
        nextSm[prompt] = { ...prev, isDeleted: false };
      }
    }
    saveQueriesSyncMeta(paths, nextSq, true);
    saveModelsSyncMeta(paths, nextSm, true);
  }

  persistRawData();
  saveQueriesNeedsReview(paths, promptsNeedingReview, useSync);
  fs.writeFileSync(paths.generated.queries, queriesModuleSource, 'utf8');
  fs.writeFileSync(paths.generated.models, modelsModuleSource, 'utf8');

  if (hitRateLimit) {
    materializeMaskConfigJson(projectRoot, config);
    return;
  }

  if (modelsNeedingReview.length > 0) {
    const lines = modelsNeedingReview.map(({ prompt }) => `  - "${prompt}"`);
    throw new Error(
      `[Mask] Compilation failed: ${modelsNeedingReview.length} model prompt(s) need review. Remove the model from code or comment it out, or fix it, then re-run compile.\n\n${lines.join('\n')}`
    );
  }
  if (failedModelsInSource.length > 0) {
    const lines = failedModelsInSource.map((p) => `  - "${p}"`);
    throw new Error(
      `[Mask] Compilation failed: ${failedModelsInSource.length} model prompt(s) failed. Remove from code or comment out, or rephrase to retry.\n\n${lines.join('\n')}`
    );
  }
  if (promptsNeedingReview.length > 0) {
    const lines = promptsNeedingReview.map(({ prompt }) => `  - "${prompt}"`);
    throw new Error(
      `[Mask] Compilation failed: ${promptsNeedingReview.length} prompt(s) need review. Remove the prompt from code or comment it out, or fix it, then re-run compile.\n\n${lines.join('\n')}`
    );
  }
  if (failedPromptsInSource.length > 0) {
    const lines = failedPromptsInSource.map((p) => `  - "${p}"`);
    throw new Error(
      `[Mask] Compilation failed: ${failedPromptsInSource.length} prompt(s) failed after 3 attempts. Remove from code or comment out, or rephrase to retry.\n\n${lines.join('\n')}`
    );
  }

  materializeMaskConfigJson(projectRoot, config);

  if (didChange) {
    // eslint-disable-next-line no-console
    console.log('Compilation completed. Updated prompt maps and generated query/model modules.');
  } else {
    // eslint-disable-next-line no-console
    console.log('Compilation completed. No changes detected.');
  }
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    watch: args.has('--watch') || args.has('-w')
  };
}

/**
 * @param {{ watch?: boolean, compileOpts?: object }} runOpts
 */
async function runInternal(runOpts) {
  const watch = !!(runOpts && runOpts.watch);
  const compileOpts = (runOpts && runOpts.compileOpts) || {};

  let resumeTimer = null;
  let compiling = false;
  let pending = false;

  function clearResumeTimer() {
    if (resumeTimer != null) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
  }

  async function triggerCompile() {
    if (compiling) {
      pending = true;
      return;
    }
    // File watcher can start only after async setup (profile load, etc.). By then most of the
    // pause window may have elapsed; calling compileOnce here only prints a misleading "Try again
    // in ~1s". While paused, coalesce into the existing resume timer instead of entering compileOnce.
    if (watch && Date.now() < maskDatabasesPauseUntilMs) {
      scheduleResumeFromPause();
      return;
    }
    compiling = true;
    try {
      await compileOnce(compileOpts);
    } catch (err) {
      const msg =
        err && typeof err.message === 'string' && err.message.trim()
          ? err.message.trim()
          : '[Mask] Unknown error during compilation.';
      logCompilerTerminalBlock(console.error, 'Error during compilation:', msg);
    } finally {
      compiling = false;
      if (pending) {
        pending = false;
        // While the pause window is active, do not chain another compile immediately: that only
        // re-logs "Try again in ~Xs" (often ~1s due to Math.ceil on sub-second remainders) and can
        // fight the resume timer. Coalesce into the single pause-driven schedule instead.
        if (watch && Date.now() < maskDatabasesPauseUntilMs) {
          scheduleResumeFromPause();
        } else {
          void triggerCompile();
        }
      }
    }
  }

  function scheduleResumeFromPause() {
    clearResumeTimer();
    if (Date.now() >= maskDatabasesPauseUntilMs) {
      return;
    }
    const delay = Math.max(0, maskDatabasesPauseUntilMs - Date.now());
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      void triggerCompile();
    }, delay);
  }

  if (watch) {
    onPauseMaskDatabases = scheduleResumeFromPause;
    clearMaskResumeSchedule = clearResumeTimer;
  } else {
    onPauseMaskDatabases = null;
    clearMaskResumeSchedule = null;
  }

  await compileOnce(compileOpts);

  if (!watch) {
    return;
  }

  // Initial compile may have hit limits; ensure we retry when the pause window ends.
  scheduleResumeFromPause();

  const projectRoot =
    compileOpts.projectRoot != null ? path.resolve(compileOpts.projectRoot) : getProjectRoot();
  const paths = getPaths(projectRoot);
  const profile = await loadOrCreateProjectProfile(paths, {
    overrideConfig: compileOpts.overrideConfig
  });
  const watchDirs = (profile.sourceDirs || ['src']).map((d) => path.join(projectRoot, d));

  // eslint-disable-next-line no-console
  console.log('Watch mode enabled. Recompiling when source files change...');

  const watcher = chokidar.watch(watchDirs, {
    persistent: true,
    ignoreInitial: true
  });

  watcher.on('add', triggerCompile);
  watcher.on('change', triggerCompile);
  watcher.on('unlink', triggerCompile);
}

/**
 * Run the compiler. Requires overrideConfig (typically from mask.compile.cjs).
 * @param {{ watch?: boolean, projectRoot?: string, overrideConfig: object }} options
 */
async function runWithMaskConfig(options) {
  const opts = options || {};
  if (opts.overrideConfig == null || typeof opts.overrideConfig !== 'object' || Array.isArray(opts.overrideConfig)) {
    throw new Error('[Mask] runWithMaskConfig requires overrideConfig (object with database, dbModulePath, syncApiKey).');
  }
  return runInternal({
    watch: opts.watch === true,
    compileOpts: {
      projectRoot: opts.projectRoot,
      overrideConfig: opts.overrideConfig
    }
  });
}

module.exports = {
  compileOnce,
  runWithMaskConfig,
  parseArgs
};
