/* ishur client app · languages for the app's own screens (round 7, 21/11/2026). The board pages have their own overlay
   (assets/i18n.js on the site, by another session); the app opens them with ?lang=<code>, which that overlay reads.
   The app's screens are written in Hebrew; this swaps every Hebrew text it knows for
   the chosen language: text, placeholder, title, aria-label, button values, the page title, confirm/alert, and anything
   a page adds later. A text that still has Hebrew after the swap (a guest's, venue's or event's name) is left as it is.
   Adding a language = one line in LANGS + one file i18n/<code>.json ({ "<Hebrew>": "<translation>" }).
   Choice: ?lang=xx (the app passes it), else the one remembered on this device, else Hebrew.
   Dictionaries: app/www/i18n/<code>.json. */
(function () {
  'use strict';
  var LANGS = {
    he: { dir: 'rtl', name: 'עברית' }, en: { dir: 'ltr', name: 'English' }, ru: { dir: 'ltr', name: 'Русский' },
    ar: { dir: 'rtl', name: 'العربية' }, fr: { dir: 'ltr', name: 'Français' }, es: { dir: 'ltr', name: 'Español' },
    yi: { dir: 'rtl', name: 'ייִדיש' }, am: { dir: 'ltr', name: 'አማርኛ' }, pt: { dir: 'ltr', name: 'Português' }
  };
  var KEY = 'ishur_lang', HE = /[֐-׿]/;
  var get = function (s, k) { try { return s.getItem(k); } catch (e) { return null; } };
  var put = function (s, k, v) { try { s.setItem(k, v); } catch (e) {} };
  var q = (/[?&]lang=([a-z]{2})(?:&|$)/.exec(location.search) || [])[1];
  var lang = (q && LANGS[q]) ? q : (get(sessionStorage, KEY) || get(localStorage, KEY) || 'he');
  if (!LANGS[lang]) lang = 'he';
  if (q && LANGS[q]) { put(sessionStorage, KEY, q); put(localStorage, KEY, q); }
  var api = window.IshurI18n = {
    lang: lang, langs: LANGS, dict: null,
    set: function (l) { if (!LANGS[l]) return; put(localStorage, KEY, l); put(sessionStorage, KEY, l); },
    t: function (s) { return s; }
  };
  if (lang === 'he') return;

  var root = document.documentElement;
  root.setAttribute('lang', lang); root.setAttribute('dir', LANGS[lang].dir); root.classList.add('i18n-' + lang, 'i18n-wait');
  var st = document.createElement('style');
  st.textContent = 'html.i18n-wait body{visibility:hidden}';
  (document.head || root).appendChild(st);
  var reveal = function () { root.classList.remove('i18n-wait'); };
  setTimeout(reveal, 2500);   /* never keep the page hidden if the file is slow */

  var dict = null, frags = null, fragRe = null;
  var norm = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };
  function tr(s) {
    if (!dict || !s || !HE.test(s)) return null;
    var n = norm(s);
    if (dict[n] != null) { var lead = /^\s*/.exec(s)[0], tail = /\s*$/.exec(s)[0]; return lead + dict[n] + tail; }
    /* pieces around numbers and names: accept only if no Hebrew is left (otherwise it holds a name: leave it) */
    if (!fragRe) return null;
    var out = s.replace(fragRe, function (m) { return dict[norm(m)] != null ? dict[norm(m)] : m; });
    return out !== s && !(lang !== 'yi' && HE.test(out)) && !(lang === 'yi' && hasUntranslated(out)) ? out : null;
  }
  /* Yiddish uses Hebrew letters too, so "is anything left" asks whether a known Hebrew key is still inside */
  function hasUntranslated(s) { var m = s.match(fragRe); return !!(m && m.some(function (x) { return dict[norm(x)] != null && dict[norm(x)] !== x; })); }
  api.t = function (s) { var r = tr(s); return r == null ? s : r; };

  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function doNode(n) {
    if (n.nodeType === 3) {
      var p = n.parentElement; if (p && /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName)) return;
      if (p && p.closest && p.closest('[data-noi18n]')) return;
      var r = tr(n.nodeValue); if (r != null && r !== n.nodeValue) n.nodeValue = r;
      return;
    }
    if (n.nodeType !== 1) return;
    if (n.closest && n.closest('[data-noi18n]')) return;
    for (var i = 0; i < ATTRS.length; i++) { var v = n.getAttribute && n.getAttribute(ATTRS[i]); if (v) { var r2 = tr(v); if (r2 != null) n.setAttribute(ATTRS[i], r2); } }
    if (n.tagName === 'INPUT' && /^(button|submit)$/i.test(n.type) && n.value) { var r3 = tr(n.value); if (r3 != null) n.value = r3; }
    if (n.tagName === 'OPTION' && n.textContent) { var r4 = tr(n.textContent); if (r4 != null) n.textContent = r4; return; }
    var w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT), c;
    while ((c = w.nextNode())) {
      if (c.nodeType === 3) { doNode(c); continue; }
      for (var j = 0; j < ATTRS.length; j++) { var a = c.getAttribute(ATTRS[j]); if (a) { var ra = tr(a); if (ra != null) c.setAttribute(ATTRS[j], ra); } }
      if (c.tagName === 'INPUT' && /^(button|submit)$/i.test(c.type) && c.value) { var rv = tr(c.value); if (rv != null) c.value = rv; }
    }
  }
  function all() { if (document.body) doNode(document.body); var rt = tr(document.title); if (rt != null) document.title = rt; }

  var nc = window.confirm, na = window.alert;
  window.confirm = function (m) { return nc.call(window, api.t(String(m))); };
  window.alert = function (m) { return na.call(window, api.t(String(m))); };

  var base = (function () { var s = document.currentScript && document.currentScript.src; return s ? s.replace(/[^/]*$/, '') : ''; })();
  function start(d) {
    dict = d || {}; api.dict = dict;
    var keys = Object.keys(dict).filter(function (k) { return (k.match(/[֐-׿]/g) || []).length >= 3; })
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    fragRe = keys.length ? new RegExp(keys.join('|'), 'g') : null;
    var go = function () {
      all(); reveal();
      new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) {
          var m = ms[i];
          if (m.type === 'characterData') doNode(m.target);
          else if (m.type === 'attributes') doNode(m.target);
          else for (var k = 0; k < m.addedNodes.length; k++) doNode(m.addedNodes[k]);
        }
        var rt = tr(document.title); if (rt != null) document.title = rt;
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
  var cacheKey = 'ishur_i18n_' + lang;
  fetch(base + 'i18n/' + lang + '.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('i18n'); return r.json(); })
    .then(function (d) { put(localStorage, cacheKey, JSON.stringify(d)); start(d); })
    .catch(function () { var c = get(localStorage, cacheKey); try { start(c ? JSON.parse(c) : {}); } catch (e) { start({}); } });
})();
