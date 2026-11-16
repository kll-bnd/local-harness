import { HttpError } from '../lib/errors.mjs';

export class Reply {
  constructor(status, body, headers = {}) { this.status = status; this.body = body; this.headers = headers; }
}
export const created = (body) => new Reply(201, body);

export function qBool(v, dflt = false) {
  if (v === null || v === undefined || v === '') return dflt;
  return v === '1' || v === 'true' || v === 'yes';
}

export function qInt(v, dflt, { min = 0, max = 10000 } = {}) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, 'bad_request', `Invalid number: ${v}`);
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function requireString(v, name, { max = 1_000_000, allowEmpty = false } = {}) {
  if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new HttpError(400, 'bad_request', `${name} must be a non-empty string`);
  if (v.length > max) throw new HttpError(400, 'bad_request', `${name} is too long`);
  return v;
}

export function modelRefFrom(body) {
  if (body == null) return null;
  if (typeof body === 'string') return { model: body };
  if (typeof body === 'object' && typeof body.model === 'string' && body.model) return { model: body.model, ...(body.providerId ? { providerId: String(body.providerId) } : {}) };
  throw new HttpError(400, 'bad_request', 'model must be {providerId?, model}');
}
