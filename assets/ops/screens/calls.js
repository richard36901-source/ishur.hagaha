/* Calls today (realtime.calls, Retell calls that started today): dialed / answered / remaining,
   per event. There is no per-call timeline in the API: that stays on calls.html. */
import { esc, fmtN, fmtTime, StatTile, Table, Badge, Skeleton } from '../ui.js';

const ST_HE = { answered: ['ok', 'נענתה'], no_answer: ['skipped', 'לא ענה'], voicemail: ['skipped', 'תא קולי'], busy: ['partial', 'תפוס'], failed: ['failed', 'נכשלה'] };
export function view(rt, names = {}) {
  const c = rt.calls || {};
  const tiles = `<div class="grid g-tiles">
${StatTile({ label: 'חיוגים היום', value: fmtN(c.out), unit: 'מתוך ' + fmtN(c.cap), meter: { value: c.out || 0, max: c.cap || 1 } })}
${StatTile({ label: 'נענו', value: fmtN(c.answered), sub: c.out ? Math.round((c.answered / c.out) * 100) + '% מהחיוגים' : '' })}
${StatTile({ label: 'נשארו להיום', value: fmtN(c.remaining), sub: fmtN(c.queued) + ' בתור' })}
${StatTile({ label: 'חלון שיחות', value: c.window && c.window.open ? 'פתוח' : 'סגור', status: c.window && c.window.open ? 'ok' : 'off', sub: 'בפעימה הבאה: ' + esc(c.why || '—') })}
</div>${!rt.calls ? '<div class="errbox" role="alert"><span>▲</span><span>אין נתוני שיחות (RETELL_KEY חסר)</span></div>' : c.source === 'retell-unreadable' ? '<div class="errbox" role="alert"><span>▲</span><span>רשימת השיחות של Retell לא נקראה. המספרים כאן עשויים להיות חלקיים.</span></div>' : ''}
<div class="sub">${fmtN(c.voicemail)} תא קולי · ${fmtN(c.no_answer)} לא ענו · ${fmtN(c.in_progress)} בשיחה עכשיו · ${fmtN(c.inbound)} נכנסות · ${fmtN(c.callbacks_queued)} חזרות בתור · עלות היום $${(c.cost_usd || 0).toFixed(2)}</div>`;
  const ev = Table({ rows: c.by_event || [], rowKey: (e) => e.token, empty: 'אין שיחות לאירועים היום', columns: [
    { label: 'אירוע', render: (e) => `<b>${esc(names[e.token] || '')}</b> <span class="sub mono">${esc(e.token)}</span>` }, { label: 'חויגו', num: true, render: (e) => fmtN(e.out) }, { label: 'נענו', num: true, render: (e) => fmtN(e.answered) },
    { label: 'נשארו', num: true, render: (e) => fmtN(e.remaining) }, { label: 'למה מחייגים', render: (e) => `<span class="ink2">${esc(e.why)}</span>` }] });
  const tl = !(c.timeline || []).length ? '<div class="empty">ציר השיחות לפי שעה נמצא בלוח השיחות המלא</div>' : `<ul class="tl">${c.timeline.map((t) => { const [s, h] = ST_HE[t.status] || ['skipped', t.status]; return `<li><time class="num">${esc(fmtTime(t.at))}</time><span class="ax" style="box-shadow:inset 0 0 0 2px var(--${s === 'ok' ? 'good' : s === 'failed' ? 'crit' : 'track'})"></span><span><b>${esc(t.event)}</b> <span class="mono sub" dir="ltr">${esc(t.to)}</span> ${Badge(s, h)}${t.duration_s ? ` <span class="sub num">${fmtN(t.duration_s)} שנ׳</span>` : ''}${t.outcome ? ` · <b>${esc(t.outcome)}</b>` : ''}<br><span class="sub">${esc(t.why)}</span></span></li>`; }).join('')}</ul>`;
  return `${tiles}<section class="card flush"><div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">לפי אירוע</h2></div>${ev}</section>
<section class="card"><div class="sec-h"><h2 class="h2">ציר היום</h2><span class="sp"></span><a class="btn ghost sm" href="calls.html">לוח השיחות המלא</a></div>${tl}</section>`;
}
export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.table(6),
  async mount(el, ctx) {
    let rt = ctx.api.cached('realtime')?.data, names = {};
    const c = ctx.api.cached('capacity')?.data; if (c) names = Object.fromEntries(c.days.flatMap((d) => d.by_event.map((e) => [e.tok8, e.name])));
    if (rt) el.innerHTML = view(rt, names);
    rt = await ctx.api.get('realtime'); el.innerHTML = view(rt, names);
    ctx.poll(async () => { rt = await ctx.api.get('realtime'); el.innerHTML = view(rt, names); }, 15000);
  },
};
