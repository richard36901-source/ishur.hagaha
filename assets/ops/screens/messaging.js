/* Messaging: per number (tier limit, sent, failed by Meta code, reason split), per event, recent sends.
   Numbers + per-event come from realtime; event names from the cached capacity response (tok8 → name);
   recent sends from the live feed (wa_out / wa_status audit rows). */
import { esc, fmtN, fmtTime, relTime, Table, Badge, Skeleton, Tabs } from '../ui.js';
import { REASON_HE as WHY_REASON } from '../adapt.js';

export const REASON_HE = { scheduled: 'לפי לוח זמנים', exception: 'מענה / ידני', failed: 'נכשל' };
const QUAL = { GREEN: ['ok', 'ירוק'], YELLOW: ['partial', 'צהוב'], RED: ['failed', 'אדום'] };
export function numberCard(n) {
  const r = n.reasons || {}, tot = Math.max(1, n.cap), pct = (v) => ((v / tot) * 100).toFixed(1) + '%';
  const [qs, qh] = QUAL[n.quality] || ['skipped', n.quality || '—'];
  return `<article class="card"><div class="sec-h"><div><h3 class="h2">${esc(n.label)}</h3><span class="sub mono" dir="ltr">${esc(n.tier || n.role)}</span></div><span class="sp"></span>${Badge(qs, 'דירוג ' + qh)}</div>
<div class="tile" style="border:0;padding:0;min-height:0"><span class="v">${fmtN(n.sent_today)} <small>${n.limit != null ? 'נשלחו היום · תקרה ' + fmtN(n.limit) : 'נשלחו היום'}</small></span></div>
<div class="meter" style="height:10px;margin:10px 0 6px" role="img" aria-label="${esc(`לפי לוח ${r.scheduled}, חריגה ${r.exception}, נכשל ${r.failed} מתוך ${n.cap}`)}"><i style="width:${pct(r.scheduled || 0)}"></i><i class="s2" style="width:${pct(r.exception || 0)}"></i><i class="crit" style="width:${pct(r.failed || 0)}"></i></div>
<div class="legend"><span><i></i>לפי לוח ${fmtN(r.scheduled)}</span><span><i style="background:var(--s2)"></i>חריגה ${fmtN(r.exception)}</span><span><i class="over"></i>נכשל ${fmtN(r.failed)}</span></div>
<dl class="kv" style="margin-top:12px">${n.role === 'guests' ? `<dt>ב-24 שעות</dt><dd class="num">${fmtN(n.used_24h)} / ${fmtN(n.limit)} · נשאר ${fmtN(n.remaining)}</dd>${n.frees_at ? `<dt>מתפנה</dt><dd class="num">${esc(fmtTime(n.frees_at))}</dd>` : ''}${n.held ? `<dt>מוחזק</dt><dd>עד ${esc(fmtTime(n.held_until))}</dd>` : ''}` : ''}<dt>כשלים</dt><dd class="num">${fmtN(n.rejected_today)} נדחו · ${fmtN(n.failed_async_today)} נכשלו${Object.keys(n.failed_by_code || {}).length ? ` <span class="sub mono" dir="ltr">${esc(Object.entries(n.failed_by_code).map(([c, k]) => c + '×' + k).join(' '))}</span>` : ''}</dd><dt>סיבות</dt><dd>${esc(Object.entries(n.by_reason || {}).map(([k, v]) => (WHY_REASON[k] || k) + ' ' + v).join(' · ') || '—')}</dd><dt>למי</dt><dd>${n.role === 'client' ? 'לקוחות ולידים בלבד' : 'אורחים בלבד'}</dd></dl></article>`;
}
export const eventsTable = (rows, names = {}) => Table({ rows, rowKey: (e) => e.token, empty: 'אין שליחות לאירועים היום', columns: [
  { label: 'אירוע', render: (e) => (e.token === '—' ? '<span class="muted">בלי אירוע (מענה / לקוח)</span>' : `<b>${esc(names[e.token] || '')}</b> <span class="sub mono">${esc(e.token)}</span>`) }, { label: 'מספר', render: (e) => esc(e.number) },
  { label: 'נשלחו', num: true, render: (e) => fmtN(e.sent) }, { label: 'בעיקר', render: (e) => esc(e.reason_top) }] });
const STATUS_RE = [[/נכשל|❌|failed/, 'failed'], [/נקרא|👁/, 'read'], [/נמסר|✅|delivered/, 'delivered']];
/* live-feed rows → recent sends: wa_out = sent (ok:false = Meta refused), wa_status = a status update */
export const recentFromLive = (items) => items.filter((x) => x.kind === 'wa_out' || x.kind === 'wa_status').map((x) => {
  const st = x.ok === false ? 'failed' : x.kind === 'wa_out' ? 'sent' : (STATUS_RE.find(([re]) => re.test(x.action)) || [0, 'sent'])[1];
  return { id: x.id, at: x.at, to: ((x.action || '').match(/\d[\d*]{6,}/) || [''])[0], number: x.area || '', event: x.token ? x.token.slice(0, 8) : '', kind: x.kind, status: st, reason: st === 'failed' ? 'failed' : '' };
});
export const recentTable = (rows, names = {}) => Table({ rows, rowKey: (x) => x.id, empty: 'אין שליחות בלוג החי', columns: [
  { label: 'שעה', render: (x) => `<span class="num">${esc(fmtTime(x.at))}</span>` }, { label: 'למי', render: (x) => `<span class="mono" dir="ltr">${esc(x.to)}</span>` },
  { label: 'אירוע', render: (x) => esc(names[x.event] || x.event || '—') }, { label: 'מ', render: (x) => esc(x.number) },
  { label: 'סוג', hideM: true, render: (x) => `<span class="badge">${x.kind === 'wa_out' ? 'שליחה' : 'סטטוס'}</span>` },
  { label: 'מצב', render: (x) => Badge(x.status === 'failed' ? 'failed' : 'ok', { sent: 'נשלח', delivered: 'נמסר', read: 'נקרא', failed: 'נכשל' }[x.status]) }] });

export function view(rt, reason = '', names = {}, recent = null) {
  const wa = rt.wa || { numbers: [], by_event: [] };
  const all = recent || [], rec = reason ? all.filter((x) => x.reason === reason) : all;
  return `<div class="grid g-3">${wa.numbers.map(numberCard).join('')}</div>
<section class="card flush"><div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">לפי אירוע · היום</h2></div>${eventsTable(wa.by_event, names)}</section>
<section class="card flush"><div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">שליחות אחרונות</h2><span class="sp"></span>${Tabs({ name: 'reason', value: reason, items: [{ value: '', label: 'הכל' }, { value: 'failed', label: 'נכשל' }] })}</div>${recent ? recentTable(rec, names) : Skeleton.lines(4)}</section>
<p class="sub">לוח השליחה לפי יום נשאר ב-<a href="calendar.html">calendar.html</a>.</p>`;
}

export default {
  skeleton: () => `<div class="grid g-3">${Skeleton.card(6)}${Skeleton.card(6)}${Skeleton.card(6)}</div>${Skeleton.table(6)}`,
  async mount(el, ctx) {
    let rt = ctx.api.cached('realtime')?.data, reason = '', recent = null;
    const capNames = (c) => (c ? Object.fromEntries(c.days.flatMap((d) => d.by_event.map((e) => [e.tok8, e.name])).concat(c.recommendations.map((r) => [r.tok8, r.name]))) : {});
    let names = capNames(ctx.api.cached('capacity')?.data);
    const paint = () => { if (rt) el.innerHTML = view(rt, reason, names, recent); };
    paint();
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'reason') { reason = e.detail.value; paint(); } });
    const loadRecent = () => ctx.api.get('live', { limit: 200 }, { cache: false }).then((d) => { recent = recentFromLive(d.items); paint(); }).catch(() => { recent = []; paint(); });
    rt = await ctx.api.get('realtime'); paint();
    if (!Object.keys(names).length) ctx.api.get('capacity').then((c) => { names = capNames(c); paint(); }).catch(() => {});
    loadRecent();
    ctx.poll(async () => { rt = await ctx.api.get('realtime'); paint(); }, 10000);
    ctx.poll(loadRecent, 30000);
  },
};
