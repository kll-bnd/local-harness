// Runs before first paint (classic script, no module) so the window never flashes the wrong theme.
// The only value Harness keeps in browser storage is the theme (not user content); everything else, including the
// authoritative theme, comes from the UI-state store after unlocking. Without it the system setting applies.
(function () {
  var root = document.documentElement;
  var theme = null;
  try { theme = JSON.parse(localStorage.getItem('harness.ui.theme') || 'null'); } catch (e) { theme = null; }
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  if (/Mac/.test(navigator.platform || '')) root.classList.add('platform-mac');
})();
