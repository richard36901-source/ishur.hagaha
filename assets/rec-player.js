/* ============================================================================
   ishur.io · rec-player.js · our call-recording player (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   Instead of the browser's <audio controls>: play/pause, a scrub bar, the time,
   speed 1x / 1.5x / 2x, and a download button with the recording's own name.

   The recording is fetched from the Worker as GET /rec/<call_id> with the admin key
   (X-Admin-Key) or the Google session (x-ishur-session) in a HEADER and played from
   a blob: the key is never part of a URL, seeking works without Range support, and
   the download keeps its name. Nothing is fetched until the first press of play.

   Use:
     IshurRec.html({ id: 'call_…', name: '2026-11-25_1830_….wav' })  → markup (a string)
     IshurRec.bind(rootElement)   once per page (delegated; works for markup added later)
     IshurRec.pauseAll(rootElement)
     IshurRec.addLoader('team', function (id) { return Promise<Blob> })   26/11: another source
       (the team panel's files): IshurRec.html({ id, name, via: 'team' }) plays what that loader returns
   The page's colour variables are used when present (--card --line --ink --ink3 and
   --ok or --pine), so light and dark follow whatever the page does.
   ========================================================================== */
(function () {
  if (window.IshurRec) return;
  var CSS = '.recp{display:flex;align-items:center;gap:.5rem;border:1px solid var(--line,#E1E4DE);border-radius:8px;padding:.35rem .5rem;background:var(--card,#fff);color:var(--ink,#1B2620);margin:.3rem 0;font-size:.8rem;direction:ltr}' +
    '.recp button,.recp a{font:inherit;border:1px solid var(--line,#E1E4DE);background:var(--card,#fff);color:var(--ink,#1B2620);border-radius:8px;height:30px;min-width:30px;padding:0 .45rem;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;flex:none}' +
    /* the icon takes the card colour: white on the dark green of a light page, dark on the light green of a dark one,
       whichever way the page decides its theme (prefers-color-scheme or data-theme) */
    '.recp .rp-play{background:var(--ok,var(--pine,#0F4C35));border-color:transparent;color:var(--card,#fff);width:34px;padding:0}' +
    '.recp .rp-play svg{width:14px;height:14px;fill:currentColor}' +
    '.recp input[type=range]{flex:1;min-width:60px;accent-color:var(--ok,var(--pine,#0F4C35));height:4px;margin:0}' +
    '.recp .rp-t{font-variant-numeric:tabular-nums;color:var(--ink3,#7F8C86);white-space:nowrap;min-width:5.6em;text-align:center}' +
    '.recp .rp-sp{min-width:3em}.recp .rp-msg{color:var(--ink3,#7F8C86)}' +
    '.recp[data-state=loading] .rp-play{opacity:.6;cursor:wait}' +
    '@media (max-width:420px){.recp{flex-wrap:wrap}.recp input[type=range]{order:5;flex-basis:100%}}';
  var PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
  var PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';
  var SPEEDS = [1, 1.5, 2];
  var cache = {};   /* call id → blob: URL ('' = not available) */
  var loaders = {};   /* via → function (id) → Promise<Blob> */

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(s) { s = Math.max(0, Math.floor(Number(s) || 0)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function base() { try { return window.ISHUR_CONFIG.endpoint('status').replace(/\/api\/status$/, ''); } catch (e) { return 'https://go.ishur.io'; } }
  function headers() {
    var h = {}, k = '', s = '';
    try { k = localStorage.getItem('ishur_calls_key') || ''; s = localStorage.getItem('ishur_session') || ''; } catch (e) {}
    if (k) h['X-Admin-Key'] = k; if (s) h['x-ishur-session'] = s;
    return h;
  }
  function ensureCss() { if (document.getElementById('recp-css')) return; var st = document.createElement('style'); st.id = 'recp-css'; st.textContent = CSS; document.head.appendChild(st); }
  function idOk(id) { return /^[A-Za-z0-9_.-]{6,80}$/.test(String(id || '')); }
  /* a signed /rec/<id>?e=&s= link or a bare id → the id */
  function idOf(x) { var m = /\/rec\/([^?#]+)/.exec(String(x || '')); return m ? decodeURIComponent(m[1]) : String(x || ''); }

  function html(o) {
    ensureCss();
    var id = idOf(o && (o.id || o.src));
    if (!idOk(id)) return '<div class="recp"><span class="rp-msg">אין הקלטה</span></div>';
    var name = (o && o.name) || (id + '.wav');
    var via = o && o.via && loaders[o.via] ? ' data-via="' + esc(o.via) + '"' : '';
    return '<div class="recp" data-rec="' + esc(id) + '" data-name="' + esc(name) + '"' + via + ' data-state="idle">' +
      '<button type="button" class="rp-play" aria-label="ניגון">' + PLAY + '</button>' +
      '<input type="range" min="0" max="1000" value="0" step="1" aria-label="מיקום בהקלטה" disabled>' +
      '<span class="rp-t">0:00 / ' + (o && o.duration_s ? fmt(o.duration_s) : '--:--') + '</span>' +
      '<button type="button" class="rp-sp" aria-label="מהירות">1x</button>' +
      '<a class="rp-dl" href="#" aria-label="הורדת ההקלטה" title="הורדה">⬇</a>' +
      '<audio preload="none" hidden></audio></div>';
  }
  function load(box) {
    var id = box.getAttribute('data-rec');
    if (cache[id] !== undefined) return Promise.resolve(cache[id]);
    box.setAttribute('data-state', 'loading');
    var via = box.getAttribute('data-via');
    return (via && loaders[via] ? Promise.resolve().then(function () { return loaders[via](id); }) :
      fetch(base() + '/rec/' + encodeURIComponent(id), { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); }))
      .then(function (b) { cache[id] = URL.createObjectURL(b); return cache[id]; })
      .catch(function () { cache[id] = ''; return ''; });
  }
  function ready(box) {
    var a = box.querySelector('audio');
    if (a.src) return Promise.resolve(a);
    return load(box).then(function (u) {
      if (!u) { box.setAttribute('data-state', 'none'); box.querySelector('.rp-t').textContent = 'ההקלטה לא זמינה'; return null; }
      a.src = u; box.setAttribute('data-state', 'ready'); box.querySelector('input').disabled = false;
      var dl = box.querySelector('.rp-dl'); dl.href = u; dl.setAttribute('download', box.getAttribute('data-name'));
      wire(box, a); return a;
    });
  }
  function wire(box, a) {
    var rng = box.querySelector('input'), t = box.querySelector('.rp-t'), pl = box.querySelector('.rp-play'), drag = false;
    function paint() { var d = a.duration || 0; if (!drag && d) rng.value = Math.round(a.currentTime / d * 1000); t.textContent = fmt(a.currentTime) + ' / ' + (d && isFinite(d) ? fmt(d) : '--:--'); }
    a.addEventListener('timeupdate', paint); a.addEventListener('loadedmetadata', paint); a.addEventListener('durationchange', paint);
    a.addEventListener('play', function () { pl.innerHTML = PAUSE; pl.setAttribute('aria-label', 'השהיה'); });
    a.addEventListener('pause', function () { pl.innerHTML = PLAY; pl.setAttribute('aria-label', 'ניגון'); });
    a.addEventListener('ended', function () { a.currentTime = 0; paint(); });
    rng.addEventListener('input', function () { drag = true; var d = a.duration || 0; if (d) t.textContent = fmt(rng.value / 1000 * d) + ' / ' + fmt(d); });
    rng.addEventListener('change', function () { var d = a.duration || 0; if (d) a.currentTime = rng.value / 1000 * d; drag = false; });
  }
  function bind(root) {
    root = root || document;
    if (root.__recp) return; root.__recp = true;
    root.addEventListener('click', function (e) {
      var box = e.target.closest && e.target.closest('.recp[data-rec]'); if (!box || e.__recp) return;
      e.__recp = true;   /* bound on a dialog AND its page: one click is handled once */
      if (e.target.closest('.rp-play')) {
        e.preventDefault();
        ready(box).then(function (a) {
          if (!a) return;
          if (a.paused) { pauseAll(document, a); a.play().catch(function () {}); } else a.pause();
        });
      } else if (e.target.closest('.rp-sp')) {
        var b = e.target.closest('.rp-sp'), a = box.querySelector('audio');
        var i = (SPEEDS.indexOf(Number(b.getAttribute('data-sp') || 1)) + 1) % SPEEDS.length;
        b.setAttribute('data-sp', SPEEDS[i]); b.textContent = SPEEDS[i] + 'x'; a.playbackRate = SPEEDS[i]; a.defaultPlaybackRate = SPEEDS[i];
      } else if (e.target.closest('.rp-dl')) {
        var dl = e.target.closest('.rp-dl');
        if (dl.getAttribute('href') === '#') { e.preventDefault(); ready(box).then(function (a) { if (a) dl.click(); }); }
      }
    });
  }
  function pauseAll(root, except) { var a = (root || document).querySelectorAll('.recp audio'); for (var i = 0; i < a.length; i++) if (a[i] !== except) a[i].pause(); }
  function addLoader(name, fn) { if (/^[a-z]{2,12}$/.test(String(name)) && typeof fn === 'function') loaders[name] = fn; }
  window.IshurRec = { html: html, bind: bind, pauseAll: pauseAll, idOf: idOf, addLoader: addLoader, _fmt: fmt };
})();
