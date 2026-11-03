/* Messaging: per number (limit, sent, failed, queued, reason split), per event, recent sends with reason. */
import { esc, fmtN, fmtTime, relTime, Table, Badge, Skeleton, Tabs } from '../ui.js';

export const REASON_HE = { scheduled: 'לפי לוח זמנים', exception: 'חריגה', failed: 'נכשל' };
const QUAL = { GREEN: ['ok', 'ירוק'], YELLOW: ['partial', 'צהוב'], RED: ['failed', 'אדום'] };
export function numberCard(n) {
  const r = n.reasons || {}, tot = Math.max(1, n.cap), pct = (v) => ((v / tot) * 100).toFixed(1) + '%';
  const [qs, qh] = QUAL[n.quality] || ['skipped', n.quality || '—'];
  return `<article class="card"><div class="sec-h"><div><h3 class="h2">${esc(n.label)}</h3><span class="sub mono" dir="ltr">${esc(n.display)}</span></div><span class="sp"></span>${Badge(qs, 'דירוג ' + qh)}</div>
<div class="tile" style="border:0;padding:0;min-height:0"><span class="v">${fmtN(n.sent_today)} <small>מתוך ${fmtN(n.cap)} היום</small></span></div>
<div class="meter" style="height:10px;margin:10px 0 6px" role="img" aria-label="${esc(`לפי לוח ${r.scheduled}, חריגה ${r.exception}, נכשל ${r.failed} מתוך ${n.cap}`)}"><i style="width:${pct(r.scheduled || 0)}"></i><i class="s2" style="width:${pct(r.exception || 0)}"></i><i class="crit" style="width:${pct(r.failed || 0)}"></i></div>
<div class="legend"><span><i></i>לפי לוח ${fmtN(r.scheduled)}</span><span><i style="background:var(--s2)"></i>חריגה ${fmtN(r.exception)}</span><span><i class="over"></i>נכשל ${fmtN(r.failed)}</span></div>
<dl class="kv" style="margin-top:12px"><dt>נשאר היום</dt><dd class="num">${fmtN(Math.max(0, n.cap - n.sent_today))}</dd><dt>בתור</dt><dd class="num">${fmtN(n.queued)}</dd><dt>נשלח לאחרונה</dt><dd>${esc(relTime(n.last_sent_at))}</dd><dt>למי</dt><dd>${n.role === 'client' ? 'לקוחות ולידים בלבד' : 'אורחים בלבד'}</dd></dl></article>`;
}
export const eventsTable = (rows) => Table({ rows, rowKey: (e) => e.token, empty: 'אין שליחות לאירועים היום', columns: [
  { label: 'אירוע', render: (e) => `<b>${esc(e.name)}</b>` }, { label: 'מספר', render: (e) => `<span class="mono">${esc(e.number)}</span>` },
  { label: 'נשלחו', num: true, render: (e) => fmtN(e.sent) }, { label: 'נכשלו', num: true, render: (e) => (e.failed ? `<span style="color:var(--crit-ink)">${fmtN(e.failed)}</span>` : '0') },
  { label: 'בתור', num: true, render: (e) => fmtN(e.queued) }, { label: 'בעיקר', render: (e) => esc(e.reason_top) }] });
export const recentTable = (rows) => Table({ rows, rowKey: (x) => x.at + x.to, empty: 'אין שליחות', columns: [
  { label: 'שעה', render: (x) => `<span class="num">${esc(fmtTime(x.at))}</span>` }, { label: 'למי', render: (x) => `<span class="mono" dir="ltr">${esc(x.to)}</span>` },
  { label: 'אירוע', render: (x) => esc(x.event) }, { label: 'מ', render: (x) => `<span class="mono">${esc(x.number)}</span>` },
  { label: 'סיבה', render: (x) => `<span class="reason ${esc(x.reason)}"><i aria-hidden="true"></i>${esc(REASON_HE[x.reason] || x.reason)}</span>` },
  { label: 'למה', hideM: true, render: (x) => `<span class="ink2">${esc(x.why)}</span>` },
  { label: 'תבנית', hideM: true, render: (x) => `<span class="mono" dir="ltr">${esc(x.template)}</span>` }, { label: 'מצב', render: (x) => Badge(x.status === 'failed' ? 'failed' : 'ok', { sent: 'נשלח', delivered: 'נמסר', read: 'נקרא', failed: 'נכשל' }[x.status]) }] });

export function view(rt, reason = '') {
  const wa = rt.wa || { numbers: [], by_event: [], recent: [] };
  const rec = reason ? wa.recent.filter((x) => x.reason === reason) : wa.recent;
  return `<div class="grid g-3">${wa.numbers.map(numberCard).join('')}</div>
<section class="card flush"><div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">לפי אירוע · היום</h2></div>${eventsTable(wa.by_event)}</section>
<section class="card flush"><div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">שליחות אחרונות</h2><span class="sp"></span>${Tabs({ name: 'reason', value: reason, items: [{ value: '', label: 'הכל' }, { value: 'scheduled', label: 'לפי לוח' }, { value: 'exception', label: 'חריגה' }, { value: 'failed', label: 'נכשל' }] })}</div>${recentTable(rec)}</section>
<p class="sub">לוח השליחה לפי יום נשאר ב-<a href="calendar.html">calendar.html</a>.</p>`;
}

export default {
  skeleton: () => `<div class="grid g-3">${Skeleton.card(6)}${Skeleton.card(6)}${Skeleton.card(6)}</div>${Skeleton.table(6)}`,
  async mount(el, ctx) {
    let rt = ctx.api.cached('realtime')?.data, reason = '';
    const paint = () => { if (rt) el.innerHTML = view(rt, reason); };
    paint();
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'reason') { reason = e.detail.value; paint(); } });
    rt = await ctx.api.get('realtime'); paint();
    ctx.poll(async () => { rt = await ctx.api.get('realtime'); paint(); }, 10000);
  },
};
