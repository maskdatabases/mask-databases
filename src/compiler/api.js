'use strict';

/**
 * Public programmatic API for the Mask compiler (mask.compile.cjs and tests).
 */
const { compileOnce, runWithMaskConfig, parseArgs } = require('./compile');
const {
  loadConfig,
  loadConfigWithMeta,
  loadOrCreateProjectProfile,
  readMaskConfigRawObject,
  normalizeAndValidateConfig,
  toMaterializedMaskConfigJson
} = require('./config');

module.exports = {
  compileOnce,
  runWithMaskConfig,
  parseArgs,
  loadConfig,
  loadConfigWithMeta,
  loadOrCreateProjectProfile,
  readMaskConfigRawObject,
  normalizeAndValidateConfig,
  toMaterializedMaskConfigJson
};
