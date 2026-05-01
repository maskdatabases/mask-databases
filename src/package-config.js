'use strict';

const MASK_DATABASES_DEFAULT_URL = 'https://maskdatabases.com';
const MASK_PREFIX = 'mask-';
const MAX_PROMPT_BYTES = 200000;
/** Directories to skip when scanning the whole project (model discovery). */
const DEFAULT_IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    '.mask',
    'dist',
    'build',
    '.next',
    'coverage',
    '.nyc_output',
    '.cache',
    'tmp',
    'temp',
    'vendor',
    'bower_components'
  ]);
const MAX_COMPILE_RETRIES = 3;

const SQL_DATABASES = ['mysql', 'postgres', 'postgresql', 'sqlite', 'sql', 'oracle', 'mariadb', 'cockroachdb'];

/** Engines with built-in DDL generators. */
const KNOWN_SQL_ENGINES = Object.freeze(['mysql', 'postgres', 'postgresql', 'sqlite']);

/** Alias -> resolved engine for DDL (reuse existing generator). */
const ENGINE_ALIASES = Object.freeze({
  mariadb: 'mysql',
  cockroachdb: 'postgres'
});

/** Shared discovery for all Node/JS/TS; only database and placeholderFormat may differ per adapter. */
const NODE_TS_DISCOVERY = {
  fileExtensions: ['.js', '.ts', '.mjs', '.cjs'],
  sourceDirs: ['src'],
  modelsDir: 'src/models',
  lineCommentStart: '//',
  blockCommentStart: '/*',
  blockCommentEnd: '*/',
  stringDelimiters: ['"', "'", '`'],
  promptCallNames: ['MaskDatabase'],
  modelDefineNames: ['MaskModels'],
  /** Patterns are derived from promptCallNames / modelDefineNames in discovery.js unless overridden in profile.json */
  placeholderFormat: ':paramName'
};

const BUILT_IN_PROFILES = {
  'node-mongodb': { ...NODE_TS_DISCOVERY, database: 'mongodb' },
  'node-mongoose': { ...NODE_TS_DISCOVERY, database: 'mongoose' },
  'node-mysql': { ...NODE_TS_DISCOVERY, database: 'mysql' },
  'node-mariadb': { ...NODE_TS_DISCOVERY, database: 'mariadb' },
  'node-postgres': { ...NODE_TS_DISCOVERY, database: 'postgres' },
  'node-postgresql': { ...NODE_TS_DISCOVERY, database: 'postgresql' },
  'node-sqlite': { ...NODE_TS_DISCOVERY, database: 'sqlite' },
  'node-oracle': { ...NODE_TS_DISCOVERY, database: 'oracle' },
  'node-neo4j': { ...NODE_TS_DISCOVERY, database: 'neo4j' }
};

const SUPPORTED_LANGUAGE = 'node';

module.exports = {
  MASK_DATABASES_DEFAULT_URL,
  MASK_PREFIX,
  MAX_PROMPT_BYTES,
  DEFAULT_IGNORE_DIRS,
  MAX_COMPILE_RETRIES,
  SQL_DATABASES,
  KNOWN_SQL_ENGINES,
  ENGINE_ALIASES,
  BUILT_IN_PROFILES,
  SUPPORTED_LANGUAGE,
};