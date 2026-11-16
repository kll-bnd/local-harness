// What the machine actually experiences when a model is loaded (macOS only; elsewhere sizing stays estimate-only):
//  - resident size of Ollama's runner processes (`llama-server`, or `ollama runner` in older versions):
//    `ps -axo pid=,rss=,args=` — the ground truth for "how much RAM does this model take";
//  - memory pressure: swap in use (`sysctl -n vm.swapusage`), compressor pages (`vm_stat`) and
//    `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical). Real data: RSS UNDER-reports once macOS
//    compresses/swaps (4.3 → 2.6 GB as swap rose), and the pressure level stayed at 1 with 0.66 GB in swap — so
//    swap and compressor GROWTH right after a load are the "this does not fit" signal, not the level.
// Every call is bounded (2 s), never throws, and returns null when the information is unavailable.
import { execFile } from 'node:child_process';

const UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

function run(cmd, args, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout));
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** `ps -axo pid=,rss=,args=` output → runner processes. RSS is in KiB. */
export function parseRunners(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const args = m[3];
    const exe = args.split(/\s+/)[0];
    const isRunner = /(^|\/)llama-server$/.test(exe) || (/(^|\/)ollama$/.test(exe) && /\srunner(\s|$)/.test(args));
    if (!isRunner) continue;
    const blob = args.match(/--model\s+\S*?sha256-([0-9a-f]{64})/i);
    out.push({ pid: Number(m[1]), rssBytes: Number(m[2]) * 1024, args: args.slice(0, 2000), modelBlob: blob ? blob[1].toLowerCase() : null });
  }
  return out;
}

/** `sysctl -n vm.swapusage` ("total = 2048.00M  used = 658.25M  free = …") → used bytes. */
export function parseSwapUsage(text) {
  const m = String(text || '').match(/used\s*=\s*([\d.]+)\s*([KMGT])?/i);
  return m ? Math.round(Number(m[1]) * (UNITS[(m[2] || 'M').toUpperCase()] || 1)) : null;
}

/** `vm_stat` → bytes held by the compressor ("Pages occupied by compressor: N." × page size). */
export function parseVmStat(text) {
  const s = String(text || '');
  const page = Number(s.match(/page size of (\d+) bytes/i)?.[1]) || 16384;
  const occ = s.match(/Pages occupied by compressor:\s+(\d+)/i);
  return occ ? Number(occ[1]) * page : null;
}

/** Thresholds for "loading this model pushed the Mac into swap" (deltas between before and after a load). */
export const PRESSURE_THRESHOLDS = { swapGrowthBytes: 256 * 1024 ** 2, compressorGrowthBytes: 512 * 1024 ** 2 };

/** Compare two pressure snapshots: { swapDeltaBytes, compressedDeltaBytes, level, signal }. */
export function pressureDelta(before, after) {
  if (!before || !after) return null;
  const swapDeltaBytes = Number.isFinite(before.swapUsedBytes) && Number.isFinite(after.swapUsedBytes) ? after.swapUsedBytes - before.swapUsedBytes : null;
  const compressedDeltaBytes = Number.isFinite(before.compressedBytes) && Number.isFinite(after.compressedBytes) ? after.compressedBytes - before.compressedBytes : null;
  const level = Number.isFinite(after.level) ? after.level : null;
  const signal = (swapDeltaBytes ?? 0) >= PRESSURE_THRESHOLDS.swapGrowthBytes
    || (compressedDeltaBytes ?? 0) >= PRESSURE_THRESHOLDS.compressorGrowthBytes
    || (level !== null && level >= 2 && !(before.level >= 2));
  return { swapDeltaBytes, compressedDeltaBytes, level, swapUsedBytes: after.swapUsedBytes ?? null, compressedBytes: after.compressedBytes ?? null, signal };
}

/**
 * @param {{ platform?: string, exec?: (cmd, args) => Promise<string|null> }} [o]
 * @returns {null | { platform, runners(): Promise<Array|null>, pressure(): Promise<object|null> }}
 */
export function createMemoryProbe({ platform = process.platform, exec = run } = {}) {
  if (platform !== 'darwin') return null;
  return {
    platform,
    async runners() {
      const out = await exec('/bin/ps', ['-axo', 'pid=,rss=,args=']);
      return out === null ? null : parseRunners(out);
    },
    async pressure() {
      const [swap, vm, level] = await Promise.all([
        exec('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
        exec('/usr/bin/vm_stat', []),
        exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      ]);
      if (swap === null && vm === null) return null;
      const lv = Number(String(level || '').trim());
      return { swapUsedBytes: parseSwapUsage(swap), compressedBytes: parseVmStat(vm), level: Number.isFinite(lv) && String(level).trim() !== '' ? lv : null, at: Date.now() };
    },
  };
}

/** Is this backend on this machine (so its processes and memory are ours to read)? */
export function isLocalUrl(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h) || h === '0.0.0.0';
  } catch {
    return false;
  }
}
