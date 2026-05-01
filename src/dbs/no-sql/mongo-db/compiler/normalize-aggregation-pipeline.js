'use strict';

const fs = require('fs');
const path = require('path');
const impl = require('./normalize-aggregation-pipeline-runtime.js');

/**
 * Source of normalize-aggregation-pipeline-runtime.js (no module wrapper), for inlining into generated queries.js.
 */
function getEmbeddedRuntimeSource() {
  let src = fs.readFileSync(path.join(__dirname, 'normalize-aggregation-pipeline-runtime.js'), 'utf8');
  src = src.replace(/^'use strict';\s*\r?\n?/, '');
  src = src.replace(/\r?\nmodule\.exports\s*=[\s\S]*$/m, '');
  return src.trim();
}

module.exports = {
  ...impl,
  getEmbeddedRuntimeSource
};
