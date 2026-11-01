/* ishur.io · calls board per event (Richard 01/11)
   בתור / חויגו / ענו / לא ענו / תא קולי / לא להתקשר · מגיע / לא מגיע / לחייג
   שוב / להעביר לריצארד · ניסיונות מול מכסה · שיחה אחרונה · משך ממוצע · עלות
   היום/סה"כ · הקלטה + תמלול לכל שיחה · מצב חלון החיוג · היום / 7 ימים / הכל.

   Works on endpoints that are ALREADY deployed (no worker change needed):
     POST /api/call-board  → queue (tries/max_tries from the sheet), last 60
                             Retell calls (state, needs_review), dial window
     POST /api/audit {from,to,kind:'call'} → one row per finished call, written
                             by the Retell webhook (index.js:2165): token,
                             outcome, answer, duration_s, cost ₪, recording,
                             transcript (detail), disconnection reason.
   aggregateCalls() is pure and exported for node (worker/test/call-board.test.mjs).
   IshurCallBoard.mount(el, { api, adminKey, base }) */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.IshurCallBoard = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var AUDIT_START = '2026-10-22';   /* audit.js went live 22/10; nothing older exists */

  function ilDay(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts)); }
  function norm(p) { var d = String(p || '').replace(/\D/g, ''); if (d.indexOf('0') === 0) d = '972' + d.slice(1); return d; }

  /* one finished call → what happened, in the board's words (shir.js:528-575) */
  function classify(r, review) {
    var d = r.data || {}, disc = String(d.disconnection || ''), dur = Number(d.duration_s) || 0;
    var out = String(d.outcome || ''), ans = String(d.answer || '');
    var res = { reach: '', outcome: '' };
    if (disc === 'voicemail_reached') res.reach = 'voicemail';
    else if (/^dial_(no_answer|busy|failed)$/.test(disc) || (!dur && !out && !ans)) res.reach = 'noanswer';
    else res.reach = 'answered';
    if (/לא להתקשר/.test(ans) || out === 'לא להתקשר') { res.reach = 'dnc'; res.outcome = 'dnc'; }
    else if (out === 'מגיע') res.outcome = 'coming';
    else if (out === 'לא מגיע') res.outcome = 'not_coming';
    /* no definite answer AND Retell's analysis asked for a human (needs_review) or the call was transferred */
    else if (review || /transfer/.test(disc)) res.outcome = 'transfer';
    else if (/מתלבט/.test(ans) || out === 'מתלבט') res.outcome = 'maybe';
    else if (res.reach === 'answered' || /לחייג שוב|ללא תוצאה|לא ענה/.test(ans)) res.outcome = 'redial';
    return res;
  }

  function aggregateCalls(input) {
    var board = input.board || {}, rows = input.rows || [], range = String(input.range || 'today');
    var now = Number(input.now) || Date.now(), today = input.today || ilDay(now);
    var since = range === 'today' ? null : range === '7' ? now - 7 * 864e5 : 0;
    var inRange = function (ts) { return range === 'today' ? ilDay(ts) === today : ts >= since; };
    var review = {};
    (board.done || []).forEach(function (c) { if (c.id && c.state === 'problem') review[c.id] = true; });
    var evs = {};
    function ev(name, date) {
      var k = name || 'ללא אירוע (נכנסות/לידים)';
      if (!evs[k]) evs[k] = { name: k, date: date || '', queue: { waiting: 0, past: 0, capped: 0, blocked: 0 }, tries: 0, max_tries: 0, guests: [],
        dialed: 0, guests_dialed: 0, answered: 0, noanswer: 0, voicemail: 0, dnc: 0,
        outcomes: { coming: 0, not_coming: 0, redial: 0, maybe: 0, transfer: 0 }, last_at: 0, dur_sum: 0, dur_n: 0,
        cost_today: 0, cost_total: 0, calls: [] };
      if (date && !evs[k].date) evs[k].date = date;
      return evs[k];
    }
    /* the queue: who is still owed a call, and why someone is not dialed */
    (board.waiting || []).forEach(function (q) {
      if (q.kind !== 'guest') return;
      var e = ev(q.event, String(q.event_date || '').slice(0, 10));
      var past = q.event_date && String(q.event_date).slice(0, 10) < today;   /* shouldDial: shir.js:116 */
      var st = q.state === 'capped' ? 'capped' : q.state === 'blocked' ? 'blocked' : past ? 'past' : 'waiting';
      e.queue[st]++;
      e.tries += Number(q.tries) || 0; e.max_tries += Number(q.max_tries) || 0;
      e.guests.push({ name: q.name || '', phone: norm(q.phone), tries: Number(q.tries) || 0, max_tries: Number(q.max_tries) || 0, state: st });
    });
    var seenGuest = {};
    rows.slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (r) {
      var d = r.data || {}, ts = Number(r.ts) || Date.parse(r.at) || 0;
      var name = d.event_name || (r.event && r.event.event) || '';
      var e = ev(name, r.event && r.event.date);
      var cost = Number(r.cost) || 0;
      if (ilDay(ts) === today) e.cost_today += cost;
      if (!inRange(ts)) return;
      var c = classify(r, review[d.call_id]);
      e.dialed++; e[c.reach]++;
      if (c.outcome && e.outcomes[c.outcome] != null) e.outcomes[c.outcome]++;
      var gk = name + '|' + (d.guest_id || r.phone);
      if (!seenGuest[gk]) { seenGuest[gk] = 1; e.guests_dialed++; }
      if (ts > e.last_at) e.last_at = ts;
      var dur = Number(d.duration_s) || 0; if (c.reach === 'answered' && dur > 0) { e.dur_sum += dur; e.dur_n++; }
      e.cost_total += cost;
      e.calls.push({ id: d.call_id || '', at: ts, name: d.guest_name || '', phone: r.phone || '', agent: d.agent || r.area || '', duration_s: dur, reach: c.reach, outcome: c.outcome,
        answer: d.answer || '', reason: d.disconnection || '', cost: cost, recording: d.recording || '', transcript: String(r.detail || ''), summary: d.summary || '' });
    });
    var list = Object.keys(evs).map(function (k) {
      var e = evs[k];
      e.avg_duration_s = e.dur_n ? Math.round(e.dur_sum / e.dur_n) : null;
      e.cost_today = Math.round(e.cost_today * 100) / 100; e.cost_total = Math.round(e.cost_total * 100) / 100;
      e.calls.sort(function (a, b) { return b.at - a.at; });
      delete e.dur_sum; delete e.dur_n;
      return e;
    }).filter(function (e) { return e.dialed || e.guests.length; });
    list.sort(function (a, b) { return (a.date || '9') < (b.date || '9') ? -1 : 1; });
    return { ok: true, range: range, today: today, window: board.window || null, events: list };
  }

  /* ── the page side ─────────────────────────────────────────────────────── */
  var CSS = '' +
    '.cbx{--c-ok:var(--good,var(--ok,#2E7D5B));--c-bad:var(--warn,var(--no,#A8402F));--c-gold:var(--gold,#A8853C);--c-mute:var(--ink3,#7A847C);--c-rail:var(--rail,#F0EFE9);font-size:.86rem;margin:.4rem 0 1rem}' +
    'html[data-theme=dark] .cbx{--c-ok:#7BC9A4;--c-bad:#F08A8A;--c-rail:#232A25}' +
    'html[data-theme=dark] body{--bg:#131714;--card:#1A201C;--line:#2A322C;--ink:#E8EBE7;--ink2:#C2C9C1;--ink3:#8D968C}' +
    '.cbx .cb-tb{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;margin-bottom:.55rem}' +
    '.cbx .cb-seg{display:inline-flex;background:var(--c-rail);border-radius:10px;padding:3px;gap:2px}' +
    '.cbx .cb-seg button{font:inherit;font-size:.78rem;font-weight:500;padding:.28rem .7rem;border:none;border-radius:8px;background:transparent;color:var(--ink2,#4A554E);cursor:pointer}' +
    '.cbx .cb-seg button[aria-pressed=true]{background:var(--card,#fff);color:var(--ink,#1B2420);box-shadow:0 1px 3px rgba(0,0,0,.12)}' +
    '.cbx .cb-win{font-size:.78rem;color:var(--ink2,#4A554E)}.cbx .cb-win b.o{color:var(--c-ok)}.cbx .cb-win b.c{color:var(--c-bad)}' +
    '.cbx .cb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:.6rem}' +
    '.cbx .cb-ev{background:var(--card,#fff);border:1px solid var(--line,#E3E1D8);border-radius:14px;padding:.75rem .9rem}' +
    '.cbx .cb-h{display:flex;justify-content:space-between;gap:.6rem;align-items:baseline}.cbx .cb-h b{font-size:.96rem}.cbx .cb-h span{font-size:.74rem;color:var(--c-mute)}' +
    '.cbx .cb-k{display:grid;grid-template-columns:repeat(6,1fr);gap:.25rem;margin:.5rem 0}' +
    '.cbx .cb-k div{background:var(--c-rail);border-radius:9px;padding:.3rem .2rem;text-align:center}.cbx .cb-k b{display:block;font-size:1.05rem;font-variant-numeric:tabular-nums}.cbx .cb-k span{font-size:.64rem;color:var(--c-mute)}' +
    '@media (max-width:520px){.cbx .cb-k{grid-template-columns:repeat(3,1fr)}}' +
    '.cbx .cb-chips{display:flex;gap:.25rem;flex-wrap:wrap;margin:.2rem 0}' +
    '.cbx .cb-c{font-size:.7rem;padding:.08rem .5rem;border-radius:99px;background:var(--c-rail);color:var(--ink2,#4A554E)}.cbx .cb-c.ok{color:var(--c-ok)}.cbx .cb-c.bad{color:var(--c-bad)}.cbx .cb-c.gold{color:#8A5A00}html[data-theme=dark] .cbx .cb-c.gold{color:#E3AA4C}' +
    '.cbx .cb-m{font-size:.76rem;color:var(--ink2,#4A554E);margin-top:.25rem}.cbx .cb-warn{font-size:.74rem;color:var(--c-bad);margin-top:.25rem}' +
    '.cbx details{margin-top:.4rem}.cbx summary{cursor:pointer;font-size:.76rem;color:var(--c-gold)}' +
    '.cbx .cb-call{display:grid;grid-template-columns:1fr auto;gap:.1rem .5rem;padding:.4rem 0;border-top:1px solid var(--line,#E3E1D8);font-size:.78rem}' +
    '.cbx .cb-call .ph{direction:ltr;unicode-bidi:embed;color:var(--c-mute);font-size:.72rem}.cbx .cb-call .a{display:flex;gap:.3rem}' +
    '.cbx .cb-call button{font:inherit;font-size:.7rem;padding:.15rem .5rem;border-radius:99px;border:1px solid var(--line,#E3E1D8);background:transparent;color:inherit;cursor:pointer}' +
    '.cbx .cb-call audio{grid-column:1/-1;width:100%;height:32px}' +
    '.cbx .cb-empty{color:var(--c-mute);font-size:.82rem;padding:.6rem 0}' +
    '.cb-bg{position:fixed;inset:0;background:rgba(15,46,34,.45);display:flex;align-items:center;justify-content:center;padding:1rem;z-index:90}' +
    '.cb-sh{background:var(--card,#fff);color:var(--ink,#1B2420);border-radius:16px;width:100%;max-width:640px;max-height:84vh;display:flex;flex-direction:column;overflow:hidden}' +
    '.cb-sh header{display:flex;justify-content:space-between;align-items:center;padding:.8rem 1rem;border-bottom:1px solid var(--line,#E3E1D8)}.cb-sh header button{border:none;background:var(--rail,#F0EFE9);color:inherit;width:32px;height:32px;border-radius:50%;cursor:pointer}' +
    '.cb-sh pre{white-space:pre-wrap;font:inherit;font-size:.82rem;line-height:1.8;padding:1rem;overflow:auto;margin:0}';

  var REACH_HE = { answered: 'ענה', noanswer: 'לא ענה', voicemail: 'תא קולי', dnc: 'לא להתקשר' };
  var OUT_HE = { coming: 'מגיע', not_coming: 'לא מגיע', redial: 'לחייג שוב', maybe: 'מתלבט', transfer: 'להעביר לריצארד', dnc: 'לא להתקשר' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ph(p) { var d = String(p || '').replace(/\D/g, ''); if (d.indexOf('972') === 0) { var l = '0' + d.slice(3); return l.length === 10 ? l.slice(0, 3) + '-' + l.slice(3, 6) + '-' + l.slice(6) : l; } return d; }
  function when(ts) { return ts ? new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }) : '—'; }
  function sec(s) { if (s == null) return '—'; s = Math.round(s); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') + ' דק׳' : s + ' שנ׳'; }
  function ils(n) { return '₪' + (Math.round((n || 0) * 100) / 100).toFixed(2); }

  function evHtml(e, i) {
    var q = e.queue, o = e.outcomes;
    var warn = q.past ? '<div class="cb-warn">' + q.past + ' אורחים מסומנים "נדרשת שיחה" אבל האירוע כבר עבר (' + esc(e.date.slice(8, 10) + '/' + e.date.slice(5, 7)) + ') — שיר לא תחייג אליהם (shouldDial), ולכן הניסיונות נשארים 0.</div>' : '';
    return '<div class="cb-ev"><div class="cb-h"><b>' + esc(e.name) + '</b><span>' + (e.date ? esc(e.date.slice(8, 10) + '/' + e.date.slice(5, 7)) : '') + '</span></div>' +
      '<div class="cb-k">' +
      '<div><b>' + q.waiting + '</b><span>בתור</span></div><div><b>' + e.dialed + '</b><span>חויגו</span></div><div><b>' + e.answered + '</b><span>ענו</span></div>' +
      '<div><b>' + e.noanswer + '</b><span>לא ענו</span></div><div><b>' + e.voicemail + '</b><span>תא קולי</span></div><div><b>' + e.dnc + '</b><span>לא להתקשר</span></div></div>' +
      '<div class="cb-chips"><span class="cb-c ok">מגיע ' + o.coming + '</span><span class="cb-c bad">לא מגיע ' + o.not_coming + '</span><span class="cb-c gold">לחייג שוב ' + o.redial + '</span>' +
      (o.maybe ? '<span class="cb-c gold">מתלבט ' + o.maybe + '</span>' : '') + '<span class="cb-c bad" title="אין תשובה ברורה ו-Retell סימנה needs_review, או שהשיחה הועברה">להעביר לריצארד ' + o.transfer + '</span>' +
      (q.capped ? '<span class="cb-c">מיצו מכסה ' + q.capped + '</span>' : '') + (q.blocked ? '<span class="cb-c">חסומים ' + q.blocked + '</span>' : '') + '</div>' +
      '<div class="cb-m">ניסיונות (בתור): ' + e.tries + ' מתוך ' + e.max_tries + ' · שיחה אחרונה ' + when(e.last_at) + ' · משך ממוצע ' + sec(e.avg_duration_s) + ' · עלות היום ' + ils(e.cost_today) + ' · בטווח ' + ils(e.cost_total) + ' · ' + e.guests_dialed + ' אורחים שונים</div>' + warn +
      (e.guests.length ? '<details><summary>' + e.guests.length + ' בתור · ניסיונות לכל אורח</summary>' + e.guests.map(function (g) { return '<div class="cb-call"><div>' + esc(g.name || 'ללא שם') + ' <span class="ph">' + ph(g.phone) + '</span></div><div>' + g.tries + '/' + g.max_tries + ' · ' + ({ waiting: 'בתור', past: 'אירוע עבר', capped: 'מוצה', blocked: 'חסום' }[g.state]) + '</div></div>'; }).join('') + '</details>' : '') +
      (e.calls.length ? '<details><summary>' + e.calls.length + ' שיחות · הקלטה ותמלול</summary>' + e.calls.map(function (c, j) {
        return '<div class="cb-call"><div><b>' + esc(c.name || 'ללא שם') + '</b> <span class="ph">' + ph(c.phone) + '</span> · ' + esc(REACH_HE[c.reach] || '') + (c.outcome ? ' · ' + esc(OUT_HE[c.outcome] || '') : '') + ' · ' + sec(c.duration_s) + (c.cost ? ' · ' + ils(c.cost) : '') + '<br><span class="ph">' + when(c.at) + (c.reason ? ' · ' + esc(c.reason) : '') + '</span></div>' +
          '<div class="a">' + (c.recording ? '<button type="button" data-rec="' + i + ':' + j + '">▶ הקלטה</button>' : '') + (c.transcript || c.id ? '<button type="button" data-tr="' + i + ':' + j + '">תמלול</button>' : '') + '</div></div>';
      }).join('') + '</details>' : '') + '</div>';
  }

  function mount(el, opt) {
    opt = opt || {};
    if (!document.getElementById('cbx-css')) { var s = document.createElement('style'); s.id = 'cbx-css'; s.textContent = CSS; document.head.appendChild(s); }
    if (!document.documentElement.getAttribute('data-theme')) { var t = null; try { t = localStorage.getItem('ishur_theme'); } catch (e) {} if (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark'; if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); }
    el.classList.add('cbx');
    var range = 'today', board = null, dayCache = {}, last = null;
    el.innerHTML = '<div class="cb-tb"><span class="cb-seg" role="group" aria-label="טווח"><button type="button" data-r="today" aria-pressed="true">היום</button><button type="button" data-r="7" aria-pressed="false">7 ימים</button><button type="button" data-r="all" aria-pressed="false">הכל</button></span><span class="cb-win"></span></div><div class="cb-body"><p class="cb-empty">טוען…</p></div>';
    var body = el.querySelector('.cb-body');
    function days() {
      var today = ilDay(Date.now()), out = [];
      var from = range === 'today' ? today : range === '7' ? ilDay(Date.now() - 6 * 864e5) : AUDIT_START;
      for (var d = new Date(from + 'T12:00:00Z'); ilDay(d) <= today && out.length < 400; d = new Date(d.getTime() + 864e5)) out.push(ilDay(d));
      return out;
    }
    function fetchDay(day) {
      var today = ilDay(Date.now());
      if (dayCache[day] && day !== today) return Promise.resolve(dayCache[day]);
      var k = day.replace(/-/g, '');
      return Promise.resolve(opt.api('audit', { from: k, to: k, kind: 'call', limit: 5000 })).then(function (r) { var rows = (r && r.items) || []; dayCache[day] = rows; return rows; }).catch(function () { return []; });
    }
    function loadRows() {
      if (opt.rows) return Promise.resolve(opt.rows);
      var ds = days(), out = [], i = 0;
      function next() { if (i >= ds.length) return Promise.resolve(); var d = ds[i++]; return fetchDay(d).then(function (r) { out = out.concat(r); }); }
      function worker() { return next().then(function () { return i < ds.length ? worker() : null; }); }
      return Promise.all([worker(), worker(), worker()]).then(function () { return out; });
    }
    function paint() {
      body.innerHTML = '<p class="cb-empty">טוען…</p>';
      var bp = board ? Promise.resolve(board) : Promise.resolve(opt.board || opt.api('call-board', {})).then(function (b) { board = b || {}; return board; });
      return Promise.all([bp, loadRows()]).then(function (r) {
        var data = aggregateCalls({ board: r[0], rows: r[1], range: range, now: opt.now });
        last = data;
        var w = data.window || {};
        el.querySelector('.cb-win').innerHTML = 'חלון החיוג: <b class="' + (w.open ? 'o' : 'c') + '">' + (w.open ? 'פתוח' : 'סגור') + '</b>' + (w.next ? ' · ' + esc(w.next) : '') + (w.paused ? ' · הכל מושהה' : '') + (w.no_contact_day ? ' · יום ללא יצירת קשר' : '');
        body.innerHTML = data.events.length ? '<div class="cb-grid">' + data.events.map(evHtml).join('') + '</div>' : '<p class="cb-empty">אין שיחות ואין אורחים בתור בטווח הזה.</p>';
      });
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.cb-seg button');
      if (b) { range = b.dataset.r; el.querySelectorAll('.cb-seg button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); paint(); return; }
      var rb = e.target.closest('[data-rec]'), tb = e.target.closest('[data-tr]');
      var ref = (rb || tb) && (rb || tb).getAttribute(rb ? 'data-rec' : 'data-tr').split(':');
      if (!ref || !last) return;
      var c = last.events[Number(ref[0])].calls[Number(ref[1])];
      if (rb) {
        /* our kept copy (audit.js:166), fetched as a blob so the key never lands in a link or history */
        rb.disabled = true; rb.textContent = 'טוען…';
        fetch((opt.base || 'https://go.ishur.io') + c.recording + '?key=' + encodeURIComponent(opt.adminKey || ''))
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
          .then(function (bl) { var a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(bl); rb.closest('.cb-call').appendChild(a); a.play().catch(function () {}); rb.remove(); })
          .catch(function () { rb.textContent = 'אין הקלטה'; });
        return;
      }
      var bg = document.createElement('div'); bg.className = 'cb-bg';
      bg.innerHTML = '<div class="cb-sh" role="dialog" aria-modal="true"><header><b>' + esc((c.name || 'שיחה') + ' · ' + when(c.at)) + '</b><button type="button" aria-label="סגירה">✕</button></header><pre>' + esc(c.transcript || c.summary || 'אין תמלול ביומן.') + '</pre></div>';
      bg.addEventListener('click', function (ev2) { if (ev2.target === bg || ev2.target.closest('header button')) bg.remove(); });
      document.body.appendChild(bg);
      /* the audit row keeps 2000 chars; the full transcript comes from Retell */
      if (c.id && (c.transcript || '').length >= 1990) Promise.resolve(opt.api('call-get', { id: c.id })).then(function (r) { if (r && r.transcript) bg.querySelector('pre').textContent = r.transcript; }).catch(function () {});
    });
    paint();
    return { refresh: function () { board = null; return paint(); } };
  }

  return { aggregateCalls: aggregateCalls, classify: classify, mount: mount };
});
