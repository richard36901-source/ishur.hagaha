/* ishur.io · structured pay-link generator (03/11, pay links v2).
   Admin picks package, records and add-ons; the Worker prices it (POST
   /api/pay-link with records → server sum) and returns a Grow link. The live
   total here is a preview mirroring the same tables; the server's number is
   the one on the link. No native selects/checkboxes: dropdowns and toggles
   are buttons. Usage: IshurPayLinkGen.mount(containerId, adminKey). */
(function (root) {
  var RATES = { msg: 0.30, call: 2, base: 20 };   /* worker ADDON_RATES */
  var PLAN_HE = { basic: 'בסיס', pro: 'פרמיום', premium: 'הכל כלול' };
  var CALLS_INCLUDED = { pro: 1, premium: 1 };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hostessPrices(cfg) {
    var out = {}; ((cfg.HOSTESS && cfg.HOSTESS.tiers) || []).forEach(function (t) { out[t.count] = t.price; }); return out;
  }
  function travelFor(cfg, n) { return cfg.HOSTESS && cfg.HOSTESS.travelFor ? cfg.HOSTESS.travelFor(n) : (n >= 2 ? 500 : 250); }
  function tiers(cfg) { return Object.keys(cfg.PRICE_TABLE || {}).map(Number).sort(function (a, b) { return a - b; }); }

  /* Richard 03/11 20:20 (final rules, same as worker/paylink.js priceQuote):
     hostesses → ALWAYS the bundle (הכל כלול + hostesses, one price; "בלי שיחות"
     keeps the price, plan basic). Up to 700: 1 ₪1,790 / 2 ₪1,990; above 700:
     2 ₪2,390 / 3 ₪2,590. Design and calls inside a bundle are "כלול" ₪0. */
  function bundleTable(cfg, records) { return cfg.bundleTable ? cfg.bundleTable(records) : (Number(records) > 700 ? { 2: 2390, 3: 2590 } : { 1: 1790, 2: 1990 }); }
  function coerce(cfg, records, n) {
    n = Number(n) || 0; if (!n) return { n: 0, note: '' };
    if (bundleTable(cfg, records)[n]) return { n: n, note: '' };
    return { n: 2, note: Number(records) > 700 ? 'מעל 700 רשומות: מינימום 2 דיילות' : '3 דיילות רק מעל 700 רשומות: עודכן ל-2' };
  }
  function price(s, cfg) {
    var lines = [], pt = (cfg.PRICE_TABLE || {})[s.records];
    if (!pt) return { lines: [], total: 0 };
    var co = coerce(cfg, s.records, s.hostesses), h = co.n;
    var b = h && cfg.bundlePick ? cfg.bundlePick(s.records, h) : null;
    var wave = Math.ceil(RATES.msg * s.records + RATES.base);
    if (b) {
      var hl = h === 1 ? 'דיילת אחת' : h + ' דיילות', plan = s.no_calls ? 'basic' : 'premium';
      lines.push({ label: s.records + ' רשומות · ' + (s.no_calls ? 'חבילה + דיילות, בלי שיחות (' + hl + ')' : 'הכל כלול + ' + hl), price: b.total });
      if (s.design) lines.push({ label: 'עיצוב ההזמנה במתנה', price: 0, incl: true });
      if (s.travel) lines.push({ label: 'נסיעות דיילות', price: b.travel != null ? b.travel : travelFor(cfg, h) });
      if (s.extra_wave) lines.push({ label: 'גל תזכורת שלישי', price: wave });
      return { lines: lines, total: lines.reduce(function (a, l) { return a + l.price; }, 0), bundle: cfg.bundleKeyOf ? cfg.bundleKeyOf(b) : 'bundle', bundleTotal: b.total, plan: plan, hostesses: h, note: co.note };
    }
    if (!pt[s.plan]) return { lines: [], total: 0 };
    lines.push({ label: s.records + ' רשומות ' + PLAN_HE[s.plan], price: pt[s.plan] });
    if (s.design) lines.push({ label: 'עיצוב הזמנה', price: cfg.DESIGN_PRICE || 79 });
    var hp = hostessPrices(cfg);
    if (h && hp[h]) lines.push({ label: h === 1 ? 'דיילת אחת' : h + ' דיילות', price: hp[h] });
    if (s.travel && h) lines.push({ label: 'נסיעות דיילות', price: travelFor(cfg, h) });
    if (s.extra_wave) lines.push({ label: 'גל תזכורת שלישי', price: wave });
    if (s.calls && !CALLS_INCLUDED[s.plan]) lines.push({ label: 'שיחות AI למי שלא ענה', price: Math.ceil(RATES.call * s.records + RATES.base) });
    return { lines: lines, total: lines.reduce(function (a, l) { return a + l.price; }, 0), plan: s.plan, hostesses: h, note: co.note };
  }
  function phoneOk(p) { var d = String(p || '').replace(/\D/g, ''); return /^05\d{8}$/.test(d) || /^9725\d{8}$/.test(d); }
  function problems(s) {
    var out = [];
    if (String(s.name || '').trim().length < 2) out.push('שם לקוח');
    if (!phoneOk(s.phone)) out.push('טלפון נייד ישראלי');
    if (!s.occasion) out.push('סוג אירוע');
    if (s.event_date && !/^\d{4}-\d{2}-\d{2}$/.test(s.event_date)) out.push('תאריך');
    return out;
  }
  function waText(link) { return 'היי, בהמשך לשיחה שלנו, זה הקישור לתשלום: ' + link; }
  function waHref(phone, link) {
    var d = String(phone || '').replace(/\D/g, ''); if (/^0/.test(d)) d = '972' + d.slice(1);
    return 'https://wa.me/' + d + '?text=' + encodeURIComponent(waText(link));
  }

  /* 03/11 layout (Richard): ONE card, form-like. One field per row, label above, aligned widths:
     name → phone → occasion → date → package → records → add-ons (checklist, price at the row end)
     → total (big) → one filled primary action. Secondary buttons are quiet tinted, 44px, radius 10. */
  function dd(id, label, value, opts, open) {
    var cur = opts.filter(function (o) { return String(o.v) === String(value); })[0];
    return '<div class="plg-f plg-dd' + (open ? ' open' : '') + '"><span class="lbl" id="plg-l-' + id + '">' + esc(label) + '</span>' +
      '<button type="button" class="plg-ddb" data-dd="' + id + '" aria-haspopup="listbox" aria-labelledby="plg-l-' + id + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + esc(cur ? cur.t : 'בחירה') + '</button>' +
      (open ? '<div class="plg-ddl" role="listbox">' + opts.map(function (o) {
        return '<button type="button" role="option" aria-selected="' + (String(o.v) === String(value)) + '" data-set="' + id + '" data-v="' + esc(o.v) + '"' + (o.off ? ' disabled' : '') + '>' + esc(o.t) + '</button>';
      }).join('') + '</div>' : '') + '</div>';
  }
  function tg(key, label, on, extra, off) {
    return '<button type="button" class="plg-tg' + (on ? ' on' : '') + '" role="checkbox" aria-checked="' + (!!on) + '" data-tg="' + key + '"' + (off ? ' disabled' : '') + '>' +
      '<span class="box" aria-hidden="true">' + (on ? '✓' : '') + '</span><span class="t">' + esc(label) + '</span><b>' + esc(extra || '') + '</b></button>';
  }
  function money(n) { return '₪' + Number(n || 0).toLocaleString('he-IL'); }
  function field(label, html) { return '<label class="plg-f"><span class="lbl">' + esc(label) + '</span>' + html + '</label>'; }

  function render(s, cfg) {
    var pr = price(s, cfg), hp = hostessPrices(cfg), recs = tiers(cfg);
    var occ = (cfg.OCCASIONS || []).map(function (o) { return { v: o.value, t: o.label }; });
    var bt = bundleTable(cfg, s.records), big = Number(s.records) > 700;
    var hostOpts = [0, 1, 2, 3].map(function (n) {
      return { v: n, t: n === 0 ? 'בלי דיילות' : (n === 1 ? 'דיילת אחת' : n + ' דיילות') + (bt[n] ? ' · הכל כלול ' + money(bt[n]) : (n === 3 ? ' · רק מעל 700 רשומות' : ' · מעל 700 מינימום 2')), off: n > 0 && !bt[n] };
    });
    var inB = !!pr.bundle;
    var miss = problems(s);
    var wave = Math.ceil(RATES.msg * s.records + RATES.base), callsP = Math.ceil(RATES.call * s.records + RATES.base);
    return '<div class="plg">' +
      field('שם הלקוח *', '<input data-in="name" value="' + esc(s.name) + '" autocomplete="off">') +
      field('טלפון *', '<input data-in="phone" inputmode="tel" dir="ltr" placeholder="05X-XXXXXXX" value="' + esc(s.phone) + '">') +
      dd('occasion', 'סוג אירוע *', s.occasion, occ, s.open === 'occasion') +
      field('תאריך האירוע (לא חובה)', '<input data-in="event_date" type="date" value="' + esc(s.event_date) + '">') +
      (inB ? '<div class="plg-f"><span class="lbl">חבילה</span><div class="plg-list">' + tg('no_calls', 'בלי שיחות בכלל (אותו מחיר, חבילת בסיס)', s.no_calls, s.no_calls ? 'חבילה + דיילות' : 'הכל כלול') + '</div></div>'
        : dd('plan', 'חבילה', s.plan, ['basic', 'pro', 'premium'].map(function (k) { return { v: k, t: PLAN_HE[k] }; }), s.open === 'plan')) +
      dd('records', 'רשומות', s.records, recs.map(function (n) { return { v: n, t: 'עד ' + n + ' רשומות' }; }), s.open === 'records') +
      '<div class="plg-f"><span class="lbl">תוספות</span><div class="plg-list">' +
        '<div class="plg-li">' + dd('hostesses', 'דיילות באירוע', s.hostesses, hostOpts, s.open === 'hostesses') + '<b>' + (inB ? money(pr.bundleTotal) : (s.hostesses && hp[s.hostesses] ? money(hp[s.hostesses]) : '')) + '</b></div>' +
        (pr.note ? '<div class="plg-li"><span class="plg-miss">' + esc(pr.note) + '</span></div>' : '') +
        tg('design', inB ? 'עיצוב ההזמנה במתנה' : 'עיצוב הזמנה', s.design, inB ? 'כלול · ' + money(0) : money(cfg.DESIGN_PRICE || 79)) +
        tg('travel', 'נסיעות (מחוץ למרכז)', s.travel && s.hostesses, s.hostesses ? money(inB && cfg.bundlePick(s.records, pr.hostesses).travel != null ? cfg.bundlePick(s.records, pr.hostesses).travel : travelFor(cfg, pr.hostesses || s.hostesses)) : 'רק עם דיילות', !s.hostesses) +
        tg('extra_wave', 'גל תזכורת שלישי', s.extra_wave, money(wave)) +
        (inB ? (s.no_calls ? '' : tg('calls', 'סבב שיחות AI', false, 'כלול · ' + money(0), true))
          : tg('calls', 'סבב שיחות AI', s.calls && !CALLS_INCLUDED[s.plan], CALLS_INCLUDED[s.plan] ? 'כלול בחבילה' : money(callsP), !!CALLS_INCLUDED[s.plan])) +
      '</div></div>' +
      '<div class="plg-sum">' + pr.lines.map(function (l) { return '<div><span>' + esc(l.label) + '</span><span>' + money(l.price) + '</span></div>'; }).join('') +
        '<div class="tot"><span>סה"כ</span><span>' + money(pr.total) + '</span></div>' +
        '<div class="note">הסכום הסופי מחושב בשרת מאותן טבלאות</div></div>' +
      '<div class="plg-act">' +
        '<button type="button" class="plg-btn p" data-plg="make"' + (miss.length || s.busy ? ' disabled' : '') + '>' + (s.busy ? 'יוצר…' : 'צור קישור') + '</button>' +
        (miss.length ? '<span class="plg-miss">חסר: ' + esc(miss.join(', ')) + '</span>' : '') +
        (s.err ? '<span class="plg-miss">' + esc(s.err) + '</span>' : '') +
      '</div>' +
      (s.url ? '<div class="plg-out"><div class="u">' + esc(s.url) + '</div>' +
        '<div class="d">' + esc(s.desc || '') + ' · ' + money(s.serverSum) + '</div>' +
        '<div class="plg-act"><button type="button" class="plg-btn" data-plg="copy">' + (s.copied ? '✓ הועתק' : 'העתקת קישור') + '</button>' +
        '<a class="plg-btn" data-plg="wa" target="_blank" rel="noopener" href="' + esc(waHref(s.phone, s.url)) + '">שליחה בוואטסאפ ללקוח</a></div></div>' : '') +
      '</div>';
  }

  /* tokens = the ishur.io brand set (assets/ops/ops.css :root), with the admin pages' own vars as fallbacks */
  var CSS = '.plg-card{--b:var(--pine,#0F4C35);--b2:#0A3826;--b4:#F3F8F5;--ln:var(--line,#E1E4DE);--r:10px;background:var(--card,#fff);border:1px solid var(--ln);border-radius:14px;padding:1.1rem 1.2rem;margin-top:.5rem;box-shadow:0 1px 3px rgba(15,46,34,.05),0 14px 40px rgba(15,46,34,.06);display:flex;flex-direction:column;gap:1.2rem}' +
    'html[data-theme=dark] .plg-card{--b2:#7BC9A4;--b4:#132B20}' +
    '.plg{display:flex;flex-direction:column;gap:.95rem;max-width:34rem}' +
    '.plg .lbl{display:block;font-size:.78rem;font-weight:600;color:var(--ink2,#4E5C55);margin-bottom:.35rem}' +
    '.plg-f{display:flex;flex-direction:column;position:relative}' +
    '.plg-f input,.plg-ddb{font:inherit;font-size:.92rem;height:44px;padding:0 .8rem;border:1px solid var(--ln);border-radius:var(--r);background:var(--card,#fff);color:var(--ink,#1B2620);width:100%;box-sizing:border-box}' +
    '.plg-f input:focus,.plg-ddb:focus-visible{outline:none;border-color:var(--b);box-shadow:0 0 0 3px rgba(15,76,53,.12)}' +
    '.plg-ddb{text-align:start;cursor:pointer;display:flex;align-items:center;justify-content:space-between}.plg-ddb::after{content:"";width:7px;height:7px;border:solid var(--ink3,#7F8C86);border-width:0 1.5px 1.5px 0;transform:rotate(45deg) translateY(-2px)}' +
    '.plg-ddl{position:absolute;z-index:20;inset-inline:0;top:100%;margin-top:.25rem;background:var(--card,#fff);border:1px solid var(--ln);border-radius:var(--r);box-shadow:0 8px 28px rgba(0,0,0,.12);display:flex;flex-direction:column;max-height:16rem;overflow:auto;padding:.25rem}' +
    '.plg-ddl button{font:inherit;font-size:.88rem;text-align:start;min-height:40px;padding:0 .7rem;border:0;border-radius:8px;background:none;color:var(--ink,#1B2620);cursor:pointer;white-space:nowrap}.plg-ddl button[aria-selected=true]{font-weight:700;color:var(--b)}.plg-ddl button:hover{background:var(--b4)}.plg-ddl button:disabled{opacity:.45;cursor:not-allowed}' +
    '.plg-list{border:1px solid var(--ln);border-radius:12px;overflow:visible}' +
    '.plg-li,.plg-tg{display:grid;grid-template-columns:1fr auto;align-items:center;gap:.8rem;min-height:52px;padding:.4rem .9rem;border-bottom:1px solid var(--ln)}' +
    '.plg-li .plg-dd .lbl{margin-bottom:.2rem}.plg-li b,.plg-tg b{font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink2,#4E5C55);min-width:4.5rem;text-align:end}' +
    '.plg-tg{grid-template-columns:auto 1fr auto;width:100%;font:inherit;font-size:.92rem;border:0;border-bottom:1px solid var(--ln);background:none;color:var(--ink,#1B2620);cursor:pointer;text-align:start}.plg-tg:last-child{border-bottom:0}.plg-tg:hover:not(:disabled){background:var(--b4)}' +
    '.plg-tg .box{width:1.25rem;height:1.25rem;border:1.5px solid var(--ln);border-radius:6px;display:inline-grid;place-items:center;font-size:.75rem}.plg-tg.on .box{background:var(--b);color:#fff;border-color:var(--b)}.plg-tg:disabled{opacity:.55;cursor:default}' +
    '.plg-sum{font-size:.86rem;display:flex;flex-direction:column;gap:.25rem}.plg-sum div{display:flex;justify-content:space-between;gap:1rem;color:var(--ink2,#4E5C55)}' +
    '.plg-sum .tot{color:var(--ink,#1B2620);font-weight:600;font-size:1rem;align-items:baseline;border-top:2px solid var(--ln);padding-top:.6rem;margin-top:.35rem;font-variant-numeric:tabular-nums}.plg-sum .tot span:last-child{font-family:Rubik,inherit;font-size:1.9rem;letter-spacing:-.02em}.plg-sum .note{font-size:.72rem;color:var(--ink3,#7F8C86)}' +
    '.plg-act{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}' +
    '.plg-btn,.plg-card .sbtn{font:inherit;font-size:.9rem;font-weight:600;height:44px;padding:0 1.1rem;border-radius:var(--r);border:1px solid rgba(15,76,53,.2);background:var(--b4);color:var(--b2);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:.4rem;text-decoration:none;transition:background .15s,transform .1s}' +
    '.plg-btn:active,.plg-card .sbtn:active{transform:scale(.97)}.plg-btn.p,.plg-card .sbtn.p{background:var(--b);border-color:transparent;color:#fff}.plg-btn:disabled{opacity:.45;cursor:not-allowed}.plg-card .sbtn.d{background:none;border-color:transparent;color:#A8402F}' +
    '.plg-miss{font-size:.8rem;color:#A8402F}.plg-out{display:flex;flex-direction:column;gap:.5rem;padding-top:.9rem;border-top:1px solid var(--ln)}.plg-out .u{font-size:.8rem;direction:ltr;text-align:left;word-break:break-all;color:var(--ink2,#4E5C55);background:var(--b4);border-radius:var(--r);padding:.55rem .7rem}.plg-out .d{font-size:.8rem;color:var(--ink2,#4E5C55)}' +
    '.plg-saved{border-top:1px solid var(--ln);padding-top:1rem}.plg-saved h3{font-size:.95rem;margin:0 0 .5rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:baseline}.plg-saved h3 span{font-size:.72rem;font-weight:500;color:var(--ink3,#7F8C86)}' +
    '.plg-card .lk{border-radius:12px;border-inline-start-width:4px}.plg-card .lk input{height:36px;border-radius:8px}' +
    /* 09/11 (Richard): "קצר וקולע" — the same form, compact: fields in a grid, add-ons as one row of pills, total + button on one line */
    '.plg{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.6rem .7rem;max-width:none;align-items:end}' +
    '.plg .lbl{margin-bottom:.2rem;font-size:.72rem}.plg-f input,.plg-ddb{height:38px;font-size:.88rem}' +
    '.plg > .plg-f:nth-child(-n+4){grid-column:span 1}@media (max-width:900px){.plg{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
    '.plg > .plg-f:has(.plg-list){grid-column:1/-1}' +
    '.plg-list{border:0;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}' +
    '.plg-li{border:0;padding:0;min-height:0;display:flex;gap:.4rem;align-items:center;width:auto}.plg-li .plg-dd .lbl{display:none}.plg-li .plg-ddb{height:34px;width:auto;min-width:9rem;border-radius:999px;font-size:.82rem}.plg-li b{min-width:0}' +
    '.plg-tg{display:inline-flex;width:auto;min-height:34px;padding:0 .7rem 0 .5rem;border:1px solid var(--ln)!important;border-radius:999px;gap:.4rem;font-size:.82rem;background:var(--card,#fff)}.plg-tg.on{border-color:var(--b)!important;background:var(--b4)}.plg-tg b{min-width:0;font-size:.78rem}.plg-tg .box{width:1rem;height:1rem;font-size:.65rem}' +
    '.plg-sum{grid-column:1/span 2;flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:.3rem .9rem}.plg-sum div{font-size:.78rem}.plg-sum .tot{border:0;padding:0;margin:0;order:-1;gap:.4rem}.plg-sum .tot span:last-child{font-size:1.35rem}.plg-sum .note{display:none}' +
    '.plg-act{grid-column:3/-1;justify-content:flex-end}.plg-btn{height:38px}' +
    '.plg-out{grid-column:1/-1;flex-direction:row;flex-wrap:wrap;align-items:center;padding-top:.5rem}.plg-out .u{flex:1;min-width:14rem;padding:.4rem .6rem}' +
    '@media (max-width:900px){.plg-sum,.plg-act{grid-column:1/-1;justify-content:flex-start}}';

  function fresh() { return { plan: 'basic', records: 100, hostesses: 0, no_calls: false, design: false, travel: false, extra_wave: false, calls: false, name: '', phone: '', occasion: '', event_date: '', open: '', busy: false, url: '', err: '' }; }
  function payload(s, cfg) {
    cfg = cfg || root.ISHUR_CONFIG || {};
    var pr = price(s, cfg), h = pr.hostesses != null ? pr.hostesses : (Number(s.hostesses) || 0), plan = pr.bundle ? pr.plan : s.plan;
    return { plan: plan, records: Number(s.records), name: String(s.name).trim(), phone: String(s.phone).trim(), occasion: s.occasion, event_date: s.event_date || '',
      no_calls: !!(pr.bundle && s.no_calls),
      addons: { design: !!s.design, hostesses: h, travel: !!(s.travel && h), extra_wave: !!s.extra_wave, calls: !!(!pr.bundle && s.calls && !CALLS_INCLUDED[plan]) } };
  }

  function mount(id, key) {
    var doc = root.document, host = doc.getElementById(id), cfg = root.ISHUR_CONFIG;
    if (!host || !cfg || host.dataset.plg) return;
    host.dataset.plg = '1';
    var st = doc.createElement('style'); st.textContent = CSS; doc.head.appendChild(st);
    var BASE = cfg.endpoint('status').replace(/\/api\/status$/, '');
    var s = fresh();
    function draw() { host.innerHTML = render(s, cfg); }
    function changed() { s.url = ''; s.err = ''; s.copied = false; }
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('button,a'); if (!b || !host.contains(b)) { return; }
      if (b.dataset.dd) { s.open = s.open === b.dataset.dd ? '' : b.dataset.dd; draw(); return; }
      if (b.dataset.set) {
        var k = b.dataset.set, v = b.dataset.v;
        s[k] = (k === 'records' || k === 'hostesses') ? Number(v) : v;
        if (k === 'hostesses' && !s.hostesses) { s.travel = false; s.no_calls = false; }
        s.open = ''; changed(); draw(); return;
      }
      if (b.dataset.tg) { s[b.dataset.tg] = !s[b.dataset.tg]; changed(); draw(); return; }
      if (b.dataset.plg === 'copy') {
        var done = function () { s.copied = true; draw(); };
        if (root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(s.url).then(done, function () {});
        return;
      }
      if (b.dataset.plg === 'make') {
        if (problems(s).length) return;
        s.busy = true; s.err = ''; draw();
        var body = Object.assign({ admin_key: key }, payload(s, cfg));
        root.fetch(BASE + '/api/pay-link', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(root.IshurGuard ? root.IshurGuard.stamp(body) : body) })
          .then(function (r) { return r.json().catch(function () { return { ok: false, why: 'http-' + r.status }; }); })
          .then(function (j) {
            s.busy = false;
            if (j && j.ok && j.url) { s.url = j.url; s.desc = j.description; s.serverSum = j.sum; }
            else s.err = 'לא נוצר קישור' + (j && (j.why || j.error || j.make) ? ': ' + (j.why || j.error || j.make) : '');
            draw();
          }, function () { s.busy = false; s.err = 'לא נוצר קישור: אין חיבור'; draw(); });
      }
    });
    host.addEventListener('input', function (ev) { var k = ev.target.dataset && ev.target.dataset.in; if (!k) return; s[k] = ev.target.value; if (s.url) { changed(); var o = host.querySelector('.plg-out'); if (o) o.remove(); } refreshBar(); });
    /* typing must not lose focus: only the button bar re-renders while typing */
    function refreshBar() {
      var mk = host.querySelector('[data-plg="make"]'), miss = problems(s), bar = mk && mk.parentNode;
      if (!mk) return; mk.disabled = !!miss.length;
      var old = bar.querySelector('.plg-miss'); if (old) old.remove();
      if (miss.length) { var sp = doc.createElement('span'); sp.className = 'plg-miss'; sp.textContent = 'חסר: ' + miss.join(', '); bar.appendChild(sp); }
    }
    doc.addEventListener('click', function (ev) { if (s.open && !host.contains(ev.target)) { s.open = ''; draw(); } });
    draw();
  }

  var api = { mount: mount, render: render, price: price, coerce: coerce, problems: problems, payload: payload, waText: waText, waHref: waHref, fresh: fresh };
  root.IshurPayLinkGen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
