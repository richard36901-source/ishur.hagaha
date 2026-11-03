/* ishur ops · overview add-on: "היום" agenda (reminders, events today, sends today) + 3 charts:
   revenue 30 days, leads funnel, sends and calls 14 days (two small multiples, never a second axis).
   Inline SVG per the dataviz skill: one series each in --s1 (already validated), thin bars with a
   rounded data end on the baseline, 2px gaps, recessive grid, per-bar hover (data-tip) on a hit
   area taller than the mark, a table view under every chart. Rendered at the measured width so
   text stays 11px on a phone instead of being scaled down. Loaded lazily by screens/overview.js
   AFTER its own 3 requests, so the overview's first paint is unchanged. */
import { esc, fmtN, fmtTime, Skeleton } from '../ui.js';
import { crm } from './adapt.js';
import { money, dayHe } from './kit.js';

const nice = (m) => { if (m <= 0) return 1; const p = 10 ** Math.floor(Math.log10(m)), f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const bar = (x, y, w, h) => { const r = Math.min(4, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

/* vertical bars, newest on the inline-start (RTL: right) like the rest of the ops charts */
export function bars(rows, { w = 600, h = 170, fmt = fmtN, label = '', every = 7 } = {}) {
  const n = rows.length; if (!n) return '<div class="empty">אין נתונים</div>';
  const padT = 10, padB = 22, padE = 34, iw = w - padE, ih = h - padT - padB, max = nice(Math.max(...rows.map((r) => r.v))), step = iw / n, bw = Math.max(2, step - 2);
  const X = (i) => iw - (i + 1) * step + 1; /* RTL time: i=0 (oldest) at the right next to the axis, newest at the left, like ui.js Sparkline */
  const ticks = [0, max / 2, max].map((t) => { const y = padT + ih - (t / max) * ih; return `<line x1="0" x2="${iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line${t ? '' : '-2'})"/><text x="${w - 2}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`; }).join('');
  const marks = rows.map((r, k) => { const bh = (r.v / max) * ih, x = X(k); return `<g><rect x="${x.toFixed(1)}" y="${padT}" width="${step.toFixed(1)}" height="${ih + padB}" fill="transparent" data-tip="${esc(dayHe(r.day) + ' · ' + fmt(r.v))}"/>${r.v ? `<path d="${bar(x, padT + ih - bh, bw, bh)}" fill="var(--s1)" pointer-events="none"/>` : ''}${(n - 1 - k) % every === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(dayHe(r.day))}</text>` : ''}</g>`; }).join('');
  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" style="direction:ltr">${ticks}${marks}</svg>`;
}
const tableOf = (rows, head, fmt = fmtN) => `<details class="tview"><summary>טבלה</summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>${esc(head[0])}</th><th class="n">${esc(head[1])}</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="num">${esc(r.day ? dayHe(r.day) : r.he)}</td><td class="n">${esc(fmt(r.v))}</td></tr>`).join('')}</tbody></table></div></details>`;

export function funnel(f, days = 30) {
  const top = (f[0] && f[0].v) || 0;
  return `<ol class="funnel" aria-label="משפך לידים ${days} יום">${f.map((s, i) => { const prev = i ? f[i - 1].v : s.v, w = top ? (s.v / top) * 100 : 0; return `<li data-tip="${esc(s.he + ': ' + fmtN(s.v) + (i ? ' · ' + (prev ? Math.round((s.v / prev) * 100) : 0) + '% מהשלב הקודם' : ''))}"><span class="fl">${esc(s.he)}</span><span class="fb"><i style="width:${w.toFixed(1)}%"></i></span><b class="num">${fmtN(s.v)}</b><span class="num muted">${i ? (prev ? Math.round((s.v / prev) * 100) : 0) + '%' : ''}</span></li>`; }).join('')}</ol><p class="sub">המרה כוללת: <b class="num">${top ? Math.round(((f[f.length - 1] || {}).v / top) * 100) : 0}%</b> מליד לסגירה</p>`;
}

export function agenda(a) {
  const li = (time, title, sub, href) => `<li><time class="num">${esc(time)}</time><span><a href="${esc(href)}"><b dir="auto">${esc(title)}</b></a>${sub ? `<br><span class="sub" dir="auto">${esc(sub)}</span>` : ''}</span></li>`;
  const col = (h, n, items, empty) => `<section class="card ag-col"><div class="sec-h"><h3 class="h2">${esc(h)}</h3><span class="badge${n ? ' info' : ''}">${fmtN(n)}</span></div><ul class="ag">${items.join('') || `<li class="empty">${esc(empty)}</li>`}</ul></section>`;
  return `<div class="grid g-3">${col('תזכורות', a.reminders.length, a.reminders.sort((x, y) => Date.parse(x.next_at) - Date.parse(y.next_at)).map((l) => li(fmtTime(l.next_at), l.name || l.phone, l.next_text, '#/leads/' + l.id)), 'אין תזכורות להיום')}
${col('אירועים היום', a.events.length, a.events.map((c) => li(c.event_time || '—', c.name, [c.venue, fmtN(c.confirmed) + ' / ' + fmtN(c.guests) + ' אישרו', c.addons.hostesses ? c.addons.hostesses + ' דיילות' : ''].filter(Boolean).join(' · '), '#/clients/' + c.token)), 'אין אירועים היום')}
${col('שליחות היום', a.sends.length, a.sends.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).map((s) => li(fmtTime(s.at), s.name, s.label + ' · ' + fmtN(s.count) + ' הודעות', '#/clients/' + s.token)), 'אין שליחות מתוכננות')}</div>`;
}

const CH = { revenue: { fmt: money, label: 'הכנסות לפי יום, 30 יום', every: 7 }, sends: { h: 140, label: 'הודעות וואטסאפ לפי יום', every: 3 }, calls: { h: 140, label: 'שיחות לפי יום', every: 3 } };
/* re-render every chart at its own box width (the grid decides 1 or 2 per row) */
export function fit(root, st) { root.querySelectorAll('[data-chart]').forEach((b) => { const w = Math.floor(b.clientWidth); if (w > 120) b.innerHTML = bars(st[b.dataset.chart], { w, ...CH[b.dataset.chart] }); }); }
export function charts(st, w = 600) {
  const half = w > 700 ? (w - 16) / 2 : w, rev = st.revenue.reduce((s, r) => s + r.v, 0);
  return `<div class="grid g-2">
<section class="card"><div class="sec-h"><h3 class="h2">הכנסות · 30 יום</h3><span class="sp"></span><b class="num">${money(rev)}</b></div><div data-chart="revenue">${bars(st.revenue, { w: half - 34, ...CH.revenue })}</div>${tableOf(st.revenue, ['יום', 'הכנסה'], money)}</section>
<section class="card"><div class="sec-h"><h3 class="h2">משפך לידים · ${st.funnel_days} יום</h3></div>${funnel(st.funnel, st.funnel_days)}</section>
</div>
<section class="card"><div class="sec-h"><h3 class="h2">שליחות ושיחות · 14 יום</h3><span class="sub">שני גרפים, כל אחד בסקאלה שלו</span></div><div class="grid g-2">
<div><div class="sub">הודעות וואטסאפ · <b class="num">${fmtN(st.sends.reduce((s, r) => s + r.v, 0))}</b></div><div data-chart="sends">${bars(st.sends, { w: half - 34, ...CH.sends })}</div>${tableOf(st.sends, ['יום', 'הודעות'])}</div>
<div><div class="sub">שיחות · <b class="num">${fmtN(st.calls.reduce((s, r) => s + r.v, 0))}</b></div><div data-chart="calls">${bars(st.calls, { w: half - 34, ...CH.calls })}</div>${tableOf(st.calls, ['יום', 'שיחות'])}</div></div></section>`;
}

export async function mount(el, ctx) {
  const api = crm(ctx), box = document.createElement('div');
  box.className = 'page crm-today'; box.innerHTML = `<section aria-label="היום"><div class="sec-h"><h2 class="h2">היום</h2></div>${Skeleton.card(4)}</section>${Skeleton.card(6)}`;
  el.after(box); ctx.onDispose(() => box.remove());
  let a = null, st = null;
  const width = () => Math.max(280, (box.clientWidth || 600) - 34);
  const paint = () => { box.innerHTML = `<section aria-label="היום"><div class="sec-h"><h2 class="h2">היום</h2></div>${a ? agenda(a) : Skeleton.card(4)}</section><section aria-label="גרפים">${st ? charts(st, width()) : Skeleton.card(6)}</section>`; if (st) fit(box, st); };
  await Promise.allSettled([api.agenda().then((x) => { a = x; paint(); }), api.stats().then((x) => { st = x; paint(); })]);
  if (!a && !st) box.innerHTML = ctx.errorBox({ message: 'נתוני ה-CRM לא נטענו' }, 'noop');
  let rT = 0, lastW = width(); const onR = () => { clearTimeout(rT); rT = setTimeout(() => { if (Math.abs(width() - lastW) > 24 && st) { lastW = width(); fit(box, st); } }, 150); };
  addEventListener('resize', onR); ctx.onDispose(() => removeEventListener('resize', onR));
  ctx.poll(async () => { a = await api.agenda(); paint(); }, 60000);
}
