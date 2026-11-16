// Minimal leveled logger. Level from HARNESS_LOG_LEVEL (debug|info|warn|error|silent).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let current = LEVELS[process.env.HARNESS_LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
  if (level in LEVELS) current = LEVELS[level];
}

let allToStderr = false;
/** Bridge mode: stdout carries frames only, so every log line goes to stderr. */
export function logToStderr(on = true) { allToStderr = on; }

function out(level, args) {
  if (LEVELS[level] < current) return;
  const ts = new Date().toISOString();
  const fn = allToStderr || level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[harness ${ts}] ${level.toUpperCase()}`, ...args);
}

export const log = {
  debug: (...a) => out('debug', a),
  info: (...a) => out('info', a),
  warn: (...a) => out('warn', a),
  error: (...a) => out('error', a),
};
