'use strict';

/**
 * Fix common LLM / typo variants in MongoDB aggregation pipelines before compile persist or driver run.
 * Recurses into $facet branches, $lookup.pipeline, $unionWith.pipeline.
 *
 * Add new rules in fixUnwind / fixLookup / etc. — keep behavior idempotent.
 */

function fixUnwindObject(uw) {
  if (!uw || typeof uw !== 'object' || Array.isArray(uw)) {
    return uw;
  }
  const next = { ...uw };
  /** @type {Array<[string, string]>} */
  const renames = [
    ['preserveNullAndEmpty', 'preserveNullAndEmptyArrays'],
    ['preserveNullOrEmpty', 'preserveNullAndEmptyArrays'],
    ['preserveNullAndEmptyArray', 'preserveNullAndEmptyArrays']
  ];
  for (const [wrong, right] of renames) {
    if (Object.prototype.hasOwnProperty.call(next, wrong)) {
      const v = next[wrong];
      delete next[wrong];
      if (!Object.prototype.hasOwnProperty.call(next, right)) {
        next[right] = v;
      }
    }
  }
  return next;
}

function fixLookupObject(lu) {
  if (!lu || typeof lu !== 'object' || Array.isArray(lu)) {
    return lu;
  }
  const next = { ...lu };
  if (Array.isArray(next.pipeline)) {
    next.pipeline = normalizeAggregationPipeline(next.pipeline);
  }
  return next;
}

function fixFacetObject(facet) {
  if (!facet || typeof facet !== 'object' || Array.isArray(facet)) {
    return facet;
  }
  const next = {};
  for (const [name, sub] of Object.entries(facet)) {
    next[name] = Array.isArray(sub) ? normalizeAggregationPipeline(sub) : sub;
  }
  return next;
}

function fixUnionWithObject(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) {
    return u;
  }
  const next = { ...u };
  if (Array.isArray(next.pipeline)) {
    next.pipeline = normalizeAggregationPipeline(next.pipeline);
  }
  return next;
}

/**
 * Normalize one stage object (may contain multiple keys in malformed output; we still walk known ops).
 * @param {unknown} stage
 * @returns {unknown}
 */
function normalizeStage(stage) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
    return stage;
  }
  let out = { ...stage };

  if (Object.prototype.hasOwnProperty.call(out, '$unwind')) {
    out = { ...out, $unwind: fixUnwindObject(out.$unwind) };
  }
  if (Object.prototype.hasOwnProperty.call(out, '$lookup')) {
    out = { ...out, $lookup: fixLookupObject(out.$lookup) };
  }
  if (Object.prototype.hasOwnProperty.call(out, '$facet')) {
    out = { ...out, $facet: fixFacetObject(out.$facet) };
  }
  if (Object.prototype.hasOwnProperty.call(out, '$unionWith')) {
    out = { ...out, $unionWith: fixUnionWithObject(out.$unionWith) };
  }

  return out;
}

/**
 * @param {unknown} pipeline
 * @returns {unknown}
 */
function normalizeAggregationPipeline(pipeline) {
  if (!Array.isArray(pipeline)) {
    return pipeline;
  }
  return pipeline.map((stage) => normalizeStage(stage));
}

module.exports = {
  normalizeAggregationPipeline,
  normalizeStage,
  fixUnwindObject
};
