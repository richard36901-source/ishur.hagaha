/* Overview v2 (Phase 5, §10): the business at a glance, from ONE request (GET /api/ops/overview, worker/notify.js).
   Order (Richard 03/11 19:45): ממתין לך (buttons) · תקריות · היום (money / leads / sends / calls with 7-day
   sparklines) · אירועים קרובים (7 days, readiness dots) · מה השתנה מאז הביקור האחרון · יתרות.
   Plain Hebrew, one line per item: what happened + what to do. Mobile first (one column at 375 px).
   The "since last visit" mark: after the page has been on screen 4 s, POST overview {seen:true} stamps lastseen:ops.
   screens/overview.js delegates here; when /api/ops/overview is missing (backend not deployed yet) it falls back
   to the classic overview. */
import { esc, fmtN, fmtDate, fmtTime, relTime, StatTile, Skeleton, Sparkline, Badge, confirmTyped, toast, busy } from '../ui.js';
import { sevChip, css as ntfCss } from './notify.js';

const ils = (n) => (n == null ? '—' : '₪' + fmtN(Math.round(n)));
const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const dayLabel = (iso, today) => { if (iso === today) return 'היום'; const t = Date.parse(today + 'T12:00:00Z'), d = Date.parse(iso + 'T12:00:00Z'); if (d - t === 864e5) return 'מחר'; return 'יום ' + DOW[new Date(d).getUTCDay()] + ' ' + fmtDate(iso + 'T12:00:00'); };
const KIND_HE = { deploy: 'גרסה', registry: 'אוטומציות', edit: 'עריכה', hold: 'החזקה', toggle: 'מתג', pause: 'עצירה', template: 'תבנית', brain: 'מוח', subevent: 'אירוע-בן', blast: 'שליחה ידנית', revert: 'שחזור', control: 'שליטה' };
const ACTOR_HE = { Richard: 'אתה', Claude: 'Claude', brain: 'המוח', system: 'מערכת' };
const SHIR_HE = { dialing: 'מחייגת עכשיו', idle: 'ממתינה', off: 'לא מחוברת', unreadable: 'לא קריא מרטל' };
const RD = { ok: ['good', '✓'], missing: ['crit', '✕'], unknown: ['', '?'] };

const CSS = `
.ov2 .card{margin:0}
.ov2{display:flex;flex-direction:column;gap:16px}
.ov2 .wait li,.ov2 .inc li,.ov2 .chg li{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.ov2 ul{list-style:none;margin:0;padding:0}
.ov2 li:last-child{border-bottom:0}
.ov2 .wait .tx,.ov2 .inc .tx,.ov2 .chg .tx{flex:1;min-width:0;font-size:14px;line-height:1.45}
.ov2 .wait .ic{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand-2);flex:none;font-size:15px}
.ov2 .ev{display:grid;grid-template-columns:76px 1fr;gap:4px 12px;padding:10px 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.ov2 .ev:last-child{border-bottom:0}
.ov2 .ev .dd{font-weight:650;font-size:13px}
.ov2 .ev .nm{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov2 .ev .rd{grid-column:2;display:flex;flex-wrap:wrap;gap:6px 10px;font-size:12.5px;color:var(--ink-2)}
.ov2 .ev .rd span{display:inline-flex;align-items:center;gap:5px}
.ov2 .ev .rd i{width:8px;height:8px;border-radius:50%;background:var(--ink-3);display:inline-block}
.ov2 .ev .rd i.good{background:var(--good)}.ov2 .ev .rd i.crit{background:var(--crit)}
.ov2 .ev .sub2{grid-column:2;font-size:12px;color:var(--ink-3)}
.ov2 .hello{font-size:15px;color:var(--ink-2);margin:0}
.ov2 .hello b{color:var(--ink)}
.ov2 .tile .s{line-height:1.4}
.ov2 .g-tiles{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.ov2 .trend .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ov2 .scr{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;max-width:100%;padding-bottom:2px}
.ov2 .scr::-webkit-scrollbar{display:none}
.ov2 .scr .chipb{flex:none}
.ov2 .chart{position:relative;width:100%;margin-top:12px;touch-action:pan-y}
.ov2 .chart svg{display:block;width:100%;height:auto;overflow:visible}
.ov2 .chart .ax{font:11px var(--font-num);fill:var(--ink-3)}
.ov2 .chart .tip{position:absolute;pointer-events:none;background:var(--raise);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:8px;padding:6px 9px;font-size:12.5px;white-space:nowrap;transform:translate(50%,-100%);z-index:2}
.ov2 .chart .tip b{font:600 14px var(--font-num)}
.ov2 .tsum{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:13px;color:var(--ink-2)}
.ov2 .tsum b{font:650 18px var(--font-num);color:var(--ink);display:block}
.ov2 table.tt{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}
.ov2 table.tt td,.ov2 table.tt th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:start}
.ov2 table.tt td.n{font-family:var(--font-num);text-align:end}
.ov2 .why{font-size:13px;color:var(--ink-3);padding:18px 0;text-align:center}
.ov2 .nav2{display:inline-flex;gap:4px}
@media (max-width:760px){.ov2 .trend .chipb,.ov2 .nav2 .btn{min-height:44px;min-width:44px}.ov2 .btn.sm,.ov2 a.btn.sm{min-height:44px}}@media (max-width:760px){.ov2 .g-tiles
{grid-template-columns:1fr 1fr}.ov2 .wait .btn,.ov2 .inc .btn{min-height:40px}}
`;
function css() { if (typeof document === 'undefined' || document.getElementById('ov2-css')) return; const s = document.createElement('style'); s.id = 'ov2-css'; s.textContent = CSS; document.head.appendChild(s); }

const ICON = { approve: '✋', reply: '💬', reminder: '⏰', followup: '↩', event: '📅' };
const actBtn = (a, i, scope) => (a.action && a.action.type === 'brain-decision'
  ? `<button type="button" class="btn primary sm" data-act="ov-approve" data-scope="${scope}" data-i="${i}">${esc(a.action.label_he || 'לאשר')}</button>`
  : `<a class="btn sm" href="${esc((a.action && a.action.href) || a.href || '#/overview')}">${esc((a.action && a.action.label_he) || 'לפתוח')}</a>`);

export function waitingView(list) {
  if (!list.length) return '<div class="empty">אין כלום שמחכה לך. 👌</div>';
  return `<ul class="wait">${list.map((w, i) => `<li><span class="ic" aria-hidden="true">${ICON[w.kind] || '•'}</span><span class="tx">${esc(w.title_he)}</span>${actBtn(w, i, 'waiting')}</li>`).join('')}</ul>`;
}
export function incidentsView(list) {
  if (!list.length) return '<div class="empty">אין תקלות. הכל רץ.</div>';
  return `<ul class="inc">${list.map((x, i) => `<li>${sevChip(x.severity)}<span class="tx">${esc(x.title_he)}</span>${actBtn(x, i, 'incidents')}</li>`).join('')}</ul>`;
}
export function todayTiles(o) {
  const m = o.money || {}, l = o.leads || {}, s = o.sends, c = o.calls;
  const sp = (v, label, color) => (v && v.length ? Sparkline(v, { w: 120, h: 26, label, color }) : '');
  const vsLast = m.last_month_to_date ? Math.round(100 * (m.month - m.last_month_to_date) / m.last_month_to_date) : null;
  return `<div class="grid g-tiles">
${StatTile({ label: 'כסף היום', value: ils(m.today), href: '#/clients', sub: `${fmtN(m.today_orders || 0)} עסקאות · החודש ${ils(m.month)}${vsLast != null ? ` (${vsLast >= 0 ? '+' : ''}${vsLast}% מול החודש שעבר)` : ''}${m.open_quotes ? ` · ${fmtN(m.open_quotes)} הצעות פתוחות` : ''}`, spark: sp(m.spark, 'הכנסות 7 ימים', 'var(--good)') })}
${StatTile({ label: 'לידים', value: fmtN(l.new_today), unit: 'חדשים היום', href: '#/leads', status: l.waiting_1h ? 'partial' : '', sub: `${l.waiting_1h ? `<b>${fmtN(l.waiting_1h)} מחכים לתשובה מעל שעה</b> · ` : ''}${fmtN(l.quoted)} עם הצעה · ${fmtN(l.closed_today)} נסגרו היום`, spark: sp(l.spark, 'לידים 7 ימים') })}
${s ? StatTile({ label: 'הודעות לאורחים', value: fmtN(s.sent), unit: s.cap_limit ? '/ ' + fmtN(s.cap_limit) : '', href: '#/messaging', status: s.paused ? 'failed' : s.failed ? 'partial' : 'ok', meter: s.cap_limit ? { value: s.cap_used || 0, max: s.cap_limit } : null, sub: `${s.paused ? '<b>השליחה עצורה</b> · ' : ''}${fmtN(s.failed)} נכשלו · התקרה ${s.cap_pct == null ? '—' : s.cap_pct + '%'}${s.next_tick_at ? ' · פעימה הבאה ' + esc(fmtTime(s.next_tick_at)) : ''}`, spark: sp(s.spark, 'הודעות 7 ימים') }) : StatTile({ label: 'הודעות לאורחים', value: '—', sub: 'לא הצלחנו לקרוא' })}
${c ? StatTile({ label: 'שיחות היום', value: fmtN(c.dialed), unit: fmtN(c.answered) + ' נענו', href: '#/calls', status: c.shir === 'unreadable' ? 'partial' : '', sub: `שיר ${esc(SHIR_HE[c.shir] || c.shir)}${c.remaining != null ? ' · ' + fmtN(c.remaining) + ' נשארו' : ''}`, spark: sp(c.spark, 'שיחות 7 ימים', 'var(--s2)') }) : StatTile({ label: 'שיחות היום', value: '—', sub: 'לא הצלחנו לקרוא' })}
</div>`;
}
export function eventsView(events, today) {
  if (!events.length) return '<div class="empty">אין אירועים בשבוע הקרוב.</div>';
  return events.map((e) => {
    const miss = e.readiness.filter((r) => r.state === 'missing');
    return `<a class="ev" href="#/clients?focus=${esc(e.tok8)}"><span class="dd">${esc(dayLabel(e.date, today))}</span><span class="nm">${esc(e.names || e.tok8)}${e.plan_he ? ` <span class="muted" style="font-weight:400">· ${esc(e.plan_he)}</span>` : ''}</span>
<span class="rd" aria-label="מוכנות">${e.readiness.map((r) => `<span><i class="${RD[r.state][0]}" aria-hidden="true"></i>${esc(r.he)}<span class="sr-only">${r.state === 'ok' ? ' מוכן' : r.state === 'missing' ? ' חסר' : ' לא ידוע'}</span></span>`).join('')}</span>
<span class="sub2">${miss.length ? `<b style="color:var(--crit-ink)">חסר: ${esc(miss.map((r) => r.he).join(', '))}</b> · ` : 'הכל מוכן · '}${fmtN(e.confirmed)} אישרו מתוך ${fmtN(e.invited)}</span></a>`;
  }).join('');
}
export function changesView(ch, lastSeen) {
  const head = `<p class="sub" style="margin:0 0 6px">${lastSeen ? 'מאז הביקור הקודם (' + esc(relTime(lastSeen)) + ')' : 'ב-24 השעות האחרונות'}: ${fmtN(ch.count)} שינויים</p>`;
  if (!ch.items.length) return head + '<div class="empty">לא השתנה כלום.</div>';
  return head + `<ul class="chg">${ch.items.map((c) => `<li><span class="badge">${esc(KIND_HE[c.kind] || c.kind)}</span><span class="tx">${esc(c.summary_he)}</span><span class="sub">${esc(ACTOR_HE[c.actor] || c.actor)} · ${esc(relTime(c.at))}</span></li>`).join('')}</ul>${ch.count > ch.items.length ? '<a class="btn ghost sm" href="#/changes">כל השינויים</a>' : ''}`;
}
export function balancesView(b) {
  if (!b.low.length) return `<div class="empty">כל היתרות מעל הסף.${b.checked_at ? ' נבדק ' + esc(relTime(b.checked_at)) + '.' : ''}</div>`;
  return `<ul class="wait">${b.low.map((v) => `<li><span class="ic" aria-hidden="true" style="background:var(--crit-bg);color:var(--crit-ink)">!</span><span class="tx"><b>${esc(v.vendor)}</b> נמוך${v.amount != null ? ` (${esc(v.amount)} ${esc(v.currency)})` : ''}. לטעון לפני שזה עוצר.</span><a class="btn sm" href="#/balances">ליתרות</a></li>`).join('')}</ul>`;
}

/* ── trends: one metric at a time, range chips, step arrows, hover/tap tooltip, table toggle ── */
export const METRICS = [
  { id: 'revenue', he: 'הכנסות', fmt: ils, color: 'var(--good)', why: 'revenue', tot: 'revenue' },
  { id: 'leads', he: 'לידים', fmt: fmtN, color: 'var(--s1)', why: 'revenue', tot: 'leads' },
  { id: 'sends', he: 'הודעות', fmt: fmtN, color: 'var(--s1)', why: 'sends' },
  { id: 'calls', he: 'שיחות', fmt: fmtN, color: 'var(--s2)', why: 'calls' },
  { id: 'visits', he: 'כניסות לאתר', fmt: fmtN, color: 'var(--s1)', why: 'visits' },
  { id: 'ad_spend', he: 'הוצאה על מודעות', fmt: ils, color: 'var(--serious)', why: 'ads' },
];
export const RANGES_HE = [{ id: 'week', he: 'שבוע' }, { id: 'month', he: 'חודש' }, { id: '3m', he: '3 חודשים' }, { id: 'year', he: 'שנה' }];
const MON = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];
const bLabel = (b) => (b.length === 7 ? MON[Number(b.slice(5)) - 1] + ' ' + b.slice(2, 4) : b.slice(8, 10) + '/' + b.slice(5, 7));
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
export function chartSvg(buckets, values, { width = 640, height = 220, color = 'var(--s1)', fmt = fmtN } = {}) {
  const padL = 8, padR = 46, padT = 12, padB = 26, w = Math.max(240, width), h = height;
  const iw = w - padL - padR, ih = h - padT - padB, n = buckets.length, max = niceMax(Math.max(0, ...values));
  const bw = iw / n, gap = Math.min(4, bw * 0.25);
  /* RTL: the oldest bucket sits at the right, the newest at the left; value labels on the right */
  const x = (i) => padL + (n - 1 - i) * bw;
  const ticks = [0, max / 2, max];
  const grid = ticks.map((t) => { const y = padT + ih - (t / max) * ih; return `<line x1="${padL}" x2="${padL + iw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line)"/><text class="ax" x="${w - 4}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmt(t))}</text>`; }).join('');
  const bars = values.map((v, i) => { const bh = v ? Math.max(2, (v / max) * ih) : 0; return !bh ? '' : `<rect data-i="${i}" x="${(x(i) + gap / 2).toFixed(1)}" y="${(padT + ih - bh).toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(3, bw / 4).toFixed(1)}" fill="${color}"/>`; }).join('');
  const every = Math.max(1, Math.ceil(n / Math.floor(iw / 46)));
  const labels = buckets.map((b, i) => (i % every === (n - 1) % every ? `<text class="ax" x="${(x(i) + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${esc(bLabel(b))}</text>` : '')).join('');
  const hits = buckets.map((b, i) => `<rect class="hit" data-i="${i}" x="${x(i).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${ih}" fill="transparent"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="גרף עמודות">${grid}${bars}${labels}${hits}</svg>`;
}
export function trendView(st) {
  const m = METRICS.find((x) => x.id === st.metric) || METRICS[0], s = st.data;
  const vals = s && s.series[m.id];
  const has = vals && vals.some(Boolean);
  const total = vals ? vals.reduce((a, b) => a + b, 0) : 0;
  const prev = s && m.tot && s.prev_totals ? s.prev_totals[m.tot] : null;
  const delta = prev ? Math.round((100 * (total - prev)) / prev) : null;
  const win = s ? s.window : null;
  return `<div class="bar"><div class="scr" role="tablist" aria-label="מדד">${METRICS.map((x) => `<button type="button" class="chipb" data-act="tr-m" data-v="${x.id}" aria-pressed="${x.id === m.id}">${esc(x.he)}</button>`).join('')}</div></div>
<div class="bar" style="margin-top:8px"><div class="scr" role="tablist" aria-label="טווח">${RANGES_HE.map((r) => `<button type="button" class="chipb" data-act="tr-r" data-v="${r.id}" aria-pressed="${r.id === st.range}">${esc(r.he)}</button>`).join('')}</div>
<span class="sp" style="flex:1"></span><span class="nav2"><button type="button" class="btn ghost sm" data-act="tr-prev" aria-label="תקופה קודמת">→</button><button type="button" class="btn ghost sm" data-act="tr-next" aria-label="תקופה הבאה"${st.offset ? '' : ' aria-disabled="true"'}>←</button></span>
<button type="button" class="chipb" data-act="tr-table" aria-pressed="${!!st.table}">טבלה</button></div>
${!s ? `<div class="chart">${Skeleton.lines(5)}</div>` : `<div class="tsum"><span><b>${esc(m.fmt(total))}</b>${esc(m.he)} · ${esc(fmtDate(win.start + 'T12:00'))}–${esc(fmtDate(win.end + 'T12:00'))}</span>${delta != null ? `<span><b>${delta >= 0 ? '+' : ''}${delta}%</b>מול התקופה הקודמת</span>` : ''}${m.id === 'revenue' && s.undated_sales ? `<span><b>${fmtN(s.undated_sales)}</b>מכירות בלי תאריך (לא בגרף)</span>` : ''}</div>
${!vals ? `<div class="why">אין נתונים עדיין: ${esc(s.why[m.why] || 'המקור לא זמין')}</div>` : st.table ? `<table class="tt"><thead><tr><th>${win.group === 'month' ? 'חודש' : 'יום'}</th><th style="text-align:end">${esc(m.he)}</th></tr></thead><tbody>${s.buckets.map((b, i) => `<tr><td>${esc(bLabel(b))}</td><td class="n">${esc(m.fmt(vals[i]))}</td></tr>`).reverse().join('')}</tbody></table>`
  : `<div class="chart" data-chart>${chartSvg(s.buckets, vals, { width: st.width || 640, color: m.color, fmt: m.fmt })}</div>${has ? '' : `<div class="why">הכל אפס בטווח הזה. ${esc(s.why[m.why] || '')}</div>`}`}`}`;
}
export function extrasTiles(o) {
  const a = o.ads || {}, t = o.traffic || {}, g = o.growth || {}, T = o.totals || {}, f = o.funnel || {};
  const no = (why) => `<span class="muted">אין נתונים עדיין: ${esc(why)}</span>`;
  return `<div class="grid g-tiles">
${StatTile({ label: 'מודעות · 7 ימים', value: a.d7 ? ils(a.d7.spend) : '—', href: '#/balances', sub: a.d7 ? `היום ${ils(a.today.spend)} · 30 יום ${ils(a.d30.spend)} · ${fmtN(a.d7.leads)} לידים${a.d7.cpl != null ? ' · ₪' + a.d7.cpl + ' לליד' : ''}${a.d7.roas != null ? ' · ROAS ' + a.d7.roas : ''}` : no(a.why || 'לא ידוע'), spark: a.spark && a.spark.length ? Sparkline(a.spark, { w: 120, h: 26, label: 'הוצאה 7 ימים', color: 'var(--serious)' }) : '' })}
${StatTile({ label: 'כניסות לאתר · 7 ימים', value: t.visitors_7d != null ? fmtN(t.visitors_7d) : '—', sub: t.visitors_7d != null ? `${t.lead_pct != null ? t.lead_pct + '% השאירו פרטים' : ''}${t.purchase_pct != null ? ' · ' + t.purchase_pct + '% קנו' : ''}${t.top_sources && t.top_sources.length ? ' · מקורות: ' + t.top_sources.slice(0, 3).map((x) => esc(x.src) + ' ' + fmtN(x.n)).join(', ') : ''}` : no(t.why || 'לא ידוע'), spark: t.spark && t.spark.length ? Sparkline(t.spark, { w: 120, h: 26, label: 'כניסות 7 ימים' }) : '' })}
${StatTile({ label: 'צמיחה החודש', value: ils(g.month), sub: `חודש שעבר ${ils(g.last_month)}${g.mom_pct != null ? ` · <b>${g.mom_pct >= 0 ? '+' : ''}${g.mom_pct}%</b>` : ''}` })}
${StatTile({ label: 'מצטבר', value: ils(T.revenue), sub: `${fmtN(T.sales)} מכירות · ${fmtN(T.events)} אירועים · ${fmtN(T.guests)} מוזמנים${T.undated ? ' · ' + fmtN(T.undated) + ' בלי תאריך' : ''}` })}
${StatTile({ label: 'משפך', value: fmtN(f.closed), unit: 'סגרו', href: '#/leads', sub: `${f.visitors_7d != null ? fmtN(f.visitors_7d) + ' כניסות (7 ימים) → ' : ''}${fmtN(f.leads)} לידים → ${fmtN(f.quoted)} הצעות → ${fmtN(f.closed)} סגרו` })}
</div>`;
}

const sec = (title, inner, extra = '') => `<section class="card"><div class="sec-h"><h2 class="h2">${title}</h2><span class="sp"></span>${extra}</div>${inner}</section>`;
export function view(o) {
  if (!o) return `<div class="ov2">${sec('ממתין לך', Skeleton.lines(3))}${sec('תקריות', Skeleton.lines(2))}<section aria-label="היום">${Skeleton.tiles(4)}</section>${sec('אירועים קרובים', Skeleton.lines(4))}</div>`;
  const nWait = o.waiting.length, nInc = o.incidents.filter((x) => ['P0', 'P1'].includes(x.severity)).length;
  const hello = nWait || nInc ? `<p class="hello"><b>${nWait ? fmtN(nWait) + ' דברים מחכים לך' : ''}${nWait && nInc ? ' · ' : ''}${nInc ? fmtN(nInc) + ' תקלות חשובות' : ''}</b>. השאר רץ לבד.</p>` : '<p class="hello"><b>הכל בשליטה.</b> אין שום דבר שמחכה לך.</p>';
  return `<div class="ov2">${hello}
${sec('ממתין לך', waitingView(o.waiting), nWait ? Badge('needs_approval', fmtN(nWait)) : '')}
${sec('תקריות', incidentsView(o.incidents), '<a class="btn ghost sm" href="#/brain">למוח</a>')}
<section aria-label="היום"><div class="sec-h"><h2 class="h2">היום</h2><span class="sp"></span><span class="sub">קווים: 7 ימים אחרונים</span></div>${todayTiles(o)}</section>
<section class="card trend" id="ov-trend"><div class="sec-h"><h2 class="h2">מגמות</h2></div><div id="ov-trend-b">${trendView(TR)}</div></section>
<section aria-label="עסק"><div class="sec-h"><h2 class="h2">מודעות, אתר וצמיחה</h2></div>${extrasTiles(o)}</section>
${sec('אירועים קרובים', eventsView(o.events, o.today), '<a class="btn ghost sm" href="#/calendar">ללוח השנה</a>')}
${sec('מה השתנה מאז הביקור האחרון', changesView(o.changes, o.last_seen))}
${sec('יתרות', balancesView(o.balances))}
${o.errors && o.errors.length ? `<p class="sub">חלק מהנתונים לא נטענו: ${esc(o.errors.map((e) => e.split(':')[0]).join(', '))}</p>` : ''}</div>`;
}

const TR = { metric: 'revenue', range: 'month', offset: 0, table: false, data: null, width: 640, cache: {} };
export default {
  skeleton: () => view(null),
  async mount(el, ctx) {
    css(); ntfCss();
    let o = ctx.api.cached('overview')?.data || null;
    let paint = () => { el.innerHTML = view(o); if (o) { ctx.setBadge('overview', o.waiting.length + o.incidents.filter((x) => ['P0', 'P1'].includes(x.severity)).length); ctx.setBadge('balances', o.balances.low.length); } };
    paint();
    o = await ctx.api.get('overview', {}, { qs: '' });   /* throws → screens/overview.js falls back to the classic view */
    paint();
    const seenT = setTimeout(() => { if (el.isConnected && !ctx.MOCK) ctx.api.post('overview', { seen: true }).catch(() => {}); }, 4000);
    ctx.onDispose(() => clearTimeout(seenT));
    ctx.on(el, 'click', async (e) => {
      const b = e.target.closest('[data-act=ov-approve]'); if (!b) return;
      const item = o[b.dataset.scope][+b.dataset.i]; const a = item && item.action; if (!a) return;
      const word = a.confirm || a.id;
      const yes = await confirmTyped({ title: 'לאשר את הפעולה של המוח', body: `<p>${esc(item.title_he)}</p><p class="sub">המוח יריץ את התיקון עכשיו. זה נרשם ביומן השינויים.</p>`, word, action: 'לאשר', danger: false });
      if (!yes) return;
      try { await busy(b, () => ctx.api.post('brain-decision', { id: a.id, approve: true, confirm: word })); toast('אושר. המוח מטפל.'); o = await ctx.api.get('overview', {}, { qs: '', cache: false }); paint(); }
      catch (err) { toast('לא אושר: ' + (err.message || ''), 'err'); }
    });
    const trBody = () => el.querySelector('#ov-trend-b');
    const paintTr = () => { const b = trBody(); if (!b) return; TR.width = Math.round(b.clientWidth || 640); b.innerHTML = trendView(TR); };
    const loadTr = async () => {
      const k = TR.range + ':' + TR.offset; TR.data = TR.cache[k] || null; paintTr();
      if (TR.cache[k]) return;
      try { const d = await ctx.api.get('overview-series', {}, { qs: `?range=${TR.range}&offset=${TR.offset}`, cache: false }); TR.cache[k] = d; if (TR.range + ':' + TR.offset === k) { TR.data = d; paintTr(); } }
      catch (e) { const b = trBody(); if (b) b.innerHTML = `<div class="why">אין נתונים עדיין: ${esc(e.message || 'השרת לא החזיר')}</div>`; }
    };
    const origPaint = paint;
    paint = () => { origPaint(); paintTr(); };
    loadTr();
    ctx.on(el, 'click', (e) => {
      const a = e.target.closest('[data-act^=tr-]'); if (!a || a.getAttribute('aria-disabled') === 'true') return;
      const act = a.dataset.act;
      if (act === 'tr-m') { TR.metric = a.dataset.v; paintTr(); }
      else if (act === 'tr-r') { TR.range = a.dataset.v; TR.offset = 0; loadTr(); }
      else if (act === 'tr-prev') { TR.offset++; loadTr(); }
      else if (act === 'tr-next') { TR.offset = Math.max(0, TR.offset - 1); loadTr(); }
      else if (act === 'tr-table') { TR.table = !TR.table; paintTr(); }
    });
    const tipAt = (e) => {
      const c = e.target.closest && e.target.closest('[data-chart]'); const hit = e.target.closest && e.target.closest('rect[data-i]');
      el.querySelectorAll('[data-chart] .tip').forEach((t) => t.remove()); if (!c || !hit || !TR.data) return;
      const i = +hit.dataset.i, m = METRICS.find((x) => x.id === TR.metric), v = TR.data.series[m.id][i];
      const r = hit.getBoundingClientRect(), cr = c.getBoundingClientRect();
      const tip = document.createElement('div'); tip.className = 'tip'; tip.innerHTML = `<b>${esc(m.fmt(v))}</b> · ${esc(bLabel(TR.data.buckets[i]))}`;
      tip.style.right = Math.max(40, Math.min(cr.width - 40, cr.right - (r.left + r.width / 2))) + 'px'; tip.style.top = '6px'; c.appendChild(tip);
    };
    ctx.on(el, 'pointermove', tipAt); ctx.on(el, 'pointerdown', tipAt);
    const onR = () => paintTr(); window.addEventListener('resize', onR); ctx.onDispose(() => window.removeEventListener('resize', onR));
    ctx.poll(async () => { o = await ctx.api.get('overview', {}, { qs: '' }); paint(); }, 60000);
  },
};
