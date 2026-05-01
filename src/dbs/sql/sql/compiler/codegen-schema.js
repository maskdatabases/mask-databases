'use strict';

const { SQL_DATABASES, getResolvedEngine, isKnownSqlEngine } = require('../../../../compiler/constants');
const { toCanonicalSpec } = require('../../../../compiler/compile-ddl');
const { callCentralCompileDdl } = require('../../../../compiler/remote-compile');

function isSqlDatabase(db) {
  return db && SQL_DATABASES.includes(String(db).toLowerCase());
}

/**
 * Model specs from Mask Databases may include Mongo-style `_id`. SQL tables use `id` (added below
 * when missing); a NOT NULL `_id` column breaks INSERTs that only set business columns.
 */
function fieldsForSqlDdl(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  for (const k of Object.keys(fields)) {
    if (k === '_id') continue;
    out[k] = fields[k];
  }
  return out;
}

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const token = value.trim().toLowerCase();
  if (!token) return undefined;
  if (['true', 'yes', 'y', '1'].includes(token)) return true;
  if (['false', 'no', 'n', '0'].includes(token)) return false;
  return undefined;
}

function getFlag(fieldSpec, keys) {
  if (!fieldSpec || typeof fieldSpec !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(fieldSpec, key)) {
      const parsed = parseBooleanFlag(fieldSpec[key]);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function isPrimaryKeyField(fieldName, fieldSpec) {
  const explicit = getFlag(fieldSpec, ['primaryKey', 'primary', 'pk']);
  if (explicit !== undefined) return explicit;
  const type = String((fieldSpec && fieldSpec.type) || '').toLowerCase();
  return fieldName === 'id' && /int|number|integer/.test(type);
}

function isAutoIncrementField(fieldName, fieldSpec) {
  const explicit = getFlag(fieldSpec, ['autoIncrement', 'autoincrement', 'identity', 'serial']);
  if (explicit !== undefined) return explicit;
  const type = String((fieldSpec && fieldSpec.type) || '').toLowerCase();
  return fieldName === 'id' && /int|number|integer/.test(type);
}

function getNullabilityMode(fieldSpec) {
  const nullable = getFlag(fieldSpec, ['nullable', 'null']);
  if (nullable !== undefined) return nullable ? 'NULL' : 'NOT NULL';
  const optional = getFlag(fieldSpec, ['optional']);
  if (optional !== undefined) return optional ? 'NULL' : 'NOT NULL';
  const required = getFlag(fieldSpec, ['required']);
  if (required !== undefined) return required ? 'NOT NULL' : 'NULL';
  return '';
}

function sqlDefaultLiteral(value, db) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') {
    return db === 'postgres' ? (value ? 'TRUE' : 'FALSE') : (value ? '1' : '0');
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.toUpperCase() === 'NULL') return 'NULL';
  const upper = raw.toUpperCase();
  const unquotedTokens = new Set([
    'CURRENT_TIMESTAMP',
    'CURRENT_DATE',
    'CURRENT_TIME',
    'NOW()'
  ]);
  if (unquotedTokens.has(upper)) return upper;
  const escaped = raw.replace(/'/g, "''");
  return `'${escaped}'`;
}

function mysqlOnUpdateClause(fieldSpec) {
  if (!fieldSpec || typeof fieldSpec !== 'object') return '';
  const currentTimestampFlag = getFlag(fieldSpec, ['onUpdateCurrentTimestamp', 'updateCurrentTimestamp']);
  if (currentTimestampFlag === true) return ' ON UPDATE CURRENT_TIMESTAMP';
  const onUpdate = fieldSpec.onUpdate;
  const lit = sqlDefaultLiteral(onUpdate, 'mysql');
  if (!lit) return '';
  return ` ON UPDATE ${lit}`;
}

function mysqlType(fieldName, fieldSpec) {
  if (!fieldSpec || typeof fieldSpec !== 'object') return 'VARCHAR(255)';
  const t = String((fieldSpec.type || 'string')).toLowerCase();
  if (t === 'string') return 'VARCHAR(255)';
  if (t === 'text') return 'TEXT';
  if (t === 'number' || t === 'integer' || t === 'int') return 'INT';
  if (t === 'bigint' || t === 'long') return 'BIGINT';
  if (t === 'boolean' || t === 'bool') return 'TINYINT(1)';
  if (t === 'date' || t === 'datetime') return 'DATETIME';
  if (t === 'objectid') return 'VARCHAR(24)';
  return 'VARCHAR(255)';
}

function postgresType(fieldName, fieldSpec) {
  if (!fieldSpec || typeof fieldSpec !== 'object') return 'VARCHAR(255)';
  const t = String((fieldSpec.type || 'string')).toLowerCase();
  if (t === 'string') return 'VARCHAR(255)';
  if (t === 'text') return 'TEXT';
  if (t === 'number' || t === 'integer' || t === 'int') return 'INTEGER';
  if (t === 'bigint' || t === 'long') return 'BIGINT';
  if (t === 'boolean' || t === 'bool') return 'BOOLEAN';
  if (t === 'date' || t === 'datetime') return 'TIMESTAMP';
  if (t === 'objectid') return 'VARCHAR(24)';
  return 'VARCHAR(255)';
}

function singleTableMysqlLines(spec) {
  if (!spec || !spec.collection) return null;
  const table = spec.collection;
  const fields = fieldsForSqlDdl(spec.fields || {});
  const colParts = [];
  const fieldNames = Object.keys(fields);
  const hasId = fieldNames.includes('id');
  for (const name of fieldNames) {
    const f = fields[name];
    let col = `  \`${name}\` ${mysqlType(name, f)}`;
    const primaryKey = isPrimaryKeyField(name, f);
    const autoIncrement = isAutoIncrementField(name, f);
    const nullability = getNullabilityMode(f);
    if (primaryKey) {
      if (autoIncrement) col += ' AUTO_INCREMENT';
      col += ' PRIMARY KEY';
    } else {
      if (nullability) col += ` ${nullability}`;
      if (f && f.unique) col += ' UNIQUE';
      const defaultLiteral = sqlDefaultLiteral(
        f && Object.prototype.hasOwnProperty.call(f, 'default') ? f.default : f && f.defaultValue,
        'mysql'
      );
      if (defaultLiteral) col += ` DEFAULT ${defaultLiteral}`;
      col += mysqlOnUpdateClause(f);
    }
    colParts.push(col);
  }
  if (!hasId && colParts.length > 0) {
    colParts.unshift('  id INT AUTO_INCREMENT PRIMARY KEY');
  } else if (!hasId) {
    colParts.push('  id INT AUTO_INCREMENT PRIMARY KEY');
  }
  return [
    `CREATE TABLE IF NOT EXISTS \`${table}\` (`,
    colParts.join(',\n'),
    ');'
  ];
}

function generateSingleTableMysql(spec) {
  const lines = singleTableMysqlLines(spec);
  return lines ? lines.join('\n') : null;
}

function generateMysqlSchema(modelMeta) {
  const lines = [
    '-- Auto-generated by mask-compile from MaskModels.define() definitions.',
    '-- Run once: mysql -u root -p < sql/schema.sql (or run in your MySQL client).',
    ''
  ];
  for (const [, spec] of Object.entries(modelMeta)) {
    const tableLines = singleTableMysqlLines(spec);
    if (tableLines) {
      lines.push(...tableLines);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function singleTablePostgresLines(spec) {
  if (!spec || !spec.collection) return null;
  const table = spec.collection;
  const fields = fieldsForSqlDdl(spec.fields || {});
  const colParts = [];
  const fieldNames = Object.keys(fields);
  const hasId = fieldNames.includes('id');
  for (const name of fieldNames) {
    const f = fields[name];
    let col = `  "${name}" ${postgresType(name, f)}`;
    const primaryKey = isPrimaryKeyField(name, f);
    const autoIncrement = isAutoIncrementField(name, f);
    const nullability = getNullabilityMode(f);
    if (primaryKey) {
      if (autoIncrement) col += ' GENERATED BY DEFAULT AS IDENTITY';
      col += ' PRIMARY KEY';
    } else {
      if (nullability) col += ` ${nullability}`;
      if (f && f.unique) col += ' UNIQUE';
      const defaultLiteral = sqlDefaultLiteral(
        f && Object.prototype.hasOwnProperty.call(f, 'default') ? f.default : f && f.defaultValue,
        'postgres'
      );
      if (defaultLiteral) col += ` DEFAULT ${defaultLiteral}`;
    }
    colParts.push(col);
  }
  if (!hasId) {
    colParts.unshift('  id INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY');
  }
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (`,
    colParts.join(',\n'),
    ');'
  ];
}

function generateSingleTablePostgres(spec) {
  const lines = singleTablePostgresLines(spec);
  return lines ? lines.join('\n') : null;
}

function sqliteType(fieldName, fieldSpec) {
  if (!fieldSpec || typeof fieldSpec !== 'object') return 'TEXT';
  const t = String((fieldSpec.type || 'string')).toLowerCase();
  if (t === 'string') return 'TEXT';
  if (t === 'text') return 'TEXT';
  if (t === 'number' || t === 'integer' || t === 'int') return 'INTEGER';
  if (t === 'bigint' || t === 'long') return 'INTEGER';
  if (t === 'boolean' || t === 'bool') return 'INTEGER';
  if (t === 'date' || t === 'datetime') return 'TEXT';
  if (t === 'objectid') return 'TEXT';
  return 'TEXT';
}

function singleTableSqliteLines(spec) {
  if (!spec || !spec.collection) return null;
  const table = spec.collection;
  const fields = fieldsForSqlDdl(spec.fields || {});
  const colParts = [];
  const fieldNames = Object.keys(fields);
  const hasId = fieldNames.includes('id');
  for (const name of fieldNames) {
    const f = fields[name];
    let col;
    const primaryKey = isPrimaryKeyField(name, f);
    const autoIncrement = isAutoIncrementField(name, f);
    const nullability = getNullabilityMode(f);
    if (primaryKey && autoIncrement) {
      col = '  "id" INTEGER PRIMARY KEY AUTOINCREMENT';
    } else {
      col = `  "${name}" ${sqliteType(name, f)}`;
      if (nullability) col += ` ${nullability}`;
      if (f && f.unique) col += ' UNIQUE';
      if (primaryKey) col += ' PRIMARY KEY';
      const defaultLiteral = sqlDefaultLiteral(
        f && Object.prototype.hasOwnProperty.call(f, 'default') ? f.default : f && f.defaultValue,
        'sqlite'
      );
      if (defaultLiteral) col += ` DEFAULT ${defaultLiteral}`;
    }
    colParts.push(col);
  }
  if (!hasId && colParts.length > 0) {
    colParts.unshift('  id INTEGER PRIMARY KEY AUTOINCREMENT');
  } else if (!hasId) {
    colParts.push('  id INTEGER PRIMARY KEY AUTOINCREMENT');
  }
  return [
    `CREATE TABLE IF NOT EXISTS "${table}" (`,
    colParts.join(',\n'),
    ');'
  ];
}

function generateSingleTableSqlite(spec) {
  const lines = singleTableSqliteLines(spec);
  return lines ? lines.join('\n') : null;
}

function generateSqliteSchema(modelMeta) {
  const lines = [
    '-- Auto-generated by mask-compile from MaskModels.define() definitions.',
    '-- SQLite: run via mask-migrate or sqlite3 CLI.',
    ''
  ];
  for (const [, spec] of Object.entries(modelMeta)) {
    const tableLines = singleTableSqliteLines(spec);
    if (tableLines) {
      lines.push(...tableLines);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function generatePostgresSchema(modelMeta) {
  const lines = [
    '-- Auto-generated by mask-compile from MaskModels.define() definitions.',
    '-- Run once in your PostgreSQL client.',
    ''
  ];
  for (const [, spec] of Object.entries(modelMeta)) {
    const tableLines = singleTablePostgresLines(spec);
    if (tableLines) {
      lines.push(...tableLines);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function generateSchemaSql(modelMeta, database) {
  if (!modelMeta || typeof modelMeta !== 'object') return null;
  const db = String(database || 'mysql').trim();
  if (!isSqlDatabase(db)) return null;
  const resolved = getResolvedEngine(db);
  if (resolved === 'postgres' || resolved === 'postgresql') {
    return generatePostgresSchema(modelMeta);
  }
  if (resolved === 'sqlite') {
    return generateSqliteSchema(modelMeta);
  }
  return generateMysqlSchema(modelMeta);
}

function generateSingleTableSql(spec, database, options) {
  if (!spec || typeof spec !== 'object') return null;
  const db = String(database || 'mysql').trim();
  if (!isSqlDatabase(db)) return null;
  const resolved = getResolvedEngine(db);
  if (isKnownSqlEngine(db)) {
    if (resolved === 'postgres' || resolved === 'postgresql') {
      return generateSingleTablePostgres(spec);
    }
    if (resolved === 'sqlite') {
      return generateSingleTableSqlite(spec);
    }
    return generateSingleTableMysql(spec);
  }
  const syncConfig = options && options.syncConfig;
  if (!syncConfig) {
    throw new Error(
        '[Mask] Dynamic DDL for "' +
          db +
          '" requires syncApiKey (mask.compile.cjs overrideConfig or MASK_SYNC_API_KEY when compiling). Then run node mask.compile.cjs.'
    );
  }
  const canonical = toCanonicalSpec(spec);
  if (!canonical) return null;
  return callCentralCompileDdl(syncConfig, db, canonical).then((r) => r.sql);
}

module.exports = {
  generateSchemaSql,
  generateMysqlSchema,
  generatePostgresSchema,
  generateSqliteSchema,
  generateSingleTableMysql,
  generateSingleTablePostgres,
  generateSingleTableSqlite,
  generateSingleTableSql
};
