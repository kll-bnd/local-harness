// The one place the version comes from: package.json `version` (bump it there; /api/health, /api/system and the
// bridge `ready` event report it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();
export const BRIDGE_PROTOCOL = 1;
