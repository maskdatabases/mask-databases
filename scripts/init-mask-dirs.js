#!/usr/bin/env node
'use strict';

/**
 * Post-install: create .mask directory structure and default mask.compile.cjs in the consuming project root.
 */



const path = require('path');
const fs = require('fs');

const thisScriptDir = __dirname;
const packageRoot = path.resolve(thisScriptDir, '..');

/**
 * Lifecycle scripts for dependencies run with cwd = the dependency package dir,
 * not the app that ran `npm install`. Use env + path heuristics so we scaffold
 * the real consumer project (works for npm flat layout and pnpm nested node_modules).
 */
function resolveConsumerProjectRoot() {
  const init = process.env.INIT_CWD && String(process.env.INIT_CWD).trim();
  if (init) {
    return path.resolve(init);
  }
  const localPrefix = process.env.npm_config_local_prefix && String(process.env.npm_config_local_prefix).trim();
  if (localPrefix) {
    return path.resolve(localPrefix);
  }
  let dir = path.resolve(packageRoot);
  const stop = path.parse(dir).root;
  let outermostHost = null;
  while (dir && dir !== stop) {
    if (path.basename(dir) === 'node_modules') {
      outermostHost = path.dirname(dir);
    }
    dir = path.dirname(dir);
  }
  if (outermostHost) {
    return outermostHost;
  }
  return process.cwd();
}

const projectRoot = resolveConsumerProjectRoot();
const resolvedProject = path.resolve(projectRoot);
const resolvedPackage = path.resolve(packageRoot);

const sameOrUnderPackage =
  resolvedProject === resolvedPackage ||
  resolvedProject.startsWith(resolvedPackage + path.sep);
if (sameOrUnderPackage) {
  process.exit(0);
}

const maskRoot = path.join(projectRoot, '.mask');
const dirs = [
  maskRoot,
  path.join(maskRoot, 'generated'),
  path.join(maskRoot, 'migrations'),
  path.join(maskRoot, 'system', 'queries'),
  path.join(maskRoot, 'system', 'models'),
  path.join(maskRoot, 'local', 'queries'),
  path.join(maskRoot, 'local', 'models')
];

for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const compileEntry = path.join(projectRoot, 'mask.compile.cjs');
if (!fs.existsSync(compileEntry)) {
  const body = `'use strict';

const path = require('path');
const { runWithMaskConfig } = require('mask-databases/compiler');

async function main() {
  const projectRoot = path.resolve(__dirname);
  await runWithMaskConfig({
    watch: process.argv.includes('--watch'),
    projectRoot,
    overrideConfig: {
      database: 'mongodb',
      dbModulePath: 'src/db',
      // Set your Mask Databases API key, e.g. process.env.MASK_SYNC_API_KEY
      syncApiKey: '',
      modelPaths: ['src'],
      queryPaths: ['src']
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;
  fs.writeFileSync(compileEntry, body, 'utf8');
}

process.exit(0);
