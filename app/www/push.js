/* ishur client app · push notifications, the phone side (spec R6). Runs only inside the native app.
   Order of things: sign-in → our own explanation sheet (once) → only on "כן" the system permission question →
   the device token goes to the Worker (/api/app/push-register). Switches in חשבון save to /api/app/push-prefs.
   Sign-out removes the device from the Worker. The app works the same without any of this. */
(function () {
  'use strict';
  var App = window.IshurApp || {}, ENV = window.ISHUR_ENV || {};
  var $ = function (id) { return document.getElementById(id); };
  var Push = App.plugin && App.plugin('PushNotifications');
  var T = function (n, p) { if (window.IshurTrack) window.IshurTrack.track(n, p); };
  if (!App.native || !Push) return;
  var device = '';
  var KINDS = { pushAnswer: 'answer', pushDaily: 'daily', pushFailed: 'failed' };
  var platform = (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) === 'android' ? 'android' : 'ios';
  if (platform === 'android' && !ENV.androidPush) return;   /* no Firebase file yet: registering would crash (env.js) */

  function showPrefs(prefs) { $('pushCard').hidden = false; Object.keys(KINDS).forEach(function (id) { $(id).checked = prefs ? prefs[KINDS[id]] !== false : true; }); }
  function sendToken() {
    if (!device || !App.session()) return;
    App.post('/api/app/push-register', { session: App.session(), device: device, platform: platform, sandbox: !!ENV.apnsSandbox, lang: (window.IshurI18n && IshurI18n.lang) || 'he' })
      .then(function (r) { if (r.status === 200 && r.body.ok) { App.store.set('push', 'on'); showPrefs(r.body.prefs); } });
  }
  Push.addListener('registration', function (t) { device = (t && t.value) || ''; sendToken(); });
  Push.addListener('registrationError', function () { /* quiet: the app works without push */ });
  Push.addListener('pushNotificationActionPerformed', function () { T('push_open'); if (App.reload) App.reload(); });   /* tapped a notification: open and refresh */

  function ask() {
    Push.requestPermissions().then(function (p) { if (p && p.receive === 'granted') { T('push_granted'); Push.register(); } else { T('push_denied'); App.store.set('push', 'declined'); } }).catch(function () {});
  }
  function begin() {
    Push.checkPermissions().then(function (p) {
      if (p && p.receive === 'granted') { Push.register(); return; }
      if (p && p.receive === 'denied') return;                       /* decided in iOS Settings: we do not nag */
      if (App.store.get('push')) return;                             /* already answered our own question */
      setTimeout(function () { if (App.session()) { $('pushAsk').hidden = false; T('push_sheet_view'); } }, 4000);   /* after the board is on screen, not on top of sign-in */
    }).catch(function () {});
  }
  $('pushYes').addEventListener('click', function () { T('push_yes'); $('pushAsk').hidden = true; App.store.set('push', 'asked'); ask(); });
  $('pushNo').addEventListener('click', function () { T('push_no'); $('pushAsk').hidden = true; App.store.set('push', 'later'); });
  Object.keys(KINDS).forEach(function (id) {
    $(id).addEventListener('change', function () {
      T('push_pref', { id: KINDS[id], ok: $(id).checked });
      var prefs = {}; Object.keys(KINDS).forEach(function (k) { prefs[KINDS[k]] = $(k).checked; });
      App.post('/api/app/push-prefs', { session: App.session(), prefs: prefs });
    });
  });
  document.addEventListener('ishur:signed-in', begin);
  document.addEventListener('ishur:signed-out', function (e) {
    var s = e.detail && e.detail.session; if (s && device) App.post('/api/app/push-unregister', { session: s, device: device });
  });
  if (App.session()) begin();
})();
