/* ============================================================================
   ishur.io · lead capture
   ----------------------------------------------------------------------------
   Shared by site v1 and site v2 so both emit the same payload. The only
   difference between them is the `variant` field, set once by each page.

   Requires config.js to be loaded first.
   ========================================================================== */

window.IshurLead = (function () {

  var CFG = window.ISHUR_CONFIG || {};
  var variant = 'v1';
  var sessionId = '';
  var partialSent = false;

  /* ── session ───────────────────────────────────────────────────────────── */

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    /* older Safari: RFC4122 v4 from getRandomValues, Math.random as last resort */
    if (window.crypto && crypto.getRandomValues) {
      var b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var h = [];
      for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
      return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' +
             h.slice(6, 8).join('') + '-' + h.slice(8, 10).join('') + '-' +
             h.slice(10, 16).join('');
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function init(opts) {
    variant = (opts && opts.variant) || 'v1';
  }

  /* new session per popup open, so an abandoned popup and a retry are
     two separate leads rather than one overwritten row */
  function newSession() {
    sessionId = uuid();
    partialSent = false;
    return sessionId;
  }

  function getSession() {
    return sessionId || newSession();
  }

  /* ── phone ─────────────────────────────────────────────────────────────── */

  /* 05X + 8 digits. Tolerates spaces, dashes, +972 and 972 prefixes. */
  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('972') === 0) d = '0' + d.slice(3);
    return d;
  }

  function isValidPhone(raw) {
    return /^05\d{8}$/.test(normalizePhone(raw));
  }

  /* ── tracking ──────────────────────────────────────────────────────────── */

  function track(event, params) {
    window.dataLayer = window.dataLayer || [];
    var payload = { event: event, variant: variant };
    if (params) for (var k in params) if (params.hasOwnProperty(k)) payload[k] = params[k];
    window.dataLayer.push(payload);
  }

  function pixel(event, params) {
    if (typeof fbq === 'undefined') return;
    try { fbq('track', event, params || {}); } catch (e) {}
  }

  /* ── utm ───────────────────────────────────────────────────────────────── */

  function utm() {
    var q = new URLSearchParams(location.search);
    return {
      utm_source: q.get('utm_source') || '',
      utm_medium: q.get('utm_medium') || '',
      utm_campaign: q.get('utm_campaign') || ''
    };
  }

  /* ── payload ───────────────────────────────────────────────────────────── */

  /* f = { name, phone, email, occasion, guests, plan } — all optional,
     whatever is filled at the moment of the call. */
  function build(eventType, f) {
    f = f || {};
    var price = (f.guests && f.plan && CFG.priceFor) ? CFG.priceFor(f.guests, f.plan) : null;
    var p = {
      event_type: eventType,
      session_id: getSession(),
      variant: variant,
      name: (f.name || '').trim(),
      phone: normalizePhone(f.phone),
      email: (f.email || '').trim(),
      occasion: f.occasion ? (CFG.occasionLabel ? CFG.occasionLabel(f.occasion) : f.occasion) : '',
      occasion_key: f.occasion || '',
      guest_range: f.guests ? (CFG.guestLabel ? CFG.guestLabel(f.guests) : f.guests) : '',
      guests: f.guests || '',
      plan: f.plan || '',
      plan_name: (f.plan && CFG.PLANS && CFG.PLANS[f.plan]) ? CFG.PLANS[f.plan].name : '',
      price: price,
      page: location.href,
      ts: new Date().toISOString()
    };
    var u = utm();
    for (var k in u) if (u.hasOwnProperty(k)) p[k] = u[k];
    return p;
  }

  /* ── send ──────────────────────────────────────────────────────────────── */

  /* keepalive so the request survives the redirect to Grow. sendBeacon is the
     fallback; it cannot set a JSON content-type, so Make reads it as text and
     parses. Never throws, never blocks the caller. */
  function send(payload) {
    var url = CFG.MAKE_LEAD_WEBHOOK;
    if (!url || !CFG.isSet(url)) return;
    var body = JSON.stringify(payload);
    try {
      if (window.fetch) {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
          mode: 'cors'
        })['catch'](function () { beacon(url, body); });
        return;
      }
    } catch (e) {}
    beacon(url, body);
  }

  function beacon(url, body) {
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    } catch (e) {}
  }

  /* ── public events ─────────────────────────────────────────────────────── */

  function popupOpen(where) {
    newSession();
    track('popup_open', { session_id: getSession(), where: where || '' });
  }

  /* fires at most once per session, on the first valid phone blur */
  function partial(f) {
    if (partialSent) return false;
    if (!isValidPhone(f && f.phone)) return false;
    partialSent = true;
    var p = build('lead_partial', f);
    send(p);
    track('lead_partial', { session_id: p.session_id });
    return true;
  }

  function submitted(f) {
    var p = build('lead_submitted', f);
    send(p);
    track('lead_submitted', {
      session_id: p.session_id,
      occasion: p.occasion_key,
      guests: p.guests,
      plan: p.plan,
      price: p.price
    });
    pixel('InitiateCheckout', { value: p.price || 0, currency: 'ILS' });
    return p;
  }

  function paymentRedirect(f, url) {
    track('payment_redirect', {
      session_id: getSession(),
      tier: (f.guests || '') + '_' + (f.plan || ''),
      guests: f.guests || '',
      plan: f.plan || '',
      price: (CFG.priceFor ? CFG.priceFor(f.guests, f.plan) : null),
      url: url || ''
    });
  }

  return {
    init: init,
    newSession: newSession,
    getSession: getSession,
    normalizePhone: normalizePhone,
    isValidPhone: isValidPhone,
    track: track,
    build: build,
    send: send,
    popupOpen: popupOpen,
    partial: partial,
    submitted: submitted,
    paymentRedirect: paymentRedirect
  };
})();
