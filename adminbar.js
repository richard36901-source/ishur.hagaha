/* ==========================================================================
   The management rail: one slim bar on top of every back-office page
   (admin / inbox / calls), so Richard moves between everything in one
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

  var INTERNAL = [
    { href: 'hq.html', label: 'HQ', icon: ic.board },
    { href: 'admin.html', label: 'מרכז הבקרה', icon: ic.board },
    { href: 'clients.html', label: 'לקוחות', icon: ic.board },
    { href: 'leads.html', label: 'לידים', icon: ic.board },
    { href: 'inbox.html', label: 'אינבוקס', icon: ic.inbox },
    { href: 'calendar.html', label: 'לוח שליחות', icon: ic.calls },
    { href: 'admin.html?view=calls', label: 'מוקד שיחות', icon: ic.calls },
    { href: 'automations.html', label: 'אוטומציות', icon: ic.flow },
    { href: 'brain.html', label: 'המוח', icon: ic.brain },
    { href: 'ops.html', label: 'שליטה', icon: ic.ops },
    { href: 'ad-report.html', label: 'דוח קמפיין', icon: ic.ads },
  ];
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
    '.ibar-more{display:none}' +
    '.ibar-tools{display:flex;align-items:center;gap:.35rem;background:none;border:none;border-bottom:2px solid transparent;font:inherit;font-size:.78rem;color:rgba(248,244,234,.78);padding:.55rem .7rem;cursor:pointer;white-space:nowrap}' +
    '.ibar-tools:hover,.ibar-tools[aria-expanded=true]{color:#F8F4EA}' +
    '.ibar-tools svg{width:14px;height:14px}' +
    '.ibar-tmenu{display:none;position:fixed;z-index:61;background:#0F2E22;border:1px solid rgba(199,174,122,.4);border-radius:14px;padding:.35rem;box-shadow:0 8px 30px rgba(0,0,0,.35);min-width:15rem;max-height:75vh;overflow:auto}' +
    '.ibar-tmenu.on{display:block}' +
    '.ibar-tmenu .g{font-size:.66rem;letter-spacing:.06em;color:#C7AE7A;padding:.55rem .8rem .2rem}' +
    '.ibar-tmenu a,.ibar-menu .tl{display:block;padding:.5rem .8rem;font-size:.82rem;color:rgba(248,244,234,.85);text-decoration:none;border-radius:10px}' +
    '.ibar-tmenu a:hover{background:rgba(199,174,122,.12);color:#F8F4EA}' +
    '.ibar-menu{display:none;position:fixed;z-index:61;left:.6rem;bottom:calc(60px + env(safe-area-inset-bottom));background:#0F2E22;border:1px solid rgba(199,174,122,.4);border-radius:14px;padding:.3rem;box-shadow:0 8px 30px rgba(0,0,0,.35);min-width:11rem}' +
    '.ibar-menu.on{display:block}' +
    '.ibar-menu a{display:flex;align-items:center;gap:.5rem;padding:.6rem .8rem;font-size:.82rem;color:rgba(248,244,234,.85);text-decoration:none;border-radius:10px}' +
    '.ibar-menu a:active,.ibar-menu a:hover{background:rgba(199,174,122,.12);color:#F8F4EA}' +
    '.ibar-menu a svg{width:15px;height:15px}' +
    /* phone: the rail becomes an iOS-style bottom tab bar, trimmed to what a
       phone session actually needs; sheet/Make live behind "עוד" */
    '@media (max-width:640px){' +
      '.ibar{position:fixed;top:auto;bottom:0;left:0;right:0;border-bottom:none;border-top:1px solid rgba(199,174,122,.35);padding-bottom:env(safe-area-inset-bottom)}' +
      '.ibar-in{justify-content:space-around;gap:0;padding:0 .3rem}' +
      '.ibar a.ibar-brand,.ibar-sep,.ibar a.ext,.ibar-tools{display:none}' +
      '.ibar-more{display:flex;background:none;border:none;font:inherit;cursor:pointer}' +
      '.ibar a,.ibar-more{flex-direction:column;gap:.18rem;align-items:center;font-size:.6rem;color:rgba(248,244,234,.75);padding:.45rem .5rem .35rem;border-bottom:none;border-top:2px solid transparent}' +
      '.ibar a svg,.ibar-more svg{width:19px;height:19px}' +
      '.ibar a.on{border-top-color:#A8853C;border-bottom-color:transparent}' +
      '.ibar .arrow{display:none}' +
      'body{padding-bottom:calc(62px + env(safe-area-inset-bottom))!important}' +
    '}';

  function link(item, current) {
    var a = document.createElement('a');
    a.href = item.href;
    var external = /^https?:/.test(item.href);
    if (external) { a.target = '_blank'; a.rel = 'noopener'; a.className = 'ext'; }
    a.innerHTML = item.icon + '<span>' + item.label + '</span>' +
      (external ? ic.out.replace('<svg ', '<svg class="arrow" ') : '');
    if (!external && current === item.href.split('?')[0] && (item.href.indexOf('?view=calls') > -1) === (location.search.indexOf('view=calls') > -1)) {
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
    var sep = document.createElement('div');
    sep.className = 'ibar-sep';
    inner.appendChild(sep);
    EXTERNAL.forEach(function (i) { inner.appendChild(link(i, current)); });

    var tools = document.createElement('button');
    tools.type = 'button';
    tools.className = 'ibar-tools';
    tools.setAttribute('aria-haspopup', 'true');
    tools.setAttribute('aria-expanded', 'false');
    tools.innerHTML = ic.ops + '<span>כלים</span>';
    inner.appendChild(tools);
    var tmenu = document.createElement('div');
    tmenu.className = 'ibar-tmenu';
    var fill = function (box) {
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
      tmenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
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
    EXTERNAL.forEach(function (i) { menu.appendChild(link(i, current)); });
    menu.style.maxHeight = '70vh'; menu.style.overflow = 'auto';
    fill(menu);

    more.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('on');
    });
    document.addEventListener('click', function () { menu.classList.remove('on'); });

    nav.appendChild(inner);
    document.body.insertBefore(nav, document.body.firstChild);
    document.body.appendChild(menu);
    document.body.appendChild(tmenu);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
