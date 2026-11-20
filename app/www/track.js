/* ishur client app · usage events, the phone side (spec R20, R21). Loaded before app.js.
   What a signed-in client does (which tab, which control, never what was typed and never a guest's name or phone)
   goes to our own Worker in batches: POST /api/app/events. Nothing is sent before sign-in; what happened on the
   sign-in screen is sent only if that person then signs in. Kept on the device while there is no network.
   No third-party code, no advertising id. */
(function () {
  'use strict';
  var ENV = window.ISHUR_ENV || {}, KEY = 'ishurapp_evq', MAX = 200;
  var Q = []; try { Q = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { Q = []; }
  var sid = Math.random().toString(36).slice(2, 10), busy = false;
  var cap = window.Capacitor, native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  var plat = native ? ((cap.getPlatform && cap.getPlatform()) === 'android' ? 'android' : 'ios') : 'web';
  function save() { try { localStorage.setItem(KEY, JSON.stringify(Q)); } catch (e) {} }
  function app() { return window.IshurApp || null; }
  function track(n, p) {
    Q.push({ n: String(n), t: Date.now(), s: sid, p: p || {} });
    if (Q.length > MAX) Q = Q.slice(-MAX);
    save();
    if (Q.length >= 20) flush();
  }
  function send(session, batch) {
    return fetch(ENV.api + '/api/app/events', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: session, plat: plat, ver: ENV.version || '', events: batch }) })
      .then(function (r) { return r.status; }).catch(function () { return 0; });
  }
  function flush(withSession) {
    var A = app(), session = withSession || (A && A.session && A.session());
    if (!session || !Q.length || busy) return;
    var batch = Q.slice(0, 50); busy = true;
    send(session, batch).then(function (status) {
      busy = false;
      /* 200: stored. 4xx other than 401/429: this batch will never pass, drop it. Otherwise keep it for next time. */
      if (status === 200 || (status >= 400 && status < 500 && status !== 401 && status !== 429)) { Q = Q.slice(batch.length); save(); if (Q.length && status === 200) flush(withSession); }
    });
  }
  window.IshurTrack = { track: track, flush: flush };

  setInterval(function () { flush(); }, 20000);
  document.addEventListener('visibilitychange', function () { if (document.hidden) { track('app_background'); flush(); } else track('app_open', { from: 'resume' }); });
  document.addEventListener('ishur:signed-in', function () { setTimeout(flush, 1500); });
  /* sign-out clears the device's storage right after this event, so the last batch leaves now, with the old session */
  document.addEventListener('ishur:signed-out', function (e) { var s = e.detail && e.detail.session; if (!s) return; track('signout'); var batch = Q.slice(0, 50); Q = []; save(); send(s, batch); });
  window.addEventListener('error', function (e) { track('js_error', { msg: String((e && e.message) || 'error').slice(0, 120) }); });
  window.addEventListener('unhandledrejection', function (e) { track('js_error', { msg: 'promise ' + String((e && e.reason && e.reason.message) || '').slice(0, 100) }); });
  /* the board inside the frame reports its own page and taps (assets/app-track.js on the site) */
  var siteOrigin = ''; try { siteOrigin = new URL(ENV.site).origin; } catch (e) {}
  window.addEventListener('message', function (e) {
    if (!siteOrigin || e.origin !== siteOrigin) return;
    var d = e.data && e.data.ishurTrack; if (!d || (d.n !== 'board_view' && d.n !== 'board_click')) return;
    track(d.n, { page: String((d.p && d.p.page) || '').slice(0, 40), id: String((d.p && d.p.id) || '').slice(0, 40) });
  });
})();
