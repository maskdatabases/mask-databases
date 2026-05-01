'use strict';

/**
 * Compiler entry for programmatic use. CLI is in cli.js.
 */
const { compileOnce, runWithMaskConfig, parseArgs } = require('./compile');

module.exports = {
  compileOnce,
  runWithMaskConfig,
  parseArgs
};
