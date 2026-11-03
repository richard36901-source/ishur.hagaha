/* פידבקים (#/feedback, g v) · GET /api/ops/feedback — every end-of-event answer (NPS + experience 1–10,
   note, review/clip clicks), a per-event roll-up with the link to the review page, and the average
   rating trend by week. Read-only. Lazy module. */
import { esc, fmtN, fmtDate, Skeleton } from '../ui.js';
import { ensureCss, lineChart, tableView } from './charts.js';

const tile = (label, value, sub = '') => `<div class="tile"><span class="sub">${esc(label)}</span><b class="num" style="font-size:22px">${value}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
const sc = (v) => (v == null ? '—' : fmtN(v));
export function view(d) {
  const t = d.totals;
  const trend = d.trend.length ? lineChart([{ key: 'n', label: 'המלצה (NPS)', points: d.trend.map((x) => ({ x: x.bucket, y: x.avg_nps })) }, { key: 'e', label: 'חוויה', points: d.trend.map((x) => ({ x: x.bucket, y: x.avg_exp })) }], { fmt: (v) => fmtN(Math.round(v * 10) / 10), min: 0, xLabel: (b) => fmtDate(b + 'T12:00:00Z'), title: 'ממוצע דירוג לפי שבוע' }) : '<p class="muted">עוד אין דירוגים</p>';
  return `<div class="mny-grid">${tile('תשובות', esc(fmtN(t.n)), esc(fmtN(t.rated)) + ' דירגו · ' + esc(fmtN(t.left)) + ' עזבו')}${tile('ממוצע המלצה', esc(sc(t.avg_nps)), 'מתוך 10')}${tile('ממוצע חוויה', esc(sc(t.avg_exp)), 'מתוך 10')}${tile('NPS', esc(t.nps_score == null ? '—' : fmtN(t.nps_score)), 'ממליצים פחות מבקרים')}</div>
<section class="card"><h2 class="h2">מגמה שבועית</h2>${trend}${tableView([{ he: 'שבוע', k: 'bucket' }, { he: 'תשובות', k: 'n', num: true }, { he: 'המלצה', num: true, f: (r) => esc(sc(r.avg_nps)) }, { he: 'חוויה', num: true, f: (r) => esc(sc(r.avg_exp)) }], d.trend)}</section>
<section class="card"><h2 class="h2">לפי אירוע</h2><div class="mny-scroll"><table class="tbl"><thead><tr><th>אירוע</th><th>תאריך</th><th>תשובות</th><th>המלצה</th><th>חוויה</th><th>הערות</th><th>לחצו ביקורת</th><th></th></tr></thead><tbody>
${d.events.map((e) => `<tr data-row><td>${esc(e.name || e.token.slice(0, 8))}</td><td class="num">${esc(e.date ? fmtDate(e.date + 'T12:00:00Z') : '—')}</td><td class="num">${fmtN(e.n)}</td><td class="num">${esc(sc(e.avg_nps))}</td><td class="num">${esc(sc(e.avg_exp))}</td><td class="num">${fmtN(e.notes)}</td><td class="num">${fmtN(e.review_clicks)}</td><td><a class="btn ghost sm" href="${esc(e.review_url)}" target="_blank" rel="noopener">דף המשוב</a></td></tr>`).join('') || '<tr><td colspan="8" class="muted">אין</td></tr>'}</tbody></table></div></section>
<section class="card"><h2 class="h2">כל התשובות</h2><div class="mny-scroll"><table class="tbl"><thead><tr><th>מתי</th><th>אירוע</th><th>מי</th><th>המלצה</th><th>חוויה</th><th>מסלול</th><th>הערה</th></tr></thead><tbody>
${d.feedback.map((f) => `<tr><td class="num">${esc(f.at ? fmtDate(f.at) : '—')}</td><td>${esc(f.name || f.token.slice(0, 8))}</td><td>${f.who === 2 ? 'בן/בת זוג' : 'לקוח'}</td><td class="num">${esc(sc(f.nps))}</td><td class="num">${esc(sc(f.exp))}</td><td>${esc(f.route || (f.left ? 'עזב' : ''))}</td><td>${esc(f.note)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">אין</td></tr>'}</tbody></table></div></section>`;
}
export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.card(5) + Skeleton.table(6),
  async mount(el, ctx) {
    ensureCss();
    let data = null;
    const load = async () => { try { data = await ctx.api.get('feedback', {}); el.innerHTML = view(data); } catch (e) { if (!data) el.innerHTML = ctx.errorBox(e); } };
    const c = ctx.api.cached('feedback', {}); if (c) { data = c.data; el.innerHTML = view(data); }
    await load();
    ctx.poll(load, 10 * 60e3);
  },
};
