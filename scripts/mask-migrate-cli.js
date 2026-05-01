#!/usr/bin/env node

'use strict';

/**
 * Run pending SQL migrations from .mask/migrations/ in order.
 * Uses the project's getSqlConnection() so run from app root (where .mask/ lives).
 * Tracks applied migrations in table mask_migrations; only runs files not yet applied.
 * Rollback is not implemented; handle manually in the DB if needed.
 */

const path = require('path');
const fs = require('fs');
const { getPaths, getProjectRoot } = require('../src/paths');
const { loadConfig } = require('../src/compiler/config');
const { isKnownSqlEngine, SQL_DATABASES } = require('../src/compiler/constants');

const MASK_MIGRATIONS_TABLE = 'mask_migrations';

const CREATE_TABLE_MYSQL = `
CREATE TABLE IF NOT EXISTS \`${MASK_MIGRATIONS_TABLE}\` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`.trim();

const CREATE_TABLE_POSTGRES = `
CREATE TABLE IF NOT EXISTS "${MASK_MIGRATIONS_TABLE}" (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`.trim();

const CREATE_TABLE_SQLITE = `
CREATE TABLE IF NOT EXISTS "${MASK_MIGRATIONS_TABLE}" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT DEFAULT (datetime('now'))
);
`.trim();

async function ensureMigrationsTable(conn, database) {
  const db = String(database || 'mysql').toLowerCase();
  let sql;
  if (db === 'postgres' || db === 'postgresql') sql = CREATE_TABLE_POSTGRES;
  else if (db === 'sqlite') sql = CREATE_TABLE_SQLITE;
  else sql = CREATE_TABLE_MYSQL;
  const executor = conn.execute ? conn : conn.query ? conn : null;
  if (!executor) {
    throw new Error('[Mask] getSqlConnection() must return something with .execute(sql, params) or .query(sql, params).');
  }
  const run = conn.execute ? (s, p) => conn.execute(s, p) : (s, p) => conn.query(s, p);
  await run(sql, []);
}

async function getAppliedNames(conn, database) {
  const run = conn.execute ? (s, p) => conn.execute(s, p) : (s, p) => conn.query(s, p);
  const quoted = isKnownSqlEngine(database)
    ? (database === 'postgres' || database === 'postgresql' ? `"${MASK_MIGRATIONS_TABLE}"` : '`' + MASK_MIGRATIONS_TABLE + '`')
    : MASK_MIGRATIONS_TABLE;
  try {
    const res = await run(`SELECT name FROM ${quoted} ORDER BY id`, []);
    const rows = res && (Array.isArray(res) ? res[0] : res.rows || res);
    return new Set(Array.isArray(rows) ? rows.map((r) => r.name) : []);
  } catch (err) {
    if (err.message && /does not exist|no such table|Table.*doesn't exist/i.test(err.message)) {
      return new Set();
    }
    throw err;
  }
}

async function applyMigration(conn, name, sql, database) {
  const run = conn.execute ? (s, p) => conn.execute(s, p) : (s, p) => conn.query(s, p);
  await run(sql, []);
  const db = String(database || 'mysql').toLowerCase();
  let insertSql;
  if (db === 'postgres' || db === 'postgresql') {
    insertSql = `INSERT INTO "${MASK_MIGRATIONS_TABLE}" (name) VALUES ($1)`;
  } else if (db === 'sqlite') {
    insertSql = `INSERT INTO "${MASK_MIGRATIONS_TABLE}" (name) VALUES (?)`;
  } else if (isKnownSqlEngine(db)) {
    insertSql = `INSERT INTO \`${MASK_MIGRATIONS_TABLE}\` (name) VALUES (?)`;
  } else {
    insertSql = `INSERT INTO ${MASK_MIGRATIONS_TABLE} (name) VALUES (?)`;
  }
  await run(insertSql, [name]);
}

async function runMigrations(options = {}) {
  const projectRoot = options.projectRoot != null ? options.projectRoot : getProjectRoot();
  const paths = getPaths(projectRoot);
  if (!paths.migrations || !paths.migrations.dir) {
    console.error('[Mask] Migrations path not configured.');
    return { ok: false, exitCode: 1 };
  }
  const config = options.config != null ? options.config : loadConfig(paths);
  const db = String(config.database || '').toLowerCase();
  if (!db || !SQL_DATABASES.includes(db)) {
    console.error('[Mask] mask-migrate requires a SQL database in config (mysql, postgres, sqlite, oracle, mssql, etc.). Current database:', config.database);
    return { ok: false, exitCode: 1 };
  }

  let getSqlConnection = options.getSqlConnection;
  if (typeof getSqlConnection !== 'function') {
    const dbModulePath = path.resolve(projectRoot, config.dbModulePath);
    try {
      const dbModule = require(dbModulePath);
      getSqlConnection = dbModule.getSqlConnection || dbModule.default?.getSqlConnection;
      if (typeof getSqlConnection !== 'function') {
        throw new Error('DB module must export getSqlConnection()');
      }
    } catch (err) {
      console.error('[Mask] Failed to load DB module at', config.dbModulePath, err.message);
      return { ok: false, exitCode: 1 };
    }
  }

  let conn;
  try {
    conn = await getSqlConnection();
  } catch (err) {
    console.error('[Mask] getSqlConnection() failed:', err.message);
    return { ok: false, exitCode: 1 };
  }

  try {
    if (!fs.existsSync(paths.migrations.dir)) {
      console.log('[Mask] No .mask/migrations directory; nothing to run.');
      return { ok: true, exitCode: 0 };
    }

    const files = fs.readdirSync(paths.migrations.dir)
      .filter((n) => n.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('[Mask] No migration files in .mask/migrations/.');
      return { ok: true, exitCode: 0 };
    }

    if (isKnownSqlEngine(config.database)) {
      await ensureMigrationsTable(conn, config.database);
    } else {
      const zeroFile = path.join(paths.migrations.dir, '000_mask_migrations.sql');
      if (!fs.existsSync(zeroFile)) {
        console.error('[Mask] Dynamic database requires 000_mask_migrations.sql. Run node mask.compile.cjs first (with Mask Databases and syncApiKey).');
        return { ok: false, exitCode: 1 };
      }
    }
    const applied = await getAppliedNames(conn, config.database);
    let runCount = 0;
    for (const name of files) {
      if (applied.has(name)) continue;
      const filePath = path.join(paths.migrations.dir, name);
      const sql = fs.readFileSync(filePath, 'utf8').trim();
      if (!sql) continue;
      await applyMigration(conn, name, sql, config.database);
      runCount++;
      console.log('[Mask] Applied:', name);
    }
    if (runCount === 0) {
      console.log('[Mask] All migrations already applied.');
    } else {
      console.log('[Mask] Applied', runCount, 'migration(s).');
    }
    return { ok: true, exitCode: 0, runCount };
  } catch (err) {
    console.error('[Mask] Migration failed:', err.message);
    return { ok: false, exitCode: 1 };
  } finally {
    if (conn && typeof conn.end === 'function') {
      await conn.end().catch(() => {});
    } else if (conn && typeof conn.close === 'function') {
      await Promise.resolve(conn.close()).catch(() => {});
    }
  }
}

module.exports = { runMigrations, ensureMigrationsTable, getAppliedNames, applyMigration };

if (require.main === module) {
  runMigrations().then((result) => {
    if (result && result.exitCode) process.exitCode = result.exitCode;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
