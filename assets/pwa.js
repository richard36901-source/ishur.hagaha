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
  /* 26/11 Richard: two boxes with swipe + dots — "add to home screen" (when the browser can) and our App Store app.
     Both stay for now; the home-screen box goes once the app covers everything. */
  var APP_URL = 'https://apps.apple.com/il/app/id6837931770';
  var BADGE = 'https://tools.applemarketingtools.com/api/badges/download-on-the-app-store/black/he-il?size=250x83';
  var CSS = '.pw-car{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;direction:rtl}.pw-car::-webkit-scrollbar{display:none}' +
    '.pw-sl{flex:0 0 100%;scroll-snap-align:start;box-sizing:border-box}.pw-dots{display:flex;justify-content:center;gap:6px;margin-top:.7rem}' +
    '.pw-dot{width:7px;height:7px;border-radius:4px;border:none;padding:0;background:var(--bdr,#ccc);cursor:pointer;transition:width .2s}.pw-dot.on{width:18px;background:var(--green2,#0F4C35)}' +
    '.pw-app{display:flex;flex-direction:column;align-items:center;gap:.55rem;text-align:center}.pw-app img{height:46px;width:auto;display:block}' +
    '.pw-soon{font-size:.74rem;color:var(--ink3,#7F8C86);border:1px solid var(--bdr,#E1E4DE);border-radius:6px;padding:.15rem .55rem}';
  var lastMode = '';
  function paint(mode) {
    var c = card(); if (!c) return;
    if (mode !== undefined) lastMode = mode || '';
    if (standalone || ls(KEY_X)) { c.hidden = true; return; }
    if (!document.getElementById('pw-css')) { var st = document.createElement('style'); st.id = 'pw-css'; st.textContent = CSS; document.head.appendChild(st); }
    var b = c.querySelector('[data-pwa-body]'), slides = [], titles = [];
    if (lastMode === 'ios') {
      slides.push('<p style="margin:0 0 .4rem">כך הלוח נפתח כמו אפליקציה, בלחיצה אחת:</p><ol style="margin:0;padding-inline-start:1.2rem;line-height:1.8">' +
        '<li>לוחצים על כפתור השיתוף <span aria-hidden="true">⬆️</span> בתחתית ספארי</li><li>בוחרים <b>"הוספה למסך הבית"</b></li><li>לוחצים <b>"הוסף"</b></li></ol>');
      titles.push('📲 הוסיפו למסך הבית');
    } else if (lastMode === 'android') {
      slides.push('<p style="margin:0 0 .6rem">כך הלוח נפתח כמו אפליקציה, בלחיצה אחת מהמסך הראשי.</p><button type="button" class="buy" data-pwa-install>הוספה למסך הבית</button>');
      titles.push('📲 הוסיפו למסך הבית');
    }
    slides.push('<div class="pw-app"><p style="margin:0">האפליקציה של אישורי הגעה זמינה עכשיו באפסטור</p>' +
      '<a href="' + APP_URL + '" target="_blank" rel="noopener" aria-label="הורדה מהאפסטור"><img src="' + BADGE + '" alt="Download on the App Store"></a>' +
      '<span class="pw-soon">אנדרואיד · בקרוב</span></div>');
    titles.push('📱 הורידו את האפליקציה');
    b.innerHTML = '<div class="pw-car">' + slides.map(function (h) { return '<div class="pw-sl">' + h + '</div>'; }).join('') + '</div>' +
      (slides.length > 1 ? '<div class="pw-dots">' + slides.map(function (_, i) { return '<button type="button" class="pw-dot' + (i ? '' : ' on') + '" aria-label="תיבה ' + (i + 1) + '"></button>'; }).join('') + '</div>' : '');
    var head = c.querySelector('.card-h span'); if (head) head.textContent = titles[0];
    var car = b.querySelector('.pw-car'), dots = b.querySelectorAll('.pw-dot');
    function at() { return Math.round(Math.abs(car.scrollLeft) / Math.max(1, car.clientWidth)); }
    car.addEventListener('scroll', function () { var i = at(); for (var j = 0; j < dots.length; j++) dots[j].classList.toggle('on', i === j); if (head) head.textContent = titles[i] || titles[0]; }, { passive: true });
    for (var k = 0; k < dots.length; k++) (function (i) { dots[i].addEventListener('click', function () { car.scrollTo({ left: -i * car.clientWidth, behavior: 'smooth' }); }); })(k);
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
  function boot() { if (isIOS) paint('ios'); else paint(''); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.IshurPwa = { savedToken: function () { return ls(KEY_T) || ''; }, standalone: function () { return standalone; } };
})();
