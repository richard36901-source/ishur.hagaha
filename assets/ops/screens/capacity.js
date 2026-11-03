/* Capacity planner (/api/ops/capacity): next 14 days of guest WhatsApp, planned vs capacity,
   recommendations, over-capacity alerts. The API plans messages only; calls get no chart. */
import { esc, fmtN, fmtDate, Skeleton, Badge, Table } from '../ui.js';

/* Bars (messages): capacity = neutral track, primary = the ROLLED plan (what will actually go out once the
   planner spreads overflow over the next open days), thin outline = the original due amount. Calls: due only. */
const sumBy = (xs, k) => { const m = {}; for (const x of xs) m[x[k]] = (m[x[k]] || 0) + x.n; return Object.entries(m); };
export const outTip = (d) => !d.rolled ? '' : ' · יוצא: ' + fmtN(d.out) + (d.rolled.length ? ' (' + sumBy(d.rolled, 'event').map(([e, n]) => e + ' ' + fmtN(n)).join(' + ') + ')' : '') + sumBy(d.rolled.filter((x) => x.from_day < d.day), 'from_day').map(([f, n]) => ' · נדחה מ-' + fmtDate(f) + ': ' + fmtN(n)).join('');
export function capBars(days, { metric = 'wa', h = 180, compact = false } = {}) {
  const wa = metric === 'wa', capK = wa ? 'capacity_wa' : 'capacity_calls', planK = wa ? 'planned_wa' : 'planned_calls';
  const n = days.length, w = compact ? 560 : 900, padB = 34, padT = 18, slot = w / n, bw = Math.min(compact ? 40 : 34, slot * 0.62);
  const max = Math.max(1, ...days.map((d) => Math.max(d[capK], d[planK]))) * 1.08;
  const y = (v) => h - padB - (v / max) * (h - padB - padT), R = (x, v, bw2, a) => `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw2.toFixed(1)}" height="${(h - padB - y(v)).toFixed(1)}" ${a}/>`;
  const g = days.map((d, i) => {
    const cx = w - (i + 0.5) * slot, x = cx - bw / 2, cap = d[capK], plan = d[planK], out = wa && d.out != null ? d.out : Math.min(plan, cap), over = Math.max(0, plan - cap);
    const tip = `${d.dow} ${fmtDate(d.date)} · מתוכנן ${fmtN(plan)} מתוך ${fmtN(cap)}${wa ? outTip(d) : ''}${d.no_contact ? ' · ' + (d.closed_reason || 'סגור') : ''}`;
    return `<g data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}"><rect x="${(cx - slot / 2).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${h}" fill="transparent"/>${cap ? R(x, cap, bw, 'rx="4" fill="var(--track)" stroke="var(--line-2)"') : ''}${out ? R(x + 3, out, bw - 6, 'rx="3" fill="var(--s1)"') : ''}${plan ? R(x + 6, plan, bw - 12, 'rx="2" fill="none" stroke="var(--ink-2)" stroke-width="1.2" stroke-dasharray="3 2"') : ''}${over ? `<text x="${cx.toFixed(1)}" y="${(y(plan) - 5).toFixed(1)}" text-anchor="middle" style="fill:var(--crit-ink);font-weight:700">▲${fmtN(over)}</text>` : ''}${d.no_contact ? `<text x="${cx.toFixed(1)}" y="${(h - padB - 8).toFixed(1)}" text-anchor="middle">${esc(d.closed_reason || 'סגור')}</text>` : ''}<text x="${cx.toFixed(1)}" y="${h - 18}" text-anchor="middle" style="fill:var(--ink-2)">${esc(d.dow)}</text><text x="${cx.toFixed(1)}" y="${h - 4}" text-anchor="middle">${esc(fmtDate(d.date))}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block;max-height:${h * 1.4}px" role="group" aria-label="קיבולת: יוצא בפועל מול מתוכנן"><line x1="0" x2="${w}" y1="${h - padB + 0.5}" y2="${h - padB + 0.5}" stroke="var(--line-2)"/>${g}</svg>`;
}
export const capLegend = () => '<div class="legend"><span><i></i>יוצא בפועל</span><span><i class="due"></i>מתוכנן במקור</span><span><i class="cap"></i>תקרה</span></div>';

export function view(d) {
  const alerts = d.alerts || [], recs = d.recommendations || [];
  const table = Table({
    columns: [
      { label: 'יום', render: (x) => `${esc(x.dow)} ${esc(fmtDate(x.date))}` },
      { label: 'הודעות מתוכננות', num: true, render: (x) => fmtN(x.planned_wa) + (x.held_planned ? ` <span class="muted">+${fmtN(x.held_planned)} מוחזק</span>` : '') },
      { label: 'תקרה', num: true, render: (x) => (x.no_contact ? esc(x.closed_reason || 'סגור') : fmtN(x.capacity_wa)) },
      { label: 'אירועים', render: (x) => x.events.map((e) => `${esc(e.name)} <span class="muted">${esc(e.kind)} · ${fmtN(e.planned_wa)}</span>`).join('<br>') || '<span class="muted">—</span>' },
    ], rows: d.days, rowKey: (x) => x.date,
  });
  return `
${d.model ? `<div class="card"><div class="sec-h"><h2 class="h2">${d.model.verified ? 'תקרה לכל מספר' : 'תקרה משותפת'}</h2><span class="sp"></span>${Badge(d.model.verified ? 'ok' : 'partial', 'אימות העסק: ' + esc((d.verification && d.verification.status) || '—'))}</div><p class="sub" style="margin:0">${esc(d.model.he || '')} · נשאר היום <b class="num">${fmtN(d.model.today_remaining)}</b></p></div>` : ''}
${alerts.length ? `<div class="card" style="border-color:color-mix(in srgb,var(--crit) 35%,transparent)"><div class="sec-h"><h2 class="h2">ביקוש מעל הקיבולת</h2>${Badge('open', alerts.length + ' ימים')}</div>${alerts.map((a) => `<div class="errbox" style="margin-top:8px"><span aria-hidden="true">▲</span><span><b>${esc(fmtDate(a.date))}</b> · ${esc(a.msg)} · חסר מקום ל-<b class="num">${fmtN(a.over_by)}</b> ${a.kind === 'wa' ? 'הודעות' : 'שיחות'}</span></div>`).join('')}</div>` : ''}
<div class="card"><div class="sec-h"><h2 class="h2">הודעות לאורחים · 14 יום</h2><span class="sp"></span>${capLegend()}</div>${capBars(d.days)}</div>
${d.days.some((x) => x.capacity_calls != null) ? `<div class="card"><div class="sec-h"><h2 class="h2">שיחות · 14 יום</h2><span class="sp"></span>${capLegend()}</div>${capBars(d.days, { metric: 'calls', h: 150 })}</div>` : ''}
<div class="card"><div class="sec-h"><h2 class="h2">מתי לשלוח</h2><span class="sub">המלצות לפי המקום הפנוי בכל יום</span></div>
${recs.length ? Table({ columns: [
    { label: 'אירוע', render: (r) => esc(r.name) },
    { label: 'מועד', render: (r) => esc(fmtDate(r.event_date)) },
    { label: 'מה', render: (r) => esc(r.wave) },
    { label: 'לשלוח ב', render: (r) => `<b>${esc(r.split ? r.split.map((s) => fmtDate(s.day) + ' · ' + s.count).join(', ') : fmtDate(r.send_on))}</b>` },
    { label: 'כמות', num: true, render: (r) => fmtN(r.planned) },
    { label: 'למה', render: (r) => `<span class="ink2">${esc(r.reason)}</span>` },
  ], rows: recs, rowKey: (r) => r.token }) : '<div class="empty">אין המלצות כרגע</div>'}</div>
<div class="card flush">${table}</div>${(d.notes || []).length ? `<ul class="sub" style="margin:0;padding-inline-start:18px">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}`;
}

export default {
  skeleton: () => Skeleton.card(6) + Skeleton.table(6),
  async mount(el, ctx) {
    const paint = (d) => { el.innerHTML = view(d); };
    const c = ctx.api.cached('capacity'); if (c) paint(c.data);
    paint(await ctx.api.get('capacity'));
    ctx.poll(async () => paint(await ctx.api.get('capacity')), 60000);
  },
};
