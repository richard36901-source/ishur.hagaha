/* ==========================================================================
   The management rail: one slim bar on top of every back-office page
   (admin / inbox / calls), so Richard moves between everything in one
   click — including the master sheet and Make. Injected from one file so
   adding a page later is a single script tag.
   ========================================================================== */
(function () {
  var SHEET_URL = 'https://docs.google.com/spreadsheets/d/1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q/edit#gid=1641117145';
  var MAKE_URL = 'https://eu1.make.com/577708/scenarios?folder=379970';

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
  };

  var INTERNAL = [
    { href: 'admin.html', label: 'מרכז הבקרה', icon: ic.board },
    { href: 'inbox.html', label: 'אינבוקס', icon: ic.inbox },
    { href: 'calls.html', label: 'מוקד שיחות', icon: ic.calls },
  ];
  var EXTERNAL = [
    { href: SHEET_URL, label: 'האקסל', icon: ic.sheet },
    { href: MAKE_URL, label: 'Make', icon: ic.make },
    { href: 'https://ishur.io', label: 'האתר', icon: ic.site },
  ];

  var css = '' +
    '.ibar{position:sticky;top:0;z-index:60;background:#0A2119;border-bottom:1px solid rgba(199,174,122,.32);flex-shrink:0}' +
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
      '.ibar a.ibar-brand,.ibar-sep,.ibar a.ext{display:none}' +
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
    if (!external && current === item.href) {
      a.className = 'on';
      a.setAttribute('aria-current', 'page');
    }
    return a;
  }

  function mount() {
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

    more.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('on');
    });
    document.addEventListener('click', function () { menu.classList.remove('on'); });

    nav.appendChild(inner);
    document.body.insertBefore(nav, document.body.firstChild);
    document.body.appendChild(menu);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
