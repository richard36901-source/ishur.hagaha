/* כספים (#/finance, g f) · GET /api/ops/finance?range — revenue by kind, P&L + margin per month,
   costs (vendors, fixed monthly editor, ad spend, manual vendor entries), per-event economics,
   invoices (resend behind a typed confirm), cash view, MoM growth + cumulative totals.
   Lazy module (outside the counted budget). Numbers marked "≈" are estimates (see data.estimates). */
import { esc, fmtN, fmtDate, Skeleton, Button, Drawer, confirmTyped, toast, busy } from '../ui.js';
import { ensureCss, stackedBars, lineChart, tableView, ils, pct, signed, rangeSeg, hBars } from './charts.js';

export const KIND_HE = { package: 'חבילות', addon: 'תוספות', hostess: 'דיילות', design: 'עיצוב' };
const VENDOR_HE = { cloudflare: 'Cloudflare', monday: 'Monday', make: 'Make', anthropic: 'Anthropic', telnyx: 'Telnyx', retell: 'Retell', other: 'אחר' };
const LS = 'ops:fin';
const monthHe = (m) => { const [y, mo] = String(m).split('-'); return mo + '/' + String(y).slice(2); };
const tile = (label, value, sub = '') => `<div class="tile"><span class="sub">${esc(label)}</span><b class="num" style="font-size:22px">${value}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

export function tiles(d) {
  const last = d.pnl[d.pnl.length - 1] || {}, gl = d.growth.length, g = d.growth[gl - 1] || {}, gc = (gl > 1 && d.range && g.month === String(d.range.to).slice(0, 7) ? d.growth[gl - 2] : g) || {};
  return `<div class="mny-grid">${tile('הכנסות בטווח', esc(ils(d.revenue.total)), fmtN(d.revenue.payments) + ' תשלומים')}
${tile('רווח נקי החודש (עד היום)', signed(last.net), 'מרווח ' + esc(pct(last.margin_pct)))}
${tile('צמיחה מול חודש קודם', esc(gc.mom_pct == null ? '—' : (gc.mom_pct > 0 ? '+' : '') + fmtN(gc.mom_pct) + '%'), 'חודש מלא אחרון ' + esc(monthHe(gc.month || '')))}
${tile('מצטבר', esc(ils(g.cum_revenue)), 'רווח מצטבר ' + signed(g.cum_net))}
${tile('חובות פתוחים', esc(ils((d.cash.hostess_owed || 0) + (d.cash.meta_ads_owed || 0))), 'דיילות ' + esc(ils(d.cash.hostess_owed)) + ' · מטא ' + esc(ils(d.cash.meta_ads_owed)))}</div>`;
}
export function revenueCard(d, st) {
  const s = d.revenue.series, keys = d.revenue.kinds;
  return `<section class="card"><div class="mny-h"><h2 class="h2">הכנסות ₪ לפי ${d.range.group === 'day' ? 'יום' : d.range.group === 'week' ? 'שבוע' : 'חודש'}</h2><span class="sp"></span>${rangeSeg(st.range)}</div>
${stackedBars(s, keys, { labels: KIND_HE, title: 'הכנסות לפי סוג', xLabel: (b) => (d.range.group === 'month' ? monthHe(b) : fmtDate(b + 'T12:00:00Z')) })}
<p class="sub">${keys.map((k) => esc(KIND_HE[k]) + ' ' + esc(ils(d.revenue.by_kind[k]))).join(' · ')}${d.revenue.entries.some((e) => e.lines.some((l) => l.estimated)) ? ' · <span class="est">≈ פיצול חבילה+דיילות/עיצוב לפי מחירון</span>' : ''}</p>
${tableView([{ he: 'תקופה', k: 'bucket' }, ...keys.map((k) => ({ he: KIND_HE[k], num: true, f: (r) => esc(ils(r[k])) })), { he: 'סה״כ', num: true, f: (r) => esc(ils(r.total)) }, { he: 'תשלומים', k: 'payments', num: true }], s)}</section>`;
}
export function pnlCard(d) {
  const rows = d.pnl;
  const chart = lineChart([{ key: 'rev', label: 'הכנסות', points: rows.map((p) => ({ x: p.month, y: p.revenue })) }, { key: 'cost', label: 'הוצאות', points: rows.map((p) => ({ x: p.month, y: p.costs.total })) }, { key: 'net', label: 'רווח נקי', points: rows.map((p) => ({ x: p.month, y: p.net })) }], { xLabel: monthHe, title: 'רווח והפסד לפי חודש' });
  const tr = (p) => `<tr><td>${esc(monthHe(p.month))}</td><td class="num">${esc(ils(p.revenue))}</td><td class="num">${esc(ils(p.costs.wa))}${p.wa_estimated ? '<span class="est"> ≈</span>' : ''}</td><td class="num">${esc(ils(p.costs.calls))}<span class="est"> ≈</span></td><td class="num">${esc(ils(p.costs.hostess))}</td><td class="num">${esc(ils(p.costs.ads))}</td><td class="num">${esc(ils(p.costs.fixed))}</td><td class="num">${esc(ils(p.costs.manual))}</td><td class="num">${signed(p.gross)}</td><td class="num"><b>${signed(p.net)}</b></td><td class="num">${esc(pct(p.margin_pct))}</td></tr>`;
  return `<section class="card"><div class="mny-h"><h2 class="h2">רווח והפסד ₪ · מרווח לפי חודש</h2></div>${chart}
<div class="mny-scroll"><table class="tbl"><thead><tr><th>חודש</th><th>הכנסות</th><th>וואטסאפ</th><th>שיחות</th><th>דיילות</th><th>פרסום</th><th>קבועות</th><th>ספקים</th><th>גולמי</th><th>נקי</th><th>מרווח</th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table></div>
<p class="sub">גולמי = הכנסות − וואטסאפ − שיחות − דיילות. נקי = גולמי − פרסום − הוצאות קבועות − ספקים ידניים. ≈ = הערכה (₪ = $×${esc(d.usd_ils)}).</p></section>`;
}
export function growthCard(d) {
  const g = d.growth;
  return `<section class="card"><div class="mny-h"><h2 class="h2">צמיחה חודשית ומצטבר</h2></div>${lineChart([{ key: 'cr', label: 'הכנסות מצטברות', points: g.map((x) => ({ x: x.month, y: x.cum_revenue })) }, { key: 'cn', label: 'רווח מצטבר', points: g.map((x) => ({ x: x.month, y: x.cum_net })) }], { xLabel: monthHe, title: 'מצטבר' })}
${tableView([{ he: 'חודש', f: (r) => esc(monthHe(r.month)) }, { he: 'הכנסות', num: true, f: (r) => esc(ils(r.revenue)) }, { he: 'שינוי', num: true, f: (r) => esc(r.mom_pct == null ? '—' : fmtN(r.mom_pct) + '%') }, { he: 'מצטבר', num: true, f: (r) => esc(ils(r.cum_revenue)) }, { he: 'רווח מצטבר', num: true, f: (r) => signed(r.cum_net) }], g)}</section>`;
}
export function costsCard(d, st) {
  const v = d.vendors || {}, m = st.month || (d.pnl[d.pnl.length - 1] || {}).month, p = d.pnl.find((x) => x.month === m) || { fixed_items: [], manual_items: {} };
  const wabas = (v.meta_wa && v.meta_wa.wabas) || [];
  const bars = [...wabas.filter((w) => !w.error).map((w) => ({ label: 'וואטסאפ · ' + w.name, v: (w.spend_mtd || 0) * d.usd_ils })), { label: 'שיחות (Retell+Telnyx)', v: v.calls_mtd_ils || 0 }, ...Object.entries(p.manual_items || {}).map(([k, x]) => ({ label: VENDOR_HE[k] || k, v: +x || 0 }))].sort((a, b) => b.v - a.v);
  const months = d.pnl.map((x) => x.month);
  return `<section class="card"><div class="mny-h"><h2 class="h2">עלויות וספקים</h2><span class="sp"></span><div class="seg" role="tablist" aria-label="חודש">${months.slice(-4).map((x) => `<button type="button" role="tab" data-act="fin-month" data-v="${esc(x)}" aria-selected="${x === m}">${esc(monthHe(x))}</button>`).join('')}</div></div>
<p class="sub">החודש הנוכחי (ספקים מה-API, ≈ ב-₪): ${wabas.map((w) => esc(w.name) + ' ' + (w.error ? 'שגיאה' : '$' + fmtN(w.spend_mtd) + ' · ' + fmtN(w.volume) + ' שיחות')).join(' · ') || 'אין נתוני וואטסאפ'}${v.telnyx ? ' · יתרת Telnyx $' + esc(fmtN(v.telnyx.balance_usd)) : ''}</p>
${hBars(bars)}
<div class="grid g-2" style="margin-top:12px"><div><h3 class="h3">הוצאות קבועות · ${esc(monthHe(m))}</h3>
<div data-fx>${(p.fixed_items.length ? p.fixed_items : [{ name: '', ils: '' }]).map((x, i) => `<div style="display:flex;gap:6px;margin:4px 0"><input class="in" data-fx-name="${i}" value="${esc(x.name)}" placeholder="שם" aria-label="שם ההוצאה" style="flex:1"><input class="in num" data-fx-ils="${i}" value="${esc(x.ils)}" inputmode="decimal" placeholder="₪" aria-label="סכום" style="width:90px"></div>`).join('')}</div>
<div style="display:flex;gap:6px;margin-top:6px">${Button('+ שורה', { size: 'sm', variant: 'ghost', act: 'fx-add' })}${Button('שמירה', { size: 'sm', act: 'fx-save' })}</div></div>
<div><h3 class="h3">פרסום · ${esc(monthHe(m))}</h3><div style="display:flex;gap:6px"><input class="in num" data-ad value="${esc(d.adspend[m] ?? '')}" inputmode="decimal" placeholder="₪" aria-label="הוצאת פרסום לחודש" style="width:110px">${Button('שמירה', { size: 'sm', act: 'ad-save' })}</div><p class="sub">מתעדכן אוטומטית מסקירת המודעות; אפשר לתקן ידנית.</p>
<h3 class="h3" style="margin-top:10px">ספק ידני · ${esc(monthHe(m))}</h3><div class="seg" role="tablist" aria-label="ספק">${(v.manual_vendors || []).map((k) => `<button type="button" role="tab" data-act="mv-pick" data-v="${esc(k)}" aria-selected="${st.vendor === k}">${esc(VENDOR_HE[k] || k)}</button>`).join('')}</div>
<div style="display:flex;gap:6px;margin-top:6px"><input class="in num" data-mv value="${esc((p.manual_items || {})[st.vendor] ?? '')}" inputmode="decimal" placeholder="₪" aria-label="סכום לספק" style="width:110px">${Button('שמירה', { size: 'sm', act: 'mv-save' })}</div></div></div></section>`;
}
export function eventsCard(d) {
  const ev = d.events;
  return `<section class="card"><div class="mny-h"><h2 class="h2">כלכלה לפי אירוע</h2><span class="sub">${fmtN(ev.length)} אירועים ששולמו</span></div><div class="mny-scroll"><table class="tbl"><thead><tr><th>אירוע</th><th>תאריך</th><th>הכנסה</th><th>הודעות ≈</th><th>שיחות</th><th>דיילות</th><th>מרווח</th><th>%</th></tr></thead><tbody>
${ev.map((e) => `<tr data-row><td>${esc(e.name)} <span class="muted mono">${esc(e.tok8)}</span></td><td class="num">${esc(e.date ? fmtDate(e.date + 'T12:00:00Z') : '—')}</td><td class="num">${esc(ils(e.revenue))}</td><td class="num">${esc(ils(e.msgs_cost))}</td><td class="num">${esc(ils(e.calls_cost))}</td><td class="num">${esc(ils(e.hostess_pay))}</td><td class="num"><b>${signed(e.margin)}</b></td><td class="num">${esc(pct(e.margin_pct))}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">אין אירועים ששולמו</td></tr>'}</tbody></table></div></section>`;
}
export function invoicesCard(d) {
  const inv = d.invoices, pend = inv.filter((i) => i.status === 'pending').length;
  return `<section class="card"><div class="mny-h"><h2 class="h2">חשבוניות</h2><span class="badge ${pend ? 'warn' : 'good'}">${pend ? fmtN(pend) + ' ממתינות' : 'הכל הופק'}</span></div><div class="mny-scroll"><table class="tbl"><thead><tr><th>לקוח</th><th>שולם</th><th>סכום</th><th>מצב</th><th>מס׳</th><th></th></tr></thead><tbody>
${inv.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${esc(i.paid_day ? fmtDate(i.paid_day + 'T12:00:00Z') : '—')}</td><td class="num">${esc(ils(i.sum))}</td><td>${i.status === 'issued' ? '<span class="badge good">הופקה</span>' : '<span class="badge warn">ממתינה</span>'}</td><td class="num">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.number || 'קישור')}</a>` : esc(i.number || '—')}</td><td>${i.url ? Button('שליחה חוזרת', { size: 'sm', variant: 'ghost', act: 'inv-resend', attr: { 'data-tok': i.token } }) : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">אין</td></tr>'}</tbody></table></div></section>`;
}
export function view(d, st) {
  return tiles(d) + revenueCard(d, st) + pnlCard(d) + `<div class="grid g-2">${growthCard(d)}${costsCard(d, st)}</div>` + eventsCard(d) + invoicesCard(d)
    + `<p class="sub">הערכות: ${d.estimates.map(esc).join(' · ')}${d.audit_truncated ? ' · יומן התשלומים נחתך, ייתכן חסר' : ''}${d.cached ? ' · מהמטמון' : ''}</p>`;
}

export default {
  skeleton: () => Skeleton.tiles(5) + Skeleton.card(6) + Skeleton.table(8),
  async mount(el, ctx) {
    ensureCss();
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { /* private */ }
    const st = { range: saved.range || '90d', month: '', vendor: 'cloudflare' };
    let data = null;
    const paint = () => { if (data) el.innerHTML = view(data, st); };
    const load = async (fresh) => {
      const c = ctx.api.cached('finance', { range: st.range }); if (c && !data) { data = c.data; paint(); }
      try { data = await ctx.api.get('finance', fresh ? { range: st.range, fresh: '1' } : { range: st.range }); paint(); } catch (e) { if (!data) el.innerHTML = ctx.errorBox(e); }
    };
    ctx.on(el, 'click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act, m = st.month || (data.pnl[data.pnl.length - 1] || {}).month;
      if (act === 'mny-range') { st.range = b.dataset.v; try { localStorage.setItem(LS, JSON.stringify({ range: st.range })); } catch (x) {} data = null; el.innerHTML = Skeleton.tiles(5) + Skeleton.card(6); load(); }
      else if (act === 'fin-month') { st.month = b.dataset.v; paint(); }
      else if (act === 'mv-pick') { st.vendor = b.dataset.v; paint(); }
      else if (act === 'fx-add') { el.querySelector('[data-fx]').insertAdjacentHTML('beforeend', `<div style="display:flex;gap:6px;margin:4px 0"><input class="in" data-fx-name="n" placeholder="שם" aria-label="שם ההוצאה" style="flex:1"><input class="in num" data-fx-ils="n" inputmode="decimal" placeholder="₪" aria-label="סכום" style="width:90px"></div>`); }
      else if (act === 'fx-save') {
        const names = [...el.querySelectorAll('[data-fx-name]')], vals = [...el.querySelectorAll('[data-fx-ils]')];
        const items = names.map((n, i) => ({ name: n.value.trim(), ils: Number(vals[i].value) || 0 })).filter((x) => x.name);
        await busy(b, async () => { await ctx.api.post('/fixedcost', { month: m, items }); toast('נשמר', 'good'); await load(true); });
      } else if (act === 'ad-save') { const v = Number(el.querySelector('[data-ad]').value); if (!Number.isFinite(v)) return; await busy(b, async () => { await ctx.api.post('/adspend', { month: m, ils: v }); toast('נשמר', 'good'); await load(true); }); }
      else if (act === 'mv-save') { const v = Number(el.querySelector('[data-mv]').value); if (!Number.isFinite(v)) return; await busy(b, async () => { await ctx.api.post('finance', { set_manual: { month: m, vendor: st.vendor, ils: v }, range: st.range }); toast('נשמר', 'good'); await load(true); }); }
      else if (act === 'inv-resend') {
        const pre = await ctx.api.post('invoice-resend', { token: b.dataset.tok }).catch((x) => { toast('השרת סירב: ' + x.message, 'crit'); return null; }); if (!pre) return;
        const p = pre.preview || {};
        const ok = await confirmTyped({ title: 'שליחה חוזרת של חשבונית', body: `<p>${esc(p.name)} · <span dir="ltr">${esc(p.phone)}</span></p><p>תבנית <b class="mono">${esc(p.template || 'אין תבנית מאושרת')}</b> עם הקישור <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.number || 'חשבונית')}</a>. נשלח רק בשעות 09:00–21:00.</p>`, word: p.confirm_required, action: 'שלח' });
        if (!ok) return;
        await busy(b, async () => { const r = await ctx.api.post('invoice-resend', { token: b.dataset.tok, confirm: p.confirm_required }, { soft: true }); toast(r.ok ? 'נשלחה' : 'לא נשלחה: ' + (r.he || r.error || ''), r.ok ? 'good' : 'crit'); });
      }
    });
    await load();
    ctx.poll(() => load(), 5 * 60e3);
  },
};
