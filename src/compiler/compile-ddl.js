'use strict';

/**
 * Convert compiler model spec to canonical schema for AI.
 * @param {{ collection: string, fields: object }} spec
 * @returns {{ tableName: string, columns: Array<{ name, type, required?, unique?, primaryKey?, autoIncrement? }> }}
 */
function toCanonicalSpec(spec) {
  if (!spec || typeof spec !== 'object' || !spec.collection) return null;
  const columns = [];
  const fields = spec.fields || {};
  const hasId = Object.prototype.hasOwnProperty.call(fields, 'id');
  for (const name of Object.keys(fields)) {
    const f = fields[name];
    const type = (f && f.type) ? String(f.type).toLowerCase() : 'string';
    const isInt = /int|number|integer/.test(type);
    const required =
      f && Object.prototype.hasOwnProperty.call(f, 'required')
        ? Boolean(f.required)
        : f && Object.prototype.hasOwnProperty.call(f, 'nullable')
          ? !Boolean(f.nullable)
          : false;
    const primaryKey =
      f && Object.prototype.hasOwnProperty.call(f, 'primaryKey')
        ? Boolean(f.primaryKey)
        : name === 'id' && isInt;
    const autoIncrement =
      f && Object.prototype.hasOwnProperty.call(f, 'autoIncrement')
        ? Boolean(f.autoIncrement)
        : name === 'id' && isInt;
    const defaultValue =
      f && Object.prototype.hasOwnProperty.call(f, 'default')
        ? f.default
        : f && Object.prototype.hasOwnProperty.call(f, 'defaultValue')
          ? f.defaultValue
          : undefined;
    columns.push({
      name,
      type: type === 'datetime' || type === 'date' ? type : type === 'text' ? 'text' : isInt ? 'integer' : 'string',
      required,
      unique: !!(f && f.unique),
      primaryKey,
      autoIncrement,
      nullable: f && Object.prototype.hasOwnProperty.call(f, 'nullable') ? Boolean(f.nullable) : undefined,
      default: defaultValue,
      onUpdate:
        f && Object.prototype.hasOwnProperty.call(f, 'onUpdate')
          ? f.onUpdate
          : f && f.onUpdateCurrentTimestamp
            ? 'CURRENT_TIMESTAMP'
            : undefined
    });
  }
  if (!hasId) {
    columns.unshift({ name: 'id', type: 'integer', primaryKey: true, autoIncrement: true });
  }
  return { tableName: spec.collection, columns };
}

/**
 * Canonical spec for mask_migrations table (used for unknown engines).
 */
function getMaskMigrationsCanonicalSpec() {
  return {
    tableName: 'mask_migrations',
    columns: [
      { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
      { name: 'name', type: 'string', required: true, unique: true },
      { name: 'applied_at', type: 'datetime' }
    ]
  };
}

module.exports = {
  toCanonicalSpec,
  getMaskMigrationsCanonicalSpec,
};
