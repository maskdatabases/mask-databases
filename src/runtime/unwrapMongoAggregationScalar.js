'use strict';

/**
 * If an aggregation returned exactly one "scalar count" document, return that number.
 * Used for count / how many prompts so callers get `2` instead of `[{ _id: null, count: 2 }]`
 * or `{ usersCount: [ { _id: null, count: 2 } ] }`.
 *
 * Conservative: only unwraps when the compiled pipeline's last stage (or $facet branch)
 * matches a global count pattern, or the result shape is an unambiguous single metric.
 */

function lastStage(pipeline) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) return null;
  return pipeline[pipeline.length - 1];
}

/** One non-_id key whose value is a finite number. */
function singleNumericMetric(doc) {
  if (!doc || typeof doc !== 'object') return undefined;
  const keys = Object.keys(doc).filter((k) => k !== '_id');
  if (keys.length !== 1) return undefined;
  const v = doc[keys[0]];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function tryUnwrapMongoScalarAggregationCount(spec, rows) {
  if (!spec || spec.type !== 'aggregation' || !Array.isArray(rows) || rows.length !== 1) {
    return undefined;
  }
  const doc = rows[0];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined;

  const pipeline = spec.pipeline;
  const last = lastStage(pipeline);

  if (last && typeof last.$count === 'string') {
    const k = last.$count;
    if (typeof doc[k] === 'number' && Number.isFinite(doc[k])) return doc[k];
  }

  if (last && last.$group && last.$group._id === null) {
    const n = singleNumericMetric(doc);
    if (n !== undefined) return n;
  }

  if (last && last.$facet && typeof last.$facet === 'object') {
    const topKeys = Object.keys(doc);
    if (topKeys.length === 1 && Array.isArray(doc[topKeys[0]]) && doc[topKeys[0]].length === 1) {
      const inner = doc[topKeys[0]][0];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        if (inner._id === null || inner._id === undefined) {
          if (typeof inner.count === 'number' && Number.isFinite(inner.count)) return inner.count;
          return singleNumericMetric(inner);
        }
      }
    }
  }

  // Global count shape without a reliable last stage in metadata (e.g. extra stages after $group in older specs)
  if (doc._id === null || doc._id === undefined) {
    if (typeof doc.count === 'number' && Number.isFinite(doc.count)) {
      const ks = Object.keys(doc);
      if (ks.length <= 2 && ks.includes('count')) return doc.count;
    }
    const n = singleNumericMetric(doc);
    if (n !== undefined) return n;
  }

  return undefined;
}

/** NL hints that the user asked for a single scalar count (not grouped breakdowns). */
function promptLooksLikeScalarCountRequest(promptText) {
  if (typeof promptText !== 'string') return false;
  const t = promptText.trim();
  if (!t) return false;
  return (
    /^count(\s|$)/i.test(t) ||
    /^how\s+many(\s|$)/i.test(t) ||
    /\btotal\s+number\s+of\b/i.test(t) ||
    /^total\s+number\b/i.test(t)
  );
}

module.exports = {
  tryUnwrapMongoScalarAggregationCount,
  promptLooksLikeScalarCountRequest
};
