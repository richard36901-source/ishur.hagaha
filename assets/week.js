/* ishur.io · week.js · the control center's week (Richard 09/11)
   "יומן של השבוע בעמודות לכל יום, ובפנים קובייה לכל אירוע: מה נשלח, מתוך כמה,
   מה נדחה ולמה. לחיצה = עוד מידע + הנוסח." Priority order inside each day.
   Data: GET /api/ops/plan?period=week (ops-plan.js), on click POST /api/send-board
   {token: tok8} for people + templates, POST /api/template-text for the wording.
   Usage: IshurWeek.mount(el, { key, base })  ·  base = worker origin */
(function () {
  'use strict';
  var CSS = '' +
    '.wk{--wk-ok:#2E7D5B;--wk-bad:#A8402F;--wk-wait:#8A5A00;--wk-mute:var(--ink3,#7A847C);--wk-rail:#F0EFE9}' +
    'html[data-theme=dark] .wk{--wk-ok:#7BC9A4;--wk-bad:#F08A8A;--wk-wait:#E3AA4C;--wk-rail:#232A25}' +
    '.wk-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:.5rem;align-items:start}' +
    '.wk-day{background:var(--wk-rail);border-radius:14px;padding:.5rem;min-height:120px}' +
    '.wk-day.today{background:transparent;box-shadow:inset 0 0 0 2px var(--gold,#A8853C)}' +
    '.wk-day.past{opacity:.62}' +
    '.wk-dh{display:flex;justify-content:space-between;align-items:baseline;gap:.3rem;padding:.1rem .2rem .45rem}' +
    '.wk-dh b{font-size:.9rem}.wk-dh span{font-size:.7rem;color:var(--wk-mute);font-variant-numeric:tabular-nums}' +
    '.wk-cap{font-size:.68rem;color:var(--wk-mute);padding:0 .2rem .4rem;font-variant-numeric:tabular-nums}.wk-cap.over{color:var(--wk-bad);font-weight:600}' +
    '.wk-ev{background:var(--card,#fff);border:1px solid var(--line,#E3E1D8);border-radius:11px;padding:.45rem .55rem;margin-bottom:.4rem}' +
    '.wk-evn{font-weight:600;font-size:.82rem;line-height:1.25;display:flex;gap:.3rem;align-items:baseline;flex-wrap:wrap}' +
    '.wk-evn em{font-style:normal;font-size:.64rem;font-weight:600;background:var(--gold,#A8853C);color:#fff;border-radius:99px;padding:.02rem .4rem}' +
    '.wk-it{display:block;width:100%;text-align:right;font:inherit;background:none;border:0;border-top:1px solid var(--line,#E3E1D8);padding:.32rem 0 .2rem;margin-top:.3rem;cursor:pointer;color:inherit}' +
    '.wk-it:hover .wk-t,.wk-it:focus-visible .wk-t{text-decoration:underline}.wk-it:focus-visible{outline:2px solid var(--gold,#A8853C);outline-offset:2px;border-radius:4px}' +
    '.wk-t{font-size:.74rem;color:var(--ink2,#4A554E)}' +
    '.wk-n{font-size:.86rem;font-variant-numeric:tabular-nums}.wk-n b{font-size:.95rem}' +
    '.wk-s{display:block;font-size:.7rem;margin-top:.1rem}.wk-s.ok{color:var(--wk-ok)}.wk-s.bad{color:var(--wk-bad)}.wk-s.wait{color:var(--wk-wait)}.wk-s.mute{color:var(--wk-mute)}' +
    '.wk-evb{font:inherit;font-weight:600;font-size:.82rem;background:none;border:0;padding:0;color:inherit;cursor:pointer;text-align:right;text-decoration:underline;text-decoration-color:var(--line,#E3E1D8);text-underline-offset:3px}.wk-evb:hover{text-decoration-color:var(--gold,#A8853C)}' +
    '.wk-live{font-size:.68rem;color:var(--wk-ok);margin-top:.2rem;font-variant-numeric:tabular-nums}' +
    '.wk-evs{font-size:.68rem;color:var(--wk-mute);margin-top:.1rem}' +
    '.wk-ev[draggable=true],.wk-it[draggable=true]{cursor:grab}.wk-drag{opacity:.45}.wk-day.drop{box-shadow:inset 0 0 0 2px var(--wk-ok)}.wk-ev.drop{box-shadow:0 -3px 0 var(--wk-ok)}' +
    '.wk-toast{position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:var(--ink,#1B2420);color:var(--card,#fff);padding:.55rem 1rem;border-radius:10px;font-size:.84rem;z-index:96}' +
    '.wk-empty{font-size:.74rem;color:var(--wk-mute);padding:.3rem .2rem}' +
    '.wk-note{font-size:.74rem;color:var(--wk-mute);margin:.5rem 0 0}' +
    '@media (max-width:900px){.wk-grid{grid-template-columns:1fr}.wk-day.past{display:none}.wk-day{min-height:0}}' +
    '.wk-bg{position:fixed;inset:0;background:rgba(15,46,34,.45);display:flex;align-items:center;justify-content:center;padding:1rem;z-index:95}' +
    '.wk-sh{background:var(--card,#fff);color:var(--ink,#1B2420);border-radius:16px;width:100%;max-width:620px;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.3)}' +
    '.wk-sh header{display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--line,#E3E1D8)}' +
    '.wk-sh header b{font-size:1rem}.wk-sh header button{border:0;background:var(--wk-rail,#F0EFE9);color:inherit;width:34px;height:34px;border-radius:50%;cursor:pointer;font-size:1rem}' +
    '.wk-bd{overflow:auto;padding:.8rem 1rem 1rem;font-size:.86rem}' +
    '.wk-kv{display:grid;grid-template-columns:auto 1fr;gap:.25rem .8rem;margin:0 0 .8rem}.wk-kv dt{color:var(--wk-mute)}.wk-kv dd{margin:0;font-variant-numeric:tabular-nums}' +
    '.wk-h{font-size:.8rem;font-weight:600;margin:.9rem 0 .35rem}' +
    '.wk-msg{white-space:pre-wrap;background:#E7F6E0;color:#1B2420;border-radius:10px 10px 10px 2px;padding:.6rem .75rem;font-size:.84rem;line-height:1.5}' +
    '.wk-msg small{display:block;color:#5B6B60;margin-top:.4rem}.wk-btns{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.4rem}.wk-btns span{font-size:.74rem;border:1px solid #9CC7A4;border-radius:8px;padding:.15rem .5rem;color:#1D5E3A}' +
    '.wk-tn{font-size:.72rem;color:var(--wk-mute);margin:.2rem 0 .15rem;direction:ltr;text-align:right}' +
    '.wk-pl{list-style:none;margin:0;padding:0;font-size:.8rem}.wk-pl li{display:flex;justify-content:space-between;gap:.6rem;padding:.3rem 0;border-bottom:1px solid var(--line,#E3E1D8)}.wk-pl li span:last-child{color:var(--wk-mute);white-space:nowrap}' +
    '.wk-tabs{display:flex;gap:.3rem;flex-wrap:wrap;margin:.3rem 0 .4rem}.wk-tabs button{font:inherit;font-size:.74rem;padding:.2rem .6rem;border-radius:99px;border:1px solid var(--line,#E3E1D8);background:transparent;color:inherit;cursor:pointer}.wk-tabs button[aria-pressed=true]{background:var(--ink,#1B2420);color:var(--card,#fff)}' +
    '.wk-a{display:inline-block;margin-top:.8rem;color:var(--gold,#A8853C)}';

  /* priority inside a day: the event that happens today first, then the waves, then calls, then Noa */
  var PRI = { table: 0, eventday: 0, daybefore: 1, subevent: 2, w1: 3, w2: 4, w3: 5, thanks: 6, gift: 6, subevent_reminder: 7, call: 8, lead_sends: 9 };
  var SHORT = { w1: 'הזמנה · גל 1', w2: 'תזכורת · גל 2', w3: 'שליחה נוספת · גל 3', daybefore: 'הודעת יום-לפני', table: 'הודעת השולחן', eventday: 'הודעת יום האירוע', thanks: 'הודעת תודה', gift: 'הודעת מתנה', subevent: 'אירוע-בן', subevent_reminder: 'תזכורת אירוע-בן', call: 'שיחות שיר', lead_sends: 'הודעות ללידים' };
  var EXPECT = { w1: 'hazmana_ishur', w2: 'hazmana_ishur', w3: 'hazmana_ishur', table: 'ishur_shulchan', daybefore: 'ishur_yom_lifnei', thanks: 'ishur_toda_orach' };
  var BUCKET_HE = { read: 'נקרא', delivered: 'נמסר', no_status: 'נשלח', failed: 'נכשל', pending: 'ממתין', answered: 'ענו', skipped: 'דילוג', dropped: 'דולג', unknown: 'לא ידוע' };

  var opt = {}, root = null, plan = null, boards = {}, texts = {};
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function stamp(b) { return window.IshurGuard ? IshurGuard.stamp(b) : b; }
  function post(path, body) {
    return fetch(opt.base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stamp(Object.assign({ admin_key: opt.key }, body || {}))) })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function getOne(period) {
    return fetch(opt.base + '/api/ops/plan?period=' + period, { headers: { 'x-admin-key': opt.key } })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  /* 09/11 (Richard): from today forward — seven days, even across the week/month edge */
  function getPlan() {
    return Promise.all([getOne('week'), getOne('month')]).then(function (r) {
      var w = r[0], m = r[1]; if (!(w && w.ok) && !(m && m.ok)) return null;
      var base = (w && w.ok) ? w : m, by = {};
      [m, w].forEach(function (p) { if (p && p.ok) (p.days || []).forEach(function (d) { by[d.day] = d; }); });
      var today = base.today;
      var days = Object.keys(by).sort().filter(function (d) { return d >= today; }).slice(0, 7).map(function (d) { return by[d]; });
      return { ok: true, at: base.at, today: today, days: days };
    });
  }
  var info = {}, live = null;
  /* 09/11 (Richard: "שיהיה לייב ויתעדכן פעם בדקה"): /api/ops/realtime — today's sends per event per number, calls per event */
  function getLive() {
    return fetch(opt.base + '/api/ops/realtime', { headers: { 'x-admin-key': opt.key } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.ok) return;
      var sent = {};
      ((d.wa && d.wa.numbers) || []).forEach(function (n) { if (n.role !== 'guests') return; Object.keys(n.by_event || {}).forEach(function (t) { var e = n.by_event[t]; sent[t] = (sent[t] || 0) + (e.total || 0) - (e.reply || 0); }); });
      live = { at: d.at, sent: sent, calls: (d.calls && d.calls.by_event) || {}, cap: d.cap || null };
    }).catch(function () {});
  }
  function loadInfo() {
    var want = {};
    (plan.days || []).forEach(function (d) { (d.items || []).forEach(function (it) { var t = it.event && it.event.tok8; if (t && !info[t]) want[t] = 1; }); });
    var list = Object.keys(want); if (!list.length) return Promise.resolve();
    return post('board-event', { tok8s: list }).then(function (r) { if (r && r.events) Object.keys(r.events).forEach(function (k) { info[k] = r.events[k]; }); });
  }
  function hm(ts) { var d = new Date(ts); return isNaN(d) || !ts ? '' : d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }); }
  function dm(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? Number(p[2]) + '/' + Number(p[1]) : iso; }
  function num(n) { return Number(n || 0).toLocaleString('he-IL'); }

  /* one line's status, in plain words */
  function statusOf(it, day) {
    var r = String(it.reason_he || '');
    if (it.kind === 'call') {
      if (it.status === 'done') return { c: 'ok', t: (it.answered || 0) + ' ענו' };
      if (it.status === 'in_progress') return { c: 'wait', t: 'בתהליך · ' + (it.answered || 0) + ' ענו' };
      if (/hold|מוחזק/.test(r)) return { c: 'wait', t: 'מוחזק' };
      return { c: it.status === 'missed' ? 'bad' : 'wait', t: it.status === 'missed' ? (r || 'לא קרה') : 'ממתין' + (it.time_hm ? ' · ' + it.time_hm : '') };
    }
    if (it._note) return { c: 'mute', t: it._note };
    if (it.status === 'done') return { c: 'ok', t: it.failed_n ? '✓ יצא · ' + it.failed_n + ' נכשלו' : '✓ יצא' };
    if (/hold|מוחזק/.test(r)) return { c: 'wait', t: '⏸ מוחזק' };
    if (/131042|חיוב מטא/.test(r)) return { c: 'bad', t: '✗ חיוב מטא חסום' };
    if (/מכסה|cap/.test(r)) return { c: 'wait', t: it.status === 'in_progress' ? '⏳ ממשיך כשיתפנה מקום (מכסה)' : '↪ ממתין למכסה' };
    if (/נדחה/.test(r)) return { c: 'wait', t: '↪ ' + r };
    if (it.status === 'in_progress') return { c: 'wait', t: '⏳ בתהליך' };
    if (it.status === 'missed') return { c: 'bad', t: '✗ ' + (r || 'לא יצא') };
    return { c: day.future ? 'mute' : 'wait', t: (day.future ? 'מתוכנן' : 'ממתין') + (it.time_hm ? ' · ' + it.time_hm : '') };
  }

  function dayItems(day) {
    var items = (day.items || []).filter(function (it) {
      if (it.kind === 'cron' || it.kind === 'event' || it.kind === 'hostess') return false;
      if (it.kind === 'send' && it.type === 'reply') return false;
      /* 09/11 (Richard): an event that already happened gets nothing but the thank-you — the rest is cancelled, not shown */
      var e = it.event && info[it.event.tok8];
      if (e && e.date && e.date < plan.today && it.type !== 'thanks') return false;
      return true;
    });
    /* Shir's round, projected: the morning after the last wave (board-event batch) — unless the planner already has it */
    (Object.keys(info)).forEach(function (t) {
      var c = info[t].calls; if (!c || c.day !== day.day || !c.n) return;
      if (info[t].date && info[t].date < plan.today) return;
      if (items.some(function (it) { return it.kind === 'call' && it.event && it.event.tok8 === t; })) return;
      items.push({ id: 'proj:' + t + ':' + day.day, kind: 'call', event: { tok8: t, name: info[t].name }, planned_n: c.n, done_n: 0, answered: 0, status: 'waiting', reason_he: 'סבב שיחות של שיר למי שלא ענה (בערך ' + c.n + ')', _proj: true });
    });
    var happening = {};
    (day.items || []).forEach(function (it) { if (it.kind === 'event' && it.event && it.event.tok8) happening[it.event.tok8] = 1; });
    /* one message per guest on the event day: a dropped day-before is noise once the day's message is there */
    var dayMsg = {};
    items.forEach(function (it) { if ((it.type === 'table' || it.type === 'eventday') && it.event) dayMsg[it.event.tok8] = 1; });
    items = items.filter(function (it) { return !(it.type === 'daybefore' && it.status === 'missed' && dayMsg[it.event.tok8]); });
    /* the engine never sends a guest a second event-day message (index.js stage 4, edMarkKey) — say so instead of "ממתין" */
    var dayDone = {};
    items.forEach(function (it) { if (it.type === 'eventday' && it.done_n > 0) dayDone[it.event.tok8] = 1; });
    items.forEach(function (it) { if (it.type === 'table' && !it.done_n && dayDone[it.event.tok8]) it._note = 'לא יוצא: הודעת יום האירוע כבר נשלחה (הודעה אחת לאורח)'; });
    var groups = {}, order = [];
    items.forEach(function (it) {
      var k = it.kind === 'lead_sends' ? 'leads' : (it.event && it.event.tok8) || it.id;
      if (!groups[k]) { groups[k] = { key: k, name: (it.event && it.event.name) || '', tok8: it.event && it.event.tok8, today: !!happening[k], items: [] }; order.push(k); }
      groups[k].items.push(it);
    });
    var pri = function (it) { var p = PRI[it.kind === 'send' ? it.type : it.kind]; return p == null ? 5 : p; };
    order.forEach(function (k) { groups[k].items.sort(function (a, b) { return pri(a) - pri(b); }); });
    return order.map(function (k) { return groups[k]; }).sort(function (a, b) {
      if (a.today !== b.today) return a.today ? -1 : 1;
      return pri(a.items[0]) - pri(b.items[0]);
    });
  }

  function render() {
    if (!root) return;
    if (!plan) { root.innerHTML = '<div class="wk-empty">לא הצלחתי לטעון את השבוע. רענון בעוד רגע.</div>'; return; }
    var html = '<div class="wk-grid">';
    (plan.days || []).forEach(function (day, di) {
      var cls = 'wk-day' + (day.today ? ' today' : '') + (day.past ? ' past' : '');
      html += '<section data-day="' + esc(day.day) + '" class="' + cls + '" aria-label="' + esc(day.dow_he + ' ' + dm(day.day)) + '"><div class="wk-dh"><b>' + esc(day.dow_he) + (day.today ? ' · היום' : '') + '</b><span>' + esc(dm(day.day)) + '</span></div>';
      var cap = day.capacity;
      if (day.today && live && live.cap && live.cap.limit) html += '<div class="wk-cap">● עכשיו: ' + num(live.cap.used) + ' מתוך ' + num(live.cap.limit) + ' יצאו ב-24 שעות · נשארו ' + num(live.cap.remaining) + '</div>';
      else if (cap && cap.capacity) html += '<div class="wk-cap' + (cap.overflow > 0 ? ' over' : '') + '">' + num(cap.planned) + ' הודעות מתוך תקרה ' + num(cap.capacity) + (cap.overflow > 0 ? ' · ' + num(cap.overflow) + ' עוברות למחר' : '') + '</div>';
      var gs = dayItems(day);
      if (!gs.length) html += '<div class="wk-empty">אין שליחות</div>';
      gs.forEach(function (g) {
        var e = info[g.tok8] || {};
        var title = g.key === 'leads' ? 'לידים · נועה' : (e.occasion ? e.occasion + ' · ' : '') + (e.name || g.name);
        var sub = g.key === 'leads' ? '' : [e.client && e.client !== e.name ? e.client : '', e.date ? 'אירוע ' + dm(e.date) : ''].filter(Boolean).join(' · ');
        html += '<div class="wk-ev"' + (g.tok8 ? ' draggable="true" data-tok="' + esc(g.tok8) + '" data-d="' + di + '"' : '') + '><div class="wk-evn">' +
          (g.tok8 ? '<button type="button" class="wk-evb" data-tok="' + esc(g.tok8) + '">' + esc(title) + '</button>' : esc(title)) + (g.today ? '<em>האירוע היום</em>' : '') + '</div>' +
          (sub ? '<div class="wk-evs">' + esc(sub) + '</div>' : '') +
          (day.today && live && g.tok8 && (live.sent[g.tok8] || live.calls[g.tok8]) ? '<div class="wk-live">● עכשיו: ' + [live.sent[g.tok8] ? num(live.sent[g.tok8]) + ' הודעות יצאו היום' : '', live.calls[g.tok8] ? num(live.calls[g.tok8].dialed || 0) + ' חויגו · ' + num(live.calls[g.tok8].queued || 0) + ' בתור לשיחה' : ''].filter(Boolean).join(' · ') + '</div>' : '');
        g.items.forEach(function (it) {
          var st = statusOf(it, day), kindKey = it.kind === 'send' ? it.type : it.kind;
          var n = it._proj ? 'בערך <b>' + num(it.planned_n) + '</b> שיחות' : it.kind === 'call' ? '<b>' + num(it.done_n) + '</b> חויגו' + (it.planned_n > it.done_n ? ' מתוך ' + num(it.planned_n) : '')
            : it.total_sent != null && it.of && /^w[123]$/.test(it.type)
              /* 09/11 (Richard): "0 מתוך 505" looked like nothing went out — show the whole wave, today's part beside it */
              ? 'בסך הכל <b>' + num(it.total_sent) + '</b> מתוך ' + num(it.of) + '<br><span class="wk-t">היום ' + num(it.done_n) + (it.left != null ? ' · נשארו ' + num(it.left) : '') + '</span>'
              : '<b>' + num(it.done_n) + '</b> נשלחו מתוך ' + num(Math.max(it.planned_n || 0, it.done_n || 0) || it.of || 0);
          var movable = it.kind === 'send' && /^w[123]$/.test(it.type) && it.status !== 'done';
          html += '<button type="button" class="wk-it"' + (movable ? ' draggable="true" data-move="' + esc(it.event.tok8 + '|' + it.type) + '"' : '') + ' data-d="' + di + '" data-id="' + esc(it.id) + '"><span class="wk-t">' + esc(SHORT[kindKey] || it.label_he) + '</span><div class="wk-n">' + n + '</div><span class="wk-s ' + st.c + '">' + esc(st.t) + '</span></button>';
        });
        html += '</div>';
      });
      html += '</section>';
    });
    html += '</div><p class="wk-note">' + (live ? '● חי ' + esc(hm(live.at)) + ' · ' : '') + 'תכנון עודכן ' + esc(hm(plan.at)) + ' · לחיצה על שם אירוע = כל הנתונים · על שורה = נוסח ומי קיבל · גרירת גל ליום אחר = שינוי תאריך · גרירת אירוע מעל אחר = סדר עדיפות</p>';
    root.innerHTML = html;
  }

  function sheet(title, body) {
    var bg = document.createElement('div'); bg.className = 'wk-bg';
    bg.innerHTML = '<div class="wk-sh" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><header><b>' + esc(title) + '</b><button type="button" aria-label="סגירה">✕</button></header><div class="wk-bd">' + body + '</div></div>';
    var close = function () { bg.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', function (e) { if (e.target === bg) close(); });
    bg.querySelector('header button').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    bg.querySelector('header button').focus();
    return bg.querySelector('.wk-bd');
  }

  function msgHtml(t, expected) {
    if (!t || t.missing) return '<p class="wk-tn">' + esc((t && t.name) || '') + ' · הנוסח לא נמצא במטא</p>';
    return '<p class="wk-tn">' + esc(t.name) + (expected ? ' · צפוי' : '') + ' · ' + esc(t.category || '') + ' · ' + esc(t.status || '') + '</p><div class="wk-msg">' + (t.header ? '<b>' + esc(t.header) + '</b>\n' : '') + esc(t.body) + (t.footer ? '<small>' + esc(t.footer) + '</small>' : '') + '</div>' +
      (t.buttons && t.buttons.length ? '<div class="wk-btns">' + t.buttons.map(function (b) { return '<span>' + esc(b) + '</span>'; }).join('') + '</div>' : '');
  }

  function open(di, id) {
    var day = plan.days[di]; var it = (day.items || []).filter(function (x) { return x.id === id; })[0]; if (!it) return;
    var kindKey = it.kind === 'send' ? it.type : it.kind;
    var st = statusOf(it, day);
    var title = (SHORT[kindKey] || it.label_he) + (it.event && it.event.name && it.kind !== 'lead_sends' ? ' · ' + it.event.name : '');
    var kv = '<dl class="wk-kv"><dt>יום</dt><dd>' + esc(day.dow_he + ' ' + dm(day.day)) + (it.time_hm ? ' · ' + esc(it.time_hm) : '') + '</dd>' +
      (it.total_sent != null && it.of ? '<dt>בסך הכל</dt><dd>' + num(it.total_sent) + ' מתוך ' + num(it.of) + (it.left != null ? ' · נשארו ' + num(it.left) : '') + '</dd>' : '') + '<dt>' + (it.kind === 'call' ? 'חויגו' : 'נשלחו היום') + '</dt><dd>' + num(it.done_n) + (it.planned_n ? ' מתוך ' + num(it.planned_n) : '') + (it.of && it.of !== it.planned_n ? ' (קהל ' + num(it.of) + ')' : '') + '</dd>' +
      (it.failed_n ? '<dt>נכשלו</dt><dd>' + num(it.failed_n) + '</dd>' : '') +
      (it.kind === 'call' ? '<dt>ענו</dt><dd>' + num(it.answered || 0) + '</dd>' : '') +
      '<dt>מצב</dt><dd>' + esc(st.t) + '</dd>' + (it.reason_he ? '<dt>למה</dt><dd>' + esc(it.reason_he) + '</dd>' : '') + '</dl>';
    var bd = sheet(title, kv + '<div class="wk-more"><p class="wk-note">טוען נוסח ונמענים…</p></div>');
    var more = bd.querySelector('.wk-more');
    if (it.kind === 'call') { more.innerHTML = '<a class="wk-a" href="admin.html?view=calls">למוקד השיחות, עם הקלטות ותמלולים ›</a>'; return; }
    if (it.kind === 'lead_sends') { more.innerHTML = '<a class="wk-a" href="inbox.html">לאינבוקס של נועה ›</a>'; return; }
    var tok = it.event && it.event.tok8; if (!tok) { more.innerHTML = ''; return; }
    var bp = boards[tok] ? Promise.resolve(boards[tok]) : post('send-board', { token: tok }).then(function (b) { if (b) boards[tok] = b; return b; });
    bp.then(function (b) {
      var ev = b && (b.events || [])[0]; var row = ev && (ev.types || []).filter(function (t) { return t.key === it.type; })[0];
      var names = row && row.templates ? Object.keys(row.templates).sort(function (x, y) { return row.templates[y] - row.templates[x]; }) : [];
      var expected = false;
      if (!names.length && EXPECT[it.type]) { names = [EXPECT[it.type]]; expected = true; }
      var need = names.filter(function (n) { return !texts[n]; });
      var tp = need.length ? post('template-text', { names: need }).then(function (r) { if (r && r.templates) Object.keys(r.templates).forEach(function (k) { texts[k] = r.templates[k]; }); }) : Promise.resolve();
      return tp.then(function () {
        var h = '';
        if (names.length) {
          h += '<div class="wk-h">הנוסח' + (names.length > 1 ? ' · ' + names.length + ' גרסאות לפי האורח' : '') + '</div>';
          names.slice(0, 3).forEach(function (n) { h += (row && row.templates[n] ? '<p class="wk-tn">' + num(row.templates[n]) + ' הודעות</p>' : '') + msgHtml(texts[n], expected); });
        } else h += '<p class="wk-note">אין נוסח רשום להודעה הזאת.</p>';
        var ppl = row && row.people;
        if (ppl) {
          var tabs = Object.keys(BUCKET_HE).filter(function (k) { return ppl[k] && ppl[k].length; });
          if (tabs.length) {
            h += '<div class="wk-h">מי קיבל</div><div class="wk-tabs">' + tabs.map(function (k, i) { return '<button type="button" data-b="' + k + '" aria-pressed="' + (i === 0) + '">' + esc(BUCKET_HE[k]) + ' ' + ppl[k].length + '</button>'; }).join('') + '</div><ul class="wk-pl"></ul>';
          }
          more.innerHTML = h;
          var ul = more.querySelector('.wk-pl');
          var show = function (k) {
            if (!ul) return;
            ul.innerHTML = ppl[k].slice(0, 300).map(function (p) { return '<li><span>' + esc(p.name || p.phone) + '</span><span>' + esc(p.reason_he || p.why || hm(p.at)) + '</span></li>'; }).join('');
            more.querySelectorAll('.wk-tabs button').forEach(function (bt) { bt.setAttribute('aria-pressed', String(bt.dataset.b === k)); });
          };
          if (tabs.length) show(tabs[0]);
          more.querySelectorAll('.wk-tabs button').forEach(function (bt) { bt.addEventListener('click', function () { show(bt.dataset.b); }); });
        } else more.innerHTML = h;
        more.insertAdjacentHTML('beforeend', '<a class="wk-a" href="calendar.html">ללוח השליחות המלא ›</a>');
      });
    }).catch(function () { more.innerHTML = '<p class="wk-note">לא הצלחתי לטעון את הפרטים.</p>'; });
  }

  var PLAN_HE = { basic: 'בסיס', pro: 'פרמיום', premium: 'הכל כלול' };
  function openEvent(tok) {
    var e = info[tok] || {};
    var bd = sheet((e.occasion ? e.occasion + ' · ' : '') + (e.name || tok), '<p class="wk-note">טוען…</p>');
    post('board-event', { tok8: tok }).then(function (d) {
      if (!d || !d.ok) { bd.innerHTML = '<p class="wk-note">לא הצלחתי לטעון.</p>'; return; }
      var st = d.stats || {}, w = d.waves || {};
      bd.innerHTML = '<dl class="wk-kv">' +
        '<dt>לקוח</dt><dd>' + esc(d.client) + (d.client_phone ? ' · <span dir="ltr">' + esc(String(d.client_phone).replace(/^972/, '0')) + '</span>' : '') + '</dd>' +
        '<dt>מתי</dt><dd>' + esc(dm(d.date)) + (d.time ? ' · ' + esc(d.time) : '') + '</dd>' +
        '<dt>איפה</dt><dd>' + esc([d.venue, d.city].filter(Boolean).join(', ')) + '</dd>' +
        '<dt>חבילה</dt><dd>' + esc(PLAN_HE[d.plan] || d.plan || '') + (d.paid ? '' : ' · לא שולם') + (d.cancelled ? ' · בוטל' : '') + '</dd>' +
        '<dt>מצב</dt><dd>' + (d.hold ? '⏸ מוחזק' + (d.holdtill ? ' עד ' + esc(dm(d.holdtill)) : '') : 'פעיל') + (d.order >= 0 ? ' · מקום ' + (d.order + 1) + ' בתור' : '') + (d.prio_share ? ' · עד ' + d.prio_share + ' ביום' : '') + '</dd>' +
        '<dt>מוזמנים</dt><dd>' + num(st.guests) + '</dd>' +
        '<dt>מגיעים</dt><dd>' + num(st.coming) + ' (' + num(st.diners) + ' סועדים)</dd>' +
        '<dt>לא מגיעים</dt><dd>' + num(st.not) + '</dd><dt>מתלבטים</dt><dd>' + num(st.maybe) + '</dd><dt>לא ענו</dt><dd>' + num(st.none) + '</dd>' +
        (st.tables ? '<dt>עם שולחן</dt><dd>' + num(st.tables) + '</dd>' : '') +
        '<dt>גלים</dt><dd>' + ['1', '2', '3'].filter(function (k) { return w[k]; }).map(function (k) { return 'גל ' + k + ': ' + dm(w[k]); }).join(' · ') + '</dd></dl>' +
        (d.custom && d.custom.text ? '<div class="wk-h">נוסח ההזמנה האישי · ' + esc(d.custom.status || '') + '</div><div class="wk-msg">' + esc(d.custom.text) + '</div>' : '') +
        '<a class="wk-a" href="' + esc(d.links.dashboard) + '" target="_blank" rel="noopener">לדשבורד המלא של האירוע ›</a>';
    });
  }
  function toast(t) { var el = document.createElement('div'); el.className = 'wk-toast'; el.textContent = t; document.body.appendChild(el); setTimeout(function () { el.remove(); }, 3500); }
  var drag = null;
  function wireDnd() {
    root.addEventListener('dragstart', function (e) {
      var it = e.target.closest && e.target.closest('[data-move]'), ev = !it && e.target.closest && e.target.closest('.wk-ev[data-tok]');
      if (it) drag = { kind: 'move', key: it.dataset.move, el: it }; else if (ev) drag = { kind: 'order', tok: ev.dataset.tok, day: ev.dataset.d, el: ev }; else return;
      drag.el.classList.add('wk-drag'); try { e.dataTransfer.setData('text/plain', 'x'); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
      e.stopPropagation();
    });
    root.addEventListener('dragend', function () { if (drag) drag.el.classList.remove('wk-drag'); drag = null; root.querySelectorAll('.drop').forEach(function (x) { x.classList.remove('drop'); }); });
    root.addEventListener('dragover', function (e) {
      if (!drag) return; var tgt = drag.kind === 'move' ? e.target.closest('.wk-day') : e.target.closest('.wk-ev[data-tok]');
      if (!tgt || (drag.kind === 'order' && tgt.dataset.d !== drag.day)) return;
      e.preventDefault(); root.querySelectorAll('.drop').forEach(function (x) { if (x !== tgt) x.classList.remove('drop'); }); tgt.classList.add('drop');
    });
    root.addEventListener('drop', function (e) {
      if (!drag) return; e.preventDefault(); var d = drag;
      if (d.kind === 'move') {
        var day = e.target.closest('.wk-day'); if (!day) return; var date = day.dataset.day, p = d.key.split('|'), en = info[p[0]] || {};
        if (!confirm('להעביר את ' + (SHORT[p[1]] || p[1]) + ' של ' + (en.name || p[0]) + ' ל-' + dm(date) + '?')) return;
        post('board-move', { tok8: p[0], type: p[1], date: date }).then(function (r) {
          var ERR = { 'after-event': 'אחרי תאריך האירוע', 'date-in-past': 'תאריך שעבר', shabbat: 'שבת', 'out-of-order': 'הסדר בין הגלים נשבר (גל 1 לפני גל 2)', 'already-sent': 'הגל כבר יצא', 'extra-not-paid': 'שליחה נוספת לא שולמה' };
          if (r && r.ok) { toast('הועבר ל-' + dm(date) + '. הלוח יתעדכן בסבב הבא (עד 10 דקות)'); }
          else toast('לא הועבר: ' + (r && ERR[r.error] || (r && r.error) || 'שגיאה'));
        });
      } else {
        var tgt = e.target.closest('.wk-ev[data-tok]'); if (!tgt || tgt.dataset.tok === d.tok) return;
        var col = tgt.closest('.wk-day'); var toks = Array.prototype.map.call(col.querySelectorAll('.wk-ev[data-tok]'), function (x) { return x.dataset.tok; }).filter(function (t) { return t !== d.tok; });
        toks.splice(toks.indexOf(tgt.dataset.tok), 0, d.tok);
        post('board-order', { order: toks }).then(function (r) {
          if (r && r.ok) { tgt.parentNode.insertBefore(d.el, tgt); toast('סדר העדיפות נשמר: ' + toks.map(function (t) { return (info[t] || {}).name || t; }).join(' > ')); }
          else toast('הסדר לא נשמר');
        });
      }
    });
  }
  function load() { return Promise.all([getPlan().then(function (p) { if (p && p.ok) plan = p; return plan ? loadInfo() : null; }), getLive()]).then(render, render); }
  var timer = null;

  window.IshurWeek = {
    mount: function (el, o) {
      opt = o || {}; root = el; if (!root) return;
      if (!document.getElementById('wk-css')) { var s = document.createElement('style'); s.id = 'wk-css'; s.textContent = CSS; document.head.appendChild(s); }
      root.classList.add('wk');
      if (!root.dataset.wired) {
        root.dataset.wired = '1';
        root.addEventListener('click', function (e) { var n = e.target.closest('.wk-evb'); if (n) { openEvent(n.dataset.tok); return; } var b = e.target.closest('.wk-it'); if (b) open(Number(b.dataset.d), b.dataset.id); });
        wireDnd();
        root.innerHTML = '<div class="wk-empty">טוען את השבוע…</div>';
      }
      boards = {};
      if (!timer) timer = setInterval(function () { if (document.hidden || document.querySelector('.wk-bg')) return; load(); }, 60000);
      return load();
    }
  };
})();
