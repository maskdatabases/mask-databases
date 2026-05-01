'use strict';

const NUMERIC_OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte', '$eq', '$ne']);

function normalizeFilter(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(normalizeFilter);
  }
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (NUMERIC_OPERATORS.has(key) && typeof value === 'string' && !value.startsWith(':')) {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : value;
    } else {
      out[key] = normalizeFilter(value);
    }
  }
  return out;
}

module.exports = { normalizeFilter, NUMERIC_OPERATORS };
