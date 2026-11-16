// The UI's own state (drafts, collapsed panels, preferences) — kept here, encrypted with the rest of the data,
// instead of in browser storage, which would sit on disk in plain text. docs/API.md §10.4.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { HttpError } from '../lib/errors.mjs';

export const UI_STATE_MAX_BYTES = 1024 * 1024;

export class UiStateStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'ui-state.json');
    this.value = { state: {}, updatedAt: null };
  }

  async load() {
    const v = await readJson(this.file, null);
    if (v && typeof v === 'object' && v.state && typeof v.state === 'object' && !Array.isArray(v.state)) this.value = { state: v.state, updatedAt: v.updatedAt || null };
    return this;
  }

  get() { return { state: this.value.state, updatedAt: this.value.updatedAt }; }

  async _save(state) {
    if (Buffer.byteLength(JSON.stringify(state)) > UI_STATE_MAX_BYTES) throw new HttpError(413, 'payload_too_large', 'UI state is limited to 1 MiB');
    this.value = { state, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.file, this.value, { pretty: false });
    return { ok: true, updatedAt: this.value.updatedAt };
  }

  async replace(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new HttpError(400, 'bad_request', 'state must be a JSON object');
    return this._save(state);
  }

  async patch({ set, remove } = {}) {
    if (set !== undefined && (!set || typeof set !== 'object' || Array.isArray(set))) throw new HttpError(400, 'bad_request', 'set must be an object');
    if (remove !== undefined && (!Array.isArray(remove) || remove.some((k) => typeof k !== 'string'))) throw new HttpError(400, 'bad_request', 'remove must be an array of keys');
    const next = { ...this.value.state, ...(set || {}) };
    for (const k of remove || []) delete next[k];
    return this._save(next);
  }
}
