/* ============================================================================
   ishur.io · request guard
   ----------------------------------------------------------------------------
   What this is honest about: the webhook URLs live in config.js and anyone can
   read them. Nothing here hides them, and a determined attacker who reads this
   file can reproduce every stamp it makes.

   What it does buy:
     · every request carries proof the page actually ran, so Make can drop
       anything posted straight at the URL with curl in a single filter, before
       it costs a row or a message
     · a submit inside the first couple of seconds is refused, which is most
       naive bots
     · per-browser caps and a duplicate check stop a stuck retry loop or a leant
       on button from firing a hundred times
     · a timestamp bounds how long a captured request stays replayable

   The real fix for a public URL is a proxy that keeps it server side and rate
   limits by IP. This is the layer that works without one.

   Requires config.js. Load before lead.js.
   ========================================================================== */

window.IshurGuard = (function () {

  var CFG = window.ISHUR_CONFIG || {};
  var G = CFG.GUARD || {};
  var KEY = G.appKey || '';
  var loadedAt = Date.now();

  /* the stamp is computed once at load, so nothing has to wait on crypto at
     the moment of submit. That matters on the payment redirect, where a delay
     would cost the lead. */
  var nonce = uuid();
  var stampTs = Date.now();
  var sig = '';

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function hex(buf) {
    var b = new Uint8Array(buf), out = '';
    for (var i = 0; i < b.length; i++) out += (b[i] + 0x100).toString(16).slice(1);
    return out;
  }

  /* sha256(appKey|nonce|ts). Make recomputes it with one sha256 call. */
  function computeSig() {
    if (!KEY || !window.crypto || !crypto.subtle) return;
    try {
      var msg = new TextEncoder().encode(KEY + '|' + nonce + '|' + stampTs);
      crypto.subtle.digest('SHA-256', msg).then(function (d) { sig = hex(d); });
    } catch (e) {}
  }
  computeSig();

  /* ── caps ─────────────────────────────────────────────────────────────── */

  function bucket(kind) {
    var k = 'ishur_g_' + kind;
    var now = Date.now();
    var hits = [];
    try { hits = JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) {}
    hits = hits.filter(function (t) { return now - t < 3600e3; });
    return { key: k, hits: hits };
  }

  function count(kind) {
    return bucket(kind).hits.length;
  }

  function record(kind) {
    var b = bucket(kind);
    b.hits.push(Date.now());
    try { localStorage.setItem(b.key, JSON.stringify(b.hits)); } catch (e) {}
  }

  /* has this exact thing already been sent in the last few minutes */
  function fingerprint(obj) {
    var s = '';
    try { s = JSON.stringify(obj); } catch (e) { s = String(obj); }
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function isDuplicate(kind, payload) {
    var k = 'ishur_d_' + kind;
    var fp = fingerprint(payload);
    var now = Date.now();
    var seen = {};
    try { seen = JSON.parse(sessionStorage.getItem(k) || '{}'); } catch (e) {}
    for (var f in seen) if (now - seen[f] > (G.duplicateWindowMs || 120000)) delete seen[f];
    if (seen[fp]) return true;
    seen[fp] = now;
    try { sessionStorage.setItem(k, JSON.stringify(seen)); } catch (e) {}
    return false;
  }

  /* ── public ───────────────────────────────────────────────────────────── */

  /* Adds the proof fields. Never throws, never blocks. */
  function stamp(payload) {
    payload = payload || {};
    if (KEY) {
      payload.app = G.appId || 'ishur-web';
      payload.nonce = nonce;
      payload.stamp_ts = stampTs;
      payload.sig = sig;
    }
    return payload;
  }

  /* Should this request be allowed out at all.
     kind is used for the per-hour cap; pass the payload to catch repeats. */
  function allow(kind, payload) {
    var limits = G.limits || {};
    var max = limits[kind] != null ? limits[kind] : 20;

    if (Date.now() - loadedAt < (G.minDwellMs || 0)) {
      return { ok: false, why: 'too-fast' };
    }
    if (count(kind) >= max) {
      return { ok: false, why: 'rate' };
    }
    if (payload && isDuplicate(kind, payload)) {
      return { ok: false, why: 'duplicate' };
    }
    record(kind);
    return { ok: true };
  }

  /* a check with no side effects, for deciding whether to enable a button */
  function remaining(kind) {
    var limits = G.limits || {};
    var max = limits[kind] != null ? limits[kind] : 20;
    return Math.max(0, max - count(kind));
  }

  return {
    stamp: stamp,
    allow: allow,
    remaining: remaining,
    nonce: function () { return nonce; },
    ready: function () { return Date.now() - loadedAt >= (G.minDwellMs || 0); }
  };
})();
