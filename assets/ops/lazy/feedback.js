/* פידבקים (#/feedback, g v) · GET /api/ops/feedback — every end-of-event answer (NPS + experience 1–10,
   note, review/clip clicks), a per-event roll-up with the link to the review page, and the average
   rating trend by week. Read-only. Lazy module.
   03/11 tab "הגרלה" (GET /api/ops/raffle): entries, ticket totals, countdown, "אומת" per claim
   (POST raffle/verify), the draw behind a typed confirm (POST raffle/draw), CSV export. */
import { esc, fmtN, fmtDate, Skeleton, Button, confirmTyped, toast, busy } from '../ui.js';
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
const pad = (n) => String(n).padStart(2, '0');
function left(iso) { const s = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000)); return `${Math.floor(s / 86400)} ימים ${pad(Math.floor(s % 86400 / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`; }
const chk = (e, f) => e[f + '_claimed_at'] ? `<label class="sub"><input type="checkbox" data-act="rf-verify" data-id="${esc(e.id)}" data-f="${f}" ${e[f + '_verified'] ? 'checked' : ''}> אומת</label>` : '<span class="muted">—</span>';
export function raffleView(r) {
  const c = r.config, n = r.counts, w = r.winner;
  const status = !c.on ? '<p class="muted">ההגרלה כבויה (RAFFLE.on=false). הדף מציג את הזרימה הישנה.</p>' : '';
  const win = w ? `<section class="card"><h2 class="h2">הזוכה</h2><p>כרטיס <b class="num">${esc(w.ticket)}</b> · ${esc(w.name || '')} · <span dir="ltr">${esc(w.phone)}</span> · מתוך ${fmtN(w.pool)} כרטיסים מאומתים · ${esc(fmtDate(w.at))}</p></section>` : '';
  return `${status}<div class="mny-grid">${tile('נרשמו', esc(fmtN(n.entries)))}${tile('כרטיסים', esc(fmtN(n.tickets)), esc(fmtN(n.verified_tickets)) + ' מאומתים')}${tile('סרטון / גוגל', esc(fmtN(n.video)) + ' / ' + esc(fmtN(n.google)))}${tile('עד ההגרלה', `<span id="rf-left">${esc(left(c.draw_at))}</span>`, esc(fmtDate(c.draw_at)) + ' · ' + esc(c.prize_he))}</div>
${win}<section class="card"><h2 class="h2">משתתפים</h2><div class="acts">${Button('ייצוא CSV', { act: 'rf-csv' })}${w ? '' : Button('הגרלה', { variant: 'danger', act: 'rf-draw' })}<span class="sub">רק כרטיסים שסומנו "אומת" נכנסים להגרלה</span></div>
<div class="mny-scroll"><table class="tbl"><thead><tr><th>מתי</th><th>שם</th><th>טלפון</th><th>אירוע</th><th>דירוג</th><th>טקסט</th><th>סרטון</th><th>גוגל</th><th>כרטיסים</th></tr></thead><tbody>
${r.entries.map((e) => `<tr><td class="num">${esc(fmtDate(e.created_at))}</td><td>${esc(e.name || '')}</td><td class="num" dir="ltr">${esc(e.phone)}</td><td class="num">${esc(String(e.token).slice(0, 8))}</td><td class="num">${esc(sc(e.rating && e.rating.nps))}/${esc(sc(e.rating && e.rating.exp))}</td><td>${esc(String(e.text || '').slice(0, 120))}</td><td>${chk(e, 'video')}</td><td>${chk(e, 'google')}</td><td class="num">${(e.tickets || []).map((t) => esc(t) + (e.ticket_src && e.ticket_src[t] === 'google' ? 'ג' : 'ס')).join(' · ')}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">עוד אין משתתפים</td></tr>'}</tbody></table></div></section>`;
}
function csv(r) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['created_at', 'name', 'phone', 'event_token', 'nps', 'exp', 'text', 'video_claimed_at', 'video_verified', 'google_claimed_at', 'google_verified', 'tickets', 'ip']]
    .concat(r.entries.map((e) => [e.created_at, e.name, e.phone, e.token, e.rating && e.rating.nps, e.rating && e.rating.exp, e.text, e.video_claimed_at, e.video_verified ? 1 : 0, e.google_claimed_at, e.google_verified ? 1 : 0, (e.tickets || []).join(' '), e.ip]));
  const blob = new Blob(['﻿' + rows.map((x) => x.map(q).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'raffle-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.card(5) + Skeleton.table(6),
  async mount(el, ctx) {
    ensureCss();
    let data = null, raf = null, tab = 'fb', timer = 0;
    el.innerHTML = `<div class="acts" role="tablist">${Button('משובים', { act: 'tab-fb', attr: { 'aria-selected': 'true' } })}${Button('הגרלה', { act: 'tab-rf' })}</div><div id="fb-body"></div>`;
    const body = el.querySelector('#fb-body');
    const paint = () => {
      el.querySelectorAll('[data-act^="tab-"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.act === 'tab-' + tab)));
      if (tab === 'fb') { if (data) body.innerHTML = view(data); }
      else if (raf) body.innerHTML = raffleView(raf); else body.innerHTML = Skeleton.tiles(4) + Skeleton.table(5);
    };
    const load = async () => { try { data = await ctx.api.get('feedback', {}); if (tab === 'fb') paint(); } catch (e) { if (!data && tab === 'fb') body.innerHTML = ctx.errorBox(e); } };
    const loadRaf = async () => { try { raf = await ctx.api.get('raffle', {}, { cache: false }); if (tab === 'rf') paint(); } catch (e) { if (tab === 'rf') body.innerHTML = ctx.errorBox(e); } };
    const c = ctx.api.cached('feedback', {}); if (c) { data = c.data; paint(); }
    el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'tab-fb' || act === 'tab-rf') { tab = act === 'tab-fb' ? 'fb' : 'rf'; paint(); if (tab === 'rf') { loadRaf(); clearInterval(timer); timer = setInterval(() => { const x = el.querySelector('#rf-left'); if (x && raf) x.textContent = left(raf.config.draw_at); }, 1000); } return; }
      if (act === 'rf-csv' && raf) { csv(raf); return; }
      if (act === 'rf-verify') {
        const r = await ctx.api.post('raffle/verify', { id: b.dataset.id, field: b.dataset.f, value: b.checked }).catch((e) => { toast('השרת סירב: ' + e.message, 'crit'); return null; });
        if (r && r.ok) { toast('נשמר'); loadRaf(); } else b.checked = !b.checked;
        return;
      }
      if (act === 'rf-draw' && raf) {
        const n = raf.counts.verified_tickets;
        if (!n) { toast('אין כרטיסים מאומתים', 'crit'); return; }
        const ok = await confirmTyped({ title: 'הגרלה', body: `<p>הגרלה אקראית אחת מבין ${esc(fmtN(n))} כרטיסים מאומתים. אי אפשר לבטל.</p>`, word: raf.confirm_word || 'draw', action: 'הגרל' });
        if (!ok) return;
        await busy(b, async () => {
          const r = await ctx.api.post('raffle/draw', { confirm: raf.confirm_word || 'draw', who: 'richard' }).catch((e) => { toast('השרת סירב: ' + e.message, 'crit'); return null; });
          if (r && r.ok) { toast('זכה כרטיס ' + r.winner.ticket); loadRaf(); }
        }).catch(() => {});
      }
    });
    await load();
    ctx.poll(() => (tab === 'fb' ? load() : loadRaf()), 10 * 60e3);
  },
};
