'use strict';

const { generateQueriesModuleSource } = require('./codegen-queries');
const { generateModelsModuleSource } = require('./codegen-models');
const { generateSchemaSql, generateSingleTableSql } = require('./codegen-schema');

module.exports = {
  generateQueriesModuleSource,
  generateModelsModuleSource,
  generateSchemaSql,
  generateSingleTableSql
};
