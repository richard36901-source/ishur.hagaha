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
  var T = function (n, p) { if (window.IshurTrack) window.IshurTrack.track(n, p); };   /* usage events: track.js */
  /* languages (i18n.js): the app's choice travels to every board page it opens */
  var I18N = window.IshurI18n || { lang: 'he', langs: { he: { name: 'עברית' } }, set: function () {} };
  var LQ = '&lang=' + I18N.lang;
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
      package: d.package ? { name: d.package.name, guests: d.package.guests, included: d.package.included || [], addons: d.package.addons || [] } : null,
      event: { name1: e.name1, name2: e.name2, occasion: e.occasion, occasion_label: e.occasion_label, event_date: e.event_date, reception_time: e.reception_time, venue_name: e.venue_name, venue_city: e.venue_city },
      totals: { confirmed_seats: t.confirmed_seats },
      sends: (d.sends || []).map(function (s) { return { key: s.key, label: s.label, date: s.date, status: s.status, sent_n: s.sent_n, stats: s.stats ? { answered: s.stats.answered } : null }; }),
      guests: (d.guests || []).map(function (g) { return { name: g.name, status: g.status, seats: g.seats, table: g.table, self: g.self, at: String(g.at || '').slice(0, 10), sent: g.sent, sent_code: g.sent_code }; })
    };
  }
  function inFilter(g, k) { return k === 'all' ? true : k === 'failed' ? !!notReached(g) : g.status === k; }
  function count(k) { return ((data && data.guests) || []).filter(function (g) { return inFilter(g, k); }).length; }

  /* ── screens ── */
  /* 22/11 opening screen: shown at least 0.8 s so the logo and the support line can be read, gone at most after 5 s */
  var BOOT = Date.now();
  function splashOut() { var sp = $('splash'); if (!sp || sp.classList.contains('out')) return; setTimeout(function () { sp.classList.add('out'); setTimeout(function () { sp.hidden = true; }, 400); }, Math.max(0, 800 - (Date.now() - BOOT))); }
  setTimeout(splashOut, 5000);
  function show(signedIn) {
    $('signin').hidden = signedIn; $('app').hidden = !signedIn; $('tabs').hidden = !signedIn; $('connect').hidden = true;
    splashOut();
  }
  /* Home ("ראשי") is the regular client board itself, so the app looks and works like the board clients know.
     With no network the app's own summary takes its place, from the copy saved on the device. */
  var offline = (navigator.onLine === false);
  /* 20/11 Richard: ראשי, מוזמנים and שליחות are three views of the regular board (home, guests, sends), so every
     setting works the way clients know it. With no network each tab falls back to the app's own slim screen. */
  var VIEW_OF = { board: 'home', guests: 'guests', sends: 'sends' }, view = 'home', curTab = 'board';
  function tab(name) {
    if (name === 'summary') name = 'board';
    curTab = name;
    T('tab_view', { tab: name });
    var screen = name;
    if (VIEW_OF[name]) {
      if (offline) { if (name === 'board') { screen = 'summary'; T('offline_view'); } }
      else { view = VIEW_OF[name]; screen = 'board'; }
    }
    ['summary', 'guests', 'sends', 'board', 'account'].forEach(function (t) { $('v-' + t).hidden = t !== screen; });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
    window.scrollTo(0, 0);
    if (screen === 'board') openBoard();
    navTitle();
  }
  /* 22/11 the top bar's title: the event on ראשי, the tab's name elsewhere. Where a screen has a big title (חשבון, and
     the slim screens with no network) the small one shows only once the big one has scrolled under the bar. */
  var TAB_TITLE = { board: '', guests: 'מוזמנים', sends: 'שליחות', account: 'חשבון' }, navEv = '';
  var bigObs = window.IntersectionObserver ? new IntersectionObserver(function (es) { es.forEach(function (en) { if (!en.target.closest('[hidden]')) $('navTitle').classList.toggle('hide', en.isIntersecting); }); }, { rootMargin: '-50px 0px 0px 0px' }) : null;
  function navTitle() {
    /* on ראשי the brand (Richard 20/11: the header reads it; 22/11: a shared screenshot carries it); elsewhere the tab's name */
    var t = $('navTitle');
    if (curTab === 'board') t.innerHTML = 'אישורי הגעה לאירועים - <bdi>ishur<span>.io</span></bdi>'; else t.textContent = TAB_TITLE[curTab] || '';
    var shown = document.querySelector('.view:not([hidden]) h1.large');
    t.classList.toggle('hide', !!shown && shown.getBoundingClientRect().bottom > 50);
  }
  if (bigObs) Array.prototype.forEach.call(document.querySelectorAll('h1.large'), function (h) { bigObs.observe(h); });
  var siteOrigin = ''; try { siteOrigin = new URL(ENV.site).origin; } catch (e) {}
  /* a site page in the frame (the event schedule) asks the app to open a link it cannot open itself: the calendar
     feed (webcal:, handed to the phone, which offers Apple Calendar) or an https page (Google Calendar, Waze) */
  window.addEventListener('message', function (e) {
    if (!siteOrigin || e.origin !== siteOrigin || !e.data || typeof e.data.ishurOpen !== 'string') return;
    var u = e.data.ishurOpen;
    if (/^webcal:\/\//.test(u)) { T('calendar_open', { kind: 'apple' }); window.location.href = u; }
    else if (/^https:\/\/(calendar\.google\.com|waze\.com)\//.test(u)) { T('calendar_open', { kind: /waze/.test(u) ? 'waze' : 'google' }); openUrl(u); }
  });
  function postView() { try { $('boardFrame').contentWindow.postMessage({ ishurView: view }, siteOrigin || '*'); } catch (e) {} }
  /* The regular client board, in its app mode, inside the app. The session travels in the address fragment (never
     sent to a server), so a locked board opens too. Loaded on first use and again when the event changes. */
  var boardFor = '';
  function openBoard() {
    if (!current) return;
    if (boardFor === current) { postView(); return; }
    boardFor = current;
    $('boardWait').hidden = false;
    $('boardFrame').src = ENV.board + '?t=' + encodeURIComponent(current) + '&app=1&view=' + view + LQ + '&theme=' + document.documentElement.getAttribute('data-theme') + '#s=' + encodeURIComponent(session);
  }
  $('boardFrame').addEventListener('load', function () { $('boardWait').hidden = true; postView(); });
  function evTitle(e) { return (e && (e.name || e.occasion)) || 'האירוע'; }

  function render() {
    var ev = events.filter(function (e) { return e.token === current; })[0] || events[0] || {};
    $('accPhone').textContent = store.get('phone') ? '0' + String(store.get('phone')).replace(/^972/, '') : '';
    $('ver').textContent = 'גרסה ' + (ENV.version || '') + (ENV.name === 'staging' ? ' · סביבת בדיקות' : '');
    var many = events.length > 1;
    $('evSwitch').hidden = !many; $('evSwitch').textContent = evTitle(ev) + ' ▾';
    navEv = evTitle(ev); navTitle();
    renderEvents();
    var pk = data && data.package;
    $('pkgCard').hidden = !pk;
    if (pk) {
      $('pkgName').textContent = 'חבילת ' + pk.name; $('pkgGuests').textContent = pk.guests ? 'עד ' + pk.guests + ' מוזמנים' : '';
      $('pkgList').innerHTML = pk.included.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
      $('pkgAddons').hidden = !pk.addons.length;
      $('pkgAddonList').innerHTML = pk.addons.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
    }
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
    return post('/api/status', { token: current, board_session: session, app: 1 }).then(function (r) {
      loading = false;
      var was = offline; offline = r.status === 0;
      if (was !== offline && VIEW_OF[curTab]) tab(curTab);   /* the network came or went: the same tab, its other form */
      if (r.status === 200 && r.body.ok) {
        data = normalize(slim(r.body)); store.set('data:' + current, data); store.set('at:' + current, Date.now()); render(); maybeRate();
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
    loadAccount().then(function (ok) { if (ok) { render(); if (!$('v-board').hidden) openBoard(); askReview(); return loadEvent(); } });
    document.dispatchEvent(new CustomEvent('ishur:signed-in', { detail: { session: session } }));
  }
  function signOut(silent) {
    var s = session;
    document.dispatchEvent(new CustomEvent('ishur:signed-out', { detail: { session: s } }));
    if (s && !silent) post('/api/account/logout', { session: s });
    session = ''; events = []; current = ''; data = null; filter = 'all'; boardFor = ''; $('boardFrame').removeAttribute('src');
    store.clear(); $('code').value = ''; if (window.IshurOtpPaint) IshurOtpPaint(); $('signinNote').textContent = '';
    show(false);
  }

  /* ── wiring ── */
  $('signinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var phone = $('phone').value.replace(/[^\d+]/g, ''), code = $('code').value.replace(/\D/g, ''), note = $('signinNote'), go = $('go');
    if (phone.replace(/\D/g, '').length < 9) { note.textContent = 'כתבו את מספר הטלפון המלא שנרשמתם איתו.'; return; }
    if (code.length !== 4) { note.textContent = 'הקוד הוא 4 ספרות.'; return; }
    go.disabled = true; note.textContent = 'בודקים…';
    post('/api/account/pin-login', IOS ? { phone: phone, pin: code, app: 1 } : { phone: phone, pin: code }).then(function (r) {
      go.disabled = false;
      if (r.status === 200 && r.body.session) { session = r.body.session; store.set('session', session); note.textContent = ''; haptic(); T('signin_ok'); afterCode(); return; }
      if (r.status === 403 && r.body && r.body.error === 'use-identity') { T('signin_fail', { kind: 'use-identity' }); note.textContent = 'החשבון שלכם מחובר ל-Apple או ל-Google. היכנסו עם הכפתור למטה.'; return; }
      T('signin_fail', { kind: String(r.status) });
      if (r.status === 429) note.textContent = 'נעשו כמה ניסיונות ברצף. נסו שוב בעוד שעה, או כתבו לנו בוואטסאפ ונעזור מיד.';
      else if (r.status === 403) note.textContent = 'הטלפון והקוד לא תואמים. בדקו את הקוד בהודעה ששלחנו, או כתבו לנו בוואטסאפ.';
      else note.textContent = 'לא הצלחנו להתחבר כרגע. בדקו את החיבור לאינטרנט ונסו שוב.';
    });
  });
  $('forgot').addEventListener('click', function (e) { e.preventDefault(); T('whatsapp_tap', { from: 'signin' }); openUrl(waLink('היי, אני צריך/ה את קוד הכניסה לאפליקציה של ishur')); });
  /* 22/11 the code's four boxes follow the one real field underneath (typing, autofill from a message, paste) */
  (function () {
    var f = $('code'), boxes = document.querySelectorAll('#otp .otp-box');
    function paint() {
      var v = f.value.replace(/\D/g, '').slice(0, 4); if (v !== f.value) f.value = v;
      var focus = document.activeElement === f;
      Array.prototype.forEach.call(boxes, function (b, i) { b.textContent = v[i] || ''; b.classList.toggle('full', !!v[i]); b.classList.toggle('on', focus && i === Math.min(v.length, 3)); });
      if (v.length === 4 && focus) haptic();
    }
    ['input', 'focus', 'blur', 'change'].forEach(function (ev) { f.addEventListener(ev, paint); });
    window.IshurOtpPaint = paint;
    paint();
  })();
  /* 22/11 Sign in with Apple / Google (plan round 6 §3; server: worker/identity.js). Only in the installed app.
     After the first sign-in with the code the app asks once to connect Apple (or Google); from then on the server
     refuses the code in the app for that phone and these buttons sign in. The App Store reviewer's demo phone is
     never asked. ENV.googleClientId turns the Google button on once Richard's Google Cloud client exists. */
  /* 25/11 Apple / Google sign-in is iPhone only for v1: on Android neither is set up (Apple needs a web redirect, Google
     an Android client made from Play's signing key). Android keeps the phone and code, with no connect step, and does not
     claim to be the app to the server, so a phone linked on an iPhone can still sign in on Android with its code. */
  var IOS = !!(NATIVE && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'ios');
  var SL = IOS ? plugin('SocialLogin') : null, slReady = null;
  function idInit() {
    if (!SL) return Promise.reject(new Error('no-plugin'));
    if (!slReady) { var cfg = { apple: { clientId: 'io.ishur.client' } }; if (ENV.googleClientId) { cfg.google = { iOSClientId: ENV.googleClientId }; if (ENV.googleServerClientId) cfg.google.iOSServerClientId = ENV.googleServerClientId; } slReady = SL.initialize(cfg); }
    return slReady;
  }
  function idToken(provider) {
    return idInit().then(function () { return SL.login({ provider: provider, options: provider === 'apple' ? { scopes: ['email', 'name'] } : { scopes: ['email', 'profile'] } }); })
      .then(function (res) { var t = res && res.result && res.result.idToken; if (!t) throw new Error('no-token'); return t; });
  }
  var cancelled = function (e) { return /cancel|1001/i.test(String((e && (e.code || e.message)) || e)); };
  /* Google only on iPhone for now: Android needs its own Google client (signing key fingerprint), not made yet */
  var googleOn = !!ENV.googleClientId && IOS;
  if (SL) { $('idBtns').hidden = false; if (googleOn) { $('googleIn').hidden = false; $('googleLink').hidden = false; } }
  function idSignIn(provider) {
    var note = $('signinNote');
    idToken(provider).then(function (t) { note.textContent = 'בודקים…'; return post('/api/account/id-login', { provider: provider, id_token: t }); }).then(function (r) {
      if (r.status === 200 && r.body.session) { session = r.body.session; store.set('session', session); note.textContent = ''; haptic(); T('signin_ok', { via: provider }); start(); return; }
      T('signin_fail', { kind: provider + ':' + (r.body && r.body.error || r.status) });
      note.textContent = r.status === 404 ? 'החשבון הזה עוד לא מחובר. היכנסו פעם אחת עם הטלפון והקוד, ואז חברו אותו.' : 'לא הצלחנו להתחבר כרגע. נסו שוב, או היכנסו עם הטלפון והקוד.';
    }).catch(function (e) { if (!cancelled(e)) note.textContent = 'לא הצלחנו להתחבר כרגע. נסו שוב, או היכנסו עם הטלפון והקוד.'; });
  }
  $('appleIn').addEventListener('click', function () { T('id_tap', { provider: 'apple', from: 'signin' }); idSignIn('apple'); });
  $('googleIn').addEventListener('click', function () { T('id_tap', { provider: 'google', from: 'signin' }); idSignIn('google'); });
  /* right after a sign-in with the code: ask once to connect, unless already linked, the review phone, or no plugin */
  function afterCode() {
    if (!SL) { start(); return; }
    post('/api/account/identities', { session: session }).then(function (r) {
      if (r.status !== 200 || (r.body.linked || []).length || r.body.review) { start(); return; }
      $('signin').hidden = true; $('connect').hidden = false; T('connect_view');
    }).catch(function () { start(); });
  }
  function idLink(provider) {
    var note = $('connectNote');
    idToken(provider).then(function (t) { note.textContent = 'מחברים…'; return post('/api/account/link-identity', { session: session, provider: provider, id_token: t }); }).then(function (r) {
      if (r.status === 200) { note.textContent = ''; haptic(); T('connect_ok', { provider: provider }); start(); return; }
      T('connect_fail', { kind: provider + ':' + (r.body && r.body.error || r.status) });
      note.textContent = r.status === 409 ? 'החשבון הזה כבר מחובר לטלפון אחר. נסו חשבון אחר, או כתבו לנו בוואטסאפ.' : 'לא הצלחנו לחבר כרגע. נסו שוב.';
    }).catch(function (e) { if (!cancelled(e)) note.textContent = 'לא הצלחנו לחבר כרגע. נסו שוב.'; });
  }
  $('appleLink').addEventListener('click', function () { idLink('apple'); });
  $('googleLink').addEventListener('click', function () { idLink('google'); });
  $('connectHelp').addEventListener('click', function (e) { e.preventDefault(); T('whatsapp_tap', { from: 'connect' }); openUrl(waLink('היי, צריך/ה עזרה בחיבור Apple או Google לאפליקציה')); });
  $('contactWa').addEventListener('click', function (e) { e.preventDefault(); T('whatsapp_tap', { from: 'contact' }); openUrl(waLink('היי, יש לי שאלה על האירוע שלי')); });
  $('contactMail').addEventListener('click', function () { T('mail_tap', { from: 'contact' }); });
  /* 22/11 appearance: light, dark, or as the phone; the board inside the app follows */
  function appearance() { var a = 'auto'; try { a = localStorage.getItem('ishur_appearance') || 'auto'; } catch (e) {} return a; }
  function applyAppearance() {
    var a = appearance(), dark = a === 'dark' || (a === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    var was = document.documentElement.getAttribute('data-theme'), now = dark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', now);
    Array.prototype.forEach.call(document.querySelectorAll('#appearance [data-a]'), function (b) { b.setAttribute('aria-checked', b.getAttribute('data-a') === a ? 'true' : 'false'); });
    if (was !== now && boardFor) { boardFor = ''; if (!$('v-board').hidden) openBoard(); }
  }
  $('appearance').addEventListener('click', function (e) { var b = e.target.closest('[data-a]'); if (!b) return; try { localStorage.setItem('ishur_appearance', b.getAttribute('data-a')); } catch (x) {} T('appearance', { to: b.getAttribute('data-a') }); haptic(); applyAppearance(); });
  if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: dark)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(function () { if (appearance() === 'auto') applyAppearance(); }); }
  applyAppearance();
  /* 22/11 swipe back, as in iOS: from the edge a page came in from (the right in Hebrew and Arabic, the left otherwise),
     the page follows the finger; past a third of the screen it closes, otherwise it springs back. */
  (function () {
    var CLOSE = { events: 'eventsClose', help: 'helpClose', page: 'pageClose' }, g = null;
    document.addEventListener('touchstart', function (e) {
      var pg = e.target.closest('.help'); if (!pg || pg.hidden || !CLOSE[pg.id] || e.touches.length !== 1) return;
      var rtl = document.documentElement.getAttribute('dir') === 'rtl', x = e.touches[0].clientX, edge = rtl ? innerWidth - x : x;
      if (edge > 24) return;
      if (pg.id === 'help' && !$('helpBack').hidden) { g = { pg: pg, rtl: rtl, x0: x, y0: e.touches[0].clientY, back: 'helpBack' }; return; }
      g = { pg: pg, rtl: rtl, x0: x, y0: e.touches[0].clientY, back: CLOSE[pg.id] };
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!g) return; var dx = (e.touches[0].clientX - g.x0) * (g.rtl ? -1 : 1);
      if (!g.on && Math.abs(e.touches[0].clientY - g.y0) > Math.abs(dx)) { g = null; return; }
      g.on = true; g.dx = Math.max(0, dx); g.pg.classList.add('swiping'); g.pg.style.transform = 'translateX(' + (g.rtl ? -g.dx : g.dx) + 'px)';
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (!g) return; var c = g; g = null; if (!c.on) return;
      c.pg.classList.remove('swiping'); c.pg.classList.add('swipe-out');
      var done = c.dx > innerWidth / 3;
      c.pg.style.transform = done ? 'translateX(' + (c.rtl ? -innerWidth : innerWidth) + 'px)' : '';
      setTimeout(function () { c.pg.classList.remove('swipe-out'); c.pg.style.transform = ''; if (done) { $(c.back).click(); haptic(); } }, 230);
    });
  })();
  /* 22/11 dragging the page down while typing hides the keyboard, as in iOS apps */
  (function () {
    var y0 = null;
    document.addEventListener('touchstart', function (e) { y0 = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      var a = document.activeElement; if (y0 == null || !a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      if (e.touches[0].clientY - y0 > 4 && !e.target.closest('input,textarea')) { a.blur(); y0 = null; }
    }, { passive: true });
  })();
  $('privacy').addEventListener('click', function (e) { e.preventDefault(); T('privacy_open'); openUrl(ENV.site + '/terms.html?app=1' + LQ + '#privacy');   /* app=1: the website's cookie bar is not shown in the app, which tracks nobody */ });
  $('signout').addEventListener('click', function () { signOut(false); });
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { tab(b.getAttribute('data-tab')); haptic(); } });
  $('filters').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; filter = b.getAttribute('data-f'); T('guest_filter', { id: filter }); render(); });
  document.querySelector('.grid').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; filter = b.getAttribute('data-go'); tab('guests'); render(); });
  $('search').addEventListener('input', renderGuests);
  $('search').addEventListener('change', function () { if ($('search').value.trim()) T('guest_search'); });   /* that a search happened, never what was typed */
  function pickEvent(tok) { if (!tok || tok === current) return; current = tok; boardFor = ''; $('boardFrame').removeAttribute('src'); store.set('current', tok); T('event_switch'); data = null; filter = 'all'; tab('board'); render(); loadEvent(); }
  /* all my events: upcoming first; an event that has passed is greyed, last, and can be reviewed */
  function renderEvents() {
    $('evList').innerHTML = events.map(function (e) {
      var meta = [heDate(e.date), e.venue, e.past ? 'הסתיים' : ''].filter(Boolean).join(' · ');
      var rev = e.past && e.next === 'score' ? '<button type="button" class="btn ghost evrev" data-review="' + esc(e.token) + '">להשאיר ביקורת</button>' : '';
      return '<div class="evrow' + (e.past ? ' past' : '') + (e.token === current ? ' on' : '') + '"><button type="button" class="row nav" data-ev="' + esc(e.token) + '"><span><span class="nm">' + esc(evTitle(e)) + '</span><span class="meta">' + esc(meta) + '</span></span></button>' + rev + '</div>';
    }).join('') || '<p class="empty">אין אירועים בחשבון הזה.</p>';
  }
  function openEvents() { T('events_open'); renderEvents(); $('events').hidden = false; }
  function openPage(title, url) { $('pageTitle').textContent = title; $('pageFrame').title = title; $('pageFrame').src = url; $('page').hidden = false; }
  function reviewUrl(tok) { return ENV.site + '/feedback.html?t=' + encodeURIComponent(tok) + '&app=1' + LQ; }
  $('evList').addEventListener('click', function (e) {
    var r = e.target.closest('[data-review]'); if (r) { T('review_go', { from: 'events' }); openPage('ביקורת על האירוע', reviewUrl(r.getAttribute('data-review'))); return; }
    var b = e.target.closest('[data-ev]'); if (b) { $('events').hidden = true; pickEvent(b.getAttribute('data-ev')); }
  });
  $('evSwitch').addEventListener('click', openEvents);
  $('eventsOpen').addEventListener('click', openEvents);
  $('eventsClose').addEventListener('click', function () { $('events').hidden = true; });
  $('pageClose').addEventListener('click', function () { $('page').hidden = true; $('pageFrame').removeAttribute('src'); if (session) loadAccount().then(function () { render(); }); });
  $('refOpen').addEventListener('click', function () { if (!current) return; T('ref_open'); openPage('המלצה עלינו', ENV.board + '?t=' + encodeURIComponent(current) + '&app=1&view=account' + LQ + '#s=' + encodeURIComponent(session)); });
  $('pkgTerms').addEventListener('click', function (e) { e.preventDefault(); T('terms_open'); openUrl(ENV.site + '/terms.html?app=1' + LQ); });
  /* after the event: asked when the app opens. "לא עכשיו" is offered once; the next time only "לדרג עכשיו". */
  var reviewFor = '';
  function askReview() {
    var e = events.filter(function (x) { return x.past && x.next === 'score'; })[0]; if (!e) return;
    reviewFor = e.token;
    $('reviewAskP').textContent = 'האירוע של ' + evTitle(e) + ' מאחוריכם. דקה מזמנכם עוזרת לנו להשתפר ולזוגות הבאים לבחור.';
    $('reviewLater').hidden = store.get('rev:' + e.token) === 'later';
    T('review_prompt'); $('reviewAsk').hidden = false;
  }
  $('reviewGo').addEventListener('click', function () { $('reviewAsk').hidden = true; T('review_go', { from: 'prompt' }); openPage('ביקורת על האירוע', reviewUrl(reviewFor)); });
  $('reviewLater').addEventListener('click', function () { $('reviewAsk').hidden = true; T('review_later'); store.set('rev:' + reviewFor, 'later'); });
  $('share').addEventListener('click', function () {
    if (!data || !data.pub) return;
    T('share_link');
    var url = 'https://ishur.io/rsvp.html?t=' + encodeURIComponent(data.pub), text = 'אישור הגעה ל' + ($('evName').textContent || 'אירוע');
    var s = plugin('Share');
    if (s) s.share({ title: text, text: text, url: url, dialogTitle: 'שיתוף' }).catch(function () {});
    else if (navigator.share) navigator.share({ title: text, text: text, url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { $('share').textContent = 'הקישור הועתק'; setTimeout(function () { $('share').textContent = 'שיתוף קישור אישור ההגעה'; }, 2500); });
  });

  /* delete-account request: in the app, as Apple and Google ask. If the request cannot be sent, hand off to WhatsApp. */
  $('delete').addEventListener('click', function () { T('delete_open'); $('sheetNote').textContent = ''; $('sheetYes').hidden = false; $('sheet').hidden = false; });
  $('sheetNo').addEventListener('click', function () { $('sheet').hidden = true; });
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) $('sheet').hidden = true; });
  $('sheetYes').addEventListener('click', function () {
    $('sheetYes').disabled = true;
    T('delete_request');
    post('/api/app/delete-request', { session: session }).then(function (r) {
      $('sheetYes').disabled = false;
      if (r.status === 200 && r.body.ok) { $('sheetYes').hidden = true; $('sheetNo').textContent = 'סגירה'; $('sheetNote').textContent = 'הבקשה התקבלה. נמחק את החשבון והמידע תוך 7 ימים ונעדכן אתכם בוואטסאפ.'; }
      else { $('sheet').hidden = true; openUrl(waLink('היי, אני מבקש/ת למחוק את החשבון והמידע שלי ב-ishur')); }
    });
  });

  /* the pine strip over the status bar follows the visible part of the page when the keyboard moves it */
  if (window.visualViewport) {
    var pinBar = function () { $('sbar').style.transform = 'translateY(' + Math.max(0, Math.round(window.visualViewport.offsetTop)) + 'px)'; };
    window.visualViewport.addEventListener('scroll', pinBar); window.visualViewport.addEventListener('resize', pinBar);
  }

  /* refresh when the app comes back to the front, and by pulling down at the top of a list */
  window.addEventListener('offline', function () { offline = true; if (VIEW_OF[curTab]) tab(curTab); });
  window.addEventListener('online', function () { if (session) loadEvent(true); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && session) loadEvent(true); });
  var pullY = null;
  document.addEventListener('touchstart', function (e) { pullY = window.scrollY <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  document.addEventListener('touchend', function (e) { if (pullY != null && e.changedTouches[0].clientY - pullY > 90 && session) { haptic(); T('pull_refresh'); loadEvent(); } pullY = null; }, { passive: true });

  /* Apple's / Google's own rating prompt (Richard 20/11: ask from time to time). Asked after a good moment: more
     guests confirmed since the client last looked, from the third opening on, and at most every 120 days on this
     phone. The system decides whether it really shows (Apple shows it at most three times a year). */
  function maybeRate() {
    try {
      var R = plugin('InAppReview'); if (!R || !data || !data.totals) return;
      var yes = Number(data.totals.confirmed_seats) || 0, k = 'yes:' + current, before = store.get(k);
      store.set(k, yes);
      var opens = (store.get('opens') || 0), last = store.get('rated_at') || 0;
      if (before == null || yes <= before || opens < 3 || Date.now() - last < 120 * 86400e3) return;
      store.set('rated_at', Date.now()); T('rate_prompt');
      R.requestReview().catch(function () {});
    } catch (e) {}
  }
  store.set('opens', (store.get('opens') || 0) + 1);

  (function () {
    var sel = $('langPick'); if (!sel) return;
    sel.innerHTML = Object.keys(I18N.langs).map(function (k) { return '<option value="' + k + '"' + (k === I18N.lang ? ' selected' : '') + '>' + I18N.langs[k].name + '</option>'; }).join('');
    sel.setAttribute('data-noi18n', '');   /* each language keeps its own name */
    sel.addEventListener('change', function () { T('lang_set', { id: sel.value }); I18N.set(sel.value); if (window.IshurTrack) window.IshurTrack.flush(); setTimeout(function () { location.reload(); }, 300); });
  })();

  window.IshurApp = { post: post, store: store, plugin: plugin, native: NATIVE, session: function () { return session; }, reload: loadEvent, openEvent: pickEvent };
  T('app_open', { signed: session ? 1 : 0 });
  if (session) start(); else { show(false); T('signin_view'); }
})();
