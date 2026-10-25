/* Shared "Install app" support for the PWAs in vibes/.
 *
 * Load it as a classic script in <head>, so it is listening before Chrome fires
 * beforeinstallprompt:
 *   <script src="../pwa/install.js"></script>
 *
 * Mark any element with data-pwa-install (a menu item, a button, a settings row).
 * It is shown only when installing is possible and clicking it installs:
 *   - Chromium (Android Chrome, Samsung Internet, Edge, desktop Chrome): the
 *     deferred beforeinstallprompt is replayed, i.e. the browser's own install dialog.
 *   - iOS / iPadOS Safari: there is no install API, so it shows how to use
 *     Share > Add to Home Screen.
 *   - Already running installed (standalone / fullscreen), or a browser with
 *     neither: the element stays hidden.
 * Visibility is set with style.display so app CSS such as `.item { display:flex }`
 * cannot override it; give the element style="display:none" in the HTML so it
 * does not flash before this runs.
 *
 * Also exposes window.pwaInstall = { state, install() } and fires a
 * 'pwa-install-change' event on window whenever state changes.
 * state: 'prompt' (Chromium, installable) | 'ios' (manual steps) | 'none'.
 */
(() => {
  'use strict';
  const SEL = '[data-pwa-install]';
  const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
  const isStandalone = () => mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)')
    || mq('(display-mode: minimal-ui)') || navigator.standalone === true;
  // iPadOS 13+ reports itself as a Mac; touch points give it away.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let deferred = null;
  let state = 'none';

  function compute() {
    if (isStandalone()) return 'none';
    if (deferred) return 'prompt';
    if (isIOS) return 'ios';
    return 'none';
  }

  function update() {
    const next = compute();
    document.querySelectorAll(SEL).forEach((el) => { el.style.display = next === 'none' ? 'none' : ''; });
    if (next !== state) {
      state = next;
      window.dispatchEvent(new CustomEvent('pwa-install-change', { detail: { state } }));
    }
  }

  async function install() {
    if (deferred) {
      const ev = deferred;
      deferred = null;              // an event can be prompted only once
      ev.prompt();
      let outcome = 'dismissed';
      try { ({ outcome } = await ev.userChoice); } catch { /* ignore */ }
      update();
      return outcome;
    }
    if (state === 'ios') { showHint(); return 'shown-hint'; }
    return 'unavailable';
  }

  let hintEl = null;
  function showHint() {
    if (hintEl) { hintEl.remove(); hintEl = null; return; }
    const el = document.createElement('div');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Install this app');
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:calc(16px + env(safe-area-inset-bottom))', 'transform:translateX(-50%)',
      'z-index:2147483647', 'max-width:min(92vw,360px)', 'padding:14px 16px 12px', 'border-radius:14px',
      'background:#1c1c1e', 'color:#f2f2f7', 'font:15px/1.4 -apple-system,system-ui,sans-serif',
      'box-shadow:0 8px 30px rgba(0,0,0,.45)', 'text-align:left',
    ].join(';');
    const share = '<svg width="16" height="18" viewBox="0 0 16 20" aria-hidden="true" style="vertical-align:-3px">'
      + '<path d="M8 1v12M4 5l4-4 4 4M3 9H1v10h14V9h-2" fill="none" stroke="#0a84ff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.innerHTML = '<b style="display:block;margin-bottom:4px">Install this app</b>'
      + `1. Tap Share ${share} in Safari's toolbar<br>2. Choose <b>Add to Home Screen</b><br>`
      + '<span style="color:#a1a1aa;font-size:13px">It then opens full screen and works offline.</span>'
      + '<button type="button" style="display:block;margin:10px 0 0 auto;padding:6px 14px;border:0;border-radius:8px;'
      + 'background:#0a84ff;color:#fff;font:inherit">OK</button>';
    const close = () => { el.remove(); if (hintEl === el) hintEl = null; };
    el.querySelector('button').addEventListener('click', close);
    setTimeout(close, 15000);
    document.body.appendChild(el);
    hintEl = el;
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();             // no mini-infobar; the app's own button offers it
    deferred = e;
    update();
  });
  window.addEventListener('appinstalled', () => { deferred = null; update(); });
  if (window.matchMedia) {
    ['standalone', 'fullscreen', 'minimal-ui'].forEach((m) => {
      const q = window.matchMedia(`(display-mode: ${m})`);
      if (q.addEventListener) q.addEventListener('change', update);
    });
  }

  // Capture phase, so app handlers that stopPropagation (popup menus) cannot swallow it.
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest(SEL);
    if (!el) return;
    e.preventDefault();
    install();
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', update);
  else update();

  window.pwaInstall = { get state() { return state; }, install, refresh: update };
})();
