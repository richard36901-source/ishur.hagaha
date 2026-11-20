/* ishur client app · the screens. Plain JS, no build step.
   Talks to the same Worker routes the website uses and changes none of them:
     POST /api/account/pin-login {phone, pin}      → {session}
     POST /api/account/me        {session}         → {phone, events[]}
     POST /api/status            {token, board_session} → the event's board data
     POST /api/account/logout    {session}
   Rule for every screen: never show failure wording. When something does not load, show what we last had and the
   time it was loaded; when sign-in does not pass, say so plainly and offer WhatsApp. */
(function () {
  'use strict';
  var ENV = window.ISHUR_ENV || {};
  var $ = function (id) { return document.getElementById(id); };
  var NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  var plugin = function (n) { return (NATIVE && window.Capacitor.Plugins && window.Capacitor.Plugins[n]) || null; };

  /* ── storage (everything under one prefix, so sign-out can remove it all) ── */
  var PRE = 'ishurapp_';
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(PRE + k)); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(PRE + k, JSON.stringify(v)); } catch (e) {} },
    clear: function () { try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf(PRE) === 0) localStorage.removeItem(k); }); } catch (e) {} }
  };

  /* ── network ── */
  function post(path, body) {
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 30000);
    return fetch(ENV.api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; }); })
      .catch(function () { return { status: 0, body: {} }; })
      .then(function (res) { clearTimeout(timer); return res; });
  }

  /* ── state ── */
  var session = store.get('session') || '';
  var events = store.get('events') || [];
  var current = store.get('current') || '';
  var data = null, filter = 'all', loading = false;

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var heDate = function (iso) { var p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : ''; };
  var heDay = function (iso) { var p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '.' + p[1] : ''; };
  var WEEK = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  function daysTo(iso) { var d = new Date(String(iso).slice(0, 10) + 'T00:00:00'); if (isNaN(d)) return null; var t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / 86400000); }
  function waLink(text) { return 'https://wa.me/' + ENV.whatsapp + '?text=' + encodeURIComponent(text); }
  function openUrl(url) { var b = plugin('Browser'); if (b) b.open({ url: url }); else window.open(url, '_blank', 'noopener'); }
  function haptic() { var h = plugin('Haptics'); if (h) h.impact({ style: 'LIGHT' }).catch(function () {}); }

  /* ── guests: the same rules the web board uses ── */
  var STATUS = { confirmed: ['אישרו', 'yes'], declined: ['לא מגיעים', 'no'], undecided: ['לא בטוחים', 'maybe'], pending: ['לא ענו', 'wait'] };
  function inviteWentOut() { return ((data && data.sends) || []).some(function (x) { return x.key === 'invite' && (x.status === 'sent' || x.status === 'passed'); }); }
  function notReached(g) {
    if (!g || g.status !== 'pending') return '';
    if (g.sent === 'failed') return g.sent_code === '131026' ? 'אין וואטסאפ' : 'לא נמסר';
    if (g.sent === 'retrying') return 'ננסה שוב';
    if ((!g.sent || g.sent === 'none') && inviteWentOut() && !g.self) return 'טרם נשלח';
    return '';
  }
  function normalize(d) {
    (d.guests || []).forEach(function (g) { if (g.status === 'awaiting_call' || !STATUS[g.status]) g.status = 'pending'; });
    return d;
  }
  /* Keep only what the screens show. Guest phones, gifts, invoices and the rest of the board's data are dropped
     before anything is held in memory or saved on the device. */
  function slim(d) {
    var e = d.event || {}, t = d.totals || {};
    return {
      ok: true, pub: d.pub || '',
      event: { name1: e.name1, name2: e.name2, occasion: e.occasion, occasion_label: e.occasion_label, event_date: e.event_date, reception_time: e.reception_time, venue_name: e.venue_name, venue_city: e.venue_city },
      totals: { confirmed_seats: t.confirmed_seats },
      sends: (d.sends || []).map(function (s) { return { key: s.key, label: s.label, date: s.date, status: s.status, sent_n: s.sent_n, stats: s.stats ? { answered: s.stats.answered } : null }; }),
      guests: (d.guests || []).map(function (g) { return { name: g.name, status: g.status, seats: g.seats, table: g.table, self: g.self, at: String(g.at || '').slice(0, 10), sent: g.sent, sent_code: g.sent_code }; })
    };
  }
  function inFilter(g, k) { return k === 'all' ? true : k === 'failed' ? !!notReached(g) : g.status === k; }
  function count(k) { return ((data && data.guests) || []).filter(function (g) { return inFilter(g, k); }).length; }

  /* ── screens ── */
  function show(signedIn) {
    $('signin').hidden = signedIn; $('app').hidden = !signedIn; $('tabs').hidden = !signedIn;
  }
  /* Home ("ראשי") is the regular client board itself, so the app looks and works like the board clients know.
     With no network the app's own summary takes its place, from the copy saved on the device. */
  var offline = (navigator.onLine === false);
  function tab(name) {
    if (name === 'board' && offline) name = 'summary';
    ['summary', 'guests', 'sends', 'board', 'account'].forEach(function (t) { $('v-' + t).hidden = t !== name; });
    var lit = name === 'summary' ? 'board' : name;
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === lit); });
    window.scrollTo(0, 0);
    if (name === 'board') openBoard();
  }
  /* The regular client board, in its app mode, inside the app. The session travels in the address fragment (never
     sent to a server), so a locked board opens too. Loaded on first use and again when the event changes. */
  var boardFor = '';
  function openBoard() {
    if (!current || boardFor === current) return;
    boardFor = current;
    $('boardWait').hidden = false;
    $('boardFrame').src = ENV.board + '?t=' + encodeURIComponent(current) + '&app=1#s=' + encodeURIComponent(session);
  }
  $('boardFrame').addEventListener('load', function () { $('boardWait').hidden = true; });
  function evTitle(e) { return (e && (e.name || e.occasion)) || 'האירוע'; }

  function render() {
    var ev = events.filter(function (e) { return e.token === current; })[0] || events[0] || {};
    $('accPhone').textContent = store.get('phone') ? '0' + String(store.get('phone')).replace(/^972/, '') : '';
    $('ver').textContent = 'גרסה ' + (ENV.version || '') + (ENV.name === 'staging' ? ' · סביבת בדיקות' : '');
    var many = events.length > 1;
    $('evSwitch').hidden = !many; $('evSwitch').textContent = evTitle(ev) + ' ▾';
    $('evListCard').hidden = !many;
    $('evList').innerHTML = events.map(function (e) { return '<button type="button" data-ev="' + esc(e.token) + '"' + (e.token === current ? ' class="on"' : '') + '>' + esc(evTitle(e)) + ' <span class="muted">' + esc(heDate(e.date)) + '</span></button>'; }).join('');
    if (!data) {
      $('evName').textContent = evTitle(ev); $('evKind').textContent = ev.occasion || '';
      $('evWhen').textContent = heDate(ev.date); $('evWhere').textContent = [ev.venue, ev.city].filter(Boolean).join(' · ');
      return;
    }
    var e = data.event || {}, t = data.totals || {};
    $('evKind').textContent = e.occasion_label || e.occasion || '';
    $('evName').textContent = [e.name1, e.name2].filter(Boolean).join(' ו') || evTitle(ev);
    var dd = daysTo(e.event_date), dObj = new Date(String(e.event_date).slice(0, 10) + 'T00:00:00');
    $('evWhen').textContent = [isNaN(dObj) ? '' : 'יום ' + WEEK[dObj.getDay()], heDate(e.event_date), e.reception_time].filter(Boolean).join(' · ') +
      (dd == null ? '' : dd > 1 ? ' · בעוד ' + dd + ' ימים' : dd === 1 ? ' · מחר' : dd === 0 ? ' · היום' : '');
    $('evWhere').textContent = [e.venue_name, e.venue_city].filter(Boolean).join(' · ');

    var all = count('all'), yes = count('confirmed'), maybe = count('undecided'), no = count('declined'), wait = count('pending'), fail = count('failed');
    $('kpiSeats').textContent = t.confirmed_seats != null ? t.confirmed_seats : yes;
    $('kpiAll').textContent = all; $('kpiYes').textContent = yes; $('kpiMaybe').textContent = maybe;
    $('kpiWait').textContent = wait; $('kpiNo').textContent = no; $('kpiFail').textContent = fail;
    var pct = function (n) { return all ? (n / all * 100).toFixed(1) + '%' : '0'; };
    $('barYes').style.width = pct(yes); $('barMaybe').style.width = pct(maybe); $('barNo').style.width = pct(no);
    $('barLbl').textContent = all ? (all - wait) + ' מתוך ' + all + ' הזמנות נענו' : '';

    var next = (data.sends || []).filter(function (s) { return s.status === 'scheduled'; })[0];
    $('nextCard').hidden = !next;
    if (next) { $('nextLbl').textContent = next.label; $('nextDate').textContent = heDay(next.date); }
    $('share').hidden = !data.pub;

    ['all', 'confirmed', 'undecided', 'pending', 'declined', 'failed'].forEach(function (k) {
      var b = document.querySelector('#filters [data-f=' + k + ']');
      b.querySelector('.n').textContent = count(k); b.classList.toggle('on', k === filter); b.setAttribute('aria-selected', k === filter ? 'true' : 'false');
    });
    renderGuests();

    var SEND = { scheduled: ['מתוזמן', 'wait'], sent: ['נשלח', 'yes'], passed: ['נשלח', 'yes'], sending: ['בשליחה', 'maybe'], off: ['כבוי', 'wait'], skipped: ['לא רלוונטי', 'wait'] };
    $('sendRows').innerHTML = (data.sends || []).map(function (s) {
      var st = SEND[s.status] || ['', 'wait'];
      var meta = heDate(s.date) + (s.sent_n ? ' · נשלח ל-' + s.sent_n : '') + (s.stats && s.stats.answered ? ' · ענו ' + s.stats.answered : '');
      return '<div class="row"><div><div class="nm">' + esc(s.label) + '</div><div class="meta">' + esc(meta) + '</div></div>' + (st[0] ? '<span class="pill ' + st[1] + '">' + st[0] + '</span>' : '') + '</div>';
    }).join('');

    var at = store.get('at:' + current);
    $('stamp').textContent = at ? 'עודכן ב-' + new Date(at).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  }

  function renderGuests() {
    var needle = $('search').value.trim();
    var list = ((data && data.guests) || []).filter(function (g) { return inFilter(g, filter) && (!needle || String(g.name || '').indexOf(needle) !== -1); });
    $('guestRows').innerHTML = list.map(function (g) {
      var st = STATUS[g.status] || STATUS.pending, why = filter === 'failed' ? notReached(g) : '';
      var meta = g.status === 'confirmed' ? (g.seats > 1 ? g.seats + ' מגיעים' : 'מגיע/ה') + (g.table ? ' · שולחן ' + g.table : '') : (g.at ? 'ענו ב-' + heDay(g.at) : '');
      return '<div class="row"><div><div class="nm">' + esc(g.name || 'ללא שם') + '</div>' + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '') + '</div><span class="pill ' + (why ? 'no' : st[1]) + '">' + esc(why || st[0]) + '</span></div>';
    }).join('');
    $('guestEmpty').hidden = list.length > 0;
    $('guestEmpty').textContent = needle ? 'לא נמצא מוזמן שמתאים לחיפוש.' : filter === 'failed' ? 'ההזמנה הגיעה לכל המוזמנים.' : 'אין מוזמנים ברשימה הזו עדיין.';
  }

  /* ── loading ── */
  function loadEvent(quiet) {
    if (!current || loading) return Promise.resolve();
    var cached = store.get('data:' + current);
    if (cached && !data) { data = normalize(cached); render(); }
    loading = true;
    return post('/api/status', { token: current, board_session: session }).then(function (r) {
      loading = false;
      var was = offline; offline = r.status === 0;
      if (offline && !$('v-board').hidden) tab('summary');
      if (was && !offline && !$('v-summary').hidden) tab('board');
      if (r.status === 200 && r.body.ok) {
        data = normalize(slim(r.body)); store.set('data:' + current, data); store.set('at:' + current, Date.now()); render();
      } else if (r.status === 401 && r.body.error === 'pin-required') { signOut(true); }
      else if (!quiet) render();   /* keep what we had; the "עודכן ב-" line tells the client how fresh it is */
    });
  }
  function loadAccount() {
    return post('/api/account/me', { session: session }).then(function (r) {
      if (r.status === 200 && r.body.ok) {
        events = (r.body.events || []).filter(function (e) { return e.token; });
        store.set('events', events); store.set('phone', r.body.phone || '');
        if (!events.some(function (e) { return e.token === current; })) { var up = events.filter(function (e) { return !e.past; })[0] || events[0]; current = up ? up.token : ''; store.set('current', current); }
        return true;
      }
      if (r.status === 401 || r.status === 403) { signOut(true); return false; }
      return events.length > 0;   /* no network: carry on with the saved list */
    });
  }
  function start() {
    show(true); tab('board'); render();
    loadAccount().then(function (ok) { if (ok) { render(); if (!$('v-board').hidden) openBoard(); return loadEvent(); } });
    document.dispatchEvent(new CustomEvent('ishur:signed-in', { detail: { session: session } }));
  }
  function signOut(silent) {
    var s = session;
    document.dispatchEvent(new CustomEvent('ishur:signed-out', { detail: { session: s } }));
    if (s && !silent) post('/api/account/logout', { session: s });
    session = ''; events = []; current = ''; data = null; filter = 'all'; boardFor = ''; $('boardFrame').removeAttribute('src');
    store.clear(); $('code').value = ''; $('signinNote').textContent = '';
    show(false);
  }

  /* ── wiring ── */
  $('signinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var phone = $('phone').value.replace(/[^\d+]/g, ''), code = $('code').value.replace(/\D/g, ''), note = $('signinNote'), go = $('go');
    if (phone.replace(/\D/g, '').length < 9) { note.textContent = 'כתבו את מספר הטלפון המלא שנרשמתם איתו.'; return; }
    if (code.length !== 4) { note.textContent = 'הקוד הוא 4 ספרות.'; return; }
    go.disabled = true; note.textContent = 'בודקים…';
    post('/api/account/pin-login', { phone: phone, pin: code }).then(function (r) {
      go.disabled = false;
      if (r.status === 200 && r.body.session) { session = r.body.session; store.set('session', session); note.textContent = ''; haptic(); start(); return; }
      if (r.status === 429) note.textContent = 'נעשו כמה ניסיונות ברצף. נסו שוב בעוד שעה, או כתבו לנו בוואטסאפ ונעזור מיד.';
      else if (r.status === 403) note.textContent = 'הטלפון והקוד לא תואמים. בדקו את הקוד בהודעה ששלחנו, או כתבו לנו בוואטסאפ.';
      else note.textContent = 'לא הצלחנו להתחבר כרגע. בדקו את החיבור לאינטרנט ונסו שוב.';
    });
  });
  $('forgot').addEventListener('click', function (e) { e.preventDefault(); openUrl(waLink('היי, אני צריך/ה את קוד הכניסה לאפליקציה של ishur')); });
  $('support').addEventListener('click', function (e) { e.preventDefault(); openUrl(waLink('היי, יש לי שאלה על האירוע שלי')); });
  $('privacy').addEventListener('click', function (e) { e.preventDefault(); openUrl(ENV.site + '/terms.html#privacy'); });
  $('signout').addEventListener('click', function () { signOut(false); });
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { tab(b.getAttribute('data-tab')); haptic(); } });
  $('filters').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; filter = b.getAttribute('data-f'); render(); });
  document.querySelector('.grid').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; filter = b.getAttribute('data-go'); tab('guests'); render(); });
  $('search').addEventListener('input', renderGuests);
  function pickEvent(tok) { if (!tok || tok === current) return; current = tok; boardFor = ''; $('boardFrame').removeAttribute('src'); store.set('current', tok); data = null; filter = 'all'; tab('board'); render(); loadEvent(); }
  $('evList').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) pickEvent(b.getAttribute('data-ev')); });
  $('evSwitch').addEventListener('click', function () { tab('account'); });
  $('share').addEventListener('click', function () {
    if (!data || !data.pub) return;
    var url = 'https://ishur.io/rsvp.html?t=' + encodeURIComponent(data.pub), text = 'אישור הגעה ל' + ($('evName').textContent || 'אירוע');
    var s = plugin('Share');
    if (s) s.share({ title: text, text: text, url: url, dialogTitle: 'שיתוף' }).catch(function () {});
    else if (navigator.share) navigator.share({ title: text, text: text, url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { $('share').textContent = 'הקישור הועתק'; setTimeout(function () { $('share').textContent = 'שיתוף קישור אישור ההגעה'; }, 2500); });
  });

  /* delete-account request: in the app, as Apple and Google ask. If the request cannot be sent, hand off to WhatsApp. */
  $('delete').addEventListener('click', function () { $('sheetNote').textContent = ''; $('sheetYes').hidden = false; $('sheet').hidden = false; });
  $('sheetNo').addEventListener('click', function () { $('sheet').hidden = true; });
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) $('sheet').hidden = true; });
  $('sheetYes').addEventListener('click', function () {
    $('sheetYes').disabled = true;
    post('/api/app/delete-request', { session: session }).then(function (r) {
      $('sheetYes').disabled = false;
      if (r.status === 200 && r.body.ok) { $('sheetYes').hidden = true; $('sheetNo').textContent = 'סגירה'; $('sheetNote').textContent = 'הבקשה התקבלה. נמחק את החשבון והמידע תוך 7 ימים ונעדכן אתכם בוואטסאפ.'; }
      else { $('sheet').hidden = true; openUrl(waLink('היי, אני מבקש/ת למחוק את החשבון והמידע שלי ב-ishur')); }
    });
  });

  /* refresh when the app comes back to the front, and by pulling down at the top of a list */
  window.addEventListener('offline', function () { offline = true; if (!$('v-board').hidden) tab('summary'); });
  window.addEventListener('online', function () { if (session) loadEvent(true); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && session) loadEvent(true); });
  var pullY = null;
  document.addEventListener('touchstart', function (e) { pullY = window.scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  document.addEventListener('touchend', function (e) { if (pullY != null && e.changedTouches[0].clientY - pullY > 90 && session) { haptic(); loadEvent(); } pullY = null; }, { passive: true });

  window.IshurApp = { post: post, store: store, plugin: plugin, native: NATIVE, session: function () { return session; }, reload: loadEvent, openEvent: pickEvent };
  if (session) start(); else show(false);
})();
