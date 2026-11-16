// The page contract (docs/DESKTOP.md "Contract with the web UI"), injected at document start into the main
// frame: <html> classes, window.harnessDesktop, the title-bar drag region, and one transport shim.
import Foundation

enum PageScript {
    /// `init` is JSON: { appVersion, actions, fullscreen }.
    static func source(init: String) -> String {
        return template.replacingOccurrences(of: "__HARNESS_INIT__", with: init)
    }

    private static let template = #"""
(function () {
  'use strict';
  if (window.top !== window) return;
  var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.harnessDesktop;
  if (!mh || window.harnessDesktop) return;
  var INIT = __HARNESS_INIT__;
  var ACTIONS = new Set(Array.isArray(INIT.actions) ? INIT.actions : []);
  var fullscreen = INIT.fullscreen === true;

  // ------------------------------------------------------------------ <html> classes
  function applyClasses() {
    var el = document.documentElement;
    if (!el) return false;
    if (!el.classList.contains('desktop')) el.classList.add('desktop');
    if (!el.classList.contains('desktop-mac')) el.classList.add('desktop-mac');
    if (!el.classList.contains('desktop-native')) el.classList.add('desktop-native');
    if (el.classList.contains('desktop-fullscreen') !== fullscreen) el.classList.toggle('desktop-fullscreen', fullscreen);
    return true;
  }
  var classObserver = null;
  function watchClasses() {
    if (classObserver || !document.documentElement) return;
    classObserver = new MutationObserver(function () { applyClasses(); });
    classObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  if (applyClasses()) {
    watchClasses();
  } else {
    var mo = new MutationObserver(function () { if (applyClasses()) { mo.disconnect(); watchClasses(); } });
    mo.observe(document, { childList: true, subtree: true });
  }
  document.addEventListener('DOMContentLoaded', function () { applyClasses(); watchClasses(); }, { once: true });

  // ------------------------------------------------------------------ menu actions
  var listeners = new Set();
  var pending = [];
  function deliver(action) {
    if (!ACTIONS.has(action)) return;
    if (listeners.size === 0) {
      pending.push({ action: action, at: Date.now() });
      if (pending.length > 10) pending.shift();
      return;
    }
    listeners.forEach(function (cb) {
      try { cb(action); } catch (err) { console.error('harnessDesktop.onMenuAction listener failed:', err); }
    });
  }
  function onMenuAction(cb) {
    if (typeof cb !== 'function') throw new TypeError('harnessDesktop.onMenuAction(callback) expects a function');
    listeners.add(cb);
    if (listeners.size === 1 && pending.length) {
      var fresh = pending.splice(0).filter(function (p) { return Date.now() - p.at < 10000; });
      setTimeout(function () {
        fresh.forEach(function (p) { try { cb(p.action); } catch (err) { console.error(err); } });
      }, 0);
    }
    return function () { listeners.delete(cb); };
  }

  // ------------------------------------------------------------------ calls into the app
  var seq = 0;
  var waiting = new Map();
  function call(op, arg) {
    return new Promise(function (resolve) {
      var id = ++seq;
      waiting.set(id, resolve);
      try { mh.postMessage({ id: id, op: op, arg: arg }); } catch (e) { waiting.delete(id); resolve(false); }
    });
  }
  function reply(id, value) {
    var r = waiting.get(id);
    if (r) { waiting.delete(id); r(value === true); }
  }
  var str = function (v) { return typeof v === 'string' ? v : ''; };

  var api = {
    platform: 'darwin',
    appVersion: typeof INIT.appVersion === 'string' ? INIT.appVersion : '',
    onMenuAction: onMenuAction,
    openExternal: function (url) { return call('openExternal', str(url)); },
    showInFolder: function (p) { return call('showInFolder', str(p)); },
    setBadge: function (text) { return call('setBadge', typeof text === 'number' || typeof text === 'string' ? text : ''); },
  };
  Object.defineProperty(window, 'harnessDesktop', { value: Object.freeze(api), enumerable: true, configurable: false, writable: false });
  Object.defineProperty(window, '__harnessNative', {
    value: Object.freeze({
      menuAction: deliver,
      fullscreen: function (v) { fullscreen = v === true; applyClasses(); },
      reply: reply,
    }),
    enumerable: false, configurable: false, writable: false,
  });

  // ------------------------------------------------------------------ title-bar drag region
  // WebKit has no -webkit-app-region, so the app drags the window when a press starts on the UI's title bar.
  var NO_DRAG = 'button, input, select, textarea, a, label, [role="button"], [contenteditable], .no-drag, [data-app-region="no-drag"]';
  var DRAG = '.titlebar, [data-app-region="drag"]';
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var t = e.target;
    if (!t || !t.closest || t.closest(NO_DRAG) || !t.closest(DRAG)) return;
    try { mh.postMessage({ op: e.detail === 2 ? 'titlebarDoubleClick' : 'dragWindow' }); } catch (err) { /* ignore */ }
  }, true);

  // ------------------------------------------------------------------ downloads of Harness's own files
  // <a download href="api/…">: the app fetches the file through the bridge and asks where to save it (the
  // download attribute's name is the suggestion). blob:/data: downloads are left to WebKit.
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[download]') : null;
    if (!a || e.button !== 0) return;
    var href = a.href || '';
    if (href.indexOf('harness://app/') !== 0) return;
    e.preventDefault();
    try { mh.postMessage({ op: 'download', arg: { url: href, name: a.getAttribute('download') || '' } }); } catch (err) { /* ignore */ }
  }, true);

  // ------------------------------------------------------------------ transport shim
  // WKWebView drops Blob/File request bodies for custom schemes (verified on macOS 26): send the bytes instead.
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (init && typeof Blob !== 'undefined' && init.body instanceof Blob) {
      var self = this;
      var blob = init.body;
      return blob.arrayBuffer().then(function (buf) {
        var headers = new Headers(init.headers || {});
        if (!headers.has('content-type') && blob.type) headers.set('content-type', blob.type);
        return origFetch.call(self, input, Object.assign({}, init, { body: buf, headers: headers }));
      });
    }
    return origFetch.apply(this, arguments);
  };
})();
"""#
}
