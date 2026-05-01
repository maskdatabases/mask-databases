'use strict';

const { SQL_DATABASES } = require('./constants');

function isSqlDatabase(db) {
  return db && SQL_DATABASES.includes(String(db).toLowerCase());
}

/**
 * Load the compiler adapter for the given database.
 * Returns { generateQueriesModuleSource, generateModelsModuleSource, generateSchemaSql? }.
 */
function getCompilerAdapter(database) {
  const db = String(database || 'mongodb').toLowerCase();

  if (db === 'mongodb') {
    return require('../dbs/no-sql/mongo-db/compiler');
  }

  if (db === 'mongoose') {
    return require('../dbs/no-sql/mongoose/compiler');
  }

  if (isSqlDatabase(db)) {
    return require('../dbs/sql/sql/compiler');
  }

  if (db === 'neo4j') {
    return require('../dbs/no-sql/neo4j/compiler');
  }

  throw new (require('./errors').UnsupportedDbsError)(database);
}

module.exports = { getCompilerAdapter };
