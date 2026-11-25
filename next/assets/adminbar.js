/* ==========================================================================
   The management rail: one slim bar on top of every back-office page
   (next/ copy · five sections + the ☰ corner), so Richard moves between everything in one
   click — including the master sheet and Make. Injected from one file so
   adding a page later is a single script tag.
   ========================================================================== */
(function () {
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/edit#gid=1641117145';
  var MAKE_URL = 'https://eu1.make.com/577708/scenarios?folder=379970';
  /* the business rulebook lives in Linear — the single source of truth for
     rules, prices and procedures. Auth-protected, so safe to link publicly. */
  var RULES_URL = 'https://linear.app/autoscalehq/document/512a25e395bc';

  /* one icon set, one stroke weight — drawn, not emoji */
  var ic = {
    /* 16/11: each section its own icon, so the phone tab bar reads at a glance */
    sales: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.300 3.600-5 6.500-5s5.500 1.700 6.500 5"/><path d="M16 4.800a3.500 3.500 0 0 1 0 6.400"/><path d="M18.500 15.300c1.600.800 2.600 2.300 3 4.700"/></svg>',
    host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.500" y="5" width="17" height="15.500" rx="2.500"/><path d="M3.500 10h17M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M9 21V9"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5z"/></svg>',
    calls: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .8 2.9a2 2 0 0 1-.5 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.9.7 2.9.8a2 2 0 0 1 1.6 2z"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M3 15h18M12 3v18"/></svg>',
    make: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z"/></svg>',
    site: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5h5v5M19 5l-8 8M19 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-11A1.5 1.5 0 0 1 6.5 6H11"/></svg>',
    flow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3" width="7" height="5.5" rx="1.6"/><rect x="14.5" y="3" width="7" height="5.5" rx="1.6"/><rect x="8.5" y="15.5" width="7" height="5.5" rx="1.6"/><path d="M6 8.5v2.6a1.8 1.8 0 0 0 1.8 1.8h8.4A1.8 1.8 0 0 0 18 11.1V8.5M12 12.9v2.6"/></svg>',
    rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M9 7h7M9 11h7"/></svg>',
    brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4a3.5 3.5 0 0 0-3.5 3.5c-2 .4-3.5 2-3.5 4a4 4 0 0 0 2.6 3.8A3.6 3.6 0 0 0 11 20h1"/><path d="M12 4a3.5 3.5 0 0 1 3.5 3.5c2 .4 3.5 2 3.5 4a4 4 0 0 1-2.6 3.8A3.6 3.6 0 0 1 13 20h-1"/><path d="M12 4v16"/></svg>',
    ads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    ops: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="5" rx="2.5"/><circle cx="8" cy="7.5" r="1.4" fill="currentColor" stroke="none"/><rect x="3" y="14" width="18" height="5" rx="2.5"/><circle cx="16" cy="16.5" r="1.4" fill="currentColor" stroke="none"/></svg>',
  };

  /* 16/11 (Richard: "שכל דבר יהיה במקום שלו"): five sections, each with its own chooser row under the bar.
     נתונים = every number (the old "היום" + כספים) · לידים = leads, pay links, script · לקוחות (+ משוב) ·
     שליחות ושיחות = the week board, inbox, call log, live floor · יומן = the one calendar.
     שליטה, המוח and the system pages moved behind the ☰ in the corner, with the sheet, Make and the outside tools. */
  var INTERNAL = [
    { href: 'admin.html', label: 'נתונים', icon: ic.ads, sub: [
      { href: 'admin.html', label: 'סקירה' },
      { href: 'admin.html?view=money', label: 'כספים · רווח והפסד' },
      { href: 'admin.html?view=camp', label: 'קמפיינים' },
      { href: 'ad-report.html', label: 'דוח מודעות מלא' },
      { href: 'report.html', label: 'דוח תקופתי' } ] },   /* 16/11: activity + profit and loss + what needs attention, saves as a branded PDF */
    { href: 'leads.html', label: 'מכירות', icon: ic.sales, sub: [
      { href: 'leads.html', label: 'לידים' },
      { href: 'leads.html#script', label: 'תסריטי שיחה' },
      { href: 'leads.html#paylink', label: 'קישורים' },
      { href: 'clients.html#referrals', label: 'הפניות ושגרירים' },
      { href: 'team.html', label: 'מוקד' } ] },   /* 16/11: agents, shifts and who owns which WhatsApp conversation (dialling still off) */   /* 16/11 Richard: referrals belong to sales (the screen itself stays a tab of the clients page) */
    { href: 'clients.html', label: 'לקוחות', icon: ic.people, sub: [
      { href: 'clients.html', label: 'לקוחות' },
      { href: 'clients.html#designs', label: 'עיצובים' },
      { href: 'admin.html?view=feedback', label: 'משוב' } ] },
    { href: 'admin.html?view=week', label: 'שליחות ושיחות', short: 'שליחות', icon: ic.calls, sub: [
      { href: 'admin.html?view=week', label: 'השבוע' },
      { href: 'inbox.html', label: 'אינבוקס' },
      { href: 'admin.html?view=calls', label: 'יומן שיחות' },
      { href: 'floor.html', label: 'מוקד חי' } ] },
    /* 16/11 Richard: ONE journal with layers (sends, costs and profit, hostesses) and filters, instead of a calendar per subject */
    /* 16/11 evening, Richard: this screen is only hostesses now (events with and without a hostess, assignment, availability); sends live under שליחות ושיחות */
    { href: 'calendar.html', label: 'דיילות', icon: ic.host },
  ];
  /* behind the ☰: control + the system pages (same tab), then the outside tools */
  var CONTROL = [
    { href: 'admin.html?view=ctl', label: 'שליטה' },
    { href: 'brain.html', label: 'המוח' },
    { href: 'automations.html', label: 'אוטומציות' },
    { href: 'live.html', label: 'לוג חי' },
    { href: 'future.html', label: 'מה מתוכנן · שיחות חיות' },   /* 25/11 future log + live calls */
    { href: 'users.html', label: 'משתמשים והרשאות' },
    { href: 'login.html', label: 'החשבון שלי · התנתקות' },
  ];
  function keyOf(href) { var m = /[?&]view=([a-z]+)/.exec(href); return href.split('?')[0].split('#')[0].split('/').pop() + '?' + (m ? m[1] : ''); }
  var HERE = keyOf((location.pathname.split('/').pop() || 'admin.html') + location.search);
  /* a section's chooser can also point INSIDE a page (clients.html#staff, leads.html#script): the full key keeps the #part */
  function hashOf(href) { var i = String(href).indexOf('#'); return i < 0 ? '' : String(href).slice(i + 1); }
  function fullKey(href) { return keyOf(href) + '#' + hashOf(href); }
  function hereFull() { return HERE + '#' + (location.hash || '').slice(1); }
  /* a part of a page can belong to another section (referrals live on the clients page, under sales): the section that lists this exact part wins */
  function owner() { var k = hereFull(), o = null; INTERNAL.forEach(function (i) { (i.sub || []).forEach(function (x) { if (fullKey(x.href) === k) o = i; }); }); return o; }
  function isOn(item) { var o = owner(); if (o && INTERNAL.indexOf(item) >= 0) return o === item; if (keyOf(item.href) === HERE) return true; return (item.sub || []).some(function (x) { return keyOf(x.href) === HERE; }); }
  var bars = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var sun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
  var moon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  /* Richard 13/10: the rail must fit one line; the rest lives under כלים */
  var EXTERNAL = [
    { href: SHEET_URL, label: 'האקסל', icon: ic.sheet },
    { href: MAKE_URL, label: 'Make', icon: ic.make },
  ];

  /* Richard 12/10: every outside tool that keeps the product running, one
     click away — grouped behind "כלים" so the rail stays one line */
  var M = 'https://rthq-ops.monday.com/boards/';
  var TOOLS = [
    { group: 'לידים ותפעול' },
    { href: M + '18432553641', label: 'לידים · מאנדיי' },
    { href: M + '18434975667', label: 'עיצובי הזמנות · מאנדיי' },
    { href: M + '18433947622', label: 'דיילות · מאנדיי' },
    { href: 'https://linear.app/autoscalehq/project/ishurio', label: 'משימות · Linear' },
    { group: 'וואטסאפ ומטא' },
    { href: 'https://business.facebook.com/latest/whatsapp_manager/overview?business_id=2361932944259784&asset_id=1060242146337688', label: 'נועה 4499 · WhatsApp Manager' },
    { href: 'https://business.facebook.com/latest/whatsapp_manager/overview?business_id=1888051741895896', label: 'שיר 6673 · WhatsApp Manager' },
    { href: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1944903292858482', label: 'מנהל המודעות' },
    { href: 'https://business.facebook.com/latest/billing_hub/accounts?business_id=2361932944259784', label: 'חיובי מטא' },
    { group: 'שיחות וקול' },
    { href: 'https://dashboard.retellai.com/', label: 'Retell · סוכני הקול' },
    { href: 'https://portal.telnyx.com/#/app/numbers/my-numbers', label: 'Telnyx · מספרים ויתרה' },
    { href: 'https://elevenlabs.io/app/home', label: 'ElevenLabs · קולות' },
    { group: 'כסף' },
    { href: 'https://grow.business/', label: 'Grow · תשלומים' },
    { href: 'https://app.greeninvoice.co.il/', label: 'מורנינג · חשבוניות' },
    { group: 'שלנו' },
    { href: RULES_URL, label: 'החוקים · Linear' },
    { href: 'https://ishur.io', label: 'האתר' },
    { group: 'תשתית' },
    { href: 'https://dash.cloudflare.com/', label: 'Cloudflare · הוורקר' },
    { href: 'https://github.com/', label: 'GitHub · האתר' },
    { href: 'https://search.google.com/search-console', label: 'Google Search Console' },
  ];

  var css = '' +
    /* translucent chrome: content scrolls under the rail, iOS-material style */
    '.ibar{position:sticky;top:0;z-index:60;background:rgba(10,33,25,.85);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border-bottom:1px solid rgba(199,174,122,.32);flex-shrink:0}' +
    '@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.ibar{background:#0A2119}}' +
    '@media (prefers-reduced-transparency:reduce){.ibar{background:#0A2119;-webkit-backdrop-filter:none;backdrop-filter:none}}' +
    '.ibar-in{max-width:1360px;margin:0 auto;padding:0 .9rem;display:flex;align-items:stretch;gap:.25rem;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}' +
    '.ibar-in::-webkit-scrollbar{display:none}' +
    '.ibar a{display:flex;align-items:center;gap:.4rem;padding:.55rem .7rem;font-size:.78rem;color:rgba(248,244,234,.78);text-decoration:none;white-space:nowrap;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}' +
    '.ibar a svg{width:14px;height:14px;flex-shrink:0}' +
    '.ibar a:hover{color:#F8F4EA}' +
    '.ibar a:focus-visible{outline:2px solid #C7AE7A;outline-offset:-2px;border-radius:6px}' +
    '.ibar a.on{color:#C7AE7A;border-bottom-color:#A8853C;font-weight:600}' +
    '.ibar-brand{font-family:"Frank Ruhl Libre",serif;font-weight:700;font-size:.9rem!important;color:#F8F4EA!important;letter-spacing:.01em}' +
    '.ibar-brand span{color:#C7AE7A}' +
    '.ibar-sep{width:1px;background:rgba(199,174,122,.25);margin:.55rem .35rem;flex-shrink:0}' +
    '.ibar .ext svg.arrow{width:10px;height:10px;opacity:.55;margin-inline-start:-.15rem}' +
    '.ibar-more{display:none}.ibar a .ls{display:none}' +
    '.ibar-sub{max-width:1360px;margin:0 auto;padding:.55rem .9rem .45rem;display:flex;gap:.4rem;border-top:1px solid rgba(199,174,122,.18);overflow-x:auto;scrollbar-width:none}' +
    '.ibar .ibar-sub a{padding:.4rem .95rem;min-height:34px;font-size:.8rem;font-weight:600;border:1px solid rgba(199,174,122,.35);border-radius:8px;color:rgba(248,244,234,.85);background:rgba(248,244,234,.04)}' +
    '.ibar a{position:relative}.ibar-dot{position:absolute;top:-5px;inset-inline-end:-5px;min-width:17px;height:17px;padding:0 4px;border-radius:99px;background:#D8402F;color:#fff;font:700 10.5px/17px system-ui,sans-serif;font-style:normal;text-align:center;box-shadow:0 0 0 2px #0A2119}.ibar-in > a .ibar-dot{top:6px;inset-inline-end:2px}' +
    '.ibar .ibar-sub a:hover{background:rgba(248,244,234,.1)}' +
    '.ibar .ibar-sub a.on{background:#C7AE7A;border-color:#C7AE7A;color:#0A2119}' +
    /* 16/11: one chooser per section — the page's own tab strip and fold are replaced by the row under the bar */
    'body[data-page="clients.html"] .tabs{display:none}' +
    'body[data-page="leads.html"][data-sub="main"] #pbfold{display:none}' +
    'body[data-page="leads.html"][data-sub="script"] #main>:not(#pbfold),body[data-page="leads.html"][data-sub="paylink"] #main>:not(#pbfold){display:none}' +
    'body[data-page="leads.html"]:not([data-sub="main"]) #pbfold>summary{display:none!important}' +
    'body[data-page="leads.html"][data-sub="script"] #sales .plg-card,body[data-page="leads.html"][data-sub="script"] #sales h2:has(+ .plg-card){display:none}' +
    'body[data-page="leads.html"][data-sub="paylink"] #sales>:not(.plg-card):not(h2:has(+ .plg-card)){display:none}' +
    /* 16/11 Richard: the big green banner repeats the bar on every page; it stays for print (the PDF report carries the brand) */
    '@media screen{header.head{display:none!important}}' +
    '.ibar-corner{margin-inline-start:auto;display:flex;align-items:center;gap:.15rem;flex-shrink:0}' +
    '.ibar-ico{display:grid;place-items:center;width:36px;height:36px;background:none;border:1px solid transparent;border-radius:8px;color:rgba(248,244,234,.85);cursor:pointer}' +
    '.ibar-ico:hover,.ibar-ico[aria-expanded=true]{background:rgba(248,244,234,.1);color:#F8F4EA}.ibar-ico:focus-visible{outline:2px solid #C7AE7A}.ibar-ico svg{width:18px;height:18px}' +
    '.ibar-tools{display:flex;align-items:center;gap:.35rem;background:none;border:none;border-bottom:2px solid transparent;font:inherit;font-size:.78rem;color:rgba(248,244,234,.78);padding:.55rem .7rem;cursor:pointer;white-space:nowrap}' +
    '.ibar-tools:hover,.ibar-tools[aria-expanded=true]{color:#F8F4EA}' +
    '.ibar-tools svg{width:14px;height:14px}' +
    '.ibar-tmenu{display:none;position:fixed;z-index:61;background:#0F2E22;border:1px solid rgba(199,174,122,.4);border-radius:8px;padding:.35rem;box-shadow:0 8px 30px rgba(0,0,0,.35);min-width:15rem;max-height:75vh;overflow:auto}' +
    '.ibar-tmenu.on{display:block}' +
    '.ibar-tmenu .g{font-size:.66rem;letter-spacing:.06em;color:#C7AE7A;padding:.55rem .8rem .2rem}' +
    '.ibar-tmenu a,.ibar-menu .tl{display:block;padding:.5rem .8rem;font-size:.82rem;color:rgba(248,244,234,.85);text-decoration:none;border-radius:6px}' +
    '.ibar-tmenu a:hover{background:rgba(199,174,122,.12);color:#F8F4EA}' +
    '.ibar-menu{display:none;position:fixed;z-index:61;left:.6rem;bottom:calc(60px + env(safe-area-inset-bottom));background:#0F2E22;border:1px solid rgba(199,174,122,.4);border-radius:8px;padding:.3rem;box-shadow:0 8px 30px rgba(0,0,0,.35);min-width:11rem}' +
    '.ibar-menu.on{display:block}' +
    '.ibar-menu a{display:flex;align-items:center;gap:.5rem;padding:.6rem .8rem;font-size:.82rem;color:rgba(248,244,234,.85);text-decoration:none;border-radius:6px}' +
    '.ibar-menu a:active,.ibar-menu a:hover{background:rgba(199,174,122,.12);color:#F8F4EA}' +
    '.ibar-menu a svg{width:15px;height:15px}' +
    /* phone: the rail becomes an iOS-style bottom tab bar, trimmed to what a
       phone session actually needs; sheet/Make live behind "עוד" */
    /* 16/11 Richard: on a phone this is an app. A tab bar at the bottom with equal tabs (icon over a short label, the
       current one tinted), the parts of the section as a row of pills at the top, both clear of the notch and the home bar. */
    '@media (max-width:640px){' +
      '.ibar{position:fixed;top:auto;bottom:0;left:0;right:0;border-bottom:none;border-top:1px solid rgba(199,174,122,.28);padding-bottom:env(safe-area-inset-bottom);background:rgba(10,33,25,.94)}' +
      '.ibar-in{justify-content:stretch;gap:0;padding:0;overflow:visible}' +
      '.ibar a.ibar-brand,.ibar-sep,.ibar a.ext,.ibar-tools,.ibar-corner{display:none}' +
      '.ibar-more{display:flex;background:none;border:none;font:inherit;cursor:pointer}' +
      '.ibar-in > a,.ibar-more{flex:1 1 0;min-width:0;min-height:54px;justify-content:center;flex-direction:column;gap:.2rem;align-items:center;font-size:.66rem;font-weight:500;color:rgba(248,244,234,.6);padding:.4rem .1rem .3rem;border:0;-webkit-tap-highlight-color:transparent}' +
      '.ibar-in > a span,.ibar-more span{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.ibar-in > a svg,.ibar-more svg{width:23px;height:23px}' +
      '.ibar-in > a.on{color:#E2C98A;border:0}' +
      '.ibar-in > a:active,.ibar-more:active{opacity:.6}' +
      '.ibar-in > a .lf{display:none}.ibar-in > a .ls{display:inline}' +
      '.ibar .arrow{display:none}' +
      '.ibar-in > a .ibar-dot{top:4px;inset-inline-end:calc(50% - 22px)}' +
      '.ibar-subm{position:fixed;top:0;left:0;right:0;z-index:60;display:flex;max-width:none;margin:0;padding:calc(.5rem + env(safe-area-inset-top)) .75rem .5rem;gap:.4rem;background:#0A2119;border-top:none;border-bottom:1px solid rgba(199,174,122,.22);overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;font-family:Heebo,sans-serif}' +
      '.ibar-subm a{flex:0 0 auto;display:inline-flex;align-items:center;position:relative;min-height:36px;font-size:.82rem;font-weight:600;padding:0 .9rem;border:1px solid rgba(199,174,122,.35);border-radius:8px;white-space:nowrap;text-decoration:none;color:rgba(248,244,234,.85);background:rgba(248,244,234,.04)}' +
      '.ibar-subm a.on{background:#C7AE7A;border-color:#C7AE7A;color:#0A2119}' +
      'body{padding-bottom:calc(58px + env(safe-area-inset-bottom))!important}' +
      'body.has-sub{padding-top:calc(54px + env(safe-area-inset-top))!important}' +
      '.ux-toast,.wk-toast,[aria-live=polite][style*="position:fixed"]{bottom:calc(70px + env(safe-area-inset-bottom))!important}' +
      '.ibar-menu{left:0!important;right:0!important;bottom:calc(56px + env(safe-area-inset-bottom))!important;top:auto!important;width:auto!important;max-height:70vh;border-radius:8px 8px 0 0}' +
    '}';

  function link(item, current) {
    var a = document.createElement('a');
    a.href = item.href;
    var external = /^https?:/.test(item.href);
    if (external) { a.target = '_blank'; a.rel = 'noopener'; a.className = 'ext'; }
    a.innerHTML = item.icon + '<span class="lf">' + item.label + '</span><span class="ls">' + (item.short || item.label) + '</span>' +
      (external ? ic.out.replace('<svg ', '<svg class="arrow" ') : '');
    if (!external && isOn(item)) {
      a.className = 'on';
      a.setAttribute('aria-current', 'page');
    }
    return a;
  }

  /* Richard, 09/09: one login, every page, every browser on the phone.
     Pages keep the session in localStorage, which Safari and the in-app
     browsers of Slack/WhatsApp do not share — so a link opened from Slack
     asked for the code again. The session is mirrored into a cookie, which
     those in-app browsers DO share with Safari; a page that wakes up with a
     cookie and no localStorage copies it over and reloads once. */
  function syncKey() {
    var ls = null;
    try { ls = localStorage.getItem('ishur_calls_key'); } catch (e) {}
    var m = document.cookie.match(/(?:^|; )ishur_sess=([^;]+)/);
    var ck = m ? decodeURIComponent(m[1]) : '';
    if (ls && ls !== ck) {
      document.cookie = 'ishur_sess=' + encodeURIComponent(ls) + '; Max-Age=31536000; Path=/; SameSite=Lax; Secure';
    } else if (!ls && ck && !sessionStorage.getItem('ishur_keysync')) {
      try { localStorage.setItem('ishur_calls_key', ck); sessionStorage.setItem('ishur_keysync', '1'); location.reload(); } catch (e) {}
    }
  }

  function mount() {
    /* 09/11: inside center.html every page is a tab — the shell has the bar, the frame must not repeat it */
    if (/[?&]embed=1/.test(location.search)) return;
    syncKey();
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    var current = (location.pathname.split('/').pop() || 'admin.html');
    var nav = document.createElement('nav');
    nav.className = 'ibar';
    nav.setAttribute('aria-label', 'ניווט ניהול');
    var inner = document.createElement('div');
    inner.className = 'ibar-in';

    var brand = document.createElement('a');
    brand.href = 'admin.html';
    brand.className = 'ibar-brand';
    brand.innerHTML = 'ishur<span>.io</span>';
    inner.appendChild(brand);

    INTERNAL.forEach(function (i) { inner.appendChild(link(i, current)); });
    /* the left corner: ☰ (control, system pages, sheet, Make, outside tools) and the dark/light switch */
    var corner = document.createElement('div'); corner.className = 'ibar-corner';
    var theme = document.createElement('button');
    theme.type = 'button'; theme.className = 'ibar-ico';
    var isDark = function () { return document.documentElement.getAttribute('data-theme') === 'dark'; };
    var paintTheme = function () { theme.innerHTML = isDark() ? sun : moon; theme.setAttribute('aria-label', isDark() ? 'מעבר לתצוגה בהירה' : 'מעבר לתצוגה כהה'); theme.title = isDark() ? 'בהיר' : 'כהה'; };
    var flipTheme = function () {
      var dark = isDark();
      if (dark) document.documentElement.setAttribute('data-theme', 'light'); else document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('ishur_theme', dark ? 'light' : 'dark'); } catch (e) {}
      paintTheme();
    };
    theme.addEventListener('click', flipTheme); paintTheme();
    var tools = document.createElement('button');
    tools.type = 'button';
    tools.className = 'ibar-ico';
    tools.setAttribute('aria-haspopup', 'true');
    tools.setAttribute('aria-expanded', 'false');
    tools.setAttribute('aria-label', 'שליטה וכלים');
    tools.innerHTML = bars;
    corner.appendChild(theme); corner.appendChild(tools);
    inner.appendChild(corner);
    var tmenu = document.createElement('div');
    tmenu.className = 'ibar-tmenu';
    var fill = function (box) {
      var g0 = document.createElement('div'); g0.className = 'g'; g0.textContent = 'שליטה ומערכת'; box.appendChild(g0);
      CONTROL.forEach(function (t) { var a = document.createElement('a'); a.href = t.href; a.className = 'tl'; a.textContent = t.label; if (keyOf(t.href) === HERE) a.style.color = '#C7AE7A'; box.appendChild(a); });
      var g1 = document.createElement('div'); g1.className = 'g'; g1.textContent = 'גיליון ואוטומציה'; box.appendChild(g1);
      EXTERNAL.forEach(function (t) { var a = document.createElement('a'); a.href = t.href; a.target = '_blank'; a.rel = 'noopener'; a.className = 'tl'; a.textContent = t.label; box.appendChild(a); });
      TOOLS.forEach(function (t) {
        if (t.group) { var g = document.createElement('div'); g.className = 'g'; g.textContent = t.group; box.appendChild(g); return; }
        var a = document.createElement('a'); a.href = t.href; a.target = '_blank'; a.rel = 'noopener'; a.className = 'tl'; a.textContent = t.label; box.appendChild(a);
      });
    };
    fill(tmenu);
    tools.addEventListener('click', function (e) {
      e.stopPropagation();
      var r = tools.getBoundingClientRect();
      tmenu.style.top = (r.bottom + 4) + 'px';
      tmenu.style.left = Math.max(8, r.left) + 'px';
      var on = tmenu.classList.toggle('on');
      tools.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    document.addEventListener('click', function () { tmenu.classList.remove('on'); tools.setAttribute('aria-expanded', 'false'); });

    /* phone-only "עוד": the external links live behind it */
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'ibar-more';
    more.setAttribute('aria-haspopup', 'true');
    more.innerHTML = ic.more + '<span>עוד</span>';
    inner.appendChild(more);

    var menu = document.createElement('div');
    menu.className = 'ibar-menu';
    var mt = document.createElement('a'); mt.href = '#'; mt.className = 'tl'; mt.textContent = 'תצוגה כהה / בהירה'; mt.addEventListener('click', function (e) { e.preventDefault(); flipTheme(); }); menu.appendChild(mt);
    menu.style.maxHeight = '70vh'; menu.style.overflow = 'auto';
    fill(menu);

    more.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('on');
    });
    document.addEventListener('click', function () { menu.classList.remove('on'); });

    nav.appendChild(inner);
    var sec = INTERNAL.filter(function (i) { return i.sub && isOn(i); })[0];
    var PHONE = window.matchMedia ? matchMedia('(max-width:640px)') : { matches: false };
    var DOTS = {};   /* part of a page -> how many things wait there (a red dot on its button and on its section) */
    var paintDots = function () {
      [].forEach.call(nav.querySelectorAll('.ibar-dot'), function (d) { d.remove(); });
      var dot = function (a, n) { var d = document.createElement('i'); d.className = 'ibar-dot'; d.textContent = n > 9 ? '9+' : String(n); d.setAttribute('aria-label', n + ' ממתינים'); a.appendChild(d); };
      var tops = inner.querySelectorAll(':scope > a:not(.ibar-brand)');
      INTERNAL.forEach(function (i, ix) { var sum = 0; (i.sub || []).forEach(function (x) { sum += DOTS[fullKey(x.href)] || 0; }); if (sum && tops[ix]) dot(tops[ix], sum); });
      [].forEach.call(document.querySelectorAll('.ibar-sub a'), function (a) { var n = DOTS[a.dataset.k] || 0; if (n) dot(a, n); });
    };
    var buildRow = function () {
      var old = document.querySelector('.ibar-sub'); if (old) old.remove();
      document.body.classList.toggle('has-sub', !!sec);
      if (!sec) return;
      var row = document.createElement('div'); row.className = 'ibar-sub';
      sec.sub.forEach(function (x) { var a = document.createElement('a'); a.href = x.href; a.textContent = x.label; a.dataset.k = fullKey(x.href); row.appendChild(a); });
      /* on a phone the row lives outside the bar: the bar's blur makes it the anchor of anything fixed inside it, and the row belongs at the top of the screen */
      if (PHONE.matches) { row.className = 'ibar-sub ibar-subm'; document.body.appendChild(row); } else nav.appendChild(row);
    };
    buildRow();
    /* which part of the page is showing: body[data-sub] drives the page CSS below, and the chooser follows the #part */
    var page = (location.pathname.split('/').pop() || 'admin.html');
    if (page === 'leads-new.html') page = 'leads.html';   /* same in-page parts (list / script / pay links) */
    document.body.dataset.page = page;
    var syncSub = function () {
      var h = (location.hash || '').slice(1);
      document.body.dataset.sub = h || 'main';
      var k = hereFull();
      var now = INTERNAL.filter(function (i) { return i.sub && isOn(i); })[0];
      if (now !== sec) { sec = now; buildRow(); var tops = inner.querySelectorAll(':scope > a:not(.ibar-brand)'); INTERNAL.forEach(function (i, ix) { if (!tops[ix]) return; var on = i === sec; tops[ix].classList.toggle('on', on); if (on) tops[ix].setAttribute('aria-current', 'page'); else tops[ix].removeAttribute('aria-current'); }); }
      [].forEach.call(document.querySelectorAll('.ibar-sub a'), function (a) { var on = a.dataset.k === k; a.className = on ? 'on' : ''; if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      paintDots();
      if (page === 'clients.html') { var tb = document.querySelector('.tab[data-tab="' + (h || 'clients') + '"]'); if (tb && tb.getAttribute('aria-selected') !== 'true') tb.click(); if (location.hash.slice(1) !== h) { try { history.replaceState(null, '', h ? '#' + h : location.pathname + location.search); } catch (e) {} } }
      if (page === 'leads.html') { var f = document.getElementById('pbfold'); if (f && (h === 'script' || h === 'paylink')) f.open = true; }
    };
    window.addEventListener('hashchange', syncSub);
    if (PHONE.addEventListener) PHONE.addEventListener('change', function () { buildRow(); syncSub(); });
    /* the notch and the home bar: without viewport-fit=cover the safe-area insets are always 0 */
    try { var vp = document.querySelector('meta[name=viewport]'); if (vp && !/viewport-fit/.test(vp.content)) vp.content += ', viewport-fit=cover'; } catch (e) {}
    syncSub();
    /* what waits for us: designs a client asked for and nobody sent yet (asked at most once every two minutes) */
    (function () {
      var show = function (n) { DOTS[fullKey('clients.html#designs')] = Number(n) || 0; paintDots(); };
      try { var c = JSON.parse(sessionStorage.getItem('ishur_dots') || 'null'); if (c && Date.now() - c.t < 120000) { show(c.dz); return; } } catch (e) {}
      var cfg = window.ISHUR_CONFIG, k = ''; try { k = localStorage.getItem('ishur_calls_key') || ''; } catch (e) {}
      if (!cfg || !cfg.endpoint || !k) return;
      fetch(cfg.endpoint('design-list'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: k }) }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) return; try { sessionStorage.setItem('ishur_dots', JSON.stringify({ t: Date.now(), dz: d.waiting || 0 })); } catch (e) {} show(d.waiting || 0);
      }).catch(function () {});
    })();
    document.body.insertBefore(nav, document.body.firstChild);
    document.body.appendChild(menu);
    document.body.appendChild(tmenu);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

/* 16/11 sign-in guard (auth.js on the Worker): once sign-in is required, a page opened without a Google session goes to the
   login page and comes back after it; a session that expires mid-work does the same on its next request. */
(function () {
  try {
    var here = location.pathname.split('/').pop();
    if (here === 'login.html' || /[?&]embed=1/.test(location.search)) return;
    var API = (window.ISHUR_CONFIG && window.ISHUR_CONFIG.endpoint) ? window.ISHUR_CONFIG.endpoint('status').replace(/\/api\/status$/, '') : 'https://go.ishur.io';
    var gone = false, toLogin = function () { if (gone) return; gone = true; location.replace('/next/login.html?back=' + encodeURIComponent(location.pathname + location.search + location.hash)); };
    var of = window.fetch;
    if (of) window.fetch = function () { return of.apply(this, arguments).then(function (r) { if (r && r.status === 401) { try { r.clone().json().then(function (j) { if (j && j.error === 'login-required') toLogin(); }).catch(function () {}); } catch (e) {} } return r; }); };
    (of || fetch)(API + '/api/auth/config').then(function (r) { return r.json(); }).then(function (c) {
      var k = ''; try { k = localStorage.getItem('ishur_calls_key') || ''; } catch (e) {}
      /* 16/11: nobody types a key any more. With no key at all the old "מפתח גישה" box is replaced by the sign-in page (on the real site only). */
      if (c && c.configured && !k && /(^|\.)ishur\.io$/.test(location.hostname)) { toLogin(); return; }
      if (!c || !c.enforce) return;
      if (!/^us\./.test(k)) toLogin();
    }).catch(function () {});
  } catch (e) {}
})();

/* 16/11 the full per-user log (Richard: "מי לחץ מה, כל דבר"): every screen a signed-in user opens and every button or link
   they press goes to the action log under their Google account. Sent in small batches; nothing is sent without a Google session. */
(function () {
  try {
    var k = ''; try { k = localStorage.getItem('ishur_calls_key') || ''; } catch (e) {}
    if (!/^us\./.test(k) || location.pathname.split('/').pop() === 'login.html') return;
    var API = (window.ISHUR_CONFIG && window.ISHUR_CONFIG.endpoint) ? window.ISHUR_CONFIG.endpoint('status').replace(/\/api\/status$/, '') : 'https://go.ishur.io';
    var q = [], where = function () { return (location.pathname.split('/').pop() || 'admin.html') + location.search.replace(/([?&])(key|k|t|token)=[^&]*/gi, '$1$2=…') + location.hash; };
    var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').replace(/\+?\d[\d\- ]{7,}\d/g, '…').trim().slice(0, 60); };
    var add = function (a) { if (q.length < 60) q.push({ a: a, p: where().slice(0, 110) }); };
    var flush = function (last) { if (!q.length) return; var items = q.splice(0, 30); try { fetch(API + '/api/auth/track', { method: 'POST', keepalive: !!last, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k, items: items }) }).catch(function () {}); } catch (e) {} };
    add('פתח מסך'); window.addEventListener('hashchange', function () { add('עבר לחלק'); });
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('button,a,summary,[role=button],[role=tab],input[type=checkbox],input[type=radio],label.btn') : null; if (!el) return;
      var t = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.name || el.id);
      add('לחץ: ' + (t || el.tagName.toLowerCase()));
    }, true);
    document.addEventListener('change', function (e) { var el = e.target; if (el && el.tagName === 'SELECT') add('בחר: ' + clean(el.getAttribute('aria-label') || el.name || el.id) + ' = ' + clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text)); }, true);
    setInterval(function () { flush(false); }, 8000); setTimeout(function () { flush(false); }, 1500);
    window.addEventListener('pagehide', function () { flush(true); });
  } catch (e) {}
})();

/* 16/11 Richard: every user is greeted by their own name. The signed-in user's name is read once per tab and kept in
   sessionStorage (ishur_me); a page that shows a greeting (#hello with data-greet) is filled in when it arrives. */
(function () {
  try {
    var k = ''; try { k = localStorage.getItem('ishur_calls_key') || ''; } catch (e) {}
    if (!/^us\./.test(k)) return;
    var put = function (m) { var h = document.getElementById('hello'); if (h && h.dataset.greet && m && m.name) h.textContent = h.dataset.greet + ', ' + m.name; };
    var c = null; try { c = JSON.parse(sessionStorage.getItem('ishur_me') || 'null'); } catch (e) {}
    if (c && c.k === k.slice(-12)) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { put(c); }); else put(c); return; }
    var API = (window.ISHUR_CONFIG && window.ISHUR_CONFIG.endpoint) ? window.ISHUR_CONFIG.endpoint('status').replace(/\/api\/status$/, '') : 'https://go.ishur.io';
    fetch(API + '/api/auth/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k }) }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok || !j.user) return; var m = { name: String(j.user.name || '').slice(0, 40), email: j.user.email, k: k.slice(-12) };
      try { sessionStorage.setItem('ishur_me', JSON.stringify(m)); } catch (e) {} put(m); setTimeout(function () { put(m); }, 1500);
    }).catch(function () {});
  } catch (e) {}
})();

/* 25/11 the team panel (משימות צוות, on the left) and the role-based menu: one file for both bars */
(function () {
  try {
    if (/[?&]embed=1/.test(location.search) || document.querySelector('script[data-teampanel]')) return;
    if (!window.IshurRec && !document.querySelector('script[src*="rec-player.js"]')) { var rp = document.createElement('script'); rp.src = '/assets/rec-player.js?v=3'; rp.defer = true; document.head.appendChild(rp); }   /* 26/11: our player replaces every <audio controls> */
    var s = document.createElement('script'); s.src = '/assets/teampanel.js?v=3'; s.defer = true; s.setAttribute('data-teampanel', '1');
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
