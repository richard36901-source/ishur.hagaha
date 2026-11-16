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
    var t = { rev: 0, vat: 0, fee: 0, wa: 0, shir: 0, ads: 0, fixed: 0, evc: 0, total: 0, profit: 0, net: 0, pay: 0, green: 0, red: 0, feeEst: false };
    lines.forEach(function (l) {
      if (String(l.date).slice(0, 7) !== month) return;
      ['rev', 'vat', 'fee', 'wa', 'shir', 'ads', 'fixed', 'evc', 'total', 'profit', 'net', 'pay'].forEach(function (k) { t[k] = r2(t[k] + (Number(l[k]) || 0)); });
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
      '<div class="pj-aside">' + sideHtml(lines, month) + '</div></div>';
  }
  function sideHtml(lines, month) {
    var t = monthTotals(lines, month), y = +month.slice(0, 4), mo = +month.slice(5, 7) - 1;
    var row = function (k, v, cls) { return '<div class="pj-r' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; };
    return '<div class="pj-side"><h3>' + MONTHS[mo] + ' ' + y + '</h3>' +
      '<div class="pj-big pj-' + (t.net > 0 ? 'profit' : t.net < 0 ? 'loss' : 'none') + '"><b>' + signed(t.net) + '</b><span>רווח אחרי מע״מ</span></div>' +
      row('הכנסות (כולל מע״מ)', '₪' + n2(t.rev)) + row(t.pay + ' עסקאות', '') +
      row('מע״מ עסקאות לתשלום', '−₪' + n2(t.vat)) +
      row('הכנסות בלי מע״מ', '₪' + n2(t.rev - t.vat), 'pj-sum') +
      row('פרסום במטא', '−₪' + n2(t.ads)) + row('וואטסאפ', '−₪' + n2(t.wa)) + row('שיחות (שיר)', '−₪' + n2(t.shir)) +
      row('עמלות סליקה Grow' + (t.feeEst ? ' ≈' : ''), '−₪' + n2(t.fee)) + row('הוצאות קבועות', '−₪' + n2(t.fixed)) + (t.evc ? row('עלויות אירועים (דיילות ועוד)', '−₪' + n2(t.evc)) : '') +
      row('סך ההוצאות', '−₪' + n2(t.total), 'pj-sum') +
      row('רווח לפני מע״מ', signed(t.profit)) +
      row('ימים', t.green + ' ברווח · ' + t.red + ' בהפסד') + '</div>';
  }
  /* ── 16/11 (Richard: "שני אלה אומרים לי את אותם נתונים, למה לא לאחד"): ONE money block. Tiles for the chosen period,
     then the same days three ways: יומן (calendar), רשימה (table), גרף (bars with axes). Week / month / quarter / year
     change everything at once. All of it is drawn from the same day lines. */
  var RANGES = [['week', 'שבוע'], ['month', 'חודש'], ['quarter', 'רבעון'], ['year', 'שנה'], ['all', 'כל הזמנים']], VIEWS = [['cal', 'יומן'], ['list', 'רשימה'], ['chart', 'גרף']];
  function shiftDay(d, n) { return new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  function rangeOf(key, today) {
    if (key === 'week') return { from: shiftDay(today, -6), to: today };
    if (key === 'quarter') return { from: addMonth(today.slice(0, 7), -2) + '-01', to: today };
    if (key === 'year') return { from: addMonth(today.slice(0, 7), -11) + '-01', to: today };
    if (key === 'all') return { from: '2026-01-01', to: today, all: true };
    return { from: today.slice(0, 7) + '-01', to: today };
  }
  function totals(lines, from, to) {
    var t = { rev: 0, vat: 0, fee: 0, wa: 0, shir: 0, ads: 0, fixed: 0, evc: 0, total: 0, profit: 0, net: 0, pay: 0, green: 0, red: 0, feeEst: false };
    lines.forEach(function (l) {
      if (l.date < from || l.date > to) return;
      ['rev', 'vat', 'fee', 'wa', 'shir', 'ads', 'fixed', 'evc', 'total', 'profit', 'net', 'pay'].forEach(function (k) { t[k] = r2(t[k] + (Number(l[k]) || 0)); });
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
    return '<div class="pj-tw"><table class="pj-tbl"><thead><tr><th>תאריך</th><th>הכנסות</th><th>עסקאות</th><th>פרסום</th><th>וואטסאפ</th><th>שיחות</th><th>סליקה</th><th>קבועות</th><th>אירועים</th><th>סה״כ הוצאות</th><th>מע״מ</th><th>רווח אחרי מע״מ</th></tr></thead><tbody>' +
      rows.map(function (l) { return '<tr data-pj-day="' + l.date + '" tabindex="0"><td>' + dm(l.date) + '/' + l.date.slice(2, 4) + '</td><td><b>' + c(l.rev) + '</b></td><td>' + (l.pay || '') + '</td><td>' + c(l.ads) + '</td><td>' + c(l.wa) + '</td><td>' + c(l.shir) + '</td><td>' + c(l.fee) + (l.feeEst && l.fee ? ' ≈' : '') + '</td><td>' + c(l.fixed) + '</td><td>' + c(l.evc) + '</td><td>' + n2(l.total) + '</td><td>' + c(l.vat) + '</td><td' + col(l.net) + '><b dir="ltr">' + n2(l.net) + '</b></td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  /* income, what went out (costs + VAT) and what is left: only the profit carries colour */
  function chartHtml(lines, from, to) {
    var days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1, mode = days <= 45 ? 'day' : days <= 190 ? 'week' : 'month', b = {}, order = [];
    var keyOf = function (d) { if (mode === 'day') return d; if (mode === 'month') return d.slice(0, 7); var x = new Date(Date.parse(d + 'T12:00:00Z')); return shiftDay(d, -x.getUTCDay()); };
    for (var d = from; d <= to; d = shiftDay(d, 1)) { var k = keyOf(d); if (!b[k]) { b[k] = { k: k, inc: 0, out: 0, net: 0 }; order.push(k); } }
    lines.forEach(function (l) { if (l.date < from || l.date > to) return; var x = b[keyOf(l.date)]; if (!x) return; x.inc = r2(x.inc + (l.rev || 0)); x.out = r2(x.out + (l.total || 0) + (l.vat || 0)); x.net = r2(x.net + (l.net || 0)); });
    return chartBars({ aria: 'הכנסות, הוצאות ורווח לפי ' + (mode === 'day' ? 'יום' : mode === 'week' ? 'שבוע' : 'חודש'),
      buckets: order.map(function (k) { var lbl = mode === 'month' ? k.slice(5, 7) + '/' + k.slice(2, 4) : dm(k); return { label: lbl, title: (mode === 'week' ? 'שבוע שמתחיל ב-' : '') + lbl, v: { inc: b[k].inc, out: b[k].out, net: b[k].net } }; }),
      series: [{ k: 'inc', label: 'הכנסות', tone: 'a' }, { k: 'out', label: 'הוצאות ומע״מ', tone: 'b' }, { k: 'net', label: 'רווח אחרי מע״מ', tone: 'hi' }] });
  }
  function panelHtml(lines, st) {
    var seg = function (items, cur, attr) { return '<span class="pj-seg">' + items.map(function (x) { return '<button type="button" ' + attr + '="' + x[0] + '" aria-pressed="' + (x[0] === cur) + '">' + x[1] + '</button>'; }).join('') + '</span>'; };
    var cal = st.view === 'cal', r = cal ? { from: st.month + '-01', to: st.month + '-' + String(new Date(Date.UTC(+st.month.slice(0, 4), +st.month.slice(5, 7), 0)).getUTCDate()).padStart(2, '0') } : rangeOf(st.range, st.today);
    if (r.to > st.today) r.to = st.today;
    if (r.all) { var first = lines.filter(function (l) { return l.rev > 0 || l.total > 0; }).map(function (l) { return l.date; }).sort()[0]; if (first) r.from = first; }   /* all time starts at the first day with any money */
    var t = totals(lines, r.from, r.to);
    var head = '<div class="pj-bar">' + seg(VIEWS, st.view, 'data-pj-view') + (cal ? '' : seg(RANGES, st.range, 'data-pj-range')) + '<span class="pj-rl">' + dm(r.from) + ' – ' + dm(r.to) + '</span>' +
      '<button type="button" class="pj-i" data-pj-info aria-label="הסבר על החישוב" aria-expanded="' + (!!st.info) + '">i</button></div>' +
      (st.info ? '<div class="pj-info">הכנסות = מה שהלקוחות שילמו, כולל מע״מ. הוצאות = פרסום במטא, וואטסאפ, שיחות, עמלות הסליקה של Grow והוצאות קבועות ביום החיוב שלהן. מע״מ לתשלום = המע״מ שבתוך ההכנסות (מע״מ עסקאות בלבד). רווח אחרי מע״מ = הכנסות פחות מע״מ ופחות כל ההוצאות. ≈ = עמלה לפי התעריף עד שנקראת העמלה בפועל.</div>' : '');
    var body = cal ? render(lines, st) : st.view === 'list' ? listHtml(lines, r.from, r.to) : chartHtml(lines, r.from, r.to);
    return '<div class="pj-panel">' + head + (cal ? '' : tilesHtml(t)) + body + '</div>';
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
    (dl.evItems || []).forEach(function (x) { h += row(esc(x.label || 'עלות אירוע') + (x.name ? ' · ' + esc(x.name) : ''), '−₪' + n2(x.ils)); });
    return h + row('רווח לפני מע״מ', signed(dl.profit), 'pj-sum') + row('רווח אחרי מע״מ', signed(dl.net), 'pj-sum');
  }
  var CSS = '.pj{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;margin:0 0 14px;align-items:start}' +
    '@media (max-width:900px){.pj{grid-template-columns:1fr}}' +
    '.pj-panel{margin:0 0 16px}.pj-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}.pj-rl{font-size:.78rem;color:var(--ink3,#7A8279);margin-inline-start:auto}' +
    '.pj-seg button{font:inherit;font-size:.82rem;font-weight:600;min-height:34px;padding:0 .8rem;background:var(--card,#fff);color:var(--ink,#1B2620);cursor:pointer}.pj-seg button[aria-pressed=true]{background:var(--pine,#0F2E22);color:#fff}' +
    '.pj-i{font:inherit;font-size:.78rem;font-weight:700;font-style:italic;width:26px;height:26px;border-radius:50%;border:1px solid var(--line,#E3E1D8);background:var(--card,#fff);color:var(--ink3,#7A8279);cursor:pointer}' +
    '.pj-info{font-size:.78rem;line-height:1.6;color:var(--ink2,#4A554C);border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.6rem .8rem;margin:0 0 10px;max-width:70ch}' +
    '.pj-tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:0 0 12px}@media (max-width:820px){.pj-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
    '.pj-t{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.7rem .8rem;display:flex;flex-direction:column;gap:.1rem;min-width:0}.pj-t b{font-size:1.35rem;line-height:1.15;color:var(--pine,#0F2E22)}.pj-t span{font-size:.76rem;color:var(--ink3,#7A8279)}.pj-t small{font-size:.7rem;color:var(--ink3,#7A8279)}' +
    '.pj-t.pj-profit{background:#EAF4EE}.pj-t.pj-profit b{color:#0F4C35}.pj-t.pj-loss{background:#FBECEA}.pj-t.pj-loss b{color:#8E2F22}' +
    '.pj-tw{overflow:auto;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);max-height:520px}.pj-tbl{border-collapse:collapse;width:100%;font-size:.82rem}.pj-tbl th{position:sticky;top:0;background:var(--card,#fff);font-size:.7rem;color:var(--ink3,#7A8279);text-align:start;padding:.5rem .6rem;border-bottom:1px solid var(--line,#E3E1D8);white-space:nowrap}.pj-tbl td{padding:.45rem .6rem;border-bottom:1px solid rgba(0,0,0,.05);white-space:nowrap}.pj-tbl tbody tr{cursor:pointer}.pj-tbl tbody tr:hover{background:rgba(0,0,0,.03)}.pj-pos{color:#0F4C35}.pj-neg{color:#8E2F22}' +
    '.pj-chart{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.6rem .6rem .4rem}.pj-chart svg{display:block;width:100%;height:auto}.pj-gl{stroke:rgba(0,0,0,.08);stroke-width:1}.pj-axl{stroke:var(--ink3,#7A8279);stroke-width:1}.pj-ax{font-size:10px;fill:var(--ink3,#7A8279)}.pj-bi{fill:#1F7A52}.pj-bo{fill:#C56A5B}.pj-b1{fill:#7F8C85}.pj-b2{fill:#C4CCC7}.pj-bh{fill:#1F7A52}.pj-bn{fill:#C0503F}.pj-ln{fill:none;stroke:#A8853C;stroke-width:1.6}.pj-ld{fill:#A8853C}.pj-hit{fill:transparent;cursor:pointer;outline:none}.pj-hit:hover,.pj-hit:focus{fill:rgba(0,0,0,.05)}' +
    '.pj-leg i.pj-k1{background:#7F8C85}.pj-leg i.pj-k2{background:#C4CCC7}.pj-leg i.pj-kh{background:#1F7A52}.pj-leg i.pj-kl{background:#A8853C;height:.2rem;border:0;vertical-align:middle}' +
    '.pj-tip{position:fixed;z-index:9999;background:#13241c;color:#fff;font-size:12.5px;line-height:1.55;padding:7px 10px;border-radius:8px;white-space:pre;pointer-events:none;direction:rtl;text-align:right}.pj-leg i.pj-li{background:#1F7A52}.pj-leg i.pj-lo{background:#C56A5B}' +
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
    '.pj-dlg{position:fixed;inset:0;margin:auto;height:fit-content;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);color:var(--ink,#1B2620);padding:1rem 1.1rem;width:min(460px,calc(100vw - 32px));max-height:85vh;overflow:auto}.pj-dlg::backdrop{background:rgba(10,20,15,.45)}' +
    '.pj-dh{display:flex;align-items:center;justify-content:space-between;margin:0 0 .6rem}.pj-dh h3{margin:0;font-size:1.05rem;color:var(--pine,#0F2E22)}.pj-x2{font:inherit;width:36px;height:36px;border:1px solid var(--line,#E3E1D8);border-radius:8px;background:none;color:inherit;cursor:pointer}' +
    '.pj-sec{font-size:.72rem;font-weight:700;color:var(--ink3,#7A8279);margin:.8rem 0 .2rem}' +
    '.pj-deal{display:flex;justify-content:space-between;gap:.8rem;padding:.4rem 0;border-bottom:1px solid rgba(0,0,0,.06);font-size:.84rem}.pj-deal div{display:flex;flex-direction:column;min-width:0}.pj-deal span{font-size:.74rem;color:var(--ink3,#7A8279)}.pj-deal>b{white-space:nowrap}' +
    '.pj-side,.pj-det{border:1px solid var(--line,#E3E1D8);border-radius:8px;background:var(--card,#fff);padding:.8rem .9rem;margin:0 0 10px}' +
    '.pj-side h3,.pj-det h3{font-size:.95rem;margin:0 0 .5rem;color:var(--pine,#0F2E22)}' +
    '.pj-big{border-radius:8px;padding:.9rem .7rem;margin:0 0 .6rem;display:flex;flex-direction:column;align-items:center;text-align:center;gap:.15rem;background:rgba(0,0,0,.04)}.pj-big b{font-size:1.7rem;line-height:1.1}.pj-big span{font-size:.72rem;color:var(--ink3,#7A8279)}' +
    '.pj-big.pj-profit{background:#EAF4EE}.pj-big.pj-profit b{color:#0F4C35}.pj-big.pj-loss{background:#FBECEA}.pj-big.pj-loss b{color:#8E2F22}' +
    '.pj-r{display:flex;justify-content:space-between;gap:.6rem;font-size:.8rem;padding:.22rem 0;border-bottom:1px solid rgba(0,0,0,.05)}.pj-r{color:var(--ink2,#4A554C)}.pj-r b{font-weight:400;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--ink,#1B2620)}.pj-r.pj-sum,.pj-r.pj-sum b{font-weight:700;color:var(--ink,#1B2620)}.pj-r.pj-sum{font-weight:700;border-bottom:1px solid var(--line,#E3E1D8)}' +
    '.pj-note{font-size:.7rem;color:var(--ink3,#7A8279);margin:.4rem 0 0}' +
    '@media (prefers-color-scheme:dark){.pj-c.pj-profit{background:#17382A}.pj-c.pj-loss{background:#3F211D}.pj-profit .pj-net{background:#235A40;color:#CFE8D8}.pj-loss .pj-net{background:#6A2E26;color:#F6D3CE}.pj-big.pj-profit{background:#17382A}.pj-big.pj-profit b{color:#8FD3AE}.pj-big.pj-loss{background:#3F211D}.pj-big.pj-loss b{color:#F2A79C}.pj-chip.pj-in{color:#E1C98F}}';
  function ilToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()); }
  var cssDone = false;
  function ensureCss() { ensureTip(); if (cssDone || !root.document) return; cssDone = true; var st0 = root.document.createElement('style'); st0.textContent = CSS; root.document.head.appendChild(st0); }
  function mount(host, getLines) {
    var doc = root.document; if (!host || host.dataset.pj) return null;
    host.dataset.pj = '1';
    ensureCss();
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
  /* ── one chart for every screen (Richard 16/11: "x/y כמו שצריך, לראות את הנתונים עם העכבר, ורק רווח בצבע אחר") ──
     Grouped bars with a value axis (y) and a label axis (x); an optional thin line on its own scale; negative values
     drop under the zero line. Every column answers the mouse (and a tap) with all its numbers.
     o = { buckets:[{label, title, v:{key:number}}], series:[{k, label, tone:'a'|'b'|'hi'}], line:{k,label}, unit:'₪'|'' , aria } */
  function niceStep(span) { var p = Math.pow(10, Math.floor(Math.log10(span || 1))), f = span / p; return (f < 2 ? 0.25 : f < 5 ? 0.5 : 1) * p; }
  function chartBars(o) {
    var B = o.buckets || [], S = o.series || [], unit = o.unit == null ? '₪' : o.unit, max = 0, min = 0;
    B.forEach(function (b) { S.forEach(function (x) { var v = Number(b.v[x.k]) || 0; if (v > max) max = v; if (v < min) min = v; }); });
    if (!B.length || (!max && !min)) return '<p class="pj-note">אין נתונים בתקופה הזאת.</p>';
    var step = niceStep(max - min), top = Math.ceil(max / step) * step, bot = Math.floor(min / step) * step, span = top - bot || 1;
    var W = 760, H = 250, L = 54, R = 8, T = 10, Bm = 30, pw = W - L - R, ph = H - T - Bm, n = B.length, slot = pw / n, bw = Math.max(2, Math.min(16, slot * 0.8 / S.length - 1));
    var y = function (v) { return T + ph - ph * (v - bot) / span; }, g = '';
    for (var v = bot; v <= top + step / 1e6; v += step) g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" class="' + (Math.abs(v) < step / 1e6 ? 'pj-axl' : 'pj-gl') + '"/><text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" class="pj-ax">' + (v < 0 ? '−' : '') + unit + n0(v) + '</text>';
    var every = Math.ceil(n / 12), pts = [], lmax = 0;
    if (o.line) B.forEach(function (b) { lmax = Math.max(lmax, Number(b.v[o.line.k]) || 0); });
    B.forEach(function (b, i) {
      var x0 = L + slot * i + slot / 2, gw = S.length * (bw + 1), tip = (b.title || b.label);
      S.forEach(function (x, j) {
        var val = Number(b.v[x.k]) || 0; tip += '\n' + x.label + ': ' + (val < 0 ? '−' : '') + unit + n0(val);
        if (!val) return;
        var y0 = y(Math.max(val, 0)), h = Math.abs(y(val) - y(0));
        g += '<rect x="' + (x0 - gw / 2 + j * (bw + 1)).toFixed(1) + '" y="' + y0.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, h).toFixed(1) + '" rx="2" class="pj-b' + (x.tone === 'hi' ? (val < 0 ? 'n' : 'h') : x.tone === 'b' ? '2' : '1') + '"/>';
      });
      if (o.line) { var lv = Number(b.v[o.line.k]) || 0; tip += '\n' + o.line.label + ': ' + n0(lv); pts.push([x0, T + ph - (lmax ? ph * 0.9 * lv / lmax : 0)]); }
      if (i % every === 0) g += '<text x="' + x0.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" class="pj-ax">' + esc(b.label) + '</text>';
      g += '<rect x="' + (L + slot * i).toFixed(1) + '" y="' + T + '" width="' + slot.toFixed(1) + '" height="' + ph + '" class="pj-hit" tabindex="0" data-tip="' + esc(tip) + '"/>';
    });
    if (pts.length) g = g.replace(/(<rect [^>]*class="pj-hit")/, '<polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" class="pj-ln"/>' + pts.map(function (p) { return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.5" class="pj-ld"/>'; }).join('') + '$1');
    g += '<line x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (T + ph) + '" class="pj-axl"/>';
    var leg = S.map(function (x) { return '<i class="pj-k' + (x.tone === 'hi' ? 'h' : x.tone === 'b' ? '2' : '1') + '"></i>' + esc(x.label); }).join(' ') + (o.line ? ' <i class="pj-kl"></i>' + esc(o.line.label) + ' (קו, בסולם משלו)' : '');
    return '<div class="pj-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.aria || '') + '" direction="ltr">' + g + '</svg><p class="pj-leg">' + leg + '</p></div>';
  }
  /* the tooltip all charts share: follows the mouse, also shows on keyboard focus and on a tap */
  var tipEl = null;
  function ensureTip() {
    var doc = root.document; if (tipEl || !doc) return;
    tipEl = doc.createElement('div'); tipEl.className = 'pj-tip'; tipEl.hidden = true; doc.body.appendChild(tipEl);
    var show = function (t, x, yy) { tipEl.textContent = t.getAttribute('data-tip'); tipEl.hidden = false; var w = tipEl.offsetWidth, h = tipEl.offsetHeight; tipEl.style.left = Math.max(8, Math.min(root.innerWidth - w - 8, x - w / 2)) + 'px'; tipEl.style.top = Math.max(8, yy - h - 14) + 'px'; };
    doc.addEventListener('mousemove', function (e) { var t = e.target.closest ? e.target.closest('[data-tip]') : null; if (t) show(t, e.clientX, e.clientY); else tipEl.hidden = true; });
    doc.addEventListener('focusin', function (e) { var t = e.target.closest ? e.target.closest('[data-tip]') : null; if (t) { var r = t.getBoundingClientRect(); show(t, r.left + r.width / 2, r.top + 40); } });
    doc.addEventListener('focusout', function () { tipEl.hidden = true; });
  }

  /* the day lines from the two server answers (cost-log + Meta's daily spend) — the same sums the money screen shows */
  function buildLines(cost, adByDay, usdIls, today) {
    cost = cost || {}; adByDay = adByDay || {}; usdIls = usdIls || 3.7;
    var inc = cost.income || {}, fx = cost.fixed || {}, exd = {}, seen = {}, rows = (cost.days || []).map(function (r) { seen[r.date] = true; return r; });
    var blank = function (d) { if (!seen[d] && d <= today) { seen[d] = true; rows.push({ date: d, wa_cost_usd_cents: 0, shir_cost_usd_cents: 0 }); } };
    (cost.extras || []).forEach(function (x) { if (x.day) (exd[x.day] = exd[x.day] || []).push(x); });
    Object.keys(adByDay).forEach(blank); Object.keys(inc).forEach(blank); Object.keys(exd).forEach(blank);
    Object.keys(fx).forEach(function (m) { (fx[m] || []).forEach(function (x) { blank(m + '-' + String(x.day || 10).padStart(2, '0')); }); });
    return rows.map(function (r) {
      var wa = (r.wa_cost_usd_cents || 0) / 100 * usdIls, shir = (r.shir_cost_usd_cents || 0) / 100 * usdIls, ads = adByDay[r.date] || 0;
      var i = inc[r.date] || { revenue: 0, vat: 0, fees: 0, payments: 0, deals: [] };
      var items = (fx[r.date.slice(0, 7)] || []).filter(function (x) { return (x.day || 10) === Number(r.date.slice(8, 10)); });
      var evItems = exd[r.date] || [], evc = evItems.reduce(function (t, x) { return t + (Number(x.ils) || 0); }, 0);
      var fixed = items.reduce(function (t, x) { return t + (Number(x.ils) || 0); }, 0), total = r2(wa + shir + ads + i.fees + fixed + evc), profit = r2(i.revenue - total);
      return { date: r.date, wa: wa, shir: shir, ads: ads, rev: i.revenue, vat: i.vat, fee: i.fees, feeEst: !!i.fee_estimated, pay: i.payments, deals: i.deals || [], fixed: fixed, fixedItems: items, evc: evc, evItems: evItems, total: total, profit: profit, net: r2(profit - i.vat) };
    });
  }
  var api = { mount: mount, render: render, dayHtml: dayHtml, buildLines: buildLines, chartBars: chartBars, ensureCss: ensureCss, signed: signed, n0: n0, panelHtml: panelHtml, totals: totals, rangeOf: rangeOf, chartHtml: chartHtml, listHtml: listHtml, monthTotals: monthTotals, toneOf: toneOf, addMonth: addMonth };
  root.IshurJournal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
