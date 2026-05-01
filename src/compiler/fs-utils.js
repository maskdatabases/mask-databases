'use strict';

const fs = require('fs');
const path = require('path');
const { getPaths } = require('../paths');

function loadJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) {
    return defaultValue;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err.message}`);
  }
}

function saveJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureMaskDirs(paths) {
  const p = paths || getPaths(process.cwd());
  if (!fs.existsSync(p.root)) {
    fs.mkdirSync(p.root, { recursive: true });
  }
  [p.generated.dir, p.migrations.dir, p.system.queries.dir, p.system.models.dir, p.local.queries.dir, p.local.models.dir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

module.exports = {
  loadJsonFile,
  saveJsonFile,
  ensureMaskDirs
};
