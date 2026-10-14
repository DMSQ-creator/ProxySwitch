// Presentation only: no permissions, configuration reads, proxy writes or network.
(function (root, factory) {
  const api = factory(root);
  root.ProxySwitchUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const doc = root.document;
  let preference = 'system';
  let media = null;
  try { if (typeof root.matchMedia === 'function') media = root.matchMedia('(prefers-color-scheme: dark)'); } catch (_) {}

  function applyTheme(theme) {
    preference = theme === 'light' || theme === 'dark' ? theme : 'system';
    const resolved = preference === 'system' ? media && media.matches ? 'dark' : 'light' : preference;
    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('data-theme', resolved);
      doc.documentElement.setAttribute('data-theme-preference', preference);
      doc.documentElement.style.colorScheme = resolved;
    }
    return resolved;
  }
  const onSystemChange = () => { if (preference === 'system') applyTheme('system'); };
  if (media) {
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onSystemChange);
    else if (typeof media.addListener === 'function') media.addListener(onSystemChange);
  }

  // Small original geometric outlines, bundled rather than loaded from a CDN.
  const shapes = {
    grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
    route: '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h9a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h9"/>',
    'arrow-up-right': '<path d="M6 18 18 6M7 6h11v11"/>',
    settings: '<path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
    list: '<path d="M4 6h16M4 12h12M4 18h8"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
    cloud: '<path d="M6 18a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 18 8a5 5 0 0 1 0 10Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="m4 16 12-12 4 4L8 20H4Zm10-10 4 4M4 16l4 4"/>',
    trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
    undo: '<path d="M4 11h10a5 5 0 0 1 0 10M4 11l5-5M4 11l5 5"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
    upload: '<path d="M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    alert: '<path d="m12 3 10 18H2ZM12 9v4M12 17h.01"/>',
    'chevron-right': '<path d="m9 5 7 7-7 7"/>',
    'chevron-down': '<path d="m5 9 7 7 7-7"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 7M4 12l3 7a7 7 0 0 0 12-3"/>',
    external: '<path d="M14 4h6v6M20 4 10 14M10 4H4v16h16v-6"/>',
    moon: '<path d="M20 14A8 8 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4M8 21h8"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  function icon(name) {
    const shape = Object.prototype.hasOwnProperty.call(shapes, name) ? shapes[name] : shapes.info;
    return '<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + shape + '</svg>';
  }
  function setIcon(element, name) {
    if (element) element.innerHTML = icon(name);
  }
  function renderIcons(container) {
    const scope = container || doc;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('[data-icon]').forEach(element => setIcon(element, element.getAttribute('data-icon')));
  }
  if (doc) {
    applyTheme('system');
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => renderIcons(), { once: true });
    else renderIcons();
  }
  return Object.freeze({ applyTheme, icon, setIcon, renderIcons });
});
