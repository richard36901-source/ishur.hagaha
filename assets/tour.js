/* 12/11 (Richard) · first-visit guided tour for dashboard.html and account.html.
   IshurTour.start(page, steps, { force })
     page   'dashboard' | 'account' — remembered per device (localStorage ishur_tour_<page>)
     steps  [{ el: '#id' | element, title, text }] — steps whose element is missing or hidden are skipped
   A spotlight (the dimmed page with a cut-out around the element), a small card with
   "שלב 2 מתוך 6", the title, one or two sentences, הקודם / הבא / דלגו על הכל. Esc closes.
   Any element with [data-tour-open] re-opens the tour with the steps given to start(). */
(function () {
  'use strict';
  var KEY = 'ishur_tour_';
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var css = '.tour-dim{position:fixed;inset:0;z-index:80;pointer-events:auto}' +
    '.tour-spot{position:absolute;border-radius:8px;box-shadow:0 0 0 9999px rgba(15,46,34,.58);transition:top .25s,left .25s,width .25s,height .25s;pointer-events:none;z-index:81}' +
    '.tour-card{position:absolute;z-index:82;width:min(92vw,340px);background:var(--card,#fff);color:var(--ink,#111827);border:1px solid var(--gold-pale,rgba(199,174,122,.3));border-radius:8px;padding:.9rem 1rem 1rem;box-shadow:0 14px 40px rgba(15,46,34,.22);font-family:Heebo,sans-serif;direction:rtl;text-align:start}' +
    '.tour-n{font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold,#A8853C);font-weight:600;margin-bottom:.25rem}' +
    '.tour-t{font-family:"Frank Ruhl Libre",serif;font-size:1.08rem;font-weight:700;margin:0 0 .3rem}' +
    '.tour-x{font-size:.9rem;line-height:1.55;color:var(--ink2,#374151);margin:0 0 .8rem}' +
    '.tour-b{display:flex;gap:.45rem;align-items:center}' +
    '.tour-b button{font:inherit;font-size:.86rem;font-weight:600;min-height:38px;padding:0 .9rem;border-radius:6px;border:1.5px solid var(--bdr,#e5e7eb);background:var(--card,#fff);color:var(--ink2,#374151);cursor:pointer}' +
    '.tour-b button.go{background:var(--green,#0F4C35);border-color:var(--green,#0F4C35);color:#fff}' +
    '.tour-b button.skip{margin-inline-start:auto;border:none;background:none;color:var(--ink3,#6b7280);font-weight:500;padding:0 .3rem}' +
    '.tour-dots{display:flex;gap:4px;margin:0 0 .6rem}.tour-dots i{width:6px;height:6px;border-radius:3px;background:var(--bdr,#e5e7eb)}.tour-dots i.on{background:var(--gold,#A8853C);width:16px}' +
    'html[data-theme=dark] .tour-card{background:var(--card,#1A201C);border-color:rgba(199,174,122,.35)}' +
    '@media (prefers-reduced-motion:reduce){.tour-spot{transition:none}}';
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  var state = null, lastSteps = null, lastPage = '';
  function visible(el) { if (!el) return false; var r = el.getBoundingClientRect(); return !!(r.width || r.height) && !el.hidden; }
  function resolve(steps) {
    return steps.map(function (s) { var el = typeof s.el === 'string' ? document.querySelector(s.el) : s.el; return el && visible(el) ? { el: el, title: s.title, text: s.text } : null; }).filter(Boolean);
  }
  function close(done) {
    if (!state) return;
    document.removeEventListener('keydown', onKey); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    state.dim.remove(); state.spot.remove(); state.card.remove();
    ls(KEY + state.page, done ? 'done' : 'skip'); state = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(false); if (e.key === 'ArrowLeft') next(); if (e.key === 'ArrowRight') prev(); }
  function place() {
    if (!state) return;
    var s = state.steps[state.i], r = s.el.getBoundingClientRect(), pad = 6;
    var top = r.top + window.scrollY, left = r.left + window.scrollX;
    state.spot.style.top = (top - pad) + 'px'; state.spot.style.left = (left - pad) + 'px';
    state.spot.style.width = (r.width + pad * 2) + 'px'; state.spot.style.height = (r.height + pad * 2) + 'px';
    var ch = state.card.offsetHeight, cw = state.card.offsetWidth;
    var below = r.bottom + 12 + ch < window.innerHeight || r.top - 12 - ch < 0;
    var cy = below ? r.bottom + window.scrollY + 12 : r.top + window.scrollY - 12 - ch;
    var cx = Math.max(8, Math.min(window.innerWidth - cw - 8, r.left + r.width / 2 - cw / 2));
    state.card.style.top = cy + 'px'; state.card.style.left = (cx + window.scrollX) + 'px';
  }
  function show(i) {
    state.i = i;
    var s = state.steps[i], n = state.steps.length;
    state.card.innerHTML = '<div class="tour-n">שלב ' + (i + 1) + ' מתוך ' + n + '</div>' +
      '<div class="tour-dots">' + state.steps.map(function (_, k) { return '<i' + (k === i ? ' class="on"' : '') + '></i>'; }).join('') + '</div>' +
      '<h3 class="tour-t"></h3><p class="tour-x"></p>' +
      '<div class="tour-b">' + (i > 0 ? '<button type="button" data-t="prev">הקודם</button>' : '') +
      '<button type="button" class="go" data-t="next">' + (i === n - 1 ? 'סיום' : 'הבא') + '</button>' +
      (i < n - 1 ? '<button type="button" class="skip" data-t="skip">דלגו על הכל</button>' : '') + '</div>';
    state.card.querySelector('.tour-t').textContent = s.title; state.card.querySelector('.tour-x').textContent = s.text;
    try { s.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { s.el.scrollIntoView(); }
    place(); setTimeout(place, 320); setTimeout(place, 650);
  }
  function next() { if (!state) return; if (state.i >= state.steps.length - 1) close(true); else show(state.i + 1); }
  function prev() { if (state && state.i > 0) show(state.i - 1); }
  function start(page, steps, opts) {
    opts = opts || {}; lastSteps = steps; lastPage = page;
    if (state) return false;
    if (!opts.force && ls(KEY + page)) return false;
    var list = resolve(steps); if (!list.length) return false;
    var dim = document.createElement('div'); dim.className = 'tour-dim';
    var spot = document.createElement('div'); spot.className = 'tour-spot';
    var card = document.createElement('div'); card.className = 'tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
    document.body.appendChild(dim); document.body.appendChild(spot); document.body.appendChild(card);
    state = { page: page, steps: list, i: 0, dim: dim, spot: spot, card: card };
    card.addEventListener('click', function (e) { var b = e.target.closest('[data-t]'); if (!b) return; if (b.dataset.t === 'next') next(); else if (b.dataset.t === 'prev') prev(); else close(false); });
    dim.addEventListener('click', function () { close(false); });
    document.addEventListener('keydown', onKey); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    show(0);
    try { if (window.posthog && posthog.capture) posthog.capture('tour_started', { page: page, steps: list.length, forced: !!opts.force }); } catch (e) {}
    return true;
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-tour-open]'); if (!a || !lastSteps) return;
    e.preventDefault(); start(lastPage, lastSteps, { force: true });
  });
  window.IshurTour = { start: start, close: close, seen: function (page) { return !!ls(KEY + page); } };
})();
