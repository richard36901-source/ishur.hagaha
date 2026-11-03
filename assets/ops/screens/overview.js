/* Overview: six tiles, 7-day capacity strip, incidents, what runs next.
   Exactly 3 requests on load: realtime, capacity, registry (registry feeds the drill-down links). */
import { esc, fmtN, fmtTime, relTime, StatTile, Skeleton, Badge, Sparkline, statusDot, timeTag } from '../ui.js';
import { capBars, capLegend } from './capacity.js';

export function tiles(rt, reg) {
  const s = rt.summary || {};
  const pacer = reg && reg.nodes.find((n) => n.id === 'd_pacer');
  const fails = reg ? reg.nodes.reduce((a, n) => a.map((v, i) => v + (n.stats ? n.stats.spark_fail_24h[i] : 0)), Array(24).fill(0)) : null;
  return `<div class="grid g-tiles">
${StatTile({ label: 'וואטסאפ לאורחים היום', value: fmtN(s.wa_sent_today), unit: '/ ' + fmtN(s.wa_cap_total), href: '#/messaging', meter: { value: s.wa_sent_today || 0, max: s.wa_cap_total || 1 }, sub: (rt.wa ? rt.wa.numbers.length : 0) + ' מספרים פעילים' })}
${StatTile({ label: 'נשאר בתקרה היום', value: fmtN(s.wa_remaining), status: s.wa_remaining < 100 ? 'partial' : 'ok', href: '#/capacity', sub: 'הודעות שעוד אפשר לשלוח' })}
${StatTile({ label: 'שיחות היום', value: fmtN(s.calls_today), unit: fmtN(s.calls_answered) + ' נענו', href: '#/calls', meter: rt.calls ? { value: rt.calls.out, max: rt.calls.cap } : null, sub: rt.calls ? fmtN(rt.calls.remaining) + ' נשארו · ' + (rt.calls.window.open ? 'החלון פתוח' : 'החלון סגור') : '' })}
${StatTile({ label: 'כשלים ב-24 שעות', value: fmtN(s.failures_24h), status: s.failures_24h ? 'failed' : 'ok', href: '#/runs?status=failed', spark: fails ? Sparkline(fails, { w: 150, h: 22, color: 'var(--crit)', label: 'כשלים לפי שעה, 24 שעות' }) : '' })}
${StatTile({ label: 'תקלות פתוחות', value: fmtN(s.incidents_open), status: s.incidents_open ? 'open' : 'ok', href: '#/brain', sub: s.incidents_open ? 'המוח מטפל או מחכה לך' : 'אין' })}
${StatTile({ label: 'יתרות נמוכות', value: fmtN(s.balances_low), status: s.balances_low ? 'partial' : 'ok', href: '#/balances', sub: s.balances_low ? 'צריך טעינה' : 'הכל מעל הסף' })}
</div>${s.paused ? '<div class="errbox" role="alert"><span>⏸</span><b>השליחה עצורה (paused).</b> אף הודעה ושיחה לא יוצאות.</div>' : ''}${pacer && pacer.stats.last_run ? `<div class="sub">${statusDot(pacer.stats.last_run.status, true)} הפייסר רץ ${esc(relTime(pacer.stats.last_run.at))} · הפעימה הבאה ${esc(fmtTime(pacer.next_fire))}</div>` : ''}`;
}
export function incidents(list) {
  if (!list || !list.length) return '<div class="empty">אין תקלות. הכל רץ.</div>';
  return `<ul class="tl">${list.map((i) => `<li><span>${timeTag(i.at)}</span><span class="ax" style="box-shadow:inset 0 0 0 2px var(--${i.status === 'resolved' ? 'good' : i.severity === 'P1' ? 'crit' : 'serious'})"></span><span><a href="#/automations/${esc(i.automation_id)}" style="color:inherit;text-decoration:none"><b>${esc(i.title)}</b></a><br>${Badge(i.severity)} ${Badge(i.status)}</span></li>`).join('')}</ul>`;
}
export function nextUp(list) {
  if (!list || !list.length) return '<div class="empty">אין ריצות מתוכננות</div>';
  return `<ul class="tl">${list.map((n) => `<li><time class="num">${esc(fmtTime(n.at))}</time><span class="ax"></span><span><a href="#/automations/${esc(n.automation_id)}" style="color:inherit;text-decoration:none"><b>${esc(n.name)}</b></a><br><span class="sub">${esc(n.what)}</span></span></li>`).join('')}</ul>`;
}
export function view(rt, cap, reg) {
  return `<section aria-label="מדדים">${rt ? tiles(rt, reg) : Skeleton.tiles(6)}</section>
<section class="card"><div class="sec-h"><h2 class="h2">קיבולת · 7 ימים</h2><span class="sp"></span>${capLegend()}<a class="btn ghost sm" href="#/capacity">14 יום</a></div><div id="ov-cap">${cap ? capBars(cap.days.slice(0, 7), { compact: true, h: 150 }) : Skeleton.lines(4)}</div></section>
<div class="grid g-2">
<section class="card"><div class="sec-h"><h2 class="h2">תקלות</h2><span class="sp"></span><a class="btn ghost sm" href="#/brain">למוח</a></div>${rt ? incidents(rt.incidents) : Skeleton.lines(5)}</section>
<section class="card"><div class="sec-h"><h2 class="h2">מה רץ בהמשך</h2><span class="sp"></span><a class="btn ghost sm" href="#/automations">כל האוטומציות</a></div>${rt ? nextUp(rt.next) : Skeleton.lines(5)}</section>
</div>`;
}

export default {
  skeleton: () => view(null, null, null),
  async mount(el, ctx) {
    let rt = ctx.api.cached('realtime')?.data, cap = ctx.api.cached('capacity')?.data, reg = ctx.api.cached('registry')?.data;
    const paint = () => { el.innerHTML = view(rt, cap, reg); ctx.setBadge('overview', rt ? rt.summary.incidents_open : 0); ctx.setBadge('balances', rt ? rt.summary.balances_low : 0); };
    if (rt || cap) paint();
    /* independent fetches, each paints when it lands (no waterfall); registry is the heavy one */
    const [a] = await Promise.allSettled([
      ctx.api.get('realtime').then((d) => { rt = d; paint(); }),
      ctx.api.get('capacity').then((d) => { cap = d; paint(); }),
      ctx.api.get('registry').then((d) => { reg = d; paint(); }),
    ]);
    if (a.status === 'rejected') el.insertAdjacentHTML('afterbegin', ctx.errorBox(a.reason));
    ctx.poll(async () => { rt = await ctx.api.get('realtime'); paint(); }, 15000);
  },
};
