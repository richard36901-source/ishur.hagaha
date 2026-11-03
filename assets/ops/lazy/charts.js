/* Shared inline-SVG charts for the money screens (lazy; imported by finance/ads/templates/feedback).
   dataviz method: categorical slots c1..c4 in fixed order (validated light + dark with
   validate_palette.js 03/11: all checks pass; c2 amber is under 3:1 on white → every chart ships a
   legend + a table view), thin marks, 2px surface gaps between stacked fills, 4px rounded data
   ends, recessive grid, a per-mark hover tooltip (ui.js [data-tip]) with hit targets wider than
   the mark, one axis only. Text wears ink tokens, never the series color. */
import { esc, fmtN } from '../ui.js';

const CSS = `/* series colours --c1..--c4 come from the brand tokens in ops.css (green-mid, gold, slate, mauve) */
.vz{width:100%;height:auto;display:block;overflow:visible}.vz text{direction:ltr;unicode-bidi:isolate;fill:var(--ink-3);font-size:11px;font-family:var(--font-num,inherit)}
@media (max-width:640px){.vz text{font-size:19px}}
.vz .grid{stroke:var(--line);stroke-width:1}.vz .base{stroke:var(--line-2);stroke-width:1}.vz .hit{fill:transparent;cursor:default}
.vz .hit:hover{fill:color-mix(in srgb,var(--ink) 6%,transparent)}.vz .ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.vz .dot{stroke:var(--surface);stroke-width:2}
.vz-leg{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--ink-2);margin:4px 0 6px}.vz-leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:5px;vertical-align:-1px}
.vz-tbl{margin-top:6px}.vz-tbl summary{cursor:pointer;font-size:12px;color:var(--ink-3)}.vz-tbl .tbl{font-size:12px}
.mny-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.grid>.card{min-width:0}.card .seg{flex-wrap:wrap;max-width:100%}
.mny-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}.mny-scroll .tbl{min-width:560px}
.mny-grid .tile b.num{unicode-bidi:isolate;direction:ltr}.mny-grid .tile b.num{text-align:start;align-self:flex-start}
.neg{color:var(--crit-ink)}.pos{color:var(--good-ink)}.est{color:var(--ink-3);font-size:11px}
.h3{font-size:13px;font-weight:600;margin:0 0 6px;color:var(--ink-2)}
.mny-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}.mny-h .h2{margin:0}.mny-h .sp{flex:1}`;
export function ensureCss() { if (typeof document === 'undefined' || document.getElementById('vz-css')) return; const s = document.createElement('style'); s.id = 'vz-css'; s.textContent = CSS; document.head.appendChild(s); }
export const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
export const ils = (n) => (n == null || Number.isNaN(+n) ? '—' : '₪' + fmtN(Math.round(+n)));
export const axisN = (v) => { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1000 ? fmtN(Math.round(a / 100) / 10) + 'K' : fmtN(Math.round(a))); };
const nice = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

export function legend(keys, labels) { return keys.length < 2 ? '' : `<div class="vz-leg" aria-hidden="true">${keys.map((k, i) => `<span><i style="background:${COLORS[i % 4]}"></i>${esc(labels[k] || k)}</span>`).join('')}</div>`; }

/* rows: [{bucket, [k]: n}] · keys stack bottom→top in fixed order */
export function stackedBars(rows, keys, { labels = {}, h = 180, fmt = ils, axis = axisN, xLabel = (b) => b.slice(5), title = '' } = {}) {
  const W = 640, L = 44, B = 22, T = 8, n = rows.length || 1;
  const max = nice(Math.max(1, ...rows.map((r) => keys.reduce((s, k) => s + Math.max(0, +r[k] || 0), 0))));
  const step = (W - L) / n, bw = Math.max(3, Math.min(36, step * 0.66)), y = (v) => T + (h - T - B) * (1 - v / max);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(axis(v))}</text>`; }
  const every = Math.ceil(n / 8);
  rows.forEach((r, i) => {
    const x = L + i * step + (step - bw) / 2; let acc = 0; const segs = [];
    keys.forEach((k, ki) => { const v = Math.max(0, +r[k] || 0); if (!v) return; const y0 = y(acc), y1 = y(acc + v); acc += v; segs.push({ ki, y0, y1 }); });
    segs.forEach((s, j) => { const top = j === segs.length - 1, hh = Math.max(0, s.y0 - s.y1 - (j ? 2 : 0)); if (hh <= 0) return;
      g += top && hh > 4 ? `<path d="M${x},${s.y0 - (j ? 2 : 0)}V${s.y1 + 4}q0,-4 4,-4h${bw - 8}q4,0 4,4V${s.y0 - (j ? 2 : 0)}z" fill="${COLORS[s.ki % 4]}"/>` : `<rect x="${x}" y="${s.y1}" width="${bw}" height="${hh}" fill="${COLORS[s.ki % 4]}"/>`; });
    const tip = r.bucket + ' · ' + keys.map((k) => (labels[k] || k) + ' ' + fmt(+r[k] || 0)).join(' · ');
    g += `<rect class="hit" x="${L + i * step}" y="${T}" width="${step}" height="${h - T - B}" data-tip="${esc(tip)}"/>`;
    if (i % every === 0) g += `<text x="${L + i * step + step / 2}" y="${h - 6}" text-anchor="middle">${esc(xLabel(r.bucket))}</text>`;
  });
  g += `<line class="base" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>`;
  return `${legend(keys, labels)}<svg class="vz" dir="ltr" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">${g}</svg>`;
}

/* series: [{key, label, points:[{x, y}]}] sharing x (same order) · values may be negative */
export function lineChart(series, { h = 170, fmt = ils, axis = axisN, xLabel = (b) => b.slice(5), title = '', min: forceMin = null } = {}) {
  const W = 640, L = 44, B = 22, T = 8, xs = (series[0] && series[0].points.map((p) => p.x)) || [], n = Math.max(1, xs.length);
  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null);
  let lo = forceMin != null ? forceMin : Math.min(0, ...all), hi = nice(Math.max(1, ...all)); if (lo < 0) lo = -nice(-lo);
  const y = (v) => T + (h - T - B) * (1 - (v - lo) / (hi - lo || 1)), x = (i) => L + (n === 1 ? (W - L) / 2 : (i * (W - L - 12)) / (n - 1) + 6);
  let g = '';
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4; g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(axis(v))}</text>`; }
  if (lo < 0) g += `<line class="base" x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>`;
  series.forEach((s, si) => {
    const pts = s.points.map((p, i) => (p.y == null ? null : [x(i), y(p.y)])).filter(Boolean);
    if (pts.length > 1) g += `<path class="ln" stroke="${COLORS[si % 4]}" d="M${pts.map((p) => p.join(',')).join('L')}"/>`;
    if (pts.length <= 12) pts.forEach((p) => { g += `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="4" fill="${COLORS[si % 4]}"/>`; });
  });
  const every = Math.ceil(n / 8), hw = (W - L) / n;
  xs.forEach((b, i) => {
    const tip = b + ' · ' + series.map((s) => s.label + ' ' + (s.points[i].y == null ? '—' : fmt(s.points[i].y))).join(' · ');
    g += `<rect class="hit" x="${x(i) - hw / 2}" y="${T}" width="${hw}" height="${h - T - B}" data-tip="${esc(tip)}"/>`;
    if (i % every === 0) g += `<text x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(xLabel(b))}</text>`;
  });
  return `${legend(series.map((s) => s.key), Object.fromEntries(series.map((s) => [s.key, s.label])))}<svg class="vz" dir="ltr" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">${g}</svg>`;
}

/* horizontal bars, one series, sorted by the caller (magnitude → one hue) */
export function hBars(items, { fmt = ils, max: m = null } = {}) {
  const max = m || Math.max(1, ...items.map((x) => x.v));
  return `<div class="hb">${items.map((x) => `<div class="hb-r" data-tip="${esc(x.label + ' · ' + fmt(x.v))}" style="display:grid;grid-template-columns:minmax(90px,30%) 1fr auto;gap:8px;align-items:center;font-size:12.5px;margin:3px 0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.label)}</span><span style="height:10px;background:var(--track);border-radius:4px;overflow:hidden"><i style="display:block;height:100%;width:${Math.max(0, Math.min(100, (100 * x.v) / max))}%;background:var(--c1);border-radius:0 4px 4px 0"></i></span><span class="num">${esc(fmt(x.v))}</span></div>`).join('')}</div>`;
}

/* table view under every chart (the a11y + amber-contrast relief) */
export function tableView(cols, rows, summary = 'טבלה') {
  return `<details class="vz-tbl"><summary>${esc(summary)}</summary><div class="mny-scroll"><table class="tbl"><thead><tr>${cols.map((c) => `<th>${esc(c.he)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
export const pct = (v) => (v == null ? '—' : fmtN(v) + '%');
export const signed = (v, f = ils) => (v == null ? '—' : `<span class="${v < 0 ? 'neg' : ''}">${esc(f(v))}</span>`);
export function rangeSeg(cur, opts = [['30d', '30 יום'], ['90d', '90 יום'], ['12m', 'שנה']], act = 'mny-range') {
  return `<div class="seg" role="tablist" aria-label="טווח">${opts.map(([v, he]) => `<button type="button" role="tab" data-act="${act}" data-v="${v}" aria-selected="${cur === v}">${esc(he)}</button>`).join('')}</div>`;
}
