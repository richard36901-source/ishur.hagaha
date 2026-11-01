/* ishur.io · send board renderer ("נשלחו מתוך כמה", Richard 01/11)
   One call: POST /api/send-board {admin_key, token?}. Until that route is
   deployed the page falls back to send-board.fixture.json (built from live
   data by worker/scripts/build-send-board-fixture.mjs) and says so on screen.
   Used by calendar.html (full) and admin.html "אירועים קרובים" (compact).
   IshurSendBoard.mount(el, { api: fn(path, body) → Promise<json|null>, compact, token }) */
(function () {
  'use strict';
  var CSS = '' +
    '.sbx{--sb-ok:var(--good,var(--ok,#2E7D5B));--sb-bad:var(--warn,#A8402F);--sb-gold:var(--gold,#B4884A);--sb-mute:var(--ink3,#7F8C86);--sb-rail:var(--rail,#F0EFE9);font-size:.86rem}' +
    'html[data-theme=dark] .sbx{--sb-ok:#7BC9A4;--sb-bad:#F08A8A;--sb-rail:#232A25}' +
    '.sbx .sb-note{font-size:.74rem;color:var(--sb-mute);background:var(--sb-rail);border-radius:10px;padding:.45rem .7rem;margin:0 0 .6rem}' +
    '.sbx .sb-note b{color:var(--ink,#1B2620)}' +
    '.sbx .sb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:.6rem}' +
    '.sbx .sb-ev{background:var(--card,#fff);border:1px solid var(--line,#E1E4DE);border-radius:14px;padding:.75rem .9rem}' +
    '.sbx .sb-evh{display:flex;justify-content:space-between;align-items:baseline;gap:.6rem;margin-bottom:.35rem}' +
    '.sbx .sb-evh .n{font-weight:600;font-size:.98rem}.sbx .sb-evh .d{font-size:.76rem;color:var(--sb-mute);white-space:nowrap}' +
    '.sbx .sb-row{border-top:1px solid var(--line,#E1E4DE);padding:.5rem 0 .45rem}' +
    '.sbx .sb-top{display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}' +
    '.sbx .sb-type{font-weight:600;font-size:.84rem;min-width:7.5rem}' +
    '.sbx .sb-main{font-variant-numeric:tabular-nums;font-size:.84rem;flex:1}' +
    '.sbx .sb-main b{font-size:.98rem}' +
    '.sbx .sb-i{font:inherit;border:1px solid var(--line,#E1E4DE);background:transparent;color:var(--ink2,#4E5C55);width:26px;height:26px;border-radius:50%;cursor:pointer;flex:none;font-size:.8rem;line-height:1}' +
    '.sbx .sb-i:hover,.sbx .sb-i:focus-visible{border-color:var(--sb-gold);outline:none}' +
    '.sbx .sb-bar{display:flex;height:6px;border-radius:99px;overflow:hidden;background:var(--sb-rail);margin:.35rem 0 .3rem}' +
    '.sbx .sb-bar i{display:block;height:100%}' +
    '.sbx .sb-chips{display:flex;gap:.25rem;flex-wrap:wrap}' +
    '.sbx .sb-c{font-size:.7rem;padding:.08rem .5rem;border-radius:99px;background:var(--sb-rail);color:var(--ink2,#4E5C55);white-space:nowrap}' +
    '.sbx .sb-c.ok{background:rgba(46,125,91,.14);color:var(--sb-ok)}.sbx .sb-c.bad{background:rgba(168,64,47,.13);color:var(--sb-bad)}' +
    '.sbx .sb-c.wait{background:rgba(180,136,74,.16);color:#8A5A00}html[data-theme=dark] .sbx .sb-c.wait{color:#E3AA4C}' +
    '.sbx .sb-c.inf{border:1px dashed var(--sb-mute);background:transparent}' +
    '.sbx .sb-empty{color:var(--sb-mute);font-size:.82rem;padding:.6rem 0}' +
    /* the ⓘ sheet */
    '.sb-bg{position:fixed;inset:0;background:rgba(15,46,34,.45);display:flex;align-items:center;justify-content:center;padding:1rem;z-index:90}' +
    '.sb-sh{background:var(--card,#fff);color:var(--ink,#1B2620);border:1px solid var(--line,#E1E4DE);border-radius:16px;width:100%;max-width:640px;max-height:84vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.3)}' +
    '.sb-sh header{display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--line,#E1E4DE)}' +
    '.sb-sh header b{font-size:.98rem}.sb-sh header button{border:none;background:var(--rail,#F0EFE9);color:inherit;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:1rem}' +
    '.sb-tabs{display:flex;gap:.3rem;flex-wrap:wrap;padding:.55rem 1rem;border-bottom:1px solid var(--line,#E1E4DE)}' +
    '.sb-tabs button{font:inherit;font-size:.74rem;padding:.2rem .6rem;border-radius:99px;border:1px solid var(--line,#E1E4DE);background:transparent;color:inherit;cursor:pointer}' +
    '.sb-tabs button[aria-pressed=true]{background:var(--ink,#1B2620);color:var(--card,#fff);border-color:var(--ink,#1B2620)}' +
    '.sb-list{overflow:auto;padding:.2rem 1rem 1rem;flex:1}' +
    '.sb-p{display:grid;grid-template-columns:1fr auto;gap:.1rem .6rem;padding:.45rem 0;border-bottom:1px solid var(--line,#E1E4DE);font-size:.82rem}' +
    '.sb-p .ph{direction:ltr;unicode-bidi:embed;font-variant-numeric:tabular-nums;color:var(--ink3,#7F8C86);font-size:.76rem}' +
    '.sb-p .w{grid-column:1/-1;font-size:.74rem;color:var(--ink2,#4E5C55)}.sb-p .t{font-size:.74rem;color:var(--ink3,#7F8C86);text-align:left;white-space:nowrap}' +
    '@media (max-width:600px){.sbx .sb-type{min-width:0;width:100%}.sb-sh{max-height:92vh}}';

  var BUCKETS = [
    ['delivered', 'נמסר, לא נקרא'], ['read', 'נמסר ונקרא'], ['no_status', 'נשלח, בלי סטטוס'], ['failed', 'נכשל'],
    ['pending', 'ממתין'], ['answered', 'ענו'], ['skipped', 'דילוג'], ['unknown', 'לא ידוע']
  ];
  var FAIL_HE = { cap: 'תקרה', notwa: 'לא בוואטסאפ', blocked: 'חסם', experiment: 'ניסוי מטא', other: 'אחר' };
  var PEND_HE = { reopened: 'נפתח מחדש', hold: 'השהיה', cap: 'תקרה', window: 'חלון', scheduled: 'מתוכנן', queue: 'בתור' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ph(p) { var d = String(p || '').replace(/\D/g, ''); if (d.indexOf('972') === 0) { var l = '0' + d.slice(3); return l.length === 10 ? l.slice(0, 3) + '-' + l.slice(3, 6) + '-' + l.slice(6) : l; } return d; }
  function when(ts) { if (!ts) return ''; var d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }); }
  function dmy(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : ''; }
  function injectCss() { if (document.getElementById('sbx-css')) return; var s = document.createElement('style'); s.id = 'sbx-css'; s.textContent = CSS; document.head.appendChild(s); }
  /* pages without their own night switch follow the OS, same rule as admin.html:499 */
  function themeFromOs() {
    if (document.documentElement.getAttribute('data-theme')) return;
    var t = null; try { t = localStorage.getItem('ishur_theme'); } catch (e) {}
    if (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark';
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  }

  function rowHtml(ev, t, ei, ti) {
    var Z = ev.invited, X = t.delivered, Y = t.sent;
    var pct = function (n) { return Z ? Math.max(0, Math.min(100, n / Z * 100)) : 0; };
    var bar = '<div class="sb-bar" aria-hidden="true">' +
      '<i style="width:' + pct(t.read) + '%;background:var(--sb-ok)"></i>' +
      '<i style="width:' + pct(X - t.read) + '%;background:var(--sb-ok);opacity:.55"></i>' +
      '<i style="width:' + pct(t.no_status) + '%;background:var(--sb-gold)"></i>' +
      '<i style="width:' + pct(t.failed.total) + '%;background:var(--sb-bad)"></i>' +
      '<i style="width:' + pct(t.pending.reopened) + '%;background:var(--sb-gold);opacity:.45"></i></div>';
    var chips = [];
    chips.push('<span class="sb-c ok">נמסר ' + X + '</span>');
    chips.push('<span class="sb-c ok">נקרא ' + t.read + '</span>');
    if (t.no_status) chips.push('<span class="sb-c">בלי סטטוס ' + t.no_status + '</span>');
    if (t.failed.total) {
      var parts = Object.keys(FAIL_HE).filter(function (k) { return t.failed[k]; }).map(function (k) { return FAIL_HE[k] + ' ' + t.failed[k]; });
      chips.push('<span class="sb-c bad">נכשל ' + t.failed.total + ' · ' + parts.join(' · ') + '</span>');
    } else chips.push('<span class="sb-c">נכשל 0</span>');
    if (t.pending.total) {
      var pp = Object.keys(PEND_HE).filter(function (k) { return t.pending[k]; }).map(function (k) { return PEND_HE[k] + ' ' + t.pending[k] + (k === 'scheduled' && t.due ? ' (' + dmy(t.due) + ')' : ''); });
      chips.push('<span class="sb-c wait">ממתין ' + t.pending.total + ' · ' + pp.join(' · ') + '</span>');
    }
    chips.push('<span class="sb-c">ענו ' + t.answered + '</span>');
    if (t.skipped) chips.push('<span class="sb-c">דילוג ' + t.skipped + '</span>');
    if (t.unknown) chips.push('<span class="sb-c inf" title="נשלח לפני שיומן הביקורת התחיל, או מחוץ לחלון — אין נתון מסירה">לא ידוע ' + t.unknown + '</span>');
    if (t.inferred) chips.push('<span class="sb-c inf" title="בלי סמני KV: נפתח-מחדש מול נכשל-סופי הוסק מכללי הקוד">' + t.inferred + ' מוסקים</span>');
    var aud = t.audience !== Z ? ' <span style="color:var(--sb-mute);font-size:.74rem">(קהל ההודעה: ' + t.audience + ')</span>' : '';
    return '<div class="sb-row"><div class="sb-top"><span class="sb-type">' + esc(t.he) + '</span>' +
      '<span class="sb-main">נמסרו <b>' + X + '</b> / נשלחו <b>' + Y + '</b> / מתוך <b>' + Z + '</b> מוזמנים' + aud + '</span>' +
      (t.people ? '<button type="button" class="sb-i" data-e="' + ei + '" data-t="' + ti + '" aria-label="מי בכל קבוצה · ' + esc(t.he) + '">ⓘ</button>' : '') +
      '</div>' + bar + '<div class="sb-chips">' + chips.join('') + '</div></div>';
  }

  function sheet(ev, t) {
    var bg = document.createElement('div'); bg.className = 'sb-bg';
    var first = BUCKETS.filter(function (b) { return (t.people[b[0]] || []).length; })[0];
    var cur = first ? first[0] : 'delivered';
    bg.innerHTML = '<div class="sb-sh" role="dialog" aria-modal="true" aria-label="' + esc(ev.name + ' · ' + t.he) + '">' +
      '<header><b>' + esc(ev.name) + ' · ' + esc(t.he) + '</b><button type="button" aria-label="סגירה">✕</button></header>' +
      '<div class="sb-tabs">' + BUCKETS.map(function (b) { var n = (t.people[b[0]] || []).length; return n ? '<button type="button" data-b="' + b[0] + '" aria-pressed="' + (b[0] === cur) + '">' + b[1] + ' ' + n + '</button>' : ''; }).join('') + '</div>' +
      '<div class="sb-list"></div></div>';
    function paint() {
      var list = (t.people[cur] || []).slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      bg.querySelector('.sb-list').innerHTML = list.length ? list.map(function (p) {
        var why = p.code ? p.code + ' · ' + (p.why || '') : (p.reason_he || p.why || (p.rsvp ? 'תשובה: ' + p.rsvp : ''));
        if (p.reason_he && p.code) why = p.reason_he + ' · ' + p.code + ' · ' + (p.why || '');
        return '<div class="sb-p"><div><b>' + esc(p.name || 'ללא שם') + '</b> <span class="ph">' + ph(p.phone) + '</span></div>' +
          '<div class="t">' + esc(when(p.at)) + (p.number ? ' · מ-' + esc(p.number) : '') + (p.src === 'kv' ? ' · KV' : '') + '</div>' +
          (why ? '<div class="w">' + esc(why) + '</div>' : '') + '</div>';
      }).join('') : '<p class="sb-empty">אין אף אחד בקבוצה הזו.</p>';
    }
    function close() { bg.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    bg.addEventListener('click', function (e) {
      if (e.target === bg || e.target.closest('header button')) return close();
      var b = e.target.closest('.sb-tabs button'); if (!b) return;
      cur = b.dataset.b; bg.querySelectorAll('.sb-tabs button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); paint();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg); paint();
    var x = bg.querySelector('header button'); if (x) x.focus();
  }

  function render(el, d, opt) {
    var evs = (d.events || []).filter(function (e) { return e.types && e.types.length; });
    if (opt.token) evs = evs.filter(function (e) { return e.token === opt.token || e.short === String(opt.token).slice(0, 8); });
    var note = '';
    if (d.__fixture) note = '<p class="sb-note"><b>נתוני דוגמה</b> · הנתיב /api/send-board עוד לא פרוס, אז מוצג קובץ שנבנה מנתונים חיים ב-' + esc(when(d.fixture && d.fixture.built_at)) + '. ' + esc((d.fixture && d.fixture.note) || '') + '</p>';
    else note = '<p class="sb-note">מקור: סטטוסי מסירה של מטא (wa_status) מול ההודעות שיצאו (wa_out), לפי מזהה ההודעה · ' + esc(d.window_days || '') + ' ימי יומן' + (d.cached ? ' · מהמטמון' : '') + ' · עודכן ' + esc(when(d.generated_at)) + '</p>';
    if (!evs.length) { el.innerHTML = note + '<p class="sb-empty">אין אירועים פעילים עם שליחות.</p>'; return; }
    el.innerHTML = note + '<div class="sb-grid">' + evs.map(function (ev, ei) {
      var types = opt.compact ? ev.types.filter(function (t) { return t.sent || t.pending.reopened || t.pending.queue || t.pending.window || t.pending.cap || t.pending.hold; }) : ev.types;
      if (opt.compact && !types.length) types = ev.types.slice(0, 1);
      return '<div class="sb-ev" data-tok="' + esc(ev.short) + '"><div class="sb-evh"><span class="n">' + esc(ev.name) + (ev.held ? ' · <span style="color:var(--sb-bad)">בהשהיה</span>' : '') + '</span><span class="d">' + dmy(ev.date) + ' · ' + ev.invited + ' מוזמנים</span></div>' +
        types.map(function (t) { return rowHtml(ev, t, ei, ev.types.indexOf(t)); }).join('') + '</div>';
    }).join('') + '</div>';
    el.onclick = function (e) {
      var b = e.target.closest('.sb-i'); if (!b) return;
      var ev = evs[Number(b.dataset.e)], t = ev.types[Number(b.dataset.t)];
      sheet(ev, t);
    };
  }

  function mount(el, opt) {
    opt = opt || {}; injectCss(); themeFromOs();
    el.classList.add('sbx');
    el.innerHTML = '<p class="sb-empty">טוען את לוח המסירה…</p>';
    var body = opt.token ? { token: opt.token } : {};
    function fixture() {
      return fetch((opt.fixtureUrl || 'send-board.fixture.json') + '?v=1', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d) d.__fixture = true; return d; });
    }
    return Promise.resolve(opt.api('send-board', body)).catch(function () { return null; })
      .then(function (d) { return d && d.ok && d.events ? d : fixture(); })
      .then(function (d) { if (!d) { el.innerHTML = '<p class="sb-empty">לוח המסירה לא נטען.</p>'; return; } render(el, d, opt); return d; })
      .catch(function () { el.innerHTML = '<p class="sb-empty">לוח המסירה לא נטען.</p>'; });
  }
  window.IshurSendBoard = { mount: mount };
})();
