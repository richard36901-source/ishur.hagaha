/* ishur.io · lite.js · instant admin pages (Richard 09/11: "תוסיף lite להכל")
   Every admin read (POST /api/<read route> with admin_key, GET /api/ops/*) is cached in localStorage.
   On the next page open the cached answer is served at once, the real request runs in the background,
   and when it lands the page is told (window event 'ishur:fresh', which the admin pages already handle
   by reloading). Within one page session a route is served from cache only once; after that it always
   goes to the network. Mutations are never cached: only the read routes listed here, and only when the
   body carries no action-like field. Load AFTER config.js + guard.js, before the page script. */
(function () {
  'use strict';
  if (window.__ishurLite) return; window.__ishurLite = true;
  var READS = ['status', 'leads', 'wave-audit', 'cap-status', 'call-board', 'evlog', 'ads-health', 'feedback-list', 'client-flags', 'calendar', 'send-board', 'ops-stats', 'traffic', 'campaign-stats', 'cost-log', 'shir-calls', 'template-stats', 'calls-log', 'inbox', 'board-event', 'template-text', 'msg-stats', 'brain-toggle', 'pause', 'fixedcost', 'addon-quote', 'leads-board', 'floor'];
  var MUTATING_KEYS = ['action', 'mode', 'set', 'on', 'date', 'order', 'text', 'assignments', 'payload', 'blocked', 'paused', 'update', 'delete', 'send', 'template', 'to'];
  var STRIP = ['sig', 'nonce', 'stamp_ts', 'app', 'admin_key'];
  var PREFIX = 'lite:', MAX_AGE = 6 * 3600e3, MAX_BYTES = 300000;
  var servedOnce = {}, pending = 0, freshTimer = null, anyFresh = false;
  var realFetch = window.fetch.bind(window);

  function keyOf(url, body) {
    var u; try { u = new URL(url, location.href); } catch (e) { return null; }
    var path = u.pathname.replace(/^\/api\//, '');
    if (u.pathname.indexOf('/api/ops/') === 0) return PREFIX + u.pathname + u.search;
    if (READS.indexOf(path) < 0) return null;
    var clean = {};
    if (body && typeof body === 'object') {
      for (var k in body) { if (STRIP.indexOf(k) >= 0) continue; if (MUTATING_KEYS.indexOf(k) >= 0 && body[k] !== undefined && body[k] !== null && body[k] !== false && body[k] !== '') return null; clean[k] = body[k]; }
    }
    return PREFIX + path + ':' + JSON.stringify(clean);
  }
  function get(k) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); if (!v || Date.now() - v.at > MAX_AGE) return null; return v; } catch (e) { return null; } }
  function put(k, text) {
    if (!text || text.length > MAX_BYTES) return;
    try { localStorage.setItem(k, JSON.stringify({ at: Date.now(), t: text })); }
    catch (e) { /* quota: drop the oldest lite entries and retry once */
      try { var ks = []; for (var i = 0; i < localStorage.length; i++) { var n = localStorage.key(i); if (n && n.indexOf(PREFIX) === 0) ks.push(n); }
        ks.sort(function (a, b) { return (get(a) || { at: 0 }).at - (get(b) || { at: 0 }).at; }); ks.slice(0, Math.ceil(ks.length / 2)).forEach(function (n) { localStorage.removeItem(n); });
        localStorage.setItem(k, JSON.stringify({ at: Date.now(), t: text })); } catch (x) {}
    }
  }
  function fresh() { anyFresh = true; clearTimeout(freshTimer); freshTimer = setTimeout(function () { if (pending > 0) { freshTimer = setTimeout(fresh, 400); return; } try { window.dispatchEvent(new Event('ishur:fresh')); } catch (e) {} badge(false); }, 250); }
  var badgeEl = null;
  function badge(on) {
    if (!badgeEl) { badgeEl = document.createElement('div'); badgeEl.setAttribute('aria-live', 'polite'); badgeEl.style.cssText = 'position:fixed;bottom:12px;inset-inline-start:12px;z-index:9998;font:12px Heebo,sans-serif;background:rgba(27,36,32,.85);color:#fff;border-radius:999px;padding:4px 10px;opacity:0;transition:opacity .2s;pointer-events:none'; badgeEl.textContent = 'מתעדכן…'; (document.body || document.documentElement).appendChild(badgeEl); }
    badgeEl.style.opacity = on ? '1' : '0';
  }
  function mkResponse(text) { return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Ishur-Lite': 'cache' } }); }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var isApi = /\/api\//.test(url);
    if (!isApi) return realFetch(input, init);
    var body = null;
    if (method === 'POST' && init && typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch (e) { body = null; } if (!body || !body.admin_key) return realFetch(input, init); }
    else if (method === 'GET') { if (!(init && init.headers && (init.headers['x-admin-key'] || init.headers['X-Admin-Key']))) return realFetch(input, init); }
    else return realFetch(input, init);
    var k = keyOf(url, body); if (!k) return realFetch(input, init);
    var net = function () {
      pending++; badge(true);
      return realFetch(input, init).then(function (r) {
        pending--; if (pending === 0) badge(false);
        if (r.ok) { r.clone().text().then(function (t) { try { var j = JSON.parse(t); if (j && j.ok !== false) put(k, t); } catch (e) {} }).catch(function () {}); }
        return r;
      }, function (e) { pending--; if (pending === 0) badge(false); throw e; });
    };
    var hit = !servedOnce[k] ? get(k) : null;
    if (hit) {
      servedOnce[k] = true;
      /* serve the cached copy now; the real one refreshes the page via ishur:fresh */
      net().then(function () { fresh(); }).catch(function () { badge(false); });
      return Promise.resolve(mkResponse(hit.t));
    }
    servedOnce[k] = true;
    return net();
  };
  window.IshurLite = { clear: function () { var ks = []; for (var i = 0; i < localStorage.length; i++) { var n = localStorage.key(i); if (n && n.indexOf(PREFIX) === 0) ks.push(n); } ks.forEach(function (n) { localStorage.removeItem(n); }); return ks.length; } };
})();
