/* 03/11 · "הוסיפו למסך הבית" for the client dashboard. Loaded by dashboard.html only.
   Registers sw.js with scope "dashboard.html", remembers the event token for the
   home-screen launch (start_url has no token), and shows the explainer card:
     iOS Safari → share → "הוספה למסך הבית"; Android/Chrome → beforeinstallprompt.
   Hidden once running installed (display-mode: standalone) or after "×". */
(function () {
  'use strict';
  var KEY_T = 'ishur_pwa_t', KEY_X = 'ishur_pwa_x';
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var qs = new URLSearchParams(location.search);
  var t = (qs.get('t') || '').trim();
  if (/^[0-9a-f-]{36}$/i.test(t)) ls(KEY_T, t);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js', { scope: 'dashboard.html' })['catch'](function () {}); });
  }

  var deferred = null;
  function card() { return document.getElementById('pwaCard'); }
  function paint(mode) {
    var c = card(); if (!c) return;
    if (standalone || ls(KEY_X)) { c.hidden = true; return; }
    var b = c.querySelector('[data-pwa-body]');
    if (mode === 'ios') {
      b.innerHTML = '<p style="margin:0 0 .4rem">כך הלוח נפתח כמו אפליקציה, בלחיצה אחת:</p><ol style="margin:0;padding-inline-start:1.2rem;line-height:1.8">' +
        '<li>לוחצים על כפתור השיתוף <span aria-hidden="true">⬆️</span> בתחתית ספארי</li><li>בוחרים <b>"הוספה למסך הבית"</b></li><li>לוחצים <b>"הוסף"</b></li></ol>';
    } else if (mode === 'android') {
      b.innerHTML = '<p style="margin:0 0 .6rem">כך הלוח נפתח כמו אפליקציה, בלחיצה אחת מהמסך הראשי.</p><button type="button" class="buy" data-pwa-install>הוספה למסך הבית</button>';
    } else { c.hidden = true; return; }
    c.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; paint('android'); });
  window.addEventListener('appinstalled', function () { standalone = true; deferred = null; paint(); });
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-pwa-x]')) { ls(KEY_X, '1'); paint(); return; }
    if (e.target.closest('[data-pwa-install]') && deferred) {
      deferred.prompt();
      (deferred.userChoice || Promise.resolve({})).then(function (r) { if (r && r.outcome === 'accepted') { ls(KEY_X, '1'); } deferred = null; paint(); });
    }
  });
  function boot() { if (isIOS) paint('ios'); else paint(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.IshurPwa = { savedToken: function () { return ls(KEY_T) || ''; }, standalone: function () { return standalone; } };
})();
