/* Overview: six tiles, 7-day capacity strip, incidents, what runs next.
   Exactly 3 requests on load: realtime, capacity, balances. There is no incidents endpoint:
   incidents are derived in adapt.js from realtime (pacer/cap/number/Noa/Retell signals),
   capacity (overflow days) and balances (status "low"). "What runs next" is the pacer's
   next tick from realtime.queue. The registry is not needed here. */
import { esc, fmtN, fmtTime, relTime, StatTile, Skeleton, Badge, statusDot, timeTag } from '../ui.js';
import { capMeters } from './capacity.js';
import { capacityIncidents, balanceIncidents } from '../adapt.js';

export function tiles(rt, bal, incidentsN) {
  const s = rt.summary || {}, lowN = bal ? bal.vendors.filter((v) => v.low).length : null, p = rt.pacer || {};
  return `<div class="grid g-tiles">
${StatTile({ label: 'וואטסאפ לאורחים היום', value: fmtN(s.wa_sent_today), unit: '/ ' + fmtN(s.wa_cap_total), href: '#/messaging', meter: { value: s.wa_sent_today || 0, max: s.wa_cap_total || 1 }, sub: (rt.wa ? rt.wa.numbers.length : 0) + ' מספרים פעילים' })}
${StatTile({ label: 'נשאר בתקרה היום', value: fmtN(s.wa_remaining), status: s.wa_remaining < 100 ? 'partial' : 'ok', href: '#/capacity', sub: 'הודעות שעוד אפשר לשלוח' })}
${StatTile({ label: 'שיחות היום', value: fmtN(s.calls_today), unit: fmtN(s.calls_answered) + ' נענו', href: '#/calls', meter: rt.calls ? { value: rt.calls.out, max: rt.calls.cap } : null, sub: rt.calls ? fmtN(rt.calls.remaining) + ' נשארו · ' + (rt.calls.window.open ? 'החלון פתוח' : 'החלון סגור') : '' })}
${StatTile({ label: 'כשלי וואטסאפ היום', value: fmtN(s.failures_today), status: s.failures_today ? 'failed' : 'ok', href: '#/messaging', sub: 'נדחו + נכשלו אחרי שליחה' })}
${StatTile({ label: 'תקלות פתוחות', value: fmtN(incidentsN), status: incidentsN ? 'open' : 'ok', href: '#/overview', sub: incidentsN ? 'מחושב מהמדדים, למטה' : 'אין' })}
${StatTile({ label: 'יתרות נמוכות', value: lowN == null ? '…' : fmtN(lowN), status: lowN ? 'partial' : 'ok', href: '#/balances', sub: lowN == null ? 'טוען' : lowN ? 'צריך טעינה' : 'הכל מעל הסף' })}
</div>${s.paused ? '<div class="errbox" role="alert"><span>⏸</span><b>השליחה עצורה (paused או הפייסר כבוי).</b> אף הודעה ושיחה לא יוצאות.</div>' : ''}${p.last_tick_at ? `<div class="sub">${statusDot('ok', !s.paused)} הפייסר רץ ${esc(relTime(p.last_tick_at))} · הפעימה הבאה ${esc(fmtTime(rt.queue && rt.queue.next_tick_at))}</div>` : ''}`;
}
export function incidents(list) {
  if (!list || !list.length) return '<div class="empty">אין תקלות. הכל רץ.</div>';
  return `<ul class="tl">${list.map((i) => `<li><span>${timeTag(i.at)}</span><span class="ax" style="box-shadow:inset 0 0 0 2px var(--${i.status === 'resolved' ? 'good' : i.severity === 'P1' ? 'crit' : 'serious'})"></span><span><a href="#/automations/${esc(i.automation_id)}" style="color:inherit;text-decoration:none"><b>${esc(i.title)}</b></a><br>${Badge(i.severity)} ${Badge(i.status)}</span></li>`).join('')}</ul>`;
}
export function nextUp(list) {
  if (!list || !list.length) return '<div class="empty">אין ריצות מתוכננות</div>';
  return `<ul class="tl">${list.map((n) => `<li><time class="num">${esc(fmtTime(n.at))}</time><span class="ax"></span><span><a href="#/automations/${esc(n.automation_id)}" style="color:inherit;text-decoration:none"><b>${esc(n.name)}</b></a><br><span class="sub">${esc(n.what)}</span></span></li>`).join('')}</ul>`;
}
export const allIncidents = (rt, cap, bal) => (rt ? rt.incidents : []).concat(capacityIncidents(cap), balanceIncidents(bal)).sort((a, b) => a.severity.localeCompare(b.severity));
export function view(rt, cap, bal) {
  const inc = allIncidents(rt, cap, bal);
  return `<section aria-label="מדדים">${rt ? tiles(rt, bal, inc.length) : Skeleton.tiles(6)}</section>
<section class="card"><div class="sec-h"><h2 class="h2">קיבולת · 7 ימים</h2><span class="sp"></span><a class="btn ghost sm" href="#/messages?tab=capacity">14 יום</a></div><div id="ov-cap">${cap ? capMeters(cap.days.slice(0, 7), { compact: true }) : Skeleton.lines(7)}</div></section>
<div class="grid g-2">
<section class="card"><div class="sec-h"><h2 class="h2">תקלות</h2><span class="sp"></span><a class="btn ghost sm" href="#/messaging">להודעות</a></div>${rt ? incidents(inc) : Skeleton.lines(5)}</section>
<section class="card"><div class="sec-h"><h2 class="h2">בפעימה הבאה</h2><span class="sp"></span><a class="btn ghost sm" href="#/automations">כל האוטומציות</a></div>${rt ? nextUp(rt.next) : Skeleton.lines(5)}</section>
</div>`;
}

/* Phase 5: the smart overview lives in lazy/overview2.js (GET /api/ops/overview). This classic view stays as the
   fallback when that endpoint is missing (backend not deployed yet). */
const classic = {
  skeleton: () => view(null, null, null),
  async mount(el, ctx) {
    let rt = ctx.api.cached('realtime')?.data, cap = ctx.api.cached('capacity')?.data, bal = ctx.api.cached('balances')?.data;
    const paint = () => { el.innerHTML = view(rt, cap, bal); ctx.setBadge('overview', rt ? allIncidents(rt, cap, bal).length : 0); ctx.setBadge('balances', bal ? bal.vendors.filter((v) => v.low).length : 0); };
    if (rt || cap) paint();
    /* independent fetches, each paints when it lands (no waterfall) */
    const [a] = await Promise.allSettled([
      ctx.api.get('realtime').then((d) => { rt = d; paint(); }),
      ctx.api.get('capacity').then((d) => { cap = d; paint(); }),
      ctx.api.get('balances').then((d) => { bal = d; paint(); }),
    ]);
    if (a.status === 'rejected') el.insertAdjacentHTML('afterbegin', ctx.errorBox(a.reason));
    /* CRM "היום" + charts: lazy, after the 3 ops requests (crm/today.js) */
    setTimeout(() => el.isConnected && import('../crm/today.js').then((m) => m.mount(el, ctx)), 1500);
    ctx.poll(async () => { rt = await ctx.api.get('realtime'); paint(); }, 15000);
  },
};
export default {
  skeleton: () => view(null, null, null),
  async mount(el, ctx) {
    try { const m = await import('../lazy/overview2.js'); el.innerHTML = m.default.skeleton(); await m.default.mount(el, ctx); }
    catch (e) { await classic.mount(el, ctx); }
  },
};
