'use strict';

const { SQL_DATABASES, ENGINE_ALIASES, KNOWN_SQL_ENGINES } = require("../package-config");

function getResolvedEngine(database) {
  const db = String(database || '').toLowerCase().trim();
  if (ENGINE_ALIASES[db]) return ENGINE_ALIASES[db];
  return db;
}

function isKnownSqlEngine(database) {
  return KNOWN_SQL_ENGINES.includes(getResolvedEngine(database));
}

module.exports = {
  SQL_DATABASES,
  getResolvedEngine,
  isKnownSqlEngine
};
