'use strict';
// Copy console output (the backend logs through console.*) into <data dir>/logs/harness.log, because
// a Finder-launched app has no terminal. Rotates once at startup when the file exceeds `maxBytes`.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

function rotateIfLarge(file, maxBytes) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
  } catch { /* missing: nothing to rotate */ }
}

/**
 * @returns {{ file: string, close: () => void }}
 */
function teeConsoleToFile(file, { maxBytes = 5 * 1024 * 1024, consoleObj = console } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfLarge(file, maxBytes);
  const fd = fs.openSync(file, 'a');
  const write = (line) => { try { fs.writeSync(fd, line); } catch { /* disk full etc. */ } };
  const original = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    original[level] = consoleObj[level];
    consoleObj[level] = (...args) => {
      const text = util.format(...args);
      // Backend lines already carry "[harness <ts>] LEVEL"; prefix the rest with a timestamp.
      write(text.startsWith('[harness ') ? `${text}\n` : `[${new Date().toISOString()}] ${level.toUpperCase()} ${text}\n`);
      try { original[level].apply(consoleObj, args); } catch { /* stdout closed (EPIPE) when launched from Finder */ }
    };
  }
  return {
    file,
    close() {
      for (const k of Object.keys(original)) consoleObj[k] = original[k];
      try { fs.closeSync(fd); } catch { /* ignore */ }
    },
  };
}

module.exports = { teeConsoleToFile, rotateIfLarge };
