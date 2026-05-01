#!/usr/bin/env node

'use strict';

/**
 * Mask compiler CLI. Loads project-root .env (optional), then runs mask.compile.cjs
 * which must call runWithMaskConfig({ overrideConfig, projectRoot, watch }).
 */

const path = require('path');
const fs = require('fs');
const { getProjectRoot, resolveMaskCompilePath, MASK_COMPILE } = require('../paths');

const projectRoot = getProjectRoot();

try {
  require('dotenv').config({ path: path.join(projectRoot, '.env') });
} catch (_) {
  /* optional dependency */
}

const entry = resolveMaskCompilePath(projectRoot);
if (!fs.existsSync(entry)) {
  /* eslint-disable no-console */
  console.error(
    `[Mask] Missing ${MASK_COMPILE} at the project root. Run: npx mask-init`
  );
  /* eslint-enable no-console */
  process.exit(1);
}

// eslint-disable-next-line import/no-dynamic-require, global-require
require(entry);
