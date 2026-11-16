/* ishur.io · pnl-journal.js · יומן רווח והפסד (Richard 16/11/2026)
   A trading-journal month: one cell per day, green when the day ended in profit, red in loss, plain when nothing
   happened. Beside it the month's totals; a click on a day lists its deals and costs. Same numbers as the daily
   table under it (both are drawn from the `lines` the page builds from /api/cost-log + Meta's daily spend).
   line = { date:'YYYY-MM-DD', rev, vat, fee, feeEst, pay, deals:[{name,desc,sum,fee,method}], wa, shir, ads, fixed,
            fixedItems:[{name,ils}], total (all costs), profit (rev − total), net (profit − vat) }
   IshurJournal.mount(host, getLines) → { redraw() } · IshurJournal.render(lines, state) → html (pure, node-testable) */
(function (root) {
  'use strict';
  var MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  var DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  var METHOD = { card: 'אשראי', bit: 'ביט', direct: 'ישירות (לא דרך Grow)' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function n0(x) { return Math.round(Math.abs(Number(x) || 0)).toLocaleString('he-IL'); }
  function n2(x) { return (Number(x) || 0).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function signed(x) { var v = r2(x); return (v < 0 ? '−' : v > 0 ? '+' : '') + '₪' + n0(v); }
  function toneOf(l) { if (!l || !(l.rev > 0 || l.total > 0)) return 'none'; return l.net > 0 ? 'profit' : l.net < 0 ? 'loss' : 'none'; }
  function addMonth(m, d) { var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + d; y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12; return y + '-' + String(mo + 1).padStart(2, '0'); }
  function monthTotals(lines, month) {
    var t = { rev: 0, vat: 0, fee: 0, wa: 0, shir: 0, ads: 0, fixed: 0, total: 0, profit: 0, net: 0, pay: 0, green: 0, red: 0, feeEst: false };
    lines.forEach(function (l) {
      if (String(l.date).slice(0, 7) !== month) return;
      ['rev', 'vat', 'fee', 'wa', 'shir', 'ads', 'fixed', 'total', 'profit', 'net', 'pay'].forEach(function (k) { t[k] = r2(t[k] + (Number(l[k]) || 0)); });
      if (l.feeEst) t.feeEst = true;
      var tn = toneOf(l); if (tn === 'profit') t.green++; else if (tn === 'loss') t.red++;
    });
    return t;
  }
  function render(lines, st) {
    var month = st.month, today = st.today || '', by = {};
    lines.forEach(function (l) { by[l.date] = l; });
    var y = +month.slice(0, 4), mo = +month.slice(5, 7) - 1, n = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate(), lead = new Date(Date.UTC(y, mo, 1)).getUTCDay();
    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<div class="pj-c pj-x"></div>';
    for (var d = 1; d <= n; d++) {
      var date = month + '-' + String(d).padStart(2, '0'), l = by[date], tn = date > today ? 'none' : toneOf(l);
      cells += '<button type="button" class="pj-c pj-' + tn + (date === today ? ' pj-today' : '') + (date === st.day ? ' pj-sel' : '') + (date > today ? ' pj-fut' : '') + '" data-pj-day="' + date + '" aria-pressed="' + (date === st.day) + '">' +
        '<span class="pj-d">' + d + '</span>' +
        (l && l.rev > 0 && date <= today ? '<span class="pj-chip pj-in">₪' + n0(l.rev) + ' · ' + l.pay + (l.pay === 1 ? ' עסקה' : ' עסקאות') + '</span>' : '') +
        (tn !== 'none' ? '<span class="pj-chip pj-net">' + (tn === 'profit' ? '✓ ' : '✕ ') + signed(l.net) + '</span>' : (l && (l.rev > 0 || l.total > 0) && date <= today ? '<span class="pj-chip">₪0</span>' : '')) +
        '</button>';
    }
    for (var z = (lead + n) % 7; z && z < 7; z++) cells += '<div class="pj-c pj-x"></div>';
    return '<div class="pj"><div class="pj-main"><div class="pj-nav"><b>' + MONTHS[mo] + ' ' + y + '</b><span class="pj-seg"><button type="button" data-pj-nav="-1" aria-label="חודש קודם" title="חודש קודם"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button><button type="button" data-pj-nav="0">היום</button><button type="button" data-pj-nav="1" aria-label="חודש הבא" title="חודש הבא"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button></span></div>' +
      '<div class="pj-grid">' + DOW.map(function (x) { return '<div class="pj-h">' + x + '</div>'; }).join('') + cells + '</div>' +
      '<p class="pj-leg"><i class="pj-profit"></i>יום ברווח <i class="pj-loss"></i>יום בהפסד <i></i>בלי פעילות · הצבע לפי הרווח אחרי מע״מ וכל ההוצאות של אותו יום</p></div>' +
      '</div>';
  }
  /* ── 16/11 (Richard: "שני אלה אומרים לי את אותם נתונים, למה לא לאחד"): ONE money block. Tiles for the chosen period,
     then the same days three ways: יומן (calendar), רשימה (table), גרף (bars with axes). Week / month / quarter / year
     change everything at once. All of it is drawn from the same day lines. */
  var RANGES = [['week', 'שבוע'], ['month', 'חודש'], ['quarter', 'רבעון'], ['year', 'שנה']], VIEWS = [['cal', 'יומן'], ['list', 'רשימה'], ['chart', 'גרף']];
  function shiftDay(d, n) { return new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function rangeOf(key, today) {
    if (key === 'week') return { from: shiftDay(today, -6), to: today };
    if (key === 'quarter') return { from: addMonth(today.slice(0, 7), -2) + '-01', to: today };
    if (key === 'year') return { from: addMonth(today.slice(0, 7), -11) + '-01', to: today };
    return { from: today.slice(0, 7) + '-01', to: today };
  }
  function totals(lines, from, to) {
    var t = { rev: 0, vat: 0, fee: 0, wa: 0, shir: 0, ads: 0, fixed: 0, total: 0, profit: 0, net: 0, pay: 0, green: 0, red: 0, feeEst: false };
    lines.forEach(function (l) {
      if (l.date < from || l.date > to) return;
      ['rev', 'vat', 'fee', 'wa', 'shir', 'ads', 'fixed', 'total', 'profit', 'net', 'pay'].forEach(function (k) { t[k] = r2(t[k] + (Number(l[k]) || 0)); });
      if (l.feeEst) t.feeEst = true;
      var tn = toneOf(l); if (tn === 'profit') t.green++; else if (tn === 'loss') t.red++;
    });
    return t;
  }
  function dm(d) { return d.slice(8, 10) + '/' + d.slice(5, 7); }
  function tilesHtml(t) {
    var tile = function (v, label, cls, sub) { return '<div class="pj-t' + (cls ? ' ' + cls : '') + '"><b>' + v + '</b><span>' + label + '</span>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; };
    return '<div class="pj-tiles">' + tile('₪' + n0(t.rev), 'הכנסות', '', t.pay + (t.pay === 1 ? ' עסקה' : ' עסקאות')) +
      tile('₪' + n0(t.total), 'הוצאות', '', 'פרסום ₪' + n0(t.ads) + ' · סליקה ₪' + n0(t.fee)) +
      tile('₪' + n0(t.vat), 'מע״מ לתשלום') +
      tile(signed(t.profit), 'רווח לפני מע״מ') +
      tile(signed(t.net), 'רווח אחרי מע״מ', t.net > 0 ? 'pj-profit' : t.net < 0 ? 'pj-loss' : '', t.pay ? 'ממוצע לעסקה ' + signed(t.net / t.pay) : '') + '</div>';
  }
  function listHtml(lines, from, to) {
    var rows = lines.filter(function (l) { return l.date >= from && l.date <= to && (l.rev > 0 || l.total > 0); }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    if (!rows.length) return '<p class="pj-note">אין פעילות בתקופה הזאת.</p>';
    var c = function (v) { return v ? n2(v) : ''; }, col = function (v) { return v > 0 ? ' class="pj-pos"' : v < 0 ? ' class="pj-neg"' : ''; };
    return '<div class="pj-tw"><table class="pj-tbl"><thead><tr><th>תאריך</th><th>הכנסות</th><th>עסקאות</th><th>פרסום</th><th>וואטסאפ</th><th>שיחות</th><th>סליקה</th><th>קבועות</th><th>סה״כ הוצאות</th><th>מע״מ</th><th>רווח אחרי מע״מ</th></tr></thead><tbody>' +
      rows.map(function (l) { return '<tr data-pj-day="' + l.date + '" tabindex="0"><td>' + dm(l.date) + '/' + l.date.slice(2, 4) + '</td><td><b>' + c(l.rev) + '</b></td><td>' + (l.pay || '') + '</td><td>' + c(l.ads) + '</td><td>' + c(l.wa) + '</td><td>' + c(l.shir) + '</td><td>' + c(l.fee) + (l.feeEst && l.fee ? ' ≈' : '') + '</td><td>' + c(l.fixed) + '</td><td>' + n2(l.total) + '</td><td>' + c(l.vat) + '</td><td' + col(l.net) + '><b dir="ltr">' + n2(l.net) + '</b></td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  /* bars with a ₪ axis (y) and a date axis (x): income beside everything that went out (costs + VAT), per day; per week or month on long ranges */
  function chartHtml(lines, from, to) {
    var days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1, mode = days <= 45 ? 'day' : days <= 190 ? 'week' : 'month', b = {}, order = [];
    var keyOf = function (d) { if (mode === 'day') return d; if (mode === 'month') return d.slice(0, 7); var x = new Date(Date.parse(d + 'T12:00:00Z')); return shiftDay(d, -x.getUTCDay()); };
    for (var d = from; d <= to; d = shiftDay(d, 1)) { var k = keyOf(d); if (!b[k]) { b[k] = { k: k, inc: 0, out: 0 }; order.push(k); } }
    lines.forEach(function (l) { if (l.date < from || l.date > to) return; var x = b[keyOf(l.date)]; if (!x) return; x.inc = r2(x.inc + (l.rev || 0)); x.out = r2(x.out + (l.total || 0) + (l.vat || 0)); });
    var max = 0; order.forEach(function (k) { max = Math.max(max, b[k].inc, b[k].out); });
    if (!max) return '<p class="pj-note">אין פעילות בתקופה הזאת.</p>';
    var step = Math.pow(10, Math.floor(Math.log10(max))); step = max / step < 2 ? step / 4 : max / step < 5 ? step / 2 : step; var top = Math.ceil(max / step) * step;
    var W = 760, H = 260, L = 52, R = 8, T = 10, B = 30, pw = W - L - R, ph = H - T - B, n = order.length, slot = pw / n, bw = Math.max(2, Math.min(18, slot * 0.36));
    var g = '';
    for (var v = 0; v <= top + 0.001; v += step) { var y = T + ph - ph * v / top; g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="pj-gl"/><text x="' + (L - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="pj-ax">₪' + n0(v) + '</text>'; }
    var every = Math.ceil(n / 12);
    order.forEach(function (k, i) {
      var x0 = L + slot * i + slot / 2, hi = ph * b[k].inc / top, ho = ph * b[k].out / top, lbl = mode === 'month' ? k.slice(5, 7) + '/' + k.slice(2, 4) : dm(k);
      var tip = lbl + ' · הכנסות ₪' + n0(b[k].inc) + ' · הוצאות ומע״מ ₪' + n0(b[k].out);
      if (hi > 0) g += '<rect x="' + (x0 - bw - 1).toFixed(1) + '" y="' + (T + ph - hi).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hi.toFixed(1) + '" rx="2" class="pj-bi"><title>' + esc(tip) + '</title></rect>';
      if (ho > 0) g += '<rect x="' + (x0 + 1).toFixed(1) + '" y="' + (T + ph - ho).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + ho.toFixed(1) + '" rx="2" class="pj-bo"><title>' + esc(tip) + '</title></rect>';
      if (i % every === 0) g += '<text x="' + x0.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" class="pj-ax">' + lbl + '</text>';
    });
    g += '<line x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (T + ph) + '" class="pj-axl"/><line x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ph) + '" y2="' + (T + ph) + '" class="pj-axl"/>';
    return '<div class="pj-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="הכנסות מול הוצאות לפי ' + (mode === 'day' ? 'יום' : mode === 'week' ? 'שבוע' : 'חודש') + '" direction="ltr">' + g + '</svg>' +
      '<p class="pj-leg"><i class="pj-li"></i>הכנסות <i class="pj-lo"></i>הוצאות ומע״מ · ציר אנכי בשקלים, ציר אופקי לפי ' + (mode === 'day' ? 'יום' : mode === 'week' ? 'שבוע (תחילת השבוע)' : 'חודש') + '</p></div>';
  }
  function panelHtml(lines, st) {
    var seg = function (items, cur, attr) { return '<span class="pj-seg">' + items.map(function (x) { return '<button type="button" ' + attr + '="' + x[0] + '" aria-pressed="' + (x[0] === cur) + '">' + x[1] + '</button>'; }).join('') + '</span>'; };
    var cal = st.view === 'cal', r = cal ? { from: st.month + '-01', to: st.month + '-' + String(new Date(Date.UTC(+st.month.slice(0, 4), +st.month.slice(5, 7), 0)).getUTCDate()).padStart(2, '0') } : rangeOf(st.range, st.today);
    if (r.to > st.today) r.to = st.today;
    var t = totals(lines, r.from, r.to);
    var head = '<div class="pj-bar">' + seg(VIEWS, st.view, 'data-pj-view') + (cal ? '' : seg(RANGES, st.range, 'data-pj-range')) + '<span class="pj-rl">' + dm(r.from) + ' – ' + dm(r.to) + '</span>' +
      '<button type="button" class="pj-i" data-pj-info aria-label="הסבר על החישוב" aria-expanded="' + (!!st.info) + '">i</button></div>' +
      (st.info ? '<div class="pj-info">הכנסות = מה שהלקוחות שילמו, כולל מע״מ. הוצאות = פרסום במטא, וואטסאפ, שיחות, עמלות הסליקה של Grow והוצאות קבועות ביום החיוב שלהן. מע״מ לתשלום = המע״מ שבתוך ההכנסות (מע״מ עסקאות בלבד). רווח אחרי מע״מ = הכנסות פחות מע״מ ופחות כל ההוצאות. ≈ = עמלה לפי התעריף עד שנקראת העמלה בפועל.</div>' : '');
    var body = cal ? render(lines, st) : st.view === 'list' ? listHtml(lines, r.from, r.to) : chartHtml(lines, r.from, r.to);
    return '<div class="pj-panel">' + head + tilesHtml(t) + body + '</div>';
  }
  /* the month arrows are drawn (svg), not typed: the characters ‹ › are mirrored by the browser inside Hebrew text, which turned them inward */
  /* 16/11 (Richard: "פה זה לא נוח, אולי פופאפ"): a day's deals and costs open in a dialog over the calendar */
  function dayHtml(lines, day) {
    var dl = null; lines.forEach(function (l) { if (l.date === day) dl = l; });
    var row = function (k, v, cls) { return '<div class="pj-r' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; };
    var has = dl && (dl.rev > 0 || dl.total > 0);
    var h = '<div class="pj-dh"><h3>' + esc(day.slice(8, 10) + '/' + day.slice(5, 7) + '/' + day.slice(0, 4)) + '</h3><button type="button" class="pj-x2" data-pj-close aria-label="סגירה">✕</button></div>';
    if (!has) return h + '<p class="pj-note">אין הכנסות או הוצאות ביום הזה.</p>';
    h += '<div class="pj-big pj-' + (dl.net > 0 ? 'profit' : dl.net < 0 ? 'loss' : 'none') + '"><b>' + signed(dl.net) + '</b><span>רווח אחרי מע״מ</span></div>';
    if ((dl.deals || []).length) h += '<div class="pj-sec">הכנסות</div>' + dl.deals.map(function (x) { return '<div class="pj-deal"><div><b>' + esc(x.name || 'לקוח') + '</b><span>' + esc(String(x.desc || '')) + '</span><span>' + esc(METHOD[x.method] || '') + (x.fee ? ' · עמלה ₪' + n2(x.fee) : '') + '</span></div><b>₪' + n2(x.sum) + '</b></div>'; }).join('');
    h += '<div class="pj-sec">הוצאות</div>';
    if (dl.rev > 0) h += row('מע״מ בתוך ההכנסות', '−₪' + n2(dl.vat));
    if (dl.fee > 0) h += row('עמלות סליקה' + (dl.feeEst ? ' ≈' : ''), '−₪' + n2(dl.fee));
    if (dl.ads > 0) h += row('פרסום במטא', '−₪' + n2(dl.ads));
    if (dl.wa > 0) h += row('וואטסאפ', '−₪' + n2(dl.wa));
    if (dl.shir > 0) h += row('שיחות (שיר)', '−₪' + n2(dl.shir));
    (dl.fixedItems || []).forEach(function (x) { h += row('קבועה · ' + esc(x.name), '−₪' + n2(x.ils)); });
    return h + row('רווח לפני מע״מ', signed(dl.profit), 'pj-sum') + row('רווח אחרי מע״מ', signed(dl.net), 'pj-sum');
  }
  var CSS = '.pj{margin:0 0 14px}' +
    '.pj-panel{margin:0 0 16px}.pj-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}.pj-rl{font-size:.78rem;color:var(--ink3,#7A8279);margin-inline-start:auto}' +
    '.pj-seg button{font:inherit;font-size:.82rem;font-weight:600;min-height:34px;padding:0 .8rem;background:var(--card,#fff);color:var(--ink,#1B2620);cursor:pointer}.pj-seg button[aria-pressed=true]{background:var(--pine,#0F2E22);color:#fff}' +
    '.pj-i{font:inherit;font-size:.78rem;font-weight:700;font-style:italic;width:26px;height:26px;border-radius:50%;border:1px solid var(--line,#E3E1D8);background:var(--card,#fff);color:var(--ink3,#7A8279);cursor:pointer}' +
    '.pj-info{font-size:.78rem;line-height:1.6;color:var(--ink2,#4A554C);border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.6rem .8rem;margin:0 0 10px;max-width:70ch}' +
    '.pj-tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:0 0 12px}@media (max-width:820px){.pj-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
    '.pj-t{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.7rem .8rem;display:flex;flex-direction:column;gap:.1rem;min-width:0}.pj-t b{font-size:1.35rem;line-height:1.15;color:var(--pine,#0F2E22)}.pj-t span{font-size:.76rem;color:var(--ink3,#7A8279)}.pj-t small{font-size:.7rem;color:var(--ink3,#7A8279)}' +
    '.pj-t.pj-profit{background:#EAF4EE}.pj-t.pj-profit b{color:#0F4C35}.pj-t.pj-loss{background:#FBECEA}.pj-t.pj-loss b{color:#8E2F22}' +
    '.pj-tw{overflow:auto;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);max-height:520px}.pj-tbl{border-collapse:collapse;width:100%;font-size:.82rem}.pj-tbl th{position:sticky;top:0;background:var(--card,#fff);font-size:.7rem;color:var(--ink3,#7A8279);text-align:start;padding:.5rem .6rem;border-bottom:1px solid var(--line,#E3E1D8);white-space:nowrap}.pj-tbl td{padding:.45rem .6rem;border-bottom:1px solid rgba(0,0,0,.05);white-space:nowrap}.pj-tbl tbody tr{cursor:pointer}.pj-tbl tbody tr:hover{background:rgba(0,0,0,.03)}.pj-pos{color:#0F4C35}.pj-neg{color:#8E2F22}' +
    '.pj-chart{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.6rem .6rem .4rem}.pj-chart svg{display:block;width:100%;height:auto}.pj-gl{stroke:rgba(0,0,0,.08);stroke-width:1}.pj-axl{stroke:var(--ink3,#7A8279);stroke-width:1}.pj-ax{font-size:10px;fill:var(--ink3,#7A8279)}.pj-bi{fill:#1F7A52}.pj-bo{fill:#C56A5B}.pj-leg i.pj-li{background:#1F7A52}.pj-leg i.pj-lo{background:#C56A5B}' +
    '@media (prefers-color-scheme:dark){.pj-t.pj-profit{background:#17382A}.pj-t.pj-profit b{color:#8FD3AE}.pj-t.pj-loss{background:#3F211D}.pj-t.pj-loss b{color:#F2A79C}.pj-gl{stroke:rgba(255,255,255,.1)}}' +
    '.pj-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px}.pj-nav b{font-size:1.05rem;color:var(--pine,#0F2E22)}' +
    '.pj-seg{display:inline-flex;border:1px solid var(--line,#E3E1D8);border-radius:8px;overflow:hidden;background:var(--card,#fff)}.pj-seg button{display:inline-grid;place-items:center;border:0!important;border-radius:0!important;border-inline-start:1px solid var(--line,#E3E1D8)!important}.pj-seg button:first-child{border-inline-start:0!important}' +
    '.pj-nav button{font:inherit;font-size:.82rem;font-weight:600;min-width:36px;min-height:34px;padding:0 .7rem;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);color:var(--ink,#1B2620);cursor:pointer}' +
    '.pj-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--line,#E3E1D8);border-radius:8px;overflow:hidden;background:var(--line,#E3E1D8);gap:1px}' +
    '.pj-h{background:var(--card,#fff);text-align:center;font-size:.72rem;font-weight:600;color:var(--ink3,#7A8279);padding:.4rem 0}' +
    '.pj-c{font:inherit;text-align:start;border:0;background:var(--card,#fff);min-height:84px;padding:.4rem .45rem;display:flex;flex-direction:column;gap:.25rem;cursor:pointer;color:var(--ink,#1B2620)}' +
    '.pj-x{cursor:default}.pj-fut{opacity:.55}.pj-d{font-size:.86rem;font-weight:700}' +
    '.pj-c.pj-profit{background:#EAF4EE}.pj-c.pj-loss{background:#FBECEA}' +
    '.pj-today .pj-d{background:var(--pine,#0F2E22);color:#fff;border-radius:999px;min-width:1.6rem;height:1.6rem;display:inline-grid;place-items:center;align-self:flex-start}' +
    '.pj-sel{outline:2px solid var(--pine,#0F2E22);outline-offset:-2px}.pj-c:focus-visible{outline:2px solid var(--gold,#A8853C);outline-offset:-2px}' +
    '.pj-chip{font-size:.7rem;font-weight:600;border-radius:6px;padding:.12rem .35rem;background:rgba(0,0,0,.05);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}' +
    '.pj-chip.pj-in{background:rgba(168,133,60,.16);color:#6E5520}.pj-profit .pj-net{background:#CFE8D8;color:#0F4C35}.pj-loss .pj-net{background:#F6D3CE;color:#8E2F22}' +
    '.pj-leg{font-size:.7rem;color:var(--ink3,#7A8279);margin:.4rem 0 0}.pj-leg i{display:inline-block;width:.7rem;height:.7rem;border-radius:3px;border:1px solid var(--line,#E3E1D8);margin:0 .3rem 0 .6rem;vertical-align:-1px}.pj-leg i.pj-profit{background:#CFE8D8}.pj-leg i.pj-loss{background:#F6D3CE}' +
    '.pj-dlg{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);color:var(--ink,#1B2620);padding:1rem 1.1rem;width:min(460px,calc(100vw - 32px));max-height:85vh;overflow:auto}.pj-dlg::backdrop{background:rgba(10,20,15,.45)}' +
    '.pj-dh{display:flex;align-items:center;justify-content:space-between;margin:0 0 .6rem}.pj-dh h3{margin:0;font-size:1.05rem;color:var(--pine,#0F2E22)}.pj-x2{font:inherit;width:36px;height:36px;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:none;color:inherit;cursor:pointer}' +
    '.pj-sec{font-size:.72rem;font-weight:700;color:var(--ink3,#7A8279);margin:.8rem 0 .2rem}' +
    '.pj-deal{display:flex;justify-content:space-between;gap:.8rem;padding:.4rem 0;border-bottom:1px solid rgba(0,0,0,.06);font-size:.84rem}.pj-deal div{display:flex;flex-direction:column;min-width:0}.pj-deal span{font-size:.74rem;color:var(--ink3,#7A8279)}.pj-deal>b{white-space:nowrap}' +
    '.pj-side,.pj-det{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.8rem .9rem;margin:0 0 10px}' +
    '.pj-side h3,.pj-det h3{font-size:.95rem;margin:0 0 .5rem;color:var(--pine,#0F2E22)}' +
    '.pj-big{border-radius:8px;padding:.6rem .7rem;margin:0 0 .5rem;display:flex;flex-direction:column;background:rgba(0,0,0,.04)}.pj-big b{font-size:1.6rem;line-height:1.1}.pj-big span{font-size:.72rem;color:var(--ink3,#7A8279)}' +
    '.pj-big.pj-profit{background:#EAF4EE}.pj-big.pj-profit b{color:#0F4C35}.pj-big.pj-loss{background:#FBECEA}.pj-big.pj-loss b{color:#8E2F22}' +
    '.pj-r{display:flex;justify-content:space-between;gap:.6rem;font-size:.8rem;padding:.22rem 0;border-bottom:1px solid rgba(0,0,0,.05)}.pj-r b{font-weight:600;white-space:nowrap}.pj-r.pj-sum{font-weight:700;border-bottom:1px solid var(--line,#E3E1D8)}' +
    '.pj-note{font-size:.7rem;color:var(--ink3,#7A8279);margin:.4rem 0 0}' +
    '@media (prefers-color-scheme:dark){.pj-c.pj-profit{background:#17382A}.pj-c.pj-loss{background:#3F211D}.pj-profit .pj-net{background:#235A40;color:#CFE8D8}.pj-loss .pj-net{background:#6A2E26;color:#F6D3CE}.pj-big.pj-profit{background:#17382A}.pj-big.pj-profit b{color:#8FD3AE}.pj-big.pj-loss{background:#3F211D}.pj-big.pj-loss b{color:#F2A79C}.pj-chip.pj-in{color:#E1C98F}}';
  function ilToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }
  function mount(host, getLines) {
    var doc = root.document; if (!host || host.dataset.pj) return null;
    host.dataset.pj = '1';
    var st0 = doc.createElement('style'); st0.textContent = CSS; doc.head.appendChild(st0);
    var st = { today: ilToday(), month: ilToday().slice(0, 7), day: '', view: 'cal', range: 'month', info: false };
    try { var sv = JSON.parse(root.localStorage.getItem('ishur_pj') || '{}'); if (sv.view) st.view = sv.view; if (sv.range) st.range = sv.range; } catch (e) {}
    function draw() { st.today = ilToday(); host.innerHTML = panelHtml(getLines() || [], st); try { root.localStorage.setItem('ishur_pj', JSON.stringify({ view: st.view, range: st.range })); } catch (e) {} }
    var dlg = doc.createElement('dialog'); dlg.className = 'pj-dlg'; dlg.setAttribute('dir', 'rtl'); doc.body.appendChild(dlg);
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg || ev.target.closest('[data-pj-close]')) dlg.close(); });
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-pj-nav],[data-pj-day],[data-pj-view],[data-pj-range],[data-pj-info]'); if (!b) return;
      if (b.dataset.pjView) { st.view = b.dataset.pjView; draw(); return; }
      if (b.dataset.pjRange) { st.range = b.dataset.pjRange; draw(); return; }
      if (b.dataset.pjInfo != null) { st.info = !st.info; draw(); return; }
      if (b.dataset.pjNav != null) { var k = +b.dataset.pjNav; st.month = k ? addMonth(st.month, k) : st.today.slice(0, 7); st.day = ''; draw(); return; }
      if (b.dataset.pjDay > st.today) return;
      st.day = b.dataset.pjDay; draw();
      dlg.innerHTML = dayHtml(getLines() || [], st.day);
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    });
    draw();
    return { redraw: draw };
  }
  var api = { mount: mount, render: render, dayHtml: dayHtml, panelHtml: panelHtml, totals: totals, rangeOf: rangeOf, chartHtml: chartHtml, listHtml: listHtml, monthTotals: monthTotals, toneOf: toneOf, addMonth: addMonth };
  root.IshurJournal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
