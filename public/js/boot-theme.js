// Runs before first paint (classic script, no module) so the window never flashes the wrong theme.
// The authoritative values live in settings.ui on the server; these localStorage mirrors are only hints.
(function () {
  var root = document.documentElement;
  function read(k) { try { var v = localStorage.getItem('harness.ui.' + k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }
  var theme = read('theme');
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  var size = read('textSize');
  if (size === 'small' || size === 'large') root.setAttribute('data-text-size', size);
  if (read('proseFont') === 'serif') root.setAttribute('data-prose', 'serif');
  if (/Mac/.test(navigator.platform || '')) root.classList.add('platform-mac');
})();
