'use strict';

/**
 * Turn Mask model field metadata (same shape as MongoDB compile) into JS source
 * for a mongoose.Schema paths object. Assumes `mongoose` is in scope.
 */
function fieldSpecToPathSource(spec) {
  if (!spec || typeof spec !== 'object') {
    return 'mongoose.Schema.Types.Mixed';
  }

  const typeStr = String(spec.type || 'string').toLowerCase();
  const isOid = typeStr === 'objectid';

  let typeExpr;
  if (isOid) {
    typeExpr = 'mongoose.Schema.Types.ObjectId';
  } else if (typeStr === 'number') {
    typeExpr = 'Number';
  } else if (typeStr === 'boolean') {
    typeExpr = 'Boolean';
  } else if (typeStr === 'date') {
    typeExpr = 'Date';
  } else {
    typeExpr = 'String';
  }

  const opts = [];
  if (spec.required === true) opts.push('required: true');
  if (spec.unique === true) opts.push('unique: true');
  if (Array.isArray(spec.enum) && spec.enum.length > 0) {
    opts.push(`enum: ${JSON.stringify(spec.enum)}`);
  }
  if (spec.ref && typeof spec.ref === 'string') {
    opts.push(`ref: ${JSON.stringify(spec.ref)}`);
  }
  if (Object.prototype.hasOwnProperty.call(spec, 'default')) {
    opts.push(`default: ${JSON.stringify(spec.default)}`);
  }

  if (opts.length === 0) {
    if (isOid && spec.ref) {
      return `{ type: mongoose.Schema.Types.ObjectId, ref: ${JSON.stringify(spec.ref)} }`;
    }
    if (isOid) {
      return '{ type: mongoose.Schema.Types.ObjectId }';
    }
    return typeExpr;
  }

  return `{ type: ${typeExpr}, ${opts.join(', ')} }`;
}

function buildPathsObjectSource(fields) {
  const entries = Object.entries(fields || {});
  if (entries.length === 0) {
    return '{}';
  }
  const lines = entries.map(([name, spec]) => {
    const safeKey = /^[a-zA-Z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    return `      ${safeKey}: ${fieldSpecToPathSource(spec)}`;
  });
  return `{\n${lines.join(',\n')}\n    }`;
}

function inferModelName(spec) {
  if (spec && typeof spec.modelName === 'string' && spec.modelName.trim()) {
    return spec.modelName.trim();
  }
  const c = String((spec && spec.collection) || 'model').replace(/[^a-zA-Z0-9_]/g, '') || 'model';
  return c.charAt(0).toUpperCase() + c.slice(1);
}

module.exports = { buildPathsObjectSource, inferModelName };
