// Tiny declarative validator used for settings, chat overrides and presets.
import { isPlainObject } from '../lib/util.mjs';

class V {
  constructor(check, opts = {}) { this.check = check; this.nullable = !!opts.nullable; this.desc = opts.desc || ''; }
}

export const num = (min = -Infinity, max = Infinity, { nullable = true, int = false, auto = false } = {}) =>
  new V((v, p) => {
    if (auto && v === 'auto') return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${p} must be a number${auto ? " or 'auto'" : ''}`;
    if (int && !Number.isInteger(v)) return `${p} must be an integer`;
    if (v < min || v > max) return `${p} must be between ${min} and ${max}`;
    return null;
  }, { nullable });

export const bool = ({ nullable = false } = {}) => new V((v, p) => (typeof v === 'boolean' ? null : `${p} must be a boolean`), { nullable });
export const str = ({ nullable = true, max = 100000 } = {}) => new V((v, p) => (typeof v === 'string' ? (v.length > max ? `${p} is too long` : null) : `${p} must be a string`), { nullable });
export const oneOf = (values, { nullable = false } = {}) => new V((v, p) => (values.includes(v) ? null : `${p} must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}`), { nullable });
export const any = ({ nullable = true } = {}) => new V(() => null, { nullable });
export const custom = (fn, { nullable = true } = {}) => new V(fn, { nullable });
export const arrayOf = (item, { nullable = false, max = 1000 } = {}) => Object.assign(new V((v, p) => {
  if (!Array.isArray(v)) return `${p} must be an array`;
  if (v.length > max) return `${p} has too many items`;
  for (let i = 0; i < v.length; i++) { const e = validateValue(item, v[i], `${p}[${i}]`); if (e) return e; }
  return null;
}, { nullable }), { item, max });
export const obj = (shape, { nullable = false, open = false, required = [] } = {}) => {
  const v = new V((val, p) => {
    if (!isPlainObject(val)) return `${p} must be an object`;
    for (const k of required) if (val[k] === undefined || val[k] === null) return `${p ? `${p}.` : ''}${k} is required`;
    for (const [k, x] of Object.entries(val)) {
      if (!(k in shape)) { if (open) continue; return `Unknown setting ${p ? `${p}.` : ''}${k}`; }
      const e = validateValue(shape[k], x, p ? `${p}.${k}` : k);
      if (e) return e;
    }
    return null;
  }, { nullable });
  v.shape = shape;
  v.open = open;
  v.required = required;
  return v;
};

export const modelRef = ({ nullable = true } = {}) => new V((v, p) => {
  if (!isPlainObject(v)) return `${p} must be {providerId, model} or null`;
  if (typeof v.model !== 'string' || !v.model) return `${p}.model must be a non-empty string`;
  if (v.providerId !== undefined && v.providerId !== null && typeof v.providerId !== 'string') return `${p}.providerId must be a string`;
  for (const k of Object.keys(v)) if (!['providerId', 'model'].includes(k)) return `Unknown key ${p}.${k}`;
  return null;
}, { nullable });

export function validateValue(validator, value, path) {
  if (value === null) return validator.nullable ? null : `${path} must not be null`;
  return validator.check(value, path);
}

/** Validate a (partial) patch against an obj() schema. Returns null or an error string. */
export function validatePatch(schema, patch) {
  return validateValue(schema, patch, '');
}

/**
 * Keep only the parts of `value` that pass `validator` (unknown keys, wrong types and invalid array items are
 * dropped instead of rejecting the whole value). Returns `{ value, dropped: [paths] }`; `value` is undefined
 * when nothing usable is left. Used to load stored files that may have been tampered with or written by an
 * older/newer version.
 */
export function sanitizeValue(validator, value, path = '') {
  const dropped = [];
  const here = path || '(root)';
  if (value === null) return validator.nullable ? { value: null, dropped } : { value: undefined, dropped: [here] };
  if (validator.shape) {
    if (!isPlainObject(value)) return { value: undefined, dropped: [here] };
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') { dropped.push(`${path}.${k}`); continue; }
      const p = path ? `${path}.${k}` : k;
      if (!(k in validator.shape)) { if (validator.open) out[k] = v; else dropped.push(p); continue; }
      const r = sanitizeValue(validator.shape[k], v, p);
      dropped.push(...r.dropped);
      if (r.value !== undefined) out[k] = r.value;
    }
    // An entry that lost a required field is dropped as a whole (e.g. a provider without a baseUrl).
    if ((validator.required || []).some((k) => out[k] === undefined || out[k] === null)) return { value: undefined, dropped: [...dropped, here] };
    return { value: out, dropped };
  }
  if (validator.item) {
    if (!Array.isArray(value)) return { value: undefined, dropped: [here] };
    const out = [];
    value.slice(0, validator.max ?? 1000).forEach((x, i) => {
      const r = sanitizeValue(validator.item, x, `${path}[${i}]`);
      dropped.push(...r.dropped);
      if (r.value !== undefined) out.push(r.value);
    });
    return { value: out, dropped };
  }
  const err = validateValue(validator, value, here);
  return err ? { value: undefined, dropped: [here] } : { value, dropped };
}
