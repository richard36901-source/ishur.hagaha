/* פרסום (#/ads, g p) · GET /api/ops/ads?range — campaigns → ad sets → ads with spend, leads, CPL and
   ROAS (revenue from CRM leads attributed to the campaign that closed ÷ spend), blended ROAS, site traffic.
   Shalev's campaign 120250670197650731 is shown read-only and labelled (no action buttons on this screen
   at all: every ad change still goes through Ads Manager). Lazy module. */
import { esc, fmtN, Skeleton, thSort, savedSort } from '../ui.js';
import { ensureCss, ils, pct, rangeSeg, hBars, lineChart, tableView } from './charts.js';

const LS = 'ops:ads';
const roasTxt = (v) => (v == null ? '—' : '×' + fmtN(v));
const roasTone = (v) => (v == null ? '' : v >= 3 ? 'good' : v >= 2 ? 'warn' : 'crit');
const tile = (label, value, sub = '') => `<div class="tile"><span class="sub">${esc(label)}</span><b class="num" style="font-size:22px">${value}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

export function tiles(d) {
  const t = d.totals;
  return `<div class="mny-grid">${tile('הוצאה', esc(ils(t.spend)))}${tile('לידים (מטא)', esc(fmtN(t.leads)), 'CPL ' + esc(ils(t.cpl)))}
${tile('ROAS משויך', `<span class="badge ${roasTone(t.roas_attributed)}">${esc(roasTxt(t.roas_attributed))}</span>`, esc(fmtN(t.closed)) + ' סגרו · ' + esc(ils(t.revenue)))}
${tile('ROAS כולל', `<span class="badge ${roasTone(d.blended.roas)}">${esc(roasTxt(d.blended.roas))}</span>`, 'כל ההכנסות ÷ כל ההוצאה · יעד ×3–4')}</div>`;
}
/* Campaign comparison (Richard 03/11 20:40): one row per campaign (ad sets expand under it), every column sorts
   (saved per table), totals in the footer. Fields come from worker/ops-money.js adsTree; older payloads without
   the funnel fields are derived here from crm_leads / closed / revenue. */
const ec = (o) => {
  const base = o.crm_leads || 0, cl = o.closed || 0;
  return { base, quoted: o.quoted ?? null, closed: cl, close: o.close_rate_pct ?? (base ? Math.round(1000 * cl / base) / 10 : null),
    cpc: o.cost_per_closed ?? (cl ? o.spend / cl : null), deal: o.avg_deal ?? (cl && o.revenue != null ? o.revenue / cl : null), gross: o.avg_gross ?? null, roas: o.roas ?? o.roas_attributed ?? null };
};
export const COLS = ['קמפיין', 'הוצאה', 'חשיפות', 'קליקים', 'לידים (מטא)', 'CPL', 'לידים → הצעה → סגירה', 'אחוז סגירה', 'עלות ללקוח שסגר', 'עסקה ממוצעת', 'רווח גולמי ללקוח', 'ROAS'];
const cells = (o, name) => { const e = ec(o); return [
  [name, o.name], [esc(ils(o.spend)), o.spend], [esc(fmtN(o.impressions)), o.impressions], [esc(fmtN(o.clicks)), o.clicks], [esc(fmtN(o.leads)), o.leads], [esc(ils(o.cpl)), o.cpl ?? ''],
  [o.crm_leads != null ? `<span class="num">${fmtN(e.base)} → ${e.quoted == null ? '—' : fmtN(e.quoted)} → ${fmtN(e.closed)}</span>` : '—', e.closed], [esc(pct(e.close)), e.close ?? ''],
  [esc(ils(e.cpc)), e.cpc ?? ''], [esc(ils(e.deal)), e.deal ?? ''], [esc(ils(e.gross)), e.gross ?? ''], [e.roas == null ? '—' : `<span class="badge ${roasTone(e.roas)}">${esc(roasTxt(e.roas))}</span>`, e.roas ?? '']]; };
const tr = (o, name, lvl, key) => `<tr${key ? ` data-row="${esc(key)}"` : ''} class="lvl-${lvl}">${cells(o, name).map(([h, v], i) => `<td class="${i ? 'n' : ''}" data-sv="${esc(v == null ? '' : v)}"${!i && lvl ? ` style="padding-inline-start:${14 + lvl * 18}px"` : ''}>${h}</td>`).join('')}</tr>`;
export function treeTable(d, open) {
  const st = savedSort('ads:compare');
  const body = d.campaigns.map((c) => {
    const tag = c.read_only ? ` <span class="badge info" title="קמפיין של שלו · לקריאה בלבד">של ${esc(c.owner || 'שלו')} · קריאה בלבד</span>` : '';
    const btn = c.adsets && c.adsets.length ? ` <button type="button" class="btn ghost sm" data-act="ads-open" data-id="${esc(c.id)}" aria-expanded="${open.has(c.id)}">${open.has(c.id) ? 'סגירה' : c.adsets.length + ' סטים'}</button>` : '';
    return tr(c, `<b>${esc(c.name)}</b>${tag}${btn}`, 0, c.id) + (open.has(c.id) ? c.adsets.map((s) => tr(s, esc(s.name), 1)).join('') : '');
  }).join('');
  const t = d.totals || {};
  const foot = d.campaigns.length ? `<tfoot><tr class="tot">${cells({ ...t, name: 'סה״כ', impressions: t.impressions ?? d.campaigns.reduce((a, c) => a + (c.impressions || 0), 0), clicks: t.clicks ?? d.campaigns.reduce((a, c) => a + (c.clicks || 0), 0), crm_leads: t.crm_leads ?? d.campaigns.reduce((a, c) => a + (c.crm_leads || 0), 0) }, '<b>סה״כ</b>').map(([h], i) => `<td class="${i ? 'n' : ''}">${h}</td>`).join('')}</tr></tfoot>` : '';
  return `<section class="card flush"><div class="sec-h"><h2 class="h2">השוואת קמפיינים</h2><span class="sp"></span><span class="sub">לחצו על כותרת כדי למיין</span></div><div class="tbl-wrap"><table class="tbl ads-cmp" data-sort-id="ads:compare" data-sort-dom><thead><tr>${COLS.map((h, i) => thSort(h, i, st, i ? 'n' : '')).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${COLS.length}" class="muted">אין נתוני מטא בטווח${d.meta_error ? ' · ' + esc(d.meta_error) : ''}</td></tr>`}</tbody>${foot}</table></div>
<p class="sub" style="padding:0 20px 16px">ROAS = הכנסות מלידים שסגרו (לפי origin.campaign) ÷ הוצאה. רווח גולמי = עסקה פחות עלות וואטסאפ, שיחות ודיילות של אותו לקוח. לידים מטופס מטא בלי קמפיין: ${esc(fmtN(d.unattributed.leads))} (${esc(fmtN(d.unattributed.closed))} סגרו, ${esc(ils(d.unattributed.revenue))}).</p></section>`;
}
export function cplCard(d) {
  const items = d.campaigns.filter((c) => c.cpl != null).map((c) => ({ label: c.name + (c.read_only ? ' (שלו)' : ''), v: c.cpl })).sort((a, b) => a.v - b.v);
  return `<section class="card"><div class="mny-h"><h2 class="h2">עלות לליד לפי קמפיין</h2></div>${items.length ? hBars(items) : '<p class="muted">אין לידים בטווח</p>'}</section>`;
}
export function trafficCard(d) {
  const t = d.traffic; const days = t && t.days && typeof t.days === 'object' ? (Array.isArray(t.days) ? t.days : Object.entries(t.days).map(([day, v]) => ({ day, ...v }))) : [];
  if (!days.length) return `<section class="card"><h2 class="h2">תנועה לאתר</h2><p class="muted">אין נתוני תנועה</p></section>`;
  const pts = days.map((x) => ({ day: x.day || x.date, views: x.views || 0, visitors: x.visitors || 0, pay: x.pay || 0 })).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return `<section class="card"><div class="mny-h"><h2 class="h2">תנועה לאתר</h2><span class="sub">מונה משלנו</span></div>${lineChart([{ key: 'v', label: 'מבקרים', points: pts.map((p) => ({ x: p.day, y: p.visitors })) }, { key: 'p', label: 'הגיעו לתשלום', points: pts.map((p) => ({ x: p.day, y: p.pay })) }], { fmt: (v) => fmtN(Math.round(v)), title: 'מבקרים לפי יום' })}
${tableView([{ he: 'יום', k: 'day' }, { he: 'צפיות', k: 'views', num: true }, { he: 'מבקרים', k: 'visitors', num: true }, { he: 'לתשלום', k: 'pay', num: true }], pts)}</section>`;
}
export function view(d, st) {
  return `<div class="mny-h"><span class="sp"></span>${rangeSeg(st.range, [['7d', '7 יום'], ['30d', '30 יום'], ['90d', '90 יום']])}</div>` + tiles(d) + treeTable(d, st.open) + `<div class="grid g-2">${cplCard(d)}${trafficCard(d)}</div>` + (d.cached ? '<p class="sub">מהמטמון (10 דק׳)</p>' : '');
}
export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.table(8),
  async mount(el, ctx) {
    ensureCss();
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { /* private */ }
    const st = { range: saved.range || '30d', open: new Set() };
    let data = null;
    const paint = () => { if (data) el.innerHTML = view(data, st); };
    const load = async () => { try { data = await ctx.api.get('ads', { range: st.range }); paint(); } catch (e) { if (!data) el.innerHTML = ctx.errorBox(e); } };
    ctx.on(el, 'click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b || b.dataset.act === 'sort') return;
      if (b.dataset.act === 'mny-range') { st.range = b.dataset.v; try { localStorage.setItem(LS, JSON.stringify({ range: st.range })); } catch (x) {} data = null; el.innerHTML = Skeleton.tiles(4) + Skeleton.table(8); load(); }
      else if (b.dataset.act === 'ads-open') { const id = b.dataset.id; if (st.open.has(id)) st.open.delete(id); else st.open.add(id); paint(); }
    });
    const c = ctx.api.cached('ads', { range: st.range }); if (c) { data = c.data; paint(); }
    await load();
    ctx.poll(load, 10 * 60e3);
  },
};
