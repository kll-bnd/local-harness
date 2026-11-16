// Hash router: #/chat/<id>, #/new, #/images, #/models, #/memory, #/settings/<section>, #/setup.
import { store } from './state.js';

export function parseRoute(hash = location.hash) {
  const p = hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(hash.split('?')[1] || '');
  switch (p[0]) {
    case 'chat': return p[1] ? { view: 'chat', chatId: p[1], query } : { view: 'chat', chatId: null, query };
    case 'images': return { view: 'images', query };
    case 'models': return { view: 'models', query };
    case 'memory': return { view: 'memory', query };
    case 'settings': return { view: 'settings', section: p[1] || 'general', query };
    case 'setup': return { view: 'setup', query };
    default: return { view: 'chat', chatId: null, query };
  }
}

export function navigate(path, { replace = false } = {}) {
  const hash = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === hash) { store.set('route', parseRoute(hash)); return; }
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  store.set('route', parseRoute(hash));
}

export function startRouter() {
  const apply = () => store.set('route', parseRoute());
  window.addEventListener('hashchange', apply);
  window.addEventListener('popstate', apply);
  apply();
}
