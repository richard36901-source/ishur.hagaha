/* Balances: one card per vendor — amount vs low threshold, source (api/manual) + staleness,
   auto top-up state, top-up link. */
import { esc, fmtN, fmtMoney, relTime, Badge, Skeleton, icon } from '../ui.js';

/* the server decides "low" (amount < low_threshold, or Retell's billing guard tripped) */
export const isLow = (v) => v.status === 'low';
const AUTO = { true: ['ok', 'טעינה אוטומטית פעילה'], false: ['partial', 'אין טעינה אוטומטית'], unknown: ['skipped', 'טעינה אוטומטית: לא ידוע'] };
export function card(v) {
  const low = isLow(v), stale = !v.as_of || Date.now() - Date.parse(v.as_of) > (v.source === 'manual' ? 3 : 0.5) * 864e5;
  const [as, ah] = AUTO[String(v.auto_topup)] || AUTO.unknown;
  const main = v.amount != null ? fmtMoney(v.amount, v.currency) : v.spent_month != null ? fmtMoney(v.spent_month, v.currency) : v.usage_requests != null ? fmtN(v.usage_requests) : '—';
  const sub = v.amount == null && v.spent_month != null ? 'הוצאה החודש' : v.usage_requests != null ? 'בקשות החודש' : v.low_threshold != null ? 'סף התראה ' + fmtMoney(v.low_threshold, v.currency) : '';
  const meter = v.amount != null && v.low_threshold ? `<div class="meter" style="margin:8px 0" aria-hidden="true"><i class="${low ? 'crit' : ''}" style="width:${Math.min(100, (v.amount / (v.low_threshold * 4)) * 100).toFixed(1)}%"></i></div>` : v.usage_pct != null ? `<div class="meter" style="margin:8px 0" aria-hidden="true"><i style="width:${v.usage_pct}%"></i></div>` : '';
  return `<article class="card" style="${low ? 'border-color:color-mix(in srgb,var(--crit) 45%,transparent)' : ''}"><div class="sec-h"><h3 class="h2">${esc(v.label)}</h3><span class="sp"></span>${low ? Badge('failed', 'נמוך') : Badge('ok', 'תקין')}</div>
<div class="tile" style="border:0;padding:0;min-height:0"><span class="v">${main}</span><span class="s">${sub}</span></div>${meter}
<div class="chips" style="margin:6px 0 10px">${Badge(as, ah)} <span class="badge ${stale ? 'warn' : ''}" title="${esc(v.as_of)}">${v.source === 'manual' ? 'ידני' : 'API'} · ${v.as_of ? esc(relTime(v.as_of)) : 'לא הוזן'}</span>${v.status === 'error' ? ' ' + Badge('failed', 'שגיאת קריאה') : ''}</div>
${v.note ? `<p class="sub" style="margin:0 0 10px">${esc(v.note)}</p>` : ''}
<a class="btn ${low ? 'primary' : ''}" href="${esc(v.topup_url)}" target="_blank" rel="noopener noreferrer">${low ? 'לטעון עכשיו' : 'לדף החיוב'} ${icon('ext')}</a></article>`;
}
export const view = (d) => {
  const vs = d.vendors || [], low = vs.filter(isLow);
  return `${low.length ? `<div class="errbox" role="alert"><span>▲</span><span>${low.length} ספקים מתחת לסף: <b>${esc(low.map((v) => v.label).join(', '))}</b></span></div>` : ''}<div class="grid g-3">${vs.map(card).join('')}</div>
<p class="sub">ספק בלי API ליתרה מוצג כ״ידני״ עם התאריך שבו עודכן. מעל 3 ימים זה מסומן בצהוב.</p>`;
};
export default {
  skeleton: () => `<div class="grid g-3">${Array.from({ length: 6 }, () => Skeleton.card(5)).join('')}</div>`,
  async mount(el, ctx) {
    const c = ctx.api.cached('balances'); if (c) el.innerHTML = view(c.data);
    const d = await ctx.api.get('balances'); el.innerHTML = view(d);
    ctx.setBadge('balances', (d.vendors || []).filter(isLow).length);
    ctx.poll(async () => { el.innerHTML = view(await ctx.api.get('balances')); }, 120000);
  },
};
