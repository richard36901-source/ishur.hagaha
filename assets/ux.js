/* ux.js — the admin pages feel instant (Richard, 11/09: "loading, skeletons,
   really pleasant to use").
   1. Read calls to the worker are answered from sessionStorage at once and
      refreshed behind; when the fresh answer differs the page hears
      'ishur:fresh' and repaints (each page calls its own load(true)).
   2. Skeleton shimmer on KPI tiles and empty tables until data lands.
   3. Non-blocking toasts instead of alert().
   4. A soft fade-in so page-to-page never flashes white. */
(function () {
  'use strict';
  var READ_KEYS = { admin_key: 1, view: 1, channel: 1, phone: 1, limit: 1, date: 1, day: 1, action: 1, nonce: 1, stamp_ts: 1, sig: 1, app: 1, token: 1, tokens: 1, agent: 1, month: 1 };
  var READ_ACTIONS = { get: 1, list: 1, '': 1 };
  var css = '' +
    'body{animation:uxIn .18s ease-out}@keyframes uxIn{from{opacity:.55}to{opacity:1}}' +
    '.ux-skel{position:relative;color:transparent!important;border-radius:6px;background:linear-gradient(90deg,rgba(127,127,127,.12) 25%,rgba(127,127,127,.22) 37%,rgba(127,127,127,.12) 63%);background-size:400% 100%;animation:uxSh 1.2s ease-in-out infinite}' +
    '.ux-skel *{visibility:hidden}' +
    '@keyframes uxSh{0%{background-position:100% 0}100%{background-position:0 0}}' +
    'tbody.ux-skel-rows tr td{color:transparent}tbody.ux-skel-rows tr td i{display:block;height:.8em;border-radius:4px;background:linear-gradient(90deg,rgba(127,127,127,.12) 25%,rgba(127,127,127,.22) 37%,rgba(127,127,127,.12) 63%);background-size:400% 100%;animation:uxSh 1.2s ease-in-out infinite}' +
    '.ux-toast{position:fixed;bottom:1.2rem;left:50%;transform:translateX(-50%) translateY(20px);background:var(--ink,#1B2420);color:var(--card,#fff);padding:.6rem 1rem;border-radius:12px;font-size:.85rem;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;transition:opacity .2s,transform .2s;z-index:9999;max-width:90vw;direction:rtl}' +
    '.ux-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}' +
    '@media (prefers-reduced-motion:reduce){body,.ux-skel,tbody.ux-skel-rows tr td i{animation:none!important}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  /* ── toasts ── */
  var toastEl = null, toastT = null;
  function toast(msg, ms) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'ux-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = String(msg || '');
    requestAnimationFrame(function () { toastEl.classList.add('on'); });
    clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 2600);
  }
  window.alert = function (m) { toast(m, 4000); };

  /* ── a confirm dialog in the site's own style (Richard 11/09: nothing
     unstyled, ever). askConfirm(text, {title, ok, cancel, danger}) → Promise<bool> */
  var dlgCss = '.ux-dlg-bg{position:fixed;inset:0;background:rgba(15,46,34,.5);z-index:9000;opacity:0;transition:opacity .18s}.ux-dlg-bg.on{opacity:1}' +
    '.ux-dlg{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.96);z-index:9001;background:var(--card,#fff);color:var(--ink,#111827);border:1.5px solid var(--gold,#A8853C);border-radius:18px;padding:1.4rem 1.5rem 1.2rem;max-width:22rem;width:88vw;direction:rtl;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,.18);opacity:0;transition:opacity .18s,transform .18s;font-family:inherit}' +
    '.ux-dlg.on{opacity:1;transform:translate(-50%,-50%) scale(1)}' +
    '.ux-dlg h3{font-size:1.05rem;margin:0 0 .4rem;font-weight:600}.ux-dlg p{font-size:.9rem;color:var(--ink2,#374151);margin:0 0 1.1rem;line-height:1.6}' +
    '.ux-dlg .row{display:flex;gap:.5rem;justify-content:center}' +
    '.ux-dlg button{font:inherit;font-size:.9rem;font-weight:600;padding:.6rem 1.2rem;border-radius:999px;cursor:pointer;border:1.5px solid var(--line,#e5e7eb);background:var(--card,#fff);color:var(--ink,#111827);min-width:6.5rem}' +
    '.ux-dlg button.ok{background:var(--green,var(--pine,#0F4C35));color:#fff;border-color:transparent}.ux-dlg button.ok.danger{background:#A8402F}' +
    '.ux-dlg button:active{transform:scale(.97)}';
  var st2 = document.createElement('style'); st2.textContent = dlgCss; document.head.appendChild(st2);
  function askConfirm(text, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var bg = document.createElement('div'); bg.className = 'ux-dlg-bg';
      var box = document.createElement('div'); box.className = 'ux-dlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
      var h = document.createElement('h3'); h.textContent = o.title || 'רגע, לוודא';
      var p = document.createElement('p'); p.textContent = String(text || '');
      var row = document.createElement('div'); row.className = 'row';
      var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'ok' + (o.danger ? ' danger' : ''); ok.textContent = o.ok || 'כן, להמשיך';
      var no = document.createElement('button'); no.type = 'button'; no.textContent = o.cancel || 'ביטול';
      row.appendChild(ok); row.appendChild(no); box.appendChild(h); box.appendChild(p); box.appendChild(row);
      document.body.appendChild(bg); document.body.appendChild(box);
      requestAnimationFrame(function () { bg.classList.add('on'); box.classList.add('on'); ok.focus(); });
      function done(v) { bg.classList.remove('on'); box.classList.remove('on'); setTimeout(function () { bg.remove(); box.remove(); }, 200); document.removeEventListener('keydown', onKey); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); }
      ok.addEventListener('click', function () { done(true); });
      no.addEventListener('click', function () { done(false); });
      bg.addEventListener('click', function () { done(false); });
      document.addEventListener('keydown', onKey);
    });
  }
  window.askConfirm = askConfirm;

  /* ── skeletons ── */
  function skel() {
    var tiles = document.querySelectorAll('.kpi b, .stat b, .cac-main b');
    Array.prototype.forEach.call(tiles, function (b) {
      if (/^[–\-—]?$/.test(b.textContent.trim())) b.classList.add('ux-skel');
    });
    Array.prototype.forEach.call(document.querySelectorAll('table tbody'), function (tb) {
      if (tb.children.length) return;
      var cols = 3;
      var th = tb.parentNode.querySelector('thead tr');
      if (th) cols = th.children.length;
      tb.classList.add('ux-skel-rows');
      for (var r = 0; r < 3; r++) {
        var tr = document.createElement('tr');
        for (var c = 0; c < cols; c++) { var td = document.createElement('td'); td.innerHTML = '<i style="width:' + (40 + ((r * 7 + c * 13) % 50)) + '%"></i>'; tr.appendChild(td); }
        tb.appendChild(tr);
      }
    });
    var mo = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        var t = m.target.nodeType === 3 ? m.target.parentNode : m.target;
        if (!t || !t.classList) return;
        if (t.classList.contains('ux-skel') && !/^[–\-—]?$/.test(t.textContent.trim())) t.classList.remove('ux-skel');
        if (t.classList.contains('ux-skel-rows') && m.type === 'childList' && m.addedNodes.length && !t.querySelector('td > i:only-child')) t.classList.remove('ux-skel-rows');
        if (t.classList.contains('ux-skel-rows') && m.type === 'childList') {
          /* the page replaced our placeholder rows (innerHTML=) */
          var own = t.querySelectorAll('td > i:only-child').length;
          if (!own || own !== t.querySelectorAll('td').length) t.classList.remove('ux-skel-rows');
        }
      });
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', skel); else skel();

  /* ── stale-while-revalidate for read calls to the worker ── */
  var CFG = window.ISHUR_CONFIG || window.CFG || null;
  var origFetch = window.fetch.bind(window);
  var fresh = false, dirty = false, inflight = 0, settleT = null;
  function isReadBody(b) {
    for (var k in b) { if (!READ_KEYS[k]) return false; }
    if (b.action != null && !READ_ACTIONS[String(b.action)]) return false;
    return true;
  }
  function keyOf(url, b) {
    var o = {}; Object.keys(b).sort().forEach(function (k) { if (k !== 'admin_key' && k !== 'nonce' && k !== 'stamp_ts' && k !== 'sig') o[k] = b[k]; });
    return 'ishur_swr:' + url.replace(/^https?:\/\/[^/]+/, '') + ':' + JSON.stringify(o);
  }
  function settle() {
    clearTimeout(settleT);
    settleT = setTimeout(function () {
      if (inflight || !dirty) return;
      dirty = false; fresh = true;
      try { window.dispatchEvent(new CustomEvent('ishur:fresh')); } catch (e) {}
      setTimeout(function () { fresh = false; }, 4000);
    }, 250);
  }
  window.fetch = function (url, opts) {
    try {
      opts = opts || {};
      var u = String(url);
      var isApi = /\/api\//.test(u) && opts.method === 'POST' && typeof opts.body === 'string';
      if (!isApi || fresh) return origFetch(url, opts);
      var b = JSON.parse(opts.body);
      if (!b || !isReadBody(b)) return origFetch(url, opts);
      var k = keyOf(u, b), cached = null;
      try { cached = sessionStorage.getItem(k); } catch (e) {}
      inflight++;
      var net = origFetch(url, opts).then(function (r) {
        if (r.ok) {
          return r.clone().text().then(function (t) {
            try { if (t !== cached) { dirty = true; sessionStorage.setItem(k, t); } } catch (e) {}
            return r;
          });
        }
        return r;
      }).finally(function () { inflight--; settle(); });
      if (cached == null) return net;
      net.catch(function () {});
      return Promise.resolve(new Response(cached, { status: 200, headers: { 'Content-Type': 'application/json' } }));
    } catch (e) { return origFetch(url, opts); }
  };
  window.IshurUX = { toast: toast, confirm: askConfirm, clear: function () { try { Object.keys(sessionStorage).forEach(function (k) { if (k.indexOf('ishur_swr:') === 0) sessionStorage.removeItem(k); }); } catch (e) {} } };
})();
