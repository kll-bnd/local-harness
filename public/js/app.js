// Harness web UI entry point. Every page load meets the security gate first (lock screen, first-run password
// setup, migration progress); only once Harness is unlocked and this window has a session are the UI-state
// store and the app itself loaded. Locking reloads the page, so nothing of the session outlives it.
import { runGate } from './gate.js';
import * as api from './api.js';
import { initUiState } from './ui-state.js';
import { isLockError } from './lockdown.js';
import { initMenuBridge } from './menu-bridge.js';

initMenuBridge();

async function open() {
  const { security, passwordReset } = await runGate();
  let state = {};
  try {
    state = (await api.uiState.get())?.state || {};
  } catch (e) {
    if (isLockError(e)) { location.reload(); return; }
    console.warn('[harness] could not read the UI state', e?.code);
  }
  initUiState(state);
  const main = await import('./main.js');
  await main.start({ security, passwordReset });
}

open();
