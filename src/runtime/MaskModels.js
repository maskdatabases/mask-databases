const fs = require('fs');
const { getPaths, getProjectRoot } = require('../paths');
const { getSyncConfig, loadMergedModelsPromptMap, loadMergedModelsMetadata } = require('../compiler/sync-data');
const { loadConfig } = require('../compiler/config');

let modelPromptMapCache = null;
let modelMetaCache = null;
let compiledModelsCache = null;
let pathsCache = null;

function getPathsForRuntime() {
  if (pathsCache) return pathsCache;
  pathsCache = getPaths(getProjectRoot());
  return pathsCache;
}

function loadModelPromptMap() {
  if (modelPromptMapCache) {
    return modelPromptMapCache;
  }

  const p = getPathsForRuntime();
  const useSync = !!getSyncConfig(p);

  if (useSync) {
    modelPromptMapCache = loadMergedModelsPromptMap(p, true);
    if (Object.keys(modelPromptMapCache).length === 0) {
      throw new Error(
        'Model prompt map not found. When using sync, expected data in .mask/local/models/ or .mask/system/models/. ' +
          'Please run your Mask compile command (e.g. "node mask.compile.cjs") before using MaskModels.define().'
      );
    }
    return modelPromptMapCache;
  }

  if (!fs.existsSync(p.models.promptMap)) {
    throw new Error(
      'Model prompt map not found. Expected at .mask/models/prompt-map.json. ' +
        'Please run your Mask compile command (e.g. "node mask.compile.cjs") before using MaskModels.define().'
    );
  }

  const raw = fs.readFileSync(p.models.promptMap, 'utf8');
  try {
    modelPromptMapCache = JSON.parse(raw || '{}');
    return modelPromptMapCache;
  } catch (err) {
    throw new Error(
      `Failed to parse .mask/models/prompt-map.json. ` +
        `Ensure the compiler completed successfully. Original error: ${err.message}`
    );
  }
}

function loadModelMeta() {
  if (modelMetaCache) return modelMetaCache;
  const p = getPathsForRuntime();
  const useSync = !!getSyncConfig(p);

  if (useSync) {
    modelMetaCache = loadMergedModelsMetadata(p, true);
    return modelMetaCache;
  }

  const metaPath = p.models.metadata;
  if (!fs.existsSync(metaPath)) return {};
  const raw = fs.readFileSync(metaPath, 'utf8');
  try {
    modelMetaCache = JSON.parse(raw || '{}');
    return modelMetaCache;
  } catch (_) {
    return {};
  }
}

function loadCompiledModels() {
  if (compiledModelsCache) {
    return compiledModelsCache;
  }

  const p = getPathsForRuntime();
  if (!fs.existsSync(p.generated.models)) {
    throw new Error(
      'Compiled models module not found. Expected at .mask/generated/models.js. ' +
        'Please run your Mask compile command (e.g. "node mask.compile.cjs") before using MaskModels.define().'
    );
  }

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const compiled = require(p.generated.models);

  if (!compiled || typeof compiled !== 'object') {
    throw new Error(
      'Invalid compiled models module. .mask/generated/models.js must export an object ' +
        'mapping model hashes to schema/metadata objects.'
    );
  }

  compiledModelsCache = compiled;
  return compiled;
}

class MaskModels {
  /**
   * Resolve a model definition by its natural language prompt.
   *
   * This uses only precompiled metadata generated at build time. If the
   * prompt is unknown, developers must run the compiler to (re)generate
   * the model metadata.
   *
   * @param {string} promptText - Natural language description of the model.
   * @returns {object} Model metadata and helper methods, as generated in .mask/generated/models.js
   */
  static define(promptText) {
    if (typeof promptText !== 'string' || !promptText.trim()) {
      throw new Error('MaskModels.define() requires a non-empty prompt string.');
    }

    const promptMap = loadModelPromptMap();
    const compiledModels = loadCompiledModels();

    const hash = promptMap[promptText];
    if (!hash) {
      throw new Error(
        `No compiled model found for prompt: "${promptText}". ` +
          'Run your Mask compile command (e.g. "node mask.compile.cjs") to generate models for all MaskModels.define() usages.'
      );
    }
    const model = compiledModels[hash];
    if (!model) {
      throw new Error(
        `Compiled model not found for hash "${hash}". ` +
          'Ensure the compiler successfully generated .mask/generated/models.js.'
      );
    }

    let database = 'mongodb';
    try {
      const cfg = loadConfig(getPathsForRuntime());
      database = String(cfg.database || 'mongodb').toLowerCase();
    } catch (_) {
      // compile config snapshot missing: keep default (MongoDB-style metadata object)
    }

    if (database === 'mongoose' && model && typeof model.buildSchema === 'function') {
      return model.buildSchema();
    }

    return model;
  }

  /**
   * Return the compiled model spec for a prompt so developers can inspect the generated
   * schema without instantiating the model. Works for all configured databases.
   *
   * @param {string} promptText - The exact prompt used in MaskModels.define('...').
   * @returns {{ hash: string, spec: object, readable: string } | null}
   */
  static getModelForPrompt(promptText) {
    if (typeof promptText !== 'string' || !promptText.trim()) {
      return null;
    }

    let promptMap;
    try {
      promptMap = loadModelPromptMap();
    } catch (_) {
      return null;
    }

    const hash = promptMap[promptText];
    if (!hash) {
      return null;
    }

    const meta = loadModelMeta();
    const spec = meta[hash];
    if (!spec) {
      return { hash, spec: null, readable: '(model not yet compiled)' };
    }

    const readable = MaskModels.formatModelSpec(spec);
    return { hash, spec, readable };
  }

  /**
   * Format a compiled model spec as a human-readable string.
   *
   * @param {object} spec - { collection, fields, relations, modelName? }
   * @returns {string}
   */
  static formatModelSpec(spec) {
    if (!spec || typeof spec !== 'object') return '';

    const parts = [];
    if (spec.modelName) {
      parts.push(`Model: ${spec.modelName}`);
    }
    parts.push(`Collection: ${spec.collection || '?'}`);

    if (spec.fields && typeof spec.fields === 'object') {
      const fieldLines = Object.entries(spec.fields).map(([name, def]) => {
        if (typeof def === 'object' && def !== null) {
          const attrs = [];
          attrs.push(def.type || 'any');
          if (def.required) attrs.push('required');
          if (def.unique) attrs.push('unique');
          if (def.ref) attrs.push(`ref:${def.ref}`);
          if (Array.isArray(def.enum) && def.enum.length) attrs.push(`enum:[${def.enum.join(',')}]`);
          return `  ${name}: ${attrs.join(', ')}`;
        }
        return `  ${name}: ${def}`;
      });
      parts.push(`Fields:\n${fieldLines.join('\n')}`);
    }

    if (Array.isArray(spec.relations) && spec.relations.length > 0) {
      const relLines = spec.relations.map((r) => {
        return `  ${r.name || '?'}: ${r.type || '?'} (${r.localField || '?'} -> ${r.foreignCollection || '?'}.${r.foreignField || '?'})`;
      });
      parts.push(`Relations:\n${relLines.join('\n')}`);
    }

    return parts.join('\n');
  }
}

module.exports = MaskModels;
