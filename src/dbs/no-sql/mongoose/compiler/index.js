'use strict';

const { generateQueriesModuleSource } = require('./codegen-queries');
const { generateModelsModuleSource } = require('./codegen-models');

module.exports = {
  generateQueriesModuleSource,
  generateModelsModuleSource,
  generateSchemaSql: null
};
