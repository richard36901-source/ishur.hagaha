/* 20/11 client app: a site page shown inside the ishur app's frame tells the app which page is on screen and which
   control was tapped, by the control's id only (never its text, never a value). Outside the app this does nothing.
   The app (app/www/track.js) sends it on to /api/app/events with the client's session. */
(function () {
  try {
    if (window.parent === window) return;
    var inApp = /[?&]app=1(&|$)/.test(location.search) || sessionStorage.getItem('ishur_in_app') === '1';
    if (!inApp) return;
    var page = ((location.pathname.split('/').pop() || '').replace(/\.html$/, '') || 'home').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    var send = function (n, p) { try { window.parent.postMessage({ ishurTrack: { n: n, p: p } }, '*'); } catch (e) {} };
    send('board_view', { page: page });
    /* 21/11 the App Store review demo: the server refuses anything that would send (demo-readonly). Say so plainly
       instead of the page's usual "not saved". Watches responses only; changes nothing that is sent. */
    if (window.fetch && !window.__ishurDemoWatch) {
      window.__ishurDemoWatch = true;
      var f0 = window.fetch;
      window.fetch = function () {
        return f0.apply(this, arguments).then(function (r) {
          if (r && r.status === 403) r.clone().json().then(function (j) {
            if (j && j.error === 'demo-readonly' && window.IshurUX && IshurUX.toast) IshurUX.toast('זה חשבון הדגמה: כאן לא נשלחות הודעות ולא מתבצעים שינויים באירוע.');
          }).catch(function () {});
          return r;
        });
      };
    }
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest && e.target.closest('button,a,summary,[role=button],[data-tab],[data-f],[data-act]');
      if (!el) return;
      var id = el.id || '';
      /* no id: name the control by its first data-* attribute ("guide-waze", "do-yes"), else by its first class.
         A value is used only when it is short and has no run of 4+ digits, so a guest's id or phone never leaves. */
      if (!id) {
        for (var i = 0; i < el.attributes.length && !id; i++) {
          var a = el.attributes[i]; if (a.name.indexOf('data-') !== 0) continue;
          var k = a.name.slice(5), v = String(a.value || '');
          id = k + (/^[A-Za-z0-9_-]{1,16}$/.test(v) && !/\d{4,}/.test(v) ? '-' + v : '');
        }
      }
      if (!id) id = (String(el.className || '').split(/\s+/)[0] || '') || el.tagName.toLowerCase();
      id = id.slice(0, 40);
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id)) return;
      send('board_click', { page: page, id: id });
    }, true);
  } catch (e) {}
})();
