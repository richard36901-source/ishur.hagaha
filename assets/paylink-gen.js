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

  function price(s, cfg) {
    var lines = [], pt = (cfg.PRICE_TABLE || {})[s.records];
    if (!pt || !pt[s.plan]) return { lines: [], total: 0 };
    lines.push({ label: s.records + ' רשומות ' + PLAN_HE[s.plan], price: pt[s.plan] });
    if (s.design) lines.push({ label: 'עיצוב הזמנה', price: cfg.DESIGN_PRICE || 79 });
    var hp = hostessPrices(cfg);
    if (s.hostesses && hp[s.hostesses]) lines.push({ label: s.hostesses === 1 ? 'דיילת אחת' : s.hostesses + ' דיילות', price: hp[s.hostesses] });
    if (s.travel && s.hostesses) lines.push({ label: 'נסיעות דיילות', price: travelFor(cfg, s.hostesses) });
    if (s.extra_wave) lines.push({ label: 'גל תזכורת שלישי', price: Math.ceil(RATES.msg * s.records + RATES.base) });
    if (s.calls && !CALLS_INCLUDED[s.plan]) lines.push({ label: 'שיחות AI למי שלא ענה', price: Math.ceil(RATES.call * s.records + RATES.base) });
    return { lines: lines, total: lines.reduce(function (a, l) { return a + l.price; }, 0) };
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

  function dd(id, label, value, opts, open) {
    var cur = opts.filter(function (o) { return String(o.v) === String(value); })[0];
    return '<div class="plg-dd' + (open ? ' open' : '') + '"><span class="lbl">' + esc(label) + '</span>' +
      '<button type="button" class="plg-ddb" data-dd="' + id + '" aria-haspopup="listbox" aria-expanded="' + (open ? 'true' : 'false') + '">' + esc(cur ? cur.t : 'בחירה') + ' ▾</button>' +
      (open ? '<div class="plg-ddl" role="listbox">' + opts.map(function (o) {
        return '<button type="button" role="option" aria-selected="' + (String(o.v) === String(value)) + '" data-set="' + id + '" data-v="' + esc(o.v) + '"' + (o.off ? ' disabled' : '') + '>' + esc(o.t) + '</button>';
      }).join('') + '</div>' : '') + '</div>';
  }
  function tg(key, label, on, extra, off) {
    return '<button type="button" class="plg-tg' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (!!on) + '" data-tg="' + key + '"' + (off ? ' disabled' : '') + '>' +
      '<span class="box">' + (on ? '✓' : '') + '</span>' + esc(label) + (extra ? ' <b>' + esc(extra) + '</b>' : '') + '</button>';
  }
  function money(n) { return '₪' + Number(n || 0).toLocaleString('he-IL'); }

  function render(s, cfg) {
    var pr = price(s, cfg), hp = hostessPrices(cfg), recs = tiers(cfg);
    var occ = (cfg.OCCASIONS || []).map(function (o) { return { v: o.value, t: o.label }; });
    var hostOpts = [0, 1, 2, 3].map(function (n) {
      return { v: n, t: n === 0 ? 'בלי דיילות' : (n === 1 ? 'דיילת אחת' : n + ' דיילות') + (hp[n] ? ' · ' + money(hp[n]) : ' · לא מתומחר'), off: n > 0 && !hp[n] };
    });
    var miss = problems(s);
    var wave = Math.ceil(RATES.msg * s.records + RATES.base), callsP = Math.ceil(RATES.call * s.records + RATES.base);
    return '<div class="plg">' +
      '<div class="plg-row">' +
        dd('plan', 'חבילה', s.plan, ['basic', 'pro', 'premium'].map(function (k) { return { v: k, t: PLAN_HE[k] }; }), s.open === 'plan') +
        dd('records', 'רשומות', s.records, recs.map(function (n) { return { v: n, t: 'עד ' + n + ' רשומות' }; }), s.open === 'records') +
        dd('hostesses', 'דיילות', s.hostesses, hostOpts, s.open === 'hostesses') +
      '</div>' +
      '<div class="plg-row">' +
        tg('design', 'עיצוב הזמנה', s.design, money(cfg.DESIGN_PRICE || 79)) +
        tg('travel', 'נסיעות (מחוץ למרכז)', s.travel && s.hostesses, s.hostesses ? money(travelFor(cfg, s.hostesses)) : 'רק עם דיילות', !s.hostesses) +
        tg('extra_wave', 'גל תזכורת שלישי', s.extra_wave, money(wave)) +
        tg('calls', 'סבב שיחות AI', s.calls && !CALLS_INCLUDED[s.plan], CALLS_INCLUDED[s.plan] ? 'כלול בחבילה' : money(callsP), !!CALLS_INCLUDED[s.plan]) +
      '</div>' +
      '<div class="plg-row">' +
        '<label class="plg-f"><span class="lbl">שם הלקוח *</span><input data-in="name" value="' + esc(s.name) + '" autocomplete="off"></label>' +
        '<label class="plg-f"><span class="lbl">טלפון *</span><input data-in="phone" inputmode="tel" dir="ltr" placeholder="05X-XXXXXXX" value="' + esc(s.phone) + '"></label>' +
        dd('occasion', 'סוג אירוע *', s.occasion, occ, s.open === 'occasion') +
        '<label class="plg-f"><span class="lbl">תאריך (לא חובה)</span><input data-in="event_date" type="date" value="' + esc(s.event_date) + '"></label>' +
      '</div>' +
      '<div class="plg-sum">' + pr.lines.map(function (l) { return '<div><span>' + esc(l.label) + '</span><span>' + money(l.price) + '</span></div>'; }).join('') +
        '<div class="tot"><span>סה"כ</span><span>' + money(pr.total) + '</span></div>' +
        '<div class="note">הסכום הסופי מחושב בשרת מאותן טבלאות</div></div>' +
      '<div class="plg-row">' +
        '<button type="button" class="sbtn p" data-plg="make"' + (miss.length || s.busy ? ' disabled' : '') + '>' + (s.busy ? 'יוצר…' : 'צור קישור') + '</button>' +
        (miss.length ? '<span class="plg-miss">חסר: ' + esc(miss.join(', ')) + '</span>' : '') +
        (s.err ? '<span class="plg-miss">' + esc(s.err) + '</span>' : '') +
      '</div>' +
      (s.url ? '<div class="plg-out"><div class="u">' + esc(s.url) + '</div>' +
        '<div class="plg-row"><span class="d">' + esc(s.desc || '') + ' · ' + money(s.serverSum) + '</span></div>' +
        '<div class="plg-row"><button type="button" class="sbtn p" data-plg="copy">' + (s.copied ? '✓ הועתק' : '📋 העתק קישור') + '</button>' +
        '<a class="sbtn p" data-plg="wa" target="_blank" rel="noopener" href="' + esc(waHref(s.phone, s.url)) + '">שלח בוואטסאפ ללקוח</a></div></div>' : '') +
      '</div>';
  }

  var CSS = '.plg{display:flex;flex-direction:column;gap:.6rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.9rem 1rem;margin-top:.5rem}' +
    '.plg-row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end}' +
    '.plg .lbl{display:block;font-size:.68rem;color:var(--ink3);margin-bottom:.15rem}' +
    '.plg-dd{position:relative}.plg-ddb{font:inherit;font-size:.82rem;padding:.35rem .7rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);cursor:pointer;min-width:9rem;text-align:start}' +
    '.plg-ddl{position:absolute;z-index:20;inset-inline-start:0;top:100%;margin-top:.2rem;background:var(--card);border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);display:flex;flex-direction:column;max-height:16rem;overflow:auto;min-width:100%}' +
    '.plg-ddl button{font:inherit;font-size:.82rem;text-align:start;padding:.4rem .7rem;border:0;background:none;color:var(--ink);cursor:pointer;white-space:nowrap}.plg-ddl button[aria-selected=true]{font-weight:700;color:var(--pine)}.plg-ddl button:hover{background:var(--bg)}.plg-ddl button:disabled{opacity:.45;cursor:not-allowed}' +
    '.plg-tg{font:inherit;font-size:.8rem;display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--ink);cursor:pointer}' +
    '.plg-tg .box{width:1rem;height:1rem;border:1px solid var(--line);border-radius:4px;display:inline-grid;place-items:center;font-size:.7rem}.plg-tg.on{border-color:var(--pine)}.plg-tg.on .box{background:var(--pine);color:#fff;border-color:var(--pine)}.plg-tg:disabled{opacity:.5;cursor:not-allowed}' +
    '.plg-f input{font:inherit;font-size:.82rem;padding:.35rem .55rem;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);min-width:9rem}' +
    '.plg-sum{font-size:.82rem;display:flex;flex-direction:column;gap:.15rem;max-width:26rem}.plg-sum div{display:flex;justify-content:space-between;gap:1rem}.plg-sum .tot{font-weight:700;border-top:1px solid var(--line);padding-top:.25rem;font-variant-numeric:tabular-nums}.plg-sum .note{font-size:.68rem;color:var(--ink3)}' +
    '.plg-miss{font-size:.74rem;color:#A8402F}.plg-out .u{font-size:.74rem;direction:ltr;text-align:left;word-break:break-all;color:var(--ink2)}.plg-out .d{font-size:.76rem;color:var(--ink2)}a.sbtn{text-decoration:none;display:inline-block}';

  function fresh() { return { plan: 'basic', records: 100, hostesses: 0, design: false, travel: false, extra_wave: false, calls: false, name: '', phone: '', occasion: '', event_date: '', open: '', busy: false, url: '', err: '' }; }
  function payload(s) {
    return { plan: s.plan, records: Number(s.records), name: String(s.name).trim(), phone: String(s.phone).trim(), occasion: s.occasion, event_date: s.event_date || '',
      addons: { design: !!s.design, hostesses: Number(s.hostesses) || 0, travel: !!(s.travel && s.hostesses), extra_wave: !!s.extra_wave, calls: !!(s.calls && !CALLS_INCLUDED[s.plan]) } };
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
        if (k === 'hostesses' && !s.hostesses) s.travel = false;
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
        var body = Object.assign({ admin_key: key }, payload(s));
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

  var api = { mount: mount, render: render, price: price, problems: problems, payload: payload, waText: waText, waHref: waHref, fresh: fresh };
  root.IshurPayLinkGen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
