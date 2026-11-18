/* ishur.io · next/assets/batch.js · one request for a whole admin view (12/11 אדמין אחד, plan §4)
   Admin READS that a page fires within a few milliseconds of each other travel together in ONE call to
   /api/admin/home and come back as ordinary Responses, so no page code changes. Only reads: the same route list
   the worker allows, and never a body with an action-like field. Anything else goes out untouched.
   Load right after config.js, BEFORE lite.js (lite then caches on top of this). */
(function () {
  'use strict';
  if (window.__ishurBatch) return; window.__ishurBatch = true;
  var READS = ['status', 'leads', 'wave-audit', 'cap-status', 'call-board', 'evlog', 'ads-health', 'feedback-list', 'client-flags', 'calendar', 'send-board', 'ops-stats', 'traffic', 'campaign-stats', 'cost-log', 'shir-calls', 'template-stats', 'calls-log', 'inbox', 'board-event', 'template-text', 'msg-stats', 'brain-toggle', 'pause', 'fixedcost', 'addon-quote', 'leads-board', 'floor', 'referrals', 'partner/list', 'design-list', 'staff', 'event-flag'];
  /* two lanes: quick reads are not held back by the slow ones (leads, logs, ads take 1–2 s each) */
  var SLOW = ['leads', 'evlog', 'ads-health', 'call-board', 'calls-log', 'inbox', 'template-stats', 'msg-stats', 'shir-calls', 'leads-board', 'ops/realtime'];
  /* the numbers under the weekly board (4–12 s to build) travel on their own, so nothing above waits for them */
  var STATS = ['wave-audit', 'ops-stats', 'cost-log', 'traffic', 'campaign-stats', 'feedback-list'];
  var MUT = ['action', 'act', 'mode', 'set', 'on', 'date', 'order', 'text', 'assignments', 'payload', 'blocked', 'paused', 'update', 'delete', 'send', 'template', 'to', 'enabled', 'confirm'];
  var real = window.fetch.bind(window), lanes = { fast: { q: [], t: null, w: 30 }, slow: { q: [], t: null, w: 250 }, stats: { q: [], t: null, w: 120 } };
  window.__ishurBatchStats = { batches: 0, calls: 0, direct: 0, failed: 0, err: '', log: [] };
  function plan(url, init) {
    var u; try { u = new URL(url, location.href); } catch (e) { return null; }
    if (!/(^|\.)ishur\.io$/.test(u.hostname) || u.pathname.indexOf('/api/') !== 0 || u.pathname === '/api/admin/home') return null;
    var method = ((init && init.method) || 'GET').toUpperCase();
    if (method === 'GET') {
      var h = (init && init.headers) || {}; var k = h['x-admin-key'] || h['X-Admin-Key'];
      if (!k || u.pathname.indexOf('/api/ops/') !== 0) return null;
      return { key: k, base: u.origin, c: { p: u.pathname + u.search, m: 'GET' } };
    }
    if (method !== 'POST' || !init || typeof init.body !== 'string') return null;
    var b; try { b = JSON.parse(init.body); } catch (e) { return null; }
    if (!b || !b.admin_key || READS.indexOf(u.pathname.slice(5)) < 0) return null;
    if (u.pathname === '/api/event-flag' && 'on' in b) return null;   /* with `on` it is a write, even on:false */
    for (var i = 0; i < MUT.length; i++) { var v = b[MUT[i]]; if (v !== undefined && v !== null && v !== false && v !== '') return null; }
    var key = b.admin_key, body = {}; for (var n in b) if (n !== 'admin_key') body[n] = b[n];
    return { key: key, base: u.origin, c: { p: u.pathname + u.search, m: 'POST', b: body } };
  }
  function flush(lane) {
    lane.t = null; var items = lane.q; lane.q = [];
    if (!items.length) return;
    if (items.length === 1) { window.__ishurBatchStats.direct++; var one = items[0]; real(one.url, one.init).then(one.res, one.rej); return; }
    window.__ishurBatchStats.batches++; window.__ishurBatchStats.calls += items.length;
    real(items[0].base + '/api/admin/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: items[0].key, calls: items.map(function (x) { return x.c; }) }) })
      .then(function (r) { if (!r.ok) throw new Error('batch ' + r.status); return r.json(); })
      .then(function (j) {
        window.__ishurBatchStats.log.push(items.map(function (it, i) { var x = (j.results || [])[i] || {}; return it.c.p.split('?')[0].slice(5) + ':' + (x.ms == null ? (x.cached ? 'cached' : '-') : x.ms); }).join(' '));
        items.forEach(function (it, i) { var x = (j.results || [])[i]; if (!x) { real(it.url, it.init).then(it.res, it.rej); return; } it.done = true; it.res(new Response(x.t, { status: x.s || 200, headers: { 'Content-Type': 'application/json', 'X-Ishur-Batch': '1' } })); });
      })
      .catch(function (e) { window.__ishurBatchStats.failed++; window.__ishurBatchStats.err = String(e && e.message || e).slice(0, 120); items.forEach(function (it) { if (!it.done) real(it.url, it.init).then(it.res, it.rej); }); });   /* the batch failed: every call goes out on its own, as before */
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = typeof input === 'string' ? plan(url, init) : null;
    if (!p) return real(input, init);
    var name = p.c.p.split('?')[0].slice(5);
    var lane = lanes[STATS.indexOf(name) > -1 ? 'stats' : SLOW.indexOf(name) > -1 ? 'slow' : 'fast'];
    if (lane.q.length && lane.q[0].key !== p.key) return real(input, init);
    return new Promise(function (res, rej) {
      lane.q.push({ url: url, init: init, res: res, rej: rej, key: p.key, base: p.base, c: p.c });
      if (lane.q.length >= 40) { clearTimeout(lane.t); flush(lane); return; }
      if (!lane.t) lane.t = setTimeout(function () { flush(lane); }, lane.w);
    });
  };
  /* measuring only: when the weekly board first has content, and when the top strip stops saying "checking" */
  try {
    var mo = new MutationObserver(function () {
      var w = document.getElementById('week');
      if (w && w.childElementCount && !performance.getEntriesByName('ishur-week').length) performance.mark('ishur-week');
      var st = document.getElementById('strip');
      if (st && !st.querySelector('.skel') && !performance.getEntriesByName('ishur-strip').length) performance.mark('ishur-strip');
    });
    document.addEventListener('DOMContentLoaded', function () { mo.observe(document.body, { childList: true, subtree: true }); });
  } catch (e) {}
})();
