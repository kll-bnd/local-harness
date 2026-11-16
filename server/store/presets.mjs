// System-prompt presets / personas. Built-ins are read-only; user presets live in presets.json.
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { newId } from '../lib/ids.mjs';
import { nowIso } from '../lib/util.mjs';
import { badRequest, notFound, HttpError } from '../lib/errors.mjs';
import { obj, str, validatePatch, sanitizeValue } from './schema.mjs';
import { PARAMS_SCHEMA } from './settings.mjs';
import { isSafeId } from '../lib/ids.mjs';

export const BUILTIN_PRESETS = [
  {
    id: 'default',
    name: 'Assistant',
    description: 'Helpful, accurate general assistant.',
    systemPrompt: 'You are Harness, a helpful, knowledgeable assistant running entirely on the user\'s own computer. Be accurate and direct. Use Markdown for structure when it helps, and code blocks for code. If you are unsure, say so instead of guessing. Use the available tools when they help.',
    params: {},
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Short, to-the-point answers.',
    systemPrompt: 'You are a concise assistant. Answer in as few words as possible while staying correct and complete. Prefer bullet points. No preamble, no repetition of the question.',
    params: {},
  },
  {
    id: 'coder',
    name: 'Coding partner',
    description: 'Senior engineer: precise code, explains trade-offs.',
    systemPrompt: 'You are an expert software engineer and pair programmer. Write correct, idiomatic, well-structured code. Ask a clarifying question when requirements are ambiguous. When changing code, show only the relevant parts unless asked for the full file. Explain trade-offs briefly. Always use fenced code blocks with a language tag.',
    params: { temperature: 0.3 },
  },
  {
    id: 'writer',
    name: 'Writing editor',
    description: 'Improves clarity, tone and structure of text.',
    systemPrompt: 'You are a skilled editor. Improve clarity, flow, tone and structure while preserving the author\'s voice and meaning. When editing, return the revised text first, then a short list of the most important changes.',
    params: { temperature: 0.7 },
  },
  {
    id: 'tutor',
    name: 'Socratic tutor',
    description: 'Teaches by guiding with questions.',
    systemPrompt: 'You are a patient tutor. Help the user understand rather than just giving answers: ask guiding questions, give hints, check understanding, and explain concepts step by step with simple examples.',
    params: { temperature: 0.6 },
  },
];

// `params` only accepts sampling parameters (never num_ctx / keep_alive, which are sized from RAM).
const PRESET_SCHEMA = obj({ name: str({ nullable: false, max: 100 }), description: str({ max: 500 }), systemPrompt: str({ nullable: false, max: 50000 }), params: PARAMS_SCHEMA, icon: str({ max: 50 }) });

export class PresetStore {
  constructor(dataDir, bus) {
    this.file = path.join(dataDir, 'presets.json');
    this.bus = bus;
    this.user = [];
  }

  async load() {
    const j = await readJson(this.file, { version: 1, items: [] });
    this.user = [];
    for (const p of Array.isArray(j?.items) ? j.items : []) {
      if (!p || !isSafeId(p.id, 'preset') || typeof p.name !== 'string' || typeof p.systemPrompt !== 'string') continue;
      p.params = sanitizeValue(PARAMS_SCHEMA, p.params && typeof p.params === 'object' ? p.params : {}).value || {};
      this.user.push(p);
    }
    return this;
  }

  async save() { await writeJsonAtomic(this.file, { version: 1, items: this.user }); }

  list() {
    return [...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })), ...this.user.map((p) => ({ ...p, builtin: false }))];
  }

  get(id) {
    const b = BUILTIN_PRESETS.find((p) => p.id === id);
    if (b) return { ...b, builtin: true };
    const u = this.user.find((p) => p.id === id);
    return u ? { ...u, builtin: false } : null;
  }

  require(id) {
    const p = this.get(id);
    if (!p) throw notFound('Preset');
    return p;
  }

  async create(body) {
    const err = validatePatch(PRESET_SCHEMA, body);
    if (err) throw badRequest(err);
    if (!body.name || !body.systemPrompt) throw badRequest('name and systemPrompt are required');
    const now = nowIso();
    const p = { id: newId('preset'), name: body.name, description: body.description || '', systemPrompt: body.systemPrompt, params: body.params || {}, icon: body.icon || null, createdAt: now, updatedAt: now };
    this.user.push(p);
    await this.save();
    this.bus?.publish('presets.updated', {});
    return { ...p, builtin: false };
  }

  async update(id, patch) {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new HttpError(403, 'read_only', 'Built-in presets cannot be modified; create a copy instead');
    const p = this.user.find((x) => x.id === id);
    if (!p) throw notFound('Preset');
    const err = validatePatch(PRESET_SCHEMA, patch);
    if (err) throw badRequest(err);
    Object.assign(p, patch, { updatedAt: nowIso() });
    await this.save();
    this.bus?.publish('presets.updated', {});
    return { ...p, builtin: false };
  }

  async delete(id) {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new HttpError(403, 'read_only', 'Built-in presets cannot be deleted');
    const i = this.user.findIndex((x) => x.id === id);
    if (i < 0) throw notFound('Preset');
    const [p] = this.user.splice(i, 1);
    await this.save();
    this.bus?.publish('presets.updated', {});
    return p;
  }
}
