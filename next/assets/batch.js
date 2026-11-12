/* ishur.io · next/assets/batch.js · one request for a whole admin view (12/11 אדמין אחד, plan §4)
   Admin READS that a page fires within a few milliseconds of each other travel together in ONE call to
   /api/admin/home and come back as ordinary Responses, so no page code changes. Only reads: the same route list
   the worker allows, and never a body with an action-like field. Anything else goes out untouched.
   Load right after config.js, BEFORE lite.js (lite then caches on top of this). */
(function () {
  'use strict';
  if (window.__ishurBatch) return; window.__ishurBatch = true;
  var READS = ['status', 'leads', 'wave-audit', 'cap-status', 'call-board', 'evlog', 'ads-health', 'feedback-list', 'client-flags', 'calendar', 'send-board', 'ops-stats', 'traffic', 'campaign-stats', 'cost-log', 'shir-calls', 'template-stats', 'calls-log', 'inbox', 'board-event', 'template-text', 'msg-stats', 'brain-toggle', 'pause', 'fixedcost', 'addon-quote', 'leads-board', 'floor', 'referrals', 'partner/list', 'design-list', 'staff'];
  var MUT = ['action', 'act', 'mode', 'set', 'on', 'date', 'order', 'text', 'assignments', 'payload', 'blocked', 'paused', 'update', 'delete', 'send', 'template', 'to', 'enabled', 'confirm'];
  var real = window.fetch.bind(window), queue = [], timer = null, WAIT = 30;
  window.__ishurBatchStats = { batches: 0, calls: 0, direct: 0 };
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
    for (var i = 0; i < MUT.length; i++) { var v = b[MUT[i]]; if (v !== undefined && v !== null && v !== false && v !== '') return null; }
    var key = b.admin_key, body = {}; for (var n in b) if (n !== 'admin_key') body[n] = b[n];
    return { key: key, base: u.origin, c: { p: u.pathname + u.search, m: 'POST', b: body } };
  }
  function flush() {
    timer = null; var items = queue; queue = [];
    if (!items.length) return;
    if (items.length === 1) { window.__ishurBatchStats.direct++; var one = items[0]; real(one.url, one.init).then(one.res, one.rej); return; }
    window.__ishurBatchStats.batches++; window.__ishurBatchStats.calls += items.length;
    real(items[0].base + '/api/admin/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: items[0].key, calls: items.map(function (x) { return x.c; }) }) })
      .then(function (r) { if (!r.ok) throw new Error('batch ' + r.status); return r.json(); })
      .then(function (j) {
        items.forEach(function (it, i) { var x = (j.results || [])[i]; if (!x) { real(it.url, it.init).then(it.res, it.rej); return; } it.res(new Response(x.t, { status: x.s || 200, headers: { 'Content-Type': 'application/json', 'X-Ishur-Batch': '1' } })); });
      })
      .catch(function () { items.forEach(function (it) { real(it.url, it.init).then(it.res, it.rej); }); });   /* the batch failed: every call goes out on its own, as before */
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = typeof input === 'string' ? plan(url, init) : null;
    if (!p || (queue.length && queue[0].key !== p.key)) return real(input, init);
    return new Promise(function (res, rej) {
      queue.push({ url: url, init: init, res: res, rej: rej, key: p.key, base: p.base, c: p.c });
      if (queue.length >= 18) { clearTimeout(timer); flush(); return; }
      if (!timer) timer = setTimeout(flush, WAIT);
    });
  };
})();
