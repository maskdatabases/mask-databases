#!/usr/bin/env node
'use strict';

/**
 * mask-init: create .mask directory and mask.compile.cjs at project root.
 *   npx mask-init
 *   npx mask-init --template next-postgres
 *   npx mask-init --list-templates
 */

const path = require('path');
const fs = require('fs');

const templatesDir = path.join(__dirname, '..', 'templates');

function listTemplateIds() {
  if (!fs.existsSync(templatesDir)) return [];
  return fs
    .readdirSync(templatesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function loadTemplate(id) {
  const file = path.join(templatesDir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Build overrideConfig object source lines (syncApiKey empty until the user sets it). */
function overrideConfigLinesFrom(cfg) {
  const c = { ...(cfg || {}) };
  delete c.syncApiKey;
  const lines = [];
  lines.push(`      database: ${JSON.stringify(c.database != null ? c.database : 'mongodb')}`);
  lines.push(`      dbModulePath: ${JSON.stringify(c.dbModulePath != null ? c.dbModulePath : 'src/db')}`);
  lines.push('      // Set your Mask Databases API key, e.g. process.env.MASK_SYNC_API_KEY');
  lines.push("      syncApiKey: ''");
  for (const k of ['modelPaths', 'queryPaths', 'customClassNames', 'syncBaseUrl', 'registery']) {
    if (c[k] !== undefined) {
      lines.push(`      ${k}: ${JSON.stringify(c[k])}`);
    }
  }
  return lines.join(',\n');
}

function buildMaskCompileCjs(overrideLines) {
  return `'use strict';

const path = require('path');
const { runWithMaskConfig } = require('@local/mask/compiler');

async function main() {
  const projectRoot = path.resolve(__dirname);
  await runWithMaskConfig({
    watch: process.argv.includes('--watch'),
    projectRoot,
    overrideConfig: {
${overrideLines}
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;
}

const args = process.argv.slice(2);
if (args.includes('--list-templates') || args.includes('-l')) {
  console.log('[mask-init] Available templates (same IDs as Mask Databases):\n');
  for (const id of listTemplateIds()) {
    const t = loadTemplate(id);
    console.log(`  ${id}${t && t.name ? ` — ${t.name}` : ''}`);
  }
  process.exit(0);
}

let templateId = null;
const ti = args.indexOf('--template');
const tShort = args.indexOf('-t');
if (ti !== -1 && args[ti + 1]) templateId = args[ti + 1];
else if (tShort !== -1 && args[tShort + 1]) templateId = args[tShort + 1];

const template = templateId ? loadTemplate(templateId) : null;
if (templateId && !template) {
  console.error(`[mask-init] Unknown template "${templateId}". Run mask-init --list-templates`);
  process.exit(1);
}

const projectRoot = process.cwd();
const maskRoot = path.join(projectRoot, '.mask');
const defaultDirs = [
  maskRoot,
  path.join(maskRoot, 'queries'),
  path.join(maskRoot, 'models'),
  path.join(maskRoot, 'generated'),
  path.join(maskRoot, 'migrations'),
  path.join(maskRoot, 'system', 'queries'),
  path.join(maskRoot, 'system', 'models'),
  path.join(maskRoot, 'local', 'queries'),
  path.join(maskRoot, 'local', 'models')
];

const extraDirs = new Set(defaultDirs);
if (template && template.config) {
  for (const mp of template.config.modelPaths || []) {
    extraDirs.add(path.join(projectRoot, path.dirname(mp)));
  }
  for (const qp of template.config.queryPaths || []) {
    extraDirs.add(path.join(projectRoot, qp));
  }
}

for (const dir of [...extraDirs]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[mask-init] Created', path.relative(projectRoot, dir));
  }
}

const compilePath = path.join(projectRoot, 'mask.compile.cjs');
const configSource = template && template.config ? template.config : {
  database: 'mongodb',
  dbModulePath: 'src/db',
  modelPaths: ['src/tables.js'],
  queryPaths: ['src']
};

if (!fs.existsSync(compilePath)) {
  fs.writeFileSync(compilePath, buildMaskCompileCjs(overrideConfigLinesFrom(configSource)), 'utf8');
  console.log(
    template
      ? `[mask-init] Created mask.compile.cjs from template "${templateId}" (${template.name || templateId}).`
      : '[mask-init] Created mask.compile.cjs — set syncApiKey in the file (e.g. process.env.MASK_SYNC_API_KEY), then run node mask.compile.cjs.'
  );
} else if (template) {
  console.log('[mask-init] mask.compile.cjs already exists. Use --template only on a fresh project, or merge manually:');
  console.log(buildMaskCompileCjs(overrideConfigLinesFrom(configSource)));
} else {
  console.log('[mask-init] mask.compile.cjs already exists. Nothing to do.');
}
