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
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest && e.target.closest('button,a,summary,[role=button],[data-tab],[data-f],[data-act]');
      if (!el) return;
      var id = el.id || el.getAttribute('data-tab') || el.getAttribute('data-f') || el.getAttribute('data-act') || el.getAttribute('data-go') || '';
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id)) return;
      send('board_click', { page: page, id: id });
    }, true);
  } catch (e) {}
})();
