/* ============================================================================
   ishur.io · tracking
   ----------------------------------------------------------------------------
   Loads the ad platforms, captures attribution, and mints the event ids that
   let Make send the same conversion server-side without Meta counting it twice.

   How the loop closes:
     1. the browser fires a pixel event with an event_id
     2. the same event_id and event_name ride along in the Make webhook payload
     3. Make posts that event to the Conversions API with the same event_id
     4. Meta sees one conversion, not two, and still gets it when the browser
        pixel is blocked

   Attribution survives the Grow redirect because click ids are persisted, so a
   purchase that lands back on thanks.html is still tied to the ad that caused it.

   Requires config.js. Load before lead.js.
   ========================================================================== */

window.IshurTrack = (function () {

  var CFG = window.ISHUR_CONFIG || {};
  var STORE = 'ishur_attr';
  var TTL_DAYS = 30;

  /* ══ storage ══════════════════════════════════════════════════════════════ */

  function read() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return {};
      var o = JSON.parse(raw);
      if (o._exp && Date.now() > o._exp) { localStorage.removeItem(STORE); return {}; }
      return o;
    } catch (e) { return {}; }
  }

  function write(o) {
    try {
      o._exp = Date.now() + TTL_DAYS * 864e5;
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch (e) {}
  }

  function cookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : '';
  }

  /* ══ attribution ══════════════════════════════════════════════════════════
     First touch wins for utm/source, last click id wins for the ad platforms,
     because that is what each side actually reports on.
     ─────────────────────────────────────────────────────────────────────── */

  var CLICK_IDS = ['fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid', 'li_fat_id'];
  var UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

  function capture() {
    var q = new URLSearchParams(location.search);
    var a = read();

    /* first touch: only set if we have never seen one */
    UTMS.forEach(function (k) {
      var v = q.get(k);
      if (v && !a[k]) a[k] = v;
    });
    if (!a.landing_page) a.landing_page = location.href.split('#')[0];
    if (!a.referrer && document.referrer && document.referrer.indexOf(location.host) === -1) {
      a.referrer = document.referrer;
    }
    if (!a.first_seen) a.first_seen = new Date().toISOString();

    /* last click wins */
    var newFbclid = false;
    CLICK_IDS.forEach(function (k) {
      var v = q.get(k);
      if (!v) return;
      if (k === 'fbclid' && v !== a.fbclid) newFbclid = true;
      a[k] = v;
    });

    /* Meta builds _fbc from fbclid itself, but only on a page where its pixel
       ran. Build it here so the value exists even if the pixel is blocked.
       Stamped once per click id: stable across page views so matching stays
       consistent, rebuilt when a different ad click arrives. */
    if (a.fbclid && !cookie('_fbc') && (newFbclid || !a._fbc_synth)) {
      a._fbc_synth = 'fb.1.' + Date.now() + '.' + a.fbclid;
    }

    write(a);
    return a;
  }

  /* everything Make needs to send a Conversions API event */
  function attribution() {
    var a = read();
    var out = {};
    UTMS.concat(CLICK_IDS).forEach(function (k) { if (a[k]) out[k] = a[k]; });
    out.fbp = cookie('_fbp') || '';
    out.fbc = cookie('_fbc') || a._fbc_synth || '';
    out.ga_client_id = (cookie('_ga') || '').split('.').slice(-2).join('.');
    out.landing_page = a.landing_page || '';
    out.referrer = a.referrer || '';
    out.first_seen = a.first_seen || '';
    out.user_agent = navigator.userAgent;
    return out;
  }

  /* ══ event ids ════════════════════════════════════════════════════════════
     One id per conversion, reused by the browser pixel and the server event.
     Kept in sessionStorage so a reload of thanks.html does not mint a second
     Purchase.
     ─────────────────────────────────────────────────────────────────────── */

  function eventId(key) {
    var k = 'ishur_eid_' + key;
    try {
      var v = sessionStorage.getItem(k);
      if (v) return v;
    } catch (e) {}
    var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
           : 'e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    try { sessionStorage.setItem(k, id); } catch (e) {}
    return id;
  }

  function newEventId(key) {
    try { sessionStorage.removeItem('ishur_eid_' + key); } catch (e) {}
    return eventId(key);
  }

  /* ══ platform loading ═════════════════════════════════════════════════════ */

  function loadGTM() {
    if (!CFG.isSet(CFG.GTM_ID)) return;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var f = document.getElementsByTagName('script')[0];
    var j = document.createElement('script');
    j.async = true;
    j.src = 'https://www.googletagmanager.com/gtm.js?id=' + CFG.GTM_ID;
    f.parentNode.insertBefore(j, f);
  }

  function loadMeta() {
    if (!CFG.isSet(CFG.FB_PIXEL_ID)) return;
    /* eslint-disable */
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    fbq('init', CFG.FB_PIXEL_ID);
    fbq('track', 'PageView', {}, { eventID: eventId('pageview_' + location.pathname) });
  }

  function loadTikTok() {
    if (!CFG.isSet(CFG.TIKTOK_PIXEL_ID)) return;
    /* eslint-disable */
    !function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie'];ttq.setAndDefer=function(e,n){e[n]=function(){e.push([n].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(e){for(var n=ttq._i[e]||[],i=0;i<ttq.methods.length;i++)ttq.setAndDefer(n,ttq.methods[i]);return n};ttq.load=function(e,n){var i='https://analytics.tiktok.com/i18n/pixel/events.js';ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement('script');o.type='text/javascript';o.async=!0;o.src=i+'?sdkid='+e+'&lib='+t;var a=d.getElementsByTagName('script')[0];a.parentNode.insertBefore(o,a)};ttq.load(w.ISHUR_CONFIG.TIKTOK_PIXEL_ID);ttq.page()}(window,document,'ttq');
    /* eslint-enable */
  }

  function loadGA4() {
    /* only when running without GTM, otherwise GTM owns GA4 */
    if (!CFG.isSet(CFG.GA4_ID) || CFG.isSet(CFG.GTM_ID)) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + CFG.GA4_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', CFG.GA4_ID);
  }

  /* ══ firing ═══════════════════════════════════════════════════════════════ */

  /* Meta standard events, with the event id that Make will reuse server-side */
  function meta(name, params, eid) {
    if (typeof fbq === 'undefined') return;
    try { fbq('track', name, params || {}, eid ? { eventID: eid } : undefined); } catch (e) {}
  }

  function tiktok(name, params) {
    if (typeof ttq === 'undefined') return;
    try { ttq.track(name, params || {}); } catch (e) {}
  }

  function ga(name, params) {
    if (typeof gtag === 'function') { try { gtag('event', name, params || {}); } catch (e) {} }
  }

  /* one call fans out to every platform that is configured */
  function conversion(spec) {
    var eid = spec.eventId || eventId(spec.key);
    var value = spec.value || 0;
    var contents = {
      value: value,
      currency: 'ILS',
      content_name: spec.contentName || '',
      content_category: spec.contentCategory || '',
      content_type: 'product'
    };
    meta(spec.meta, contents, eid);
    tiktok(spec.tiktok || spec.meta, { value: value, currency: 'ILS', content_name: spec.contentName || '' });
    ga(spec.ga || spec.key, { value: value, currency: 'ILS', items: spec.contentName ? [{ item_name: spec.contentName }] : undefined });
    return eid;
  }

  /* ══ init ═════════════════════════════════════════════════════════════════ */

  capture();
  loadGTM();
  loadMeta();
  loadTikTok();
  loadGA4();

  /* ══ pending order ════════════════════════════════════════════════════════
     Stored before the redirect to Grow so the page the buyer comes back to
     knows what was bought and can fire a Purchase with a real value.
     ─────────────────────────────────────────────────────────────────────── */

  var PENDING = 'ishur_pending';

  function setPending(o) {
    try {
      o.at = Date.now();
      localStorage.setItem(PENDING, JSON.stringify(o));
    } catch (e) {}
  }

  function getPending() {
    try {
      var o = JSON.parse(localStorage.getItem(PENDING) || 'null');
      /* a checkout older than 6 hours is not the one that just completed */
      if (!o || Date.now() - (o.at || 0) > 6 * 3600e3) return null;
      return o;
    } catch (e) { return null; }
  }

  function clearPending() {
    try { localStorage.removeItem(PENDING); } catch (e) {}
  }

  return {
    attribution: attribution,
    setPending: setPending,
    getPending: getPending,
    clearPending: clearPending,
    eventId: eventId,
    newEventId: newEventId,
    conversion: conversion,
    meta: meta,
    tiktok: tiktok,
    ga: ga,
    capture: capture
  };
})();
