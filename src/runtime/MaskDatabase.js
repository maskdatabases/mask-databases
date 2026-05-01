const fs = require('fs');
const { getPaths, getProjectRoot } = require('../paths');
const {
  tryUnwrapMongoScalarAggregationCount,
  promptLooksLikeScalarCountRequest
} = require('./unwrapMongoAggregationScalar');
const {
  getSyncConfig,
  loadMergedQueriesPromptMap,
  loadMergedQueriesMetadata,
  loadPromptsRegisteryFromMaskConfig
} = require('../compiler/sync-data');
const { MASK_PREFIX } = require('../package-config');

let promptMapCache = null;
let queryMetaCache = null;
let compiledQueriesCache = null;
let pathsCache = null;
let promptsRegisteryCache = null;
/** Lowercased `database` from `.mask/compile-config.json`; empty if missing. */
let compileDatabaseCache;

function extractUserCallsiteFromStack(stack, projectRoot) {
  const text = typeof stack === 'string' ? stack : '';
  if (!text) return null;
  const lines = text.split('\n').slice(1);
  const root = typeof projectRoot === 'string' ? projectRoot : '';
  for (const line of lines) {
    const m = line.match(/\((.*):(\d+):(\d+)\)$/) || line.match(/at (.*):(\d+):(\d+)$/);
    if (!m) continue;
    const filePath = m[1];
    const lineNum = Number.parseInt(m[2], 10);
    const colNum = Number.parseInt(m[3], 10);
    if (!filePath || !Number.isFinite(lineNum) || !Number.isFinite(colNum)) continue;
    if (filePath.includes('/node_modules/')) continue;
    if (filePath.includes('/packages/mask/src/')) continue;
    const inProject = root && filePath.startsWith(root);
    const file = inProject ? filePath.slice(root.length + 1) : filePath;
    return { file, line: lineNum, column: colNum };
  }
  return null;
}

function makeQuerySpecSummary(spec) {
  if (!spec || typeof spec !== 'object') return {};
  const out = {};
  if (spec.type) out.type = spec.type;
  if (spec.collection) out.collection = spec.collection;
  if (Array.isArray(spec.pipeline)) out.pipelineStages = spec.pipeline.length;
  if (spec.query && typeof spec.query === 'string') out.query = spec.query.slice(0, 180);
  if (spec.cypher && typeof spec.cypher === 'string') out.cypher = spec.cypher.slice(0, 180);
  return out;
}

class MaskPromptExecutionError extends Error {
  constructor({ promptText, promptHash, callsite, specSummary, cause }) {
    const parts = ['[Mask] Prompt execution failed.'];
    if (callsite && callsite.file && callsite.line) {
      parts.push(`Source: ${callsite.file}:${callsite.line}:${callsite.column || 0}`);
    }
    if (promptHash) parts.push(`Hash: ${promptHash}`);
    if (promptText) parts.push(`Prompt: "${promptText}"`);
    if (specSummary && Object.keys(specSummary).length > 0) {
      parts.push(`Spec: ${JSON.stringify(specSummary)}`);
    }
    if (cause && cause.message) {
      parts.push(`Cause: ${String(cause.message)}`);
    }
    super(parts.join('\n'), cause ? { cause } : undefined);
    this.name = 'MaskPromptExecutionError';
    this.promptText = promptText;
    this.promptHash = promptHash;
    this.callsite = callsite || null;
    this.specSummary = specSummary || null;
    this.originalError = cause || null;
  }
}

function getPathsForRuntime() {
  if (pathsCache) return pathsCache;
  pathsCache = getPaths(getProjectRoot());
  return pathsCache;
}

function getPersistedCompileDatabase() {
  if (compileDatabaseCache !== undefined) return compileDatabaseCache;
  compileDatabaseCache = '';
  try {
    const raw = fs.readFileSync(getPathsForRuntime().config, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.database === 'string') {
      compileDatabaseCache = cfg.database.toLowerCase().trim();
    }
  } catch (_) {
    /* compile-config missing or invalid */
  }
  return compileDatabaseCache;
}

function loadPromptMap() {
  if (promptMapCache) return promptMapCache;
  const p = getPathsForRuntime();
  const useSync = !!getSyncConfig(p);

  if (useSync) {
    promptMapCache = loadMergedQueriesPromptMap(p, true);
    if (Object.keys(promptMapCache).length === 0) {
      throw new Error(
        'Prompt map not found. When using sync, expected data in .mask/local/queries/ or .mask/system/queries/. ' +
          'Please run your Mask compile command (e.g. "node mask.compile.cjs") before starting the application.'
      );
    }
    return promptMapCache;
  }

  if (!fs.existsSync(p.queries.promptMap)) {
    throw new Error(
      'Prompt map not found. Expected at .mask/queries/prompt-map.json. ' +
        'Please run your Mask compile command (e.g. "node mask.compile.cjs") before starting the application.'
    );
  }
  const raw = fs.readFileSync(p.queries.promptMap, 'utf8');
  try {
    promptMapCache = JSON.parse(raw || '{}');
    return promptMapCache;
  } catch (err) {
    throw new Error(
      `Failed to parse .mask/queries/prompt-map.json. Original error: ${err.message}`
    );
  }
}

function loadQueryMeta() {
  if (queryMetaCache) return queryMetaCache;
  const p = getPathsForRuntime();
  const useSync = !!getSyncConfig(p);

  if (useSync) {
    queryMetaCache = loadMergedQueriesMetadata(p, true);
    return queryMetaCache;
  }

  if (!fs.existsSync(p.queries.metadata)) {
    return {};
  }
  const raw = fs.readFileSync(p.queries.metadata, 'utf8');
  try {
    queryMetaCache = JSON.parse(raw || '{}');
    return queryMetaCache;
  } catch (_) {
    return {};
  }
}

function loadCompiledQueries() {
  if (compiledQueriesCache) return compiledQueriesCache;
  const p = getPathsForRuntime();
  if (!fs.existsSync(p.generated.queries)) {
    throw new Error(
      'Compiled queries module not found. Expected at .mask/generated/queries.js. ' +
        'Please run your Mask compile command (e.g. "node mask.compile.cjs") before starting the application.'
    );
  }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const compiled = require(p.generated.queries);
  if (!compiled || typeof compiled !== 'object') {
    throw new Error(
      'Invalid compiled queries module. .mask/generated/queries.js must export an object mapping prompt hashes to async query functions.'
    );
  }
  compiledQueriesCache = compiled;
  return compiled;
}

function loadPromptsRegistery() {
  if (promptsRegisteryCache !== null) return promptsRegisteryCache;
  const p = getPathsForRuntime();
  const fromConfig = loadPromptsRegisteryFromMaskConfig(p);
  promptsRegisteryCache = fromConfig && typeof fromConfig === 'object' ? fromConfig : {};
  return promptsRegisteryCache;
}

/**
 * If promptText is mask-<key>, validate key in registery and return the resolved full prompt for lookup.
 * Otherwise return promptText unchanged. mask-* keys resolve via registery from mask.compile.cjs overrideConfig.registery (after compile).
 */
function resolveMaskPrompt(promptText) {
  if (typeof promptText !== 'string' || !promptText.startsWith(MASK_PREFIX)) return promptText;
  const key = promptText.slice(MASK_PREFIX.length);
  if (!key.trim()) {
    throw new Error(
      `[Mask] Invalid mask prompt: "${promptText}". Use mask-<key> where <key> is defined in overrideConfig.registery (mask.compile.cjs).`
    );
  }
  const registery = loadPromptsRegistery();
  if (!registery[key]) {
    throw new Error(
      `[Mask] Prompt "${promptText}" uses mask-"${key}" but "${key}" is not in the registery. ` +
        'Add it under overrideConfig.registery in mask.compile.cjs, then re-run the compiler.'
    );
  }
  return registery[key];
}

/** Collect all :paramName placeholders from a spec (filter, pipeline, updateTemplate, etc.), plus spec.params for SQL/Neo4j. */
function getRequiredParamNames(spec) {
  const names = new Set();
  function walk(value) {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      const m = value.match(/^:(\w+)$/);
      if (m) names.add(m[1]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value)) walk(v);
    }
  }
  walk(spec);
  if (Array.isArray(spec.params)) {
    for (const p of spec.params) {
      if (typeof p === 'string' && p) names.add(p);
    }
  }
  return names;
}

/** :word placeholders written in the natural-language prompt (e.g. :userId, :email). */
function extractParamNamesFromPromptText(promptText) {
  const names = new Set();
  if (typeof promptText !== 'string' || !promptText) {
    return names;
  }
  const re = /:(\w+)/g;
  let m;
  while ((m = re.exec(promptText)) !== null) {
    names.add(m[1]);
  }
  return names;
}

function isRelationalSqlDatabaseName(db) {
  const d = String(db || '').toLowerCase().trim();
  return (
    d === 'mysql' ||
    d === 'mariadb' ||
    d === 'postgres' ||
    d === 'postgresql' ||
    d === 'sqlite' ||
    d === 'oracle' ||
    d === 'mssql' ||
    d === 'sqlserver' ||
    d === 'cockroachdb'
  );
}

/**
 * For SQL reads: if the natural-language prompt does not include ":param" tokens, do not force
 * runtime params for placeholders that look like "fixed filter literals" the compiler invented.
 *
 * Example prompt: "Get carts with status active ..." should not require `{ status: 'active' }`
 * when the compiled SQL contains `WHERE carts.status = :status` but the prompt never wrote `:status`.
 */
function filterSqlSelectPlaceholdersAgainstPrompt(spec, promptText, db) {
  const out = new Set();
  if (!spec || typeof spec !== 'object') return out;
  if (!isRelationalSqlDatabaseName(db)) return out;
  if (String(spec.type || '').toLowerCase() !== 'select') return out;

  const q = typeof spec.query === 'string' ? spec.query : '';
  if (!q) return out;

  const fromSpec = getRequiredParamNames(spec);
  const fromPrompt = extractParamNamesFromPromptText(promptText || '');
  if (fromPrompt.size > 0) return fromSpec;

  const lowerPrompt = String(promptText || '').toLowerCase();
  for (const name of fromSpec) {
    const token = `:${name}`;
    if (!q.includes(token)) continue;

    // If the prompt explicitly parameterized this name, require it (handled by fromPrompt branch above).
    // Otherwise, only require it if it looks like a dynamic key (id-ish) OR the prompt mentions the
    // column name without also stating an obvious literal filter for that column.
    const nameLower = String(name).toLowerCase();
    const looksDynamic =
      /(^|_)(id|ids|uuid|guid|key|token|ref|code|slug|email|phone)$/.test(nameLower) ||
      nameLower.endsWith('_id') ||
      nameLower.endsWith('id');

    const esc = nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionsColumn = new RegExp(`\\b${esc}\\b`, 'i').test(lowerPrompt);

    // Heuristic: prose like "status active" / "status is active" implies a literal filter.
    const mentionsLiteralPair =
      mentionsColumn &&
      new RegExp(
        `\\b${esc}\\b\\s+(is\\s+)?(active|inactive|open|closed|paid|unpaid|pending|completed|cancelled)\\b`,
        'i'
      ).test(lowerPrompt);

    if (!mentionsColumn || looksDynamic || !mentionsLiteralPair) {
      out.add(name);
    }
  }

  return out;
}

/**
 * Decide which params the caller must pass.
 * If the prompt mentions at least one :name, only those names are required (compiled spec may add
 * extra :placeholders for optional schema fields — those are omitted at insert, not forced here).
 * If the prompt mentions none, fall back to every placeholder in the spec (SQL/Neo4j-friendly).
 */
function getParamsRequiredForCall(spec, promptText) {
  const fromSpec = getRequiredParamNames(spec);
  const fromPrompt = extractParamNamesFromPromptText(promptText || '');
  if (fromPrompt.size > 0) {
    return fromPrompt;
  }

  const db = getPersistedCompileDatabase();
  if (isRelationalSqlDatabaseName(db) && String(spec.type || '').toLowerCase() === 'select') {
    return filterSqlSelectPlaceholdersAgainstPrompt(spec, promptText, db);
  }

  return fromSpec;
}

function validateParamsForSpec(spec, params, promptText) {
  if (!spec || spec.type === 'needs_review' || spec.type === 'failed') return;
  const required = getParamsRequiredForCall(spec, promptText);
  if (required.size === 0) return;
  const given = params && typeof params === 'object' ? params : {};
  const missing = [];
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(given, name)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[Mask] Prompt expects parameter(s) ${missing.map((n) => `:${n}`).join(', ')} but they were not provided in the second argument. ` +
      `Missing: ${missing.join(', ')}. Pass them in the params object, e.g. { ${missing.map((n) => `${n}: value`).join(', ')} }.`
    );
  }
}

class MaskDatabase {
  /**
   * Execute a previously compiled query by its natural language prompt.
   *
   * At runtime this method:
   * 1. Looks up the prompt in .mask/queries/prompt-map.json to get a stable hash.
   * 2. Loads the compiled query functions from .mask/generated/queries.js.
   * 3. Invokes the query function with any provided parameters.
   *
   * No AI calls are made here. If the prompt is unknown, developers must run
   * the compiler again to generate the necessary query.
   *
   * @param {string} promptText - The exact natural language prompt found in source code.
   * @param {object} [params] - Optional named parameters for templated prompts.
   * @param {object} [options] - Optional third argument. For **MongoDB and Mongoose**, driver/query
   *   options normally come from compiled `driverOptions` (compile time), not this object.
   *   **`unwrapAggregationCount`**: if `false`, disables automatic scalar unwrapping for count-style
   *   aggregation prompts (see unwrapMongoAggregationScalar.js). Omit or `true` to allow unwrap when
   *   the prompt looks like a scalar count (e.g. `"count users"`) and the result shape matches.
   * @returns {Promise<*>} Query results.
   */
  static async prompt(promptText, params, options) {
    if (typeof promptText !== 'string' || !promptText.trim()) {
      throw new Error('MaskDatabase.prompt() requires a non-empty prompt string.');
    }
    const projectRoot = getProjectRoot();
    const callsite = extractUserCallsiteFromStack(new Error().stack, projectRoot);
    const lookupPrompt = resolveMaskPrompt(promptText);

    const promptMap = loadPromptMap();
    const compiledQueries = loadCompiledQueries();

    const hash = promptMap[lookupPrompt];
    if (!hash) {
      throw new Error(
        `No compiled query found for prompt: "${promptText}". ` +
          'Run your Mask compile command (e.g. "node mask.compile.cjs") to generate queries for all MaskDatabase.prompt() usages.'
      );
    }

    const queryFn = compiledQueries[hash];
    if (typeof queryFn !== 'function') {
      throw new Error(
        `Compiled query not found for hash "${hash}". ` +
          'Ensure the compiler successfully generated .mask/generated/queries.js.'
      );
    }

    const queryMeta = loadQueryMeta();
    const spec = queryMeta[hash];
    validateParamsForSpec(spec, params, lookupPrompt);
    let raw;
    try {
      raw = await queryFn(params || {}, options || {});
    } catch (err) {
      throw new MaskPromptExecutionError({
        promptText,
        promptHash: hash,
        callsite,
        specSummary: makeQuerySpecSummary(spec),
        cause: err
      });
    }
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.unwrapAggregationCount === false) {
      return raw;
    }
    const dbn = getPersistedCompileDatabase();
    if (
      (dbn === 'mongodb' || dbn === 'mongoose') &&
      spec &&
      spec.type === 'aggregation' &&
      promptLooksLikeScalarCountRequest(lookupPrompt)
    ) {
      const n = tryUnwrapMongoScalarAggregationCount(spec, raw);
      if (typeof n === 'number' && Number.isFinite(n)) {
        return n;
      }
    }
    return raw;
  }

  /**
   * Return the compiled query spec for a prompt so the UI can show the generated query without running it.
   * Use this to let developers verify the query (e.g. in a dev panel) before calling prompt().
   *
   * @param {string} promptText - The exact natural language prompt (same string as in MaskDatabase.prompt('...')).
   * @returns {{ spec: object, readable: string, hash: string } | null} The spec (type, collection, filter/pipeline, etc.),
   *   a human-readable query string, and the prompt hash; or null if the prompt is not compiled.
   */
  static getQueryForPrompt(promptText) {
    if (typeof promptText !== 'string' || !promptText.trim()) {
      return null;
    }
    let lookupPrompt;
    try {
      lookupPrompt = resolveMaskPrompt(promptText);
    } catch (_) {
      return null;
    }

    const promptMap = loadPromptMap();
    const hash = promptMap[lookupPrompt];
    if (!hash) {
      return null;
    }

    const queryMeta = loadQueryMeta();
    const spec = queryMeta[hash];
    if (!spec || spec.type === 'failed') {
      return { hash, spec: spec || null, readable: '(query not yet compiled or previously failed)' };
    }
    if (spec.type === 'needs_review') {
      return { hash, spec, readable: `(Prompt needs review: ${spec.warning || 'Unclear or nonsensical.'} Fix the prompt and re-run compile.)` };
    }

    const readable = MaskDatabase.formatQuerySpec(spec);
    return { hash, spec, readable };
  }

  /**
   * Format a compiled query spec as a human-readable string (e.g. for dev UI).
   *
   * @param {object} spec - Compiled spec from query-metadata.json: { type, collection, filter?, pipeline?, ... }.
   * @returns {string} Readable representation of the query.
   */
  static formatQuerySpec(spec) {
    if (!spec || typeof spec !== 'object') {
      return '';
    }
    const withDriverOpts = (base) => {
      if (!spec.driverOptions || typeof spec.driverOptions !== 'object') {
        return base;
      }
      const keys = Object.keys(spec.driverOptions);
      if (keys.length === 0) return base;
      return `${base}\n// driverOptions: ${JSON.stringify(spec.driverOptions)}`;
    };
    const coll = spec.collection || '?';
    if (spec.type === 'aggregation') {
      const pipeline = spec.pipeline;
      const pipelineStr = Array.isArray(pipeline)
        ? JSON.stringify(pipeline, null, 2)
        : '[]';
      return withDriverOpts(`db.collection('${coll}').aggregate(${pipelineStr})`);
    }
    if (spec.type === 'find') {
      const filter = spec.filter != null ? JSON.stringify(spec.filter, null, 2) : '{}';
      let out = `db.collection('${coll}').find(${filter})`;
      if (spec.projection && Object.keys(spec.projection).length > 0) {
        out += `.project(${JSON.stringify(spec.projection)})`;
      }
      if (spec.sort && Object.keys(spec.sort).length > 0) {
        out += `.sort(${JSON.stringify(spec.sort)})`;
      }
      if (spec.skip !== undefined && spec.skip !== null) {
        out += `.skip(${typeof spec.skip === 'number' ? spec.skip : JSON.stringify(spec.skip)})`;
      }
      if (spec.limit !== undefined && spec.limit !== null) {
        out += `.limit(${typeof spec.limit === 'number' ? spec.limit : JSON.stringify(spec.limit)})`;
      }
      out += '.toArray()';
      return withDriverOpts(out);
    }
    if (spec.type === 'insert') {
      if (spec.documentFromParams) {
        return withDriverOpts(`db.collection('${coll}').insertOne(<params as document>)`);
      }
      const doc = spec.documentTemplate != null ? JSON.stringify(spec.documentTemplate, null, 2) : '{}';
      return withDriverOpts(`db.collection('${coll}').insertOne(${doc})`);
    }
    if (spec.type === 'update') {
      const filter = spec.filter != null ? JSON.stringify(spec.filter, null, 2) : '{}';
      const method = spec.oneOrMany === 'many' ? 'updateMany' : 'updateOne';
      if (spec.setFieldsFromParams) {
        return withDriverOpts(`db.collection('${coll}').${method}(${filter}, { $set: <params not used in filter> })`);
      }
      const update = spec.updateTemplate != null ? JSON.stringify(spec.updateTemplate, null, 2) : '{}';
      return withDriverOpts(`db.collection('${coll}').${method}(${filter}, ${update})`);
    }
    if (spec.type === 'delete') {
      const filter = spec.filter != null ? JSON.stringify(spec.filter, null, 2) : '{}';
      const method = spec.oneOrMany === 'many' ? 'deleteMany' : 'deleteOne';
      return withDriverOpts(`db.collection('${coll}').${method}(${filter})`);
    }
    if (spec.type === 'needs_review') {
      return `(Prompt needs review: ${spec.warning || 'Unclear or nonsensical.'})`;
    }
    if (spec.query && ['select', 'insert', 'update', 'delete'].includes(spec.type)) {
      let sqlLine = `SQL (${spec.type}): ${spec.query}`;
      if (spec.dialect) {
        sqlLine += `\n// dialect: ${JSON.stringify(spec.dialect)}`;
      }
      return withDriverOpts(sqlLine);
    }
    if (spec.cypher && ['read', 'write'].includes(spec.type)) {
      let cy = `Cypher (${spec.type}): ${spec.cypher}`;
      if (spec.sessionMode) {
        cy += `\n// sessionMode: ${JSON.stringify(spec.sessionMode)}`;
      }
      return withDriverOpts(cy);
    }
    return JSON.stringify(spec);
  }
}

MaskDatabase._maskParamHelpers = {
  extractParamNamesFromPromptText,
  isRelationalSqlDatabaseName,
  filterSqlSelectPlaceholdersAgainstPrompt,
  getParamsRequiredForCall,
  validateParamsForSpec,
  extractUserCallsiteFromStack
};

module.exports = MaskDatabase;
