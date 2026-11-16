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
    var t = monthTotals(lines, month);
    var row = function (k, v, cls) { return '<div class="pj-r' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>'; };
    var side = '<div class="pj-side"><h3>' + MONTHS[mo] + ' ' + y + '</h3>' +
      '<div class="pj-big pj-' + (t.net > 0 ? 'profit' : t.net < 0 ? 'loss' : 'none') + '"><b>' + signed(t.net) + '</b><span>רווח אחרי מע״מ</span></div>' +
      row('הכנסות (כולל מע״מ)', '₪' + n2(t.rev)) + row(t.pay + ' עסקאות', '') +
      row('מע״מ עסקאות לתשלום', '−₪' + n2(t.vat)) +
      row('הכנסות בלי מע״מ', '₪' + n2(t.rev - t.vat), 'pj-sum') +
      row('פרסום במטא', '−₪' + n2(t.ads)) + row('וואטסאפ', '−₪' + n2(t.wa)) + row('שיחות (שיר)', '−₪' + n2(t.shir)) +
      row('עמלות סליקה Grow' + (t.feeEst ? ' ≈' : ''), '−₪' + n2(t.fee)) + row('הוצאות קבועות', '−₪' + n2(t.fixed)) +
      row('סך ההוצאות', '−₪' + n2(t.total), 'pj-sum') +
      row('רווח לפני מע״מ', signed(t.profit) ) +
      row('ימים', t.green + ' ברווח · ' + t.red + ' בהפסד') +
      (t.feeEst ? '<p class="pj-note">≈ עמלה לפי התעריף של Grow (1.4% אשראי, 1.7% ביט, + ₪1.20 לעסקה, + מע״מ) עד שנקראת העמלה בפועל.</p>' : '') + '</div>';
    var dl = by[st.day], det = '';
    if (st.day) {
      det = '<div class="pj-det"><h3>' + esc(st.day.slice(8, 10) + '/' + st.day.slice(5, 7)) + (dl && (dl.rev > 0 || dl.total > 0) ? ' · ' + signed(dl.net) + ' אחרי מע״מ' : '') + '</h3>';
      if (!dl || !(dl.rev > 0 || dl.total > 0)) det += '<p class="pj-note">אין הכנסות או הוצאות ביום הזה.</p>';
      else {
        det += (dl.deals || []).map(function (x) { return '<div class="pj-r"><span>' + esc(x.name || 'לקוח') + ' · ' + esc(String(x.desc || '').slice(0, 44)) + ' · ' + esc(METHOD[x.method] || '') + '</span><b>₪' + n2(x.sum) + '</b></div>'; }).join('');
        if (dl.rev > 0) det += row('מע״מ בתוך ההכנסות', '−₪' + n2(dl.vat));
        if (dl.fee > 0) det += row('עמלות סליקה' + (dl.feeEst ? ' ≈' : ''), '−₪' + n2(dl.fee));
        if (dl.ads > 0) det += row('פרסום במטא', '−₪' + n2(dl.ads));
        if (dl.wa > 0) det += row('וואטסאפ', '−₪' + n2(dl.wa));
        if (dl.shir > 0) det += row('שיחות (שיר)', '−₪' + n2(dl.shir));
        (dl.fixedItems || []).forEach(function (x) { det += row('קבועה · ' + esc(x.name), '−₪' + n2(x.ils)); });
        det += row('רווח לפני מע״מ', signed(dl.profit), 'pj-sum') + row('רווח אחרי מע״מ', signed(dl.net), 'pj-sum');
      }
      det += '</div>';
    }
    return '<div class="pj"><div class="pj-main"><div class="pj-nav"><b>' + MONTHS[mo] + ' ' + y + '</b><span class="pj-seg"><button type="button" data-pj-nav="-1" aria-label="חודש קודם" title="חודש קודם">›</button><button type="button" data-pj-nav="0">היום</button><button type="button" data-pj-nav="1" aria-label="חודש הבא" title="חודש הבא">‹</button></span></div>' +
      '<div class="pj-grid">' + DOW.map(function (x) { return '<div class="pj-h">' + x + '</div>'; }).join('') + cells + '</div>' +
      '<p class="pj-leg"><i class="pj-profit"></i>יום ברווח <i class="pj-loss"></i>יום בהפסד <i></i>בלי פעילות · הצבע לפי הרווח אחרי מע״מ וכל ההוצאות של אותו יום</p></div>' +
      '<div class="pj-aside">' + side + det + '</div></div>';
  }
  var CSS = '.pj{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;margin:0 0 14px;align-items:start}' +
    '@media (max-width:900px){.pj{grid-template-columns:1fr}}' +
    '.pj-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px}.pj-nav b{font-size:1.05rem;color:var(--pine,#0F2E22)}' +
    '.pj-seg{display:inline-flex;border:1px solid var(--line,#E3E1D8);border-radius:8px;overflow:hidden;background:var(--card,#fff)}.pj-seg button{border:0!important;border-radius:0!important;border-inline-start:1px solid var(--line,#E3E1D8)!important}.pj-seg button:first-child{border-inline-start:0!important}' +
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
    var st = { today: ilToday(), month: ilToday().slice(0, 7), day: ilToday() };
    function draw() { st.today = ilToday(); host.innerHTML = render(getLines() || [], st); }
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-pj-nav],[data-pj-day]'); if (!b) return;
      if (b.dataset.pjNav != null) { var k = +b.dataset.pjNav; st.month = k ? addMonth(st.month, k) : st.today.slice(0, 7); st.day = k ? '' : st.today; }
      else st.day = b.dataset.pjDay;
      draw();
    });
    draw();
    return { redraw: draw };
  }
  var api = { mount: mount, render: render, monthTotals: monthTotals, toneOf: toneOf, addMonth: addMonth };
  root.IshurJournal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
