// Memory baseline: load the real UI (first-run password screen), do nothing for a while, quit cleanly.
(async () => {
  await new Promise((r) => setTimeout(r, Number(window.__idleSeconds || 25) * 1000));
  await native('result', { key: 'idle', value: { ok: location.href.startsWith('harness://app/') && !!document.querySelector('#app'), href: location.href } });
  await native('finish', { status: 'idle-done' });
})();
