/* ishur.io · next/assets/leads-crm.js · the logic of the leads list (16/11/2026)
   No DOM in here: sorting, filtering, the counts on the chips, the optimistic
   edit with its rollback, and how a change that arrives from monday lands on a
   list somebody is typing in. next/leads.html draws; this decides.
   Tested from node (worker/test/leads-screen.test.mjs). */
(function (root) {
  'use strict';
  var COLS = [
    { k: 'name', he: 'שם', t: 'text' }, { k: 'phone', he: 'טלפון', t: 'text' }, { k: 'event', he: 'אירוע', t: 'text' },
    { k: 'guests', he: 'כמות', t: 'num' }, { k: 'package', he: 'חבילה', t: 'text' }, { k: 'price', he: 'מחיר', t: 'num' },
    { k: 'source', he: 'מקור', t: 'text' }, { k: 'ad', he: 'מודעה', t: 'text' }, { k: 'status', he: 'סטטוס', t: 'text' },
    { k: 'owner', he: 'טיפול', t: 'text' }, { k: 'touch_at', he: 'נגיעה אחרונה', t: 'date' }, { k: 'next', he: 'הצעד הבא', t: 'date' }
  ];
  var EDITABLE = ['status', 'owner', 'price', 'next'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtPhone(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.indexOf('972') === 0) { var l = '0' + d.slice(3); return l.length === 10 ? l.slice(0, 3) + '-' + l.slice(3, 6) + '-' + l.slice(6) : l; }
    return d;
  }
  function empty(v) { return v === null || v === undefined || v === ''; }

  /* sort by any column; empties last whatever the direction; ties keep the newest first */
  function sortLeads(list, key, dir) {
    var col = null; for (var i = 0; i < COLS.length; i++) if (COLS[i].k === key) col = COLS[i];
    var t = col ? col.t : key === 'created_at' ? 'date' : 'text', d = dir === 'asc' ? 1 : -1;
    var val = function (l) { var v = l[key]; if (empty(v)) return null; return t === 'num' ? Number(v) : t === 'date' ? (Date.parse(v) || 0) : String(v); };
    return (list || []).slice().sort(function (a, b) {
      var x = val(a), y = val(b);
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      if (x !== null && y !== null && x !== y) return (t === 'text' ? x.localeCompare(y, 'he') : x - y) * d;
      var ca = Date.parse(a.created_at) || 0, cb = Date.parse(b.created_at) || 0;
      if (ca !== cb) return cb - ca;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
  }

  /* f = { status: '' | label, owner: '' | label | '-' (nobody), q } */
  function matchLead(l, f) {
    f = f || {};
    if (f.status && l.status !== f.status) return false;
    if (f.owner === '-' ? !!l.owner : f.owner && l.owner !== f.owner) return false;
    var q = String(f.q || '').trim().toLowerCase();
    if (q) {
      var digits = q.replace(/\D/g, '');
      var hay = [l.name, l.event, l.source, l.ad, l.package, l.status, l.owner, l.phone_text, fmtPhone(l.phone)].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0 && !(digits.length >= 3 && String(l.phone || '').indexOf(digits.replace(/^0/, '')) >= 0)) return false;
    }
    return true;
  }
  function counts(list, statuses, owners) {
    var c = { all: (list || []).length, status: {}, owner: { '-': 0 } };
    (statuses || []).forEach(function (s) { c.status[s] = 0; }); (owners || []).forEach(function (o) { c.owner[o] = 0; });
    (list || []).forEach(function (l) {
      if (l.status) c.status[l.status] = (c.status[l.status] || 0) + 1;
      if (l.owner) c.owner[l.owner] = (c.owner[l.owner] || 0) + 1; else c.owner['-']++;
    });
    return c;
  }

  /* an edit before the server answers: the row shows the new value at once, `base`
     is what the user was looking at (the server checks it against monday), `undo`
     puts the row back when the save fails */
  function optimistic(lead, fields) {
    var next = {}, base = {}, undo = {}, k;
    for (k in lead) next[k] = lead[k];
    EDITABLE.forEach(function (f) { if (fields[f] !== undefined) { base[f] = empty(lead[f]) ? '' : lead[f]; undo[f] = lead[f]; next[f] = fields[f]; } });
    return { lead: next, base: base, undo: undo };
  }
  function rollback(lead, undo) { var out = {}, k; for (k in lead) out[k] = lead[k]; for (k in undo) out[k] = undo[k]; return out; }

  /* what the server said about a save → the row's state: saved only on an explicit ok */
  function saveState(status, j) {
    if (j && j.ok === true && j.lead) return 'saved';
    if (status === 409 || (j && j.error === 'conflict')) return 'conflict';
    return 'failed';
  }
  var STATE_HE = { saving: 'שומר', saved: 'נשמר', failed: 'לא נשמר', conflict: 'השתנה במאנדיי' };

  /* a "changed since" answer onto the list. Rows the user is in the middle of
     (busy[id]) are not touched now: their change waits in `held` for the next pass.
     Returns { list, held, changed:[ids], removed:[ids] }. */
  function applyRemote(list, answer, busy, held) {
    busy = busy || {}; var wait = {}, k;
    for (k in (held || {})) wait[k] = held[k];
    ((answer && answer.items) || []).forEach(function (l) { wait[l.id] = l; });
    ((answer && answer.deleted) || []).forEach(function (id) { wait[id] = null; });
    var by = {}, order = [], changed = [], removed = [];
    (list || []).forEach(function (l) { by[l.id] = l; order.push(l.id); });
    for (k in wait) {
      if (busy[k]) continue;
      var inc = wait[k]; delete wait[k];
      if (inc === null) { if (by[k]) { delete by[k]; removed.push(k); } continue; }
      var had = by[k];
      /* an older answer than the one on screen (our own save came back first) is dropped */
      if (had && had.rev && inc.rev && inc.rev < had.rev) continue;
      if (!had) order.unshift(k);
      if (!had || !sameShown(had, inc)) changed.push(k);
      by[k] = inc;
    }
    return { list: order.filter(function (id) { return by[id]; }).map(function (id) { return by[id]; }), held: wait, changed: changed, removed: removed };
  }
  var SHOWN = ['name', 'phone', 'event', 'guests', 'package', 'price', 'source', 'ad', 'status', 'owner', 'next', 'notes', 'dial', 'touch_text', 'group'];
  function sameShown(a, b) { for (var i = 0; i < SHOWN.length; i++) { var x = a[SHOWN[i]], y = b[SHOWN[i]]; if ((empty(x) ? '' : x) !== (empty(y) ? '' : y)) return false; } return true; }

  /* "לפני 5 דק׳" */
  function relTime(iso, now) {
    var t = Date.parse(iso || ''); if (!t) return '';
    var m = Math.max(0, Math.round(((now || Date.now()) - t) / 60000));
    if (m < 1) return 'עכשיו';
    if (m < 60) return 'לפני ' + m + ' דק׳';
    var h = Math.round(m / 60); if (h < 24) return 'לפני ' + h + ' שע׳';
    var d = Math.round(h / 24); if (d < 31) return 'לפני ' + d + ' ימים';
    var dt = new Date(t); return ('0' + dt.getDate()).slice(-2) + '.' + ('0' + (dt.getMonth() + 1)).slice(-2) + '.' + String(dt.getFullYear()).slice(2);
  }
  function heDate(iso) { var p = String(iso || '').slice(0, 10).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0].slice(2) : ''; }
  function lastNoteLine(notes) { var a = String(notes || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); return a.length ? a[a.length - 1] : ''; }
  function money(n) { return empty(n) ? '' : '₪' + Number(n).toLocaleString('en-US'); }

  var api = { COLS: COLS, EDITABLE: EDITABLE, STATE_HE: STATE_HE, esc: esc, fmtPhone: fmtPhone, sortLeads: sortLeads, matchLead: matchLead, counts: counts, optimistic: optimistic, rollback: rollback, saveState: saveState, applyRemote: applyRemote, sameShown: sameShown, relTime: relTime, heDate: heDate, lastNoteLine: lastNoteLine, money: money };
  root.IshurLeadsCRM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
