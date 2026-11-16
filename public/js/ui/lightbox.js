// Full-window image viewer with keyboard navigation and metadata. Images are always same-origin URLs.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { fmtBytes } from '../lib/format.js';

/**
 * openLightbox(images, index, { actions }) — images: [{ url, prompt?, seed?, width?, height?, model?, id? }]
 * actions(img) → [{ label, icon, run }] extra buttons for the current image.
 */
export function openLightbox(images, index = 0, { actions = null } = {}) {
  if (!images?.length) return;
  const returnFocus = document.activeElement;
  let i = Math.max(0, Math.min(index, images.length - 1));
  const imgEl = h('img.lb-img', { alt: '' });
  const meta = h('div.lb-meta');
  const counter = h('span.lb-count.num');
  const prev = h('button.icon-btn.lb-nav.lb-prev', { type: 'button', 'aria-label': 'Previous image', on: { click: () => go(-1) } }, icon('chevronLeft', { size: 20 }));
  const next = h('button.icon-btn.lb-nav.lb-next', { type: 'button', 'aria-label': 'Next image', on: { click: () => go(1) } }, icon('chevronRight', { size: 20 }));
  const bar = h('div.lb-actions');
  const dlg = h('dialog.lightbox', { attrs: { 'aria-label': 'Image viewer' } },
    h('div.lb-stage', { on: { click: (e) => { if (e.target.classList.contains('lb-stage')) close(); } } }, prev, imgEl, next),
    h('div.lb-foot', meta, h('div.row', counter, bar, h('button.icon-btn', { type: 'button', 'aria-label': 'Close', on: { click: () => close() } }, icon('x')))),
  );
  function render() {
    const img = images[i];
    imgEl.src = img.url;
    imgEl.alt = img.prompt || 'Image';
    meta.replaceChildren(
      img.prompt ? h('div.lb-prompt', img.prompt) : null,
      h('div.lb-sub.num', [img.width && img.height ? `${img.width}×${img.height}` : null, img.seed != null ? `seed ${img.seed}` : null, img.model || null, img.bytes ? fmtBytes(img.bytes) : null].filter(Boolean).join(' · ')),
    );
    counter.textContent = images.length > 1 ? `${i + 1} / ${images.length}` : '';
    prev.hidden = next.hidden = images.length < 2;
    bar.replaceChildren(
      h('a.icon-btn', { href: `${img.url}${img.url.includes('?') ? '&' : '?'}download=1`, title: 'Download', 'aria-label': 'Download', attrs: { download: '' } }, icon('download')),
      ...(actions ? actions(img, close) : []).map((a) => h('button.btn.btn-small', { type: 'button', on: { click: () => a.run(img, close) } }, a.icon ? icon(a.icon, { size: 14 }) : null, a.label)),
    );
  }
  function go(d) { i = (i + d + images.length) % images.length; render(); }
  function close() { dlg.close(); dlg.remove(); returnFocus?.focus?.(); }
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  render();
  dlg.showModal();
  dlg.querySelector('.lb-foot .icon-btn:last-child')?.focus();
}
