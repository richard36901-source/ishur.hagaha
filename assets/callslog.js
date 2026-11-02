/* ishur.io · one calls view (Richard 02/11, F.4 + F.5)
   One row per person (guest / lead / inbound call): סוכנת · שם · טלפון ·
   אירוע/ליד · מצב · ניסיונות · שיחה אחרונה (▶ + תמלול) · הערה · ניסיון הבא.
   Data: POST /api/calls-log (worker/calls-log.js) — 100 calls per page with a
   cursor, filters applied on the server, header counts one day per request.
   Until that route is deployed: calls-log.fixture.json (scrubbed), filtered here.
   IshurCallsLog.mount(el, { api(path, body) → Promise<json|null>, raw(path, body) → Promise<Response>, adminKey, base }) */
(function () {
  'use strict';
  var CSS = '' +
    '.clx{--x-ok:var(--good,var(--ok,#2E7D5B));--x-bad:var(--warn,#A8402F);--x-gold:var(--gold,#A8853C);--x-mute:var(--ink3,#7A847C);--x-rail:var(--rail,#F0EFE9);font-size:.86rem}' +
    'html[data-theme=dark] .clx{--x-ok:#7BC9A4;--x-bad:#F08A8A;--x-rail:#232A25}' +
    '.clx .x-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:.45rem;margin:0 0 .7rem}' +
    '.clx .x-kpi{background:var(--card,#fff);border:1px solid var(--line,#E3E1D8);border-radius:12px;padding:.55rem .4rem;text-align:center}' +
    '.clx .x-kpi b{display:block;font-size:1.25rem;font-variant-numeric:tabular-nums}.clx .x-kpi span{font-size:.68rem;color:var(--x-mute)}' +
    '.clx .x-kpi.bad b{color:var(--x-bad)}.clx .x-kpi.ok b{color:var(--x-ok)}' +
    '.clx .x-head{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:.2rem 0 .5rem}.clx .x-head h2{margin:0;font-size:1.05rem}.clx .x-head small{color:var(--x-mute);font-size:.74rem}' +
    '.clx .x-f{display:flex;gap:.45rem;flex-wrap:wrap;align-items:center;margin-bottom:.6rem}' +
    '.clx .x-seg{display:inline-flex;background:var(--x-rail);border-radius:10px;padding:3px;gap:2px}' +
    '.clx .x-seg button{font:inherit;font-size:.76rem;padding:.26rem .62rem;border:none;border-radius:8px;background:transparent;color:var(--ink2,#4A554E);cursor:pointer}' +
    '.clx .x-seg button[aria-pressed=true]{background:var(--card,#fff);color:var(--ink,#1B2420);box-shadow:0 1px 3px rgba(0,0,0,.12)}' +
    '.clx select,.clx input[type=date],.clx input[type=search]{font:inherit;font-size:.78rem;padding:.3rem .5rem;border:1px solid var(--line,#E3E1D8);border-radius:9px;background:var(--card,#fff);color:var(--ink,#1B2420);min-width:0}' +
    '.clx input[type=search]{flex:1 1 9rem}.clx label.x-chk{font-size:.78rem;display:inline-flex;gap:.3rem;align-items:center;cursor:pointer}' +
    '.clx .x-btn{font:inherit;font-size:.76rem;font-weight:600;padding:.3rem .75rem;border-radius:99px;border:1px solid var(--line,#E3E1D8);background:var(--card,#fff);color:var(--ink,#1B2420);cursor:pointer;white-space:nowrap}' +
    '.clx .x-btn:disabled{opacity:.5;cursor:wait}' +
    '.clx .x-note{font-size:.74rem;color:var(--x-mute);background:var(--x-rail);border-radius:10px;padding:.45rem .7rem;margin:0 0 .6rem}' +
    '.clx .x-tw{overflow-x:auto;border:1px solid var(--line,#E3E1D8);border-radius:12px;background:var(--card,#fff)}' +
    '.clx table{width:100%;border-collapse:collapse;font-size:.8rem}' +
    '.clx th{font-size:.7rem;font-weight:600;color:var(--x-mute);text-align:start;padding:.45rem .5rem;border-bottom:1px solid var(--line,#E3E1D8);white-space:nowrap;position:sticky;top:0;background:var(--card,#fff)}' +
    '.clx td{padding:.45rem .5rem;border-bottom:1px solid var(--line,#E3E1D8);vertical-align:top}' +
    '.clx td .ph{direction:ltr;unicode-bidi:embed;font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.clx .st{display:inline-block;font-size:.7rem;font-weight:600;padding:.05rem .5rem;border-radius:99px;background:var(--x-rail);white-space:nowrap}' +
    '.clx .st.done{color:var(--x-ok)}.clx .st.failed,.clx .st.review{color:var(--x-bad)}.clx .st.waiting{color:#8A5A00}html[data-theme=dark] .clx .st.waiting{color:#E3AA4C}' +
    '.clx .lc{white-space:nowrap}.clx .lc small{display:block;color:var(--x-mute);font-size:.7rem;white-space:normal}' +
    '.clx .lc button{font:inherit;font-size:.68rem;padding:.08rem .45rem;border-radius:99px;border:1px solid var(--line,#E3E1D8);background:transparent;color:inherit;cursor:pointer;margin-inline-start:.2rem}' +
    '.clx .lc audio{display:block;width:220px;height:30px;margin-top:.25rem}' +
    '.clx .x-more{display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.7rem 0;color:var(--x-mute);font-size:.76rem}' +
    '.clx .x-empty{color:var(--x-mute);text-align:center;padding:1.2rem 0}' +
    /* phones: the table becomes cards */
    '@media (max-width:700px){.clx .x-tw{border:none;background:transparent}.clx table,.clx tbody,.clx tr,.clx td{display:block;width:100%}.clx thead{display:none}' +
    '.clx tr{background:var(--card,#fff);border:1px solid var(--line,#E3E1D8);border-radius:12px;margin-bottom:.5rem;padding:.3rem .2rem}' +
    '.clx td{border:none;padding:.15rem .6rem;display:flex;gap:.6rem}.clx td::before{content:attr(data-l);flex:0 0 5.6rem;color:var(--x-mute);font-size:.7rem}.clx td:empty{display:none}.clx .lc audio{width:100%}}' +
    '.x-bg{position:fixed;inset:0;background:rgba(15,46,34,.45);display:flex;align-items:center;justify-content:center;padding:1rem;z-index:90}' +
    '.x-sh{background:var(--card,#fff);color:var(--ink,#1B2420);border-radius:16px;width:100%;max-width:660px;max-height:84vh;display:flex;flex-direction:column;overflow:hidden}' +
    '.x-sh header{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.8rem 1rem;border-bottom:1px solid var(--line,#E3E1D8)}.x-sh header button{border:none;background:var(--rail,#F0EFE9);color:inherit;width:32px;height:32px;border-radius:50%;cursor:pointer}' +
    '.x-sh .sum{padding:.6rem 1rem;font-size:.8rem;border-bottom:1px solid var(--line,#E3E1D8);color:var(--ink2,#4A554E)}.x-sh pre{white-space:pre-wrap;font:inherit;font-size:.82rem;line-height:1.8;padding:1rem;overflow:auto;margin:0}';

  var STATE_HE = { waiting: 'בתור', capped: 'מיצה', past: 'אירוע עבר', done: 'בוצע', noanswer: 'לא ענה', failed: 'נכשל', review: 'לבדיקה' };
  var STATE_CLS = { waiting: 'waiting', capped: '', past: '', done: 'done', noanswer: '', failed: 'failed', review: 'review' };
  var KIND_HE = { guest: 'אורח', lead: 'ליד', inbound: 'נכנסת' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ph(p) { var d = String(p || '').replace(/\D/g, ''); if (d.indexOf('972') === 0) { var l = '0' + d.slice(3); return l.length === 10 ? l.slice(0, 3) + '-' + l.slice(3, 6) + '-' + l.slice(6) : l; } return d; }
  function when(ts) { return ts ? new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }) : '—'; }
  function sec(s) { s = Math.round(Number(s) || 0); return s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + ' שנ׳'; }
  function ilDay(ts) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts)); }
  function shift(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function dayList(from, to) { var out = []; for (var d = to; d >= from && out.length < 400; d = shift(d, -1)) out.push(d); return out; }

  /* the same filter the server applies (worker/calls-log.js · matches) — used on the fixture only */
  function matches(r, f) {
    if (f.agent && r.agent !== f.agent) return false;
    if (f.kind && r.kind !== f.kind) return false;
    if (f.state === 'review' ? !r.review : (f.state && r.state !== f.state)) return false;
    if (f.review && !r.review) return false;
    if (f.q) { var n = f.q.toLowerCase(); if ((r.name + ' ' + r.phone + ' ' + r.event + ' ' + r.answer).toLowerCase().indexOf(n) < 0) return false; }
    if (f.from && r.day < f.from) return false;
    if (f.to && r.day > f.to) return false;
    return true;
  }

  /* calls + queue → one row per person */
  function people(calls, queue, f) {
    var byKey = {}, list = [];
    function keyOf(x) { return x.kind === 'inbound' ? 'in:' + x.id : (x.guest_id || x.phone) + '|' + (x.kind === 'lead' ? 'lead' : String(x.token || '').slice(0, 8)); }
    (queue || []).forEach(function (q) {
      if (f.agent && q.agent !== f.agent) return; if (f.kind && q.kind !== f.kind) return;
      var k = keyOf(q); if (byKey[k]) return;
      var p = { key: k, agent: q.agent, kind: q.kind, name: q.name, phone: q.phone, event: q.event, event_date: q.event_date, queue: q, calls: [] };
      byKey[k] = p; list.push(p);
    });
    calls.forEach(function (c) {
      var k = keyOf(c), p = byKey[k];
      if (!p) { p = { key: k, agent: c.agent, kind: c.kind, name: c.name, phone: c.phone, event: c.event, event_date: c.event_date, queue: null, calls: [] }; byKey[k] = p; list.push(p); }
      p.calls.push(c);
      if (!p.name && c.name) p.name = c.name;
    });
    list.forEach(function (p) {
      p.calls.sort(function (a, b) { return b.ts - a.ts; });
      var last = p.calls[0];
      p.last = last || null;
      p.state = p.queue && p.queue.state !== 'waiting' ? p.queue.state : last ? (last.review ? 'review' : last.state) : 'waiting';
      if (p.queue && p.queue.state === 'waiting' && (!last || !last.review)) p.state = 'waiting';
      p.sort = last ? last.ts : (p.queue && p.queue.next_at) || 0;
    });
    var st = f.pstate;
    if (st) list = list.filter(function (p) { return p.state === st; });
    if (f.review) list = list.filter(function (p) { return p.last && p.last.review; });
    /* no call in the chosen range and not waiting: not part of this view */
    list = list.filter(function (p) { return p.calls.length || (p.queue && p.queue.state === 'waiting') || st === p.state; });
    list.sort(function (a, b) { return (b.calls.length ? b.sort : 0) - (a.calls.length ? a.sort : 0) || String(a.event_date || '').localeCompare(String(b.event_date || '')); });
    return list;
  }

  function rowHtml(p, i) {
    var q = p.queue, c = p.last;
    var tries = q && q.max_tries != null ? (q.tries || 0) + '/' + q.max_tries : (p.calls.length === 1 ? 'שיחה אחת' : p.calls.length ? p.calls.length + ' שיחות' : '—');
    var outc = c ? (c.outcome || c.answer || (c.voicemail ? 'תא קולי' : STATE_HE[c.state])) : '';
    var lc = c ? '<div class="lc">' + when(c.ts) + ' · ' + sec(c.duration_s) + (outc ? ' · ' + esc(outc) : '') +
      (c.recording ? '<button type="button" data-play="' + i + '">▶</button>' : '') + ((c.transcript || c.summary) ? '<button type="button" data-tr="' + i + '">תמלול</button>' : '') +
      (p.calls.length > 1 ? '<small>' + p.calls.length + ' שיחות בטווח</small>' : '') + '</div>' : '<span class="lc">—</span>';
    var note = (c && c.summary) || (q && q.last_answer) || (c && c.disconnection) || '';
    var next = q ? (q.next_he || (q.next_at ? when(q.next_at) : '—')) : '—';
    return '<tr><td data-l="סוכנת">' + esc(p.agent) + ' <small style="color:var(--x-mute)">' + esc(KIND_HE[p.kind] || '') + '</small></td>' +
      '<td data-l="שם"><b>' + esc(p.name || (p.kind === 'inbound' ? 'מתקשר/ת' : 'ללא שם')) + '</b></td>' +
      '<td data-l="טלפון"><span class="ph">' + (p.phone ? ph(p.phone) : (p.kind === 'inbound' ? 'לא נשמר' : '—')) + '</span></td>' +
      '<td data-l="אירוע/ליד">' + esc(p.event || (p.kind === 'lead' ? 'ליד' : '—')) + (p.event_date ? ' <small style="color:var(--x-mute)">' + esc(String(p.event_date).slice(8, 10) + '/' + String(p.event_date).slice(5, 7)) + '</small>' : '') + '</td>' +
      '<td data-l="מצב"><span class="st ' + (STATE_CLS[p.state] || '') + '">' + (STATE_HE[p.state] || esc(p.state)) + '</span></td>' +
      '<td data-l="ניסיונות">' + tries + '</td>' +
      '<td data-l="שיחה אחרונה">' + lc + '</td>' +
      '<td data-l="הערה">' + esc(String(note).slice(0, 120)) + '</td>' +
      '<td data-l="ניסיון הבא">' + esc(next) + '</td></tr>';
  }

  function mount(el, opt) {
    opt = opt || {};
    if (!document.getElementById('clx-css')) { var s = document.createElement('style'); s.id = 'clx-css'; s.textContent = CSS; document.head.appendChild(s); }
    if (!document.documentElement.getAttribute('data-theme')) { var t = null; try { t = localStorage.getItem('ishur_theme'); } catch (e) {} if (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark'; if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); }
    el.classList.add('clx');
    var today = ilDay(Date.now());
    var f = { agent: '', kind: '', state: '', pstate: '', review: false, q: '', from: shift(today, -6), to: today };
    var S = { calls: [], queue: null, cursor: null, fixture: null, window: null, gen: 0, counts: null, list: [] };
    el.innerHTML =
      '<div class="x-kpis" id="xK"></div>' +
      '<div class="x-head"><h2 id="xH">— שיחות · — לבדיקה</h2><small id="xHs"></small></div>' +
      '<div class="x-f">' +
      '<span class="x-seg" data-f="agent" role="group" aria-label="סוכנת"><button type="button" data-v="" aria-pressed="true">הכל</button><button type="button" data-v="שיר" aria-pressed="false">שיר</button><button type="button" data-v="נועה" aria-pressed="false">נועה</button></span>' +
      '<span class="x-seg" data-f="kind" role="group" aria-label="סוג"><button type="button" data-v="" aria-pressed="true">הכל</button><button type="button" data-v="guest" aria-pressed="false">אורחים</button><button type="button" data-v="lead" aria-pressed="false">לידים</button><button type="button" data-v="inbound" aria-pressed="false">נכנסות</button></span>' +
      '<select aria-label="מצב" data-f="state"><option value="">כל המצבים</option><option value="waiting">בתור</option><option value="done">בוצע</option><option value="noanswer">לא ענה</option><option value="failed">נכשל</option><option value="review">לבדיקה</option><option value="capped">מיצה</option><option value="past">אירוע עבר</option></select>' +
      '<input type="date" aria-label="מתאריך" data-f="from" value="' + f.from + '"><input type="date" aria-label="עד תאריך" data-f="to" value="' + f.to + '" max="' + today + '">' +
      '<label class="x-chk"><input type="checkbox" data-f="review"> רק לבדיקה</label>' +
      '<input type="search" data-f="q" placeholder="שם, טלפון, אירוע" aria-label="חיפוש">' +
      '<button type="button" class="x-btn" data-act="csv">ייצוא CSV</button></div>' +
      '<p class="x-note" id="xN" hidden></p>' +
      '<div class="x-tw"><table><thead><tr><th>סוכנת</th><th>שם</th><th>טלפון</th><th>אירוע/ליד</th><th>מצב</th><th>ניסיונות</th><th>שיחה אחרונה</th><th>הערה</th><th>ניסיון הבא</th></tr></thead><tbody id="xB"></tbody></table></div>' +
      '<div class="x-more" id="xM"></div>';
    var $ = function (id) { return el.querySelector('#' + id); };

    function serverFilter() {
      var callState = /^(done|noanswer|failed|review)$/.test(f.state) ? f.state : '';
      return { agent: f.agent, kind: f.kind, state: callState, review: f.review, q: f.q, from: f.from, to: f.to };
    }
    function fixture() {
      if (S.fixture) return Promise.resolve(S.fixture);
      return fetch((opt.fixtureUrl || 'calls-log.fixture.json') + '?v=1', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { S.fixture = d; return d; });
    }
    function fetchPage(cursor) {
      var body = Object.assign({ cursor: cursor || undefined, queue: !cursor }, serverFilter());
      return Promise.resolve(opt.api('calls-log', body)).catch(function () { return null; }).then(function (d) {
        if (d && d.ok && d.rows) return d;
        return fixture().then(function (fx) {
          if (!fx) return null;
          var sf = serverFilter();
          var rows = (fx.rows || []).filter(function (r) { return matches(r, sf); }).sort(function (a, b) { return b.ts - a.ts; });
          var start = cursor ? Number(cursor) : 0;
          return { ok: true, __fixture: true, fixture: fx.fixture, rows: rows.slice(start, start + 100), cursor: start + 100 < rows.length ? String(start + 100) : null, queue: cursor ? undefined : fx.queue, window: fx.window, all: rows };
        });
      });
    }
    function counts(gen) {
      /* N שיחות · M לבדיקה: one request per day (each request reads one day of the log) */
      var ds = dayList(f.from, f.to), tot = { calls: 0, review: 0, cost: 0, done: 0 }, i = 0, sf = serverFilter();
      if (S.lastPage && S.lastPage.__fixture) {
        S.lastPage.all.forEach(function (r) { tot.calls++; if (r.review) tot.review++; tot.cost += r.cost || 0; });
        return Promise.resolve(tot);
      }
      function next() {
        if (i >= ds.length || gen !== S.gen) return Promise.resolve();
        var d = ds[i++];
        return Promise.resolve(opt.api('calls-log', Object.assign({ count_day: d }, sf))).catch(function () { return null; }).then(function (r) { if (r && r.ok) { tot.calls += r.calls; tot.review += r.review; tot.cost += r.cost || 0; tot.done++; paintHead(tot, ds.length); } return next(); });
      }
      return Promise.all([next(), next(), next()]).then(function () { return tot; });
    }
    function paintHead(tot, n) {
      $('xH').textContent = tot.calls + ' שיחות · ' + tot.review + ' לבדיקה';
      $('xHs').textContent = f.from.slice(8, 10) + '/' + f.from.slice(5, 7) + '–' + f.to.slice(8, 10) + '/' + f.to.slice(5, 7) + (n && tot.done < n ? ' · סופר ' + tot.done + '/' + n + ' ימים…' : '');
      S.counts = tot; paintKpis();
    }
    function paintKpis() {
      var q = S.queue || [], c = S.counts || {}, calls = S.calls;
      var waiting = q.filter(function (x) { return x.state === 'waiting'; }).length;
      var ans = calls.filter(function (x) { return x.state === 'done'; }).length, na = calls.filter(function (x) { return x.state === 'noanswer'; }).length;
      var w = S.window || {};
      var tiles = [['בתור', waiting, ''], ['שיחות בטווח', c.calls == null ? '…' : c.calls, ''], ['לבדיקה', c.review == null ? '…' : c.review, c.review ? 'bad' : ''],
        ['ענו (נטען)', ans, 'ok'], ['לא ענו / תא קולי (נטען)', na, ''], ['עלות בטווח ₪', c.cost == null ? '…' : (Math.round(c.cost * 100) / 100).toFixed(2), ''], ['חלון חיוג', w.open ? 'פתוח' : 'סגור', w.open ? 'ok' : 'bad']];
      $('xK').innerHTML = tiles.map(function (t) { return '<div class="x-kpi ' + t[2] + '"><b>' + esc(t[1]) + '</b><span>' + esc(t[0]) + '</span></div>'; }).join('');
    }
    function paint() {
      S.list = people(S.calls, S.queue, { agent: f.agent, kind: f.kind, pstate: f.state, review: f.review });
      $('xB').innerHTML = S.list.length ? S.list.map(rowHtml).join('') : '<tr><td colspan="9" class="x-empty">אין שיחות לפי הסינון.</td></tr>';
      $('xM').innerHTML = S.cursor ? '<span>' + S.calls.length + ' שיחות נטענו</span><button type="button" class="x-btn" data-act="more">טען עוד 100</button>' : (S.calls.length ? '<span>כל ' + S.calls.length + ' השיחות בטווח נטענו</span>' : '');
      paintKpis();
    }
    function reload() {
      var gen = ++S.gen; S.calls = []; S.cursor = null; S.queue = null; S.counts = null;
      $('xB').innerHTML = '<tr><td colspan="9" class="x-empty">טוען…</td></tr>'; $('xM').innerHTML = '';
      paintHead({ calls: '…', review: '…' }, 0);
      return load(null, gen).then(function () { if (gen === S.gen) return counts(gen).then(function (tot) { if (gen === S.gen) paintHead(tot, 0); }); });
    }
    function load(cursor, gen, hops) {
      hops = hops || 0;
      return fetchPage(cursor).then(function (d) {
        if (gen !== S.gen) return;
        if (!d) { $('xB').innerHTML = '<tr><td colspan="9" class="x-empty">לא נטען. נסו לרענן.</td></tr>'; return; }
        S.lastPage = d;
        if (d.queue) S.queue = d.queue;
        if (d.window) S.window = d.window;
        S.calls = S.calls.concat(d.rows || []); S.cursor = d.cursor || null;
        $('xN').hidden = !d.__fixture;
        if (d.__fixture) $('xN').innerHTML = '<b>נתוני דוגמה</b> · /api/calls-log עוד לא פרוס; מוצג קובץ מנותק-זהות שנבנה מנתונים אמיתיים (' + esc((d.fixture && d.fixture.built_at || '').slice(0, 16).replace('T', ' ')) + '). שמות, טלפונים ותמלולים הוחלפו.';
        /* a server page can come back empty with a cursor (filters emptied the days it read) — keep walking, bounded */
        if (!(d.rows || []).length && d.cursor && hops < 12) return load(d.cursor, gen, hops + 1);
        paint();
      });
    }
    function csv() {
      var btn = el.querySelector('[data-act=csv]'); btn.disabled = true; btn.textContent = 'מייצא…';
      var done = function (text) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        a.download = 'ishur-calls-' + f.from + '_' + f.to + '.csv'; document.body.appendChild(a); a.click(); a.remove();
        btn.disabled = false; btn.textContent = 'ייצוא CSV';
      };
      if (S.lastPage && S.lastPage.__fixture) {
        var cols = ['day', 'agent', 'kind', 'name', 'phone', 'event', 'state', 'review', 'outcome', 'answer', 'duration_s', 'cost', 'id'];
        return done('﻿' + cols.join(',') + '\r\n' + S.lastPage.all.map(function (r) { return cols.map(function (k) { return '"' + String(r[k] == null ? '' : r[k]).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n'));
      }
      var parts = [], guard = 0;
      (function step(cursor) {
        Promise.resolve(opt.raw('calls-log', Object.assign({ format: 'csv', cursor: cursor || undefined }, serverFilter()))).then(function (r) {
          if (!r || !r.ok) throw new Error('csv');
          var nc = r.headers.get('X-Next-Cursor') || '';
          return r.text().then(function (t) { parts.push(t); if (nc && ++guard < 60) step(nc); else done(parts.join('\r\n')); });
        }).catch(function () { btn.disabled = false; btn.textContent = 'ייצוא נכשל'; });
      })(null);
    }
    el.addEventListener('click', function (e) {
      var sb = e.target.closest('.x-seg button');
      if (sb) { var seg = sb.parentNode; f[seg.dataset.f] = sb.dataset.v; seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === sb)); }); reload(); return; }
      var act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'more') { act.disabled = true; load(S.cursor, S.gen).then(paint); return; }
      if (act && act.dataset.act === 'csv') { csv(); return; }
      var pl = e.target.closest('[data-play]');
      if (pl) {
        var c = S.list[Number(pl.dataset.play)].last;
        pl.disabled = true; pl.textContent = '…';
        /* our kept copy (audit.js:166) as a blob, so the key never sits in a link */
        fetch((opt.base || 'https://go.ishur.io') + c.recording + '?key=' + encodeURIComponent(opt.adminKey || ''))
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
          .then(function (b) { var a = document.createElement('audio'); a.controls = true; a.src = URL.createObjectURL(b); pl.closest('.lc').appendChild(a); a.play().catch(function () {}); pl.remove(); })
          .catch(function () { pl.textContent = 'אין הקלטה'; });
        return;
      }
      var tr = e.target.closest('[data-tr]');
      if (tr) {
        var cc = S.list[Number(tr.dataset.tr)].last;
        var bg = document.createElement('div'); bg.className = 'x-bg';
        bg.innerHTML = '<div class="x-sh" role="dialog" aria-modal="true"><header><b>' + esc((cc.name || 'שיחה') + ' · ' + when(cc.ts)) + '</b><button type="button" aria-label="סגירה">✕</button></header>' +
          (cc.summary ? '<div class="sum">' + esc(cc.summary) + '</div>' : '') + '<pre>' + esc(cc.transcript || 'אין תמלול ביומן.') + '</pre></div>';
        var close = function () { bg.remove(); document.removeEventListener('keydown', onKey); };
        var onKey = function (ev) { if (ev.key === 'Escape') close(); };
        bg.addEventListener('click', function (ev) { if (ev.target === bg || ev.target.closest('header button')) close(); });
        document.addEventListener('keydown', onKey); document.body.appendChild(bg); bg.querySelector('header button').focus();
        if (cc.id && /^call_/.test(cc.id) && (cc.transcript || '').length >= 1990) Promise.resolve(opt.api('call-get', { id: cc.id })).then(function (r) { if (r && r.transcript) bg.querySelector('pre').textContent = r.transcript; }).catch(function () {});
      }
    });
    var tq = null;
    el.addEventListener('change', function (e) {
      var k = e.target.dataset && e.target.dataset.f; if (!k) return;
      f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (k === 'from' && !f.from) f.from = shift(today, -6);
      if (k === 'to' && !f.to) f.to = today;
      if (f.from > f.to) { var x = f.from; f.from = f.to; f.to = x; }
      /* queue-only states (בתור/מיצה/אירוע עבר) filter the loaded people, no refetch */
      if (k === 'state' && !/^(done|noanswer|failed|review)$/.test(f.state) && !S.serverState) { paint(); return; }
      S.serverState = k === 'state' ? /^(done|noanswer|failed|review)$/.test(f.state) : S.serverState;
      reload();
    });
    el.addEventListener('input', function (e) { if (e.target.dataset && e.target.dataset.f === 'q') { clearTimeout(tq); tq = setTimeout(function () { f.q = e.target.value.trim(); reload(); }, 350); } });
    reload();
    return { reload: reload };
  }
  window.IshurCallsLog = { mount: mount, people: people, matches: matches };
})();
