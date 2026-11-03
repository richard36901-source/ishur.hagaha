/* תבניות (#/templates, g n) · GET /api/ops/templates — every template on the three WABAs with status,
   category and quality, per-template sends / delivered / read / failed (template-stats over 30 days),
   pending ones with their age. "הגשת גרסה" copies a template's components under a new name and submits
   it to Meta (POST /api/ops/template-variant) behind a typed confirm = the new name. Lazy module. */
import { esc, fmtN, Skeleton, Button, confirmTyped, toast, busy } from '../ui.js';
import { ensureCss, pct, stackedBars, tableView } from './charts.js';

const ST_TONE = { APPROVED: 'good', PENDING: 'warn', IN_APPEAL: 'warn', REJECTED: 'crit', PAUSED: 'serious', DISABLED: 'crit' };
const ST_HE = { APPROVED: 'מאושרת', PENDING: 'ממתינה', IN_APPEAL: 'בערעור', REJECTED: 'נדחתה', PAUSED: 'מושהית', DISABLED: 'מושבתת' };
const Q_HE = { GREEN: 'גבוהה', YELLOW: 'בינונית', RED: 'נמוכה', UNKNOWN: 'לא ידוע' };
export function match(t, st) { return (!st.waba || t.waba === st.waba) && (!st.status || t.status === st.status) && (!st.q || t.name.includes(st.q.toLowerCase())); }
export function view(d, st) {
  const list = d.templates.filter((t) => match(t, st));
  const pending = d.templates.filter((t) => t.pending);
  const top = d.templates.filter((t) => t.sends > 0).sort((a, b) => b.sends - a.sends).slice(0, 12);
  const chart = top.length ? stackedBars(top.map((t) => ({ bucket: t.name, delivered: Math.max(0, t.delivered - t.read), read: t.read, failed: t.failed + t.rejected })), ['read', 'delivered', 'failed'], { labels: { read: 'נקראו', delivered: 'נמסרו (לא נקראו)', failed: 'נכשלו' }, fmt: (v) => fmtN(Math.round(v)), xLabel: (b) => b.slice(0, 10), title: 'ביצועי תבניות' }) : '';
  return `<div class="card"><div class="mny-h"><h2 class="h2">תבניות בשלושת חשבונות הוואטסאפ</h2><span class="sp"></span>${Object.entries(d.by_status).map(([k, n]) => `<span class="badge ${ST_TONE[k] || ''}">${esc(ST_HE[k] || k)} ${fmtN(n)}</span>`).join(' ')}</div>
<div class="cal-filters"><div class="seg" role="tablist" aria-label="חשבון">${[['', 'הכל'], ...d.wabas.map((w) => [w.key, w.he])].map(([k, he]) => `<button type="button" role="tab" data-act="tp-waba" data-v="${esc(k)}" aria-selected="${(st.waba || '') === k}">${esc(he)}</button>`).join('')}</div>
<div class="seg" role="tablist" aria-label="מצב">${['', 'APPROVED', 'PENDING', 'REJECTED', 'PAUSED'].map((k) => `<button type="button" role="tab" data-act="tp-st" data-v="${k}" aria-selected="${(st.status || '') === k}">${esc(k ? ST_HE[k] : 'כל המצבים')}</button>`).join('')}</div>
<input class="in" data-search placeholder="חיפוש שם תבנית" aria-label="חיפוש תבנית" value="${esc(st.q || '')}"></div>
${d.errors.length ? `<div class="errbox" role="status"><span style="flex:1">לא נטענו: ${d.errors.map((e) => esc(e.waba + ' · ' + e.error)).join(' · ')}</span></div>` : ''}</div>
${pending.length ? `<section class="card"><h2 class="h2">ממתינות לאישור מטא</h2><ul class="plain">${pending.map((t) => `<li>${esc(t.name)} <span class="muted">${esc(t.waba_he)}</span> · ${t.pending_age_days == null ? 'גיל לא ידוע' : 'ממתינה ' + fmtN(t.pending_age_days) + ' ימים'}</li>`).join('')}</ul></section>` : ''}
${chart ? `<section class="card"><h2 class="h2">מסירה וקריאה · ${fmtN(d.days)} ימים</h2>${chart}${d.stats_partial ? '<p class="sub">חלק מהימים עוד לא חושבו (נטען בהדרגה)</p>' : ''}</section>` : ''}
<section class="card"><div class="mny-scroll"><table class="tbl"><thead><tr><th>תבנית</th><th>חשבון</th><th>מצב</th><th>קטגוריה</th><th>איכות</th><th>נשלחו</th><th>נמסרו</th><th>נקראו</th><th>נכשלו</th><th></th></tr></thead><tbody>
${list.map((t) => `<tr data-row><td><span class="mono" dir="ltr">${esc(t.name)}</span>${t.rejected_reason ? `<div class="sub">${esc(t.rejected_reason)}</div>` : ''}</td><td>${esc(t.waba_he)}</td><td><span class="badge ${ST_TONE[t.status] || ''}">${esc(ST_HE[t.status] || t.status)}</span>${t.pending && t.pending_age_days != null ? ` <span class="sub">${fmtN(t.pending_age_days)} ימים</span>` : ''}</td><td>${esc(t.category)}</td><td>${esc(Q_HE[t.quality] || t.quality || '—')}</td><td class="num">${fmtN(t.sends)}</td><td class="num">${fmtN(t.delivered)} <span class="sub">${esc(pct(t.delivery_rate))}</span></td><td class="num">${fmtN(t.read)} <span class="sub">${esc(pct(t.read_rate))}</span></td><td class="num">${fmtN(t.failed + t.rejected)}</td><td>${Button('הגשת גרסה', { size: 'sm', variant: 'ghost', act: 'tp-variant', attr: { 'data-w': t.waba, 'data-n': t.name } })}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">אין תבנית שמתאימה</td></tr>'}</tbody></table></div></section>`;
}
export function suggestName(name, existing) { const b = name.replace(/_v\d+$/, ''); for (let i = 2; i < 50; i++) { const n = b + '_v' + i; if (!existing.has(n)) return n; } return b + '_v' + Date.now() % 1000; }
export default {
  skeleton: () => Skeleton.card(3) + Skeleton.table(10),
  async mount(el, ctx) {
    ensureCss();
    const st = { waba: '', status: '', q: '' };
    let data = null;
    const paint = () => { if (!data) return; const f = document.activeElement && document.activeElement.matches('[data-search]'); el.innerHTML = view(data, st); if (f) { const s = el.querySelector('[data-search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); } };
    const load = async (fresh) => { try { data = await ctx.api.get('templates', fresh ? { fresh: '1' } : {}); paint(); } catch (e) { if (!data) el.innerHTML = ctx.errorBox(e); } };
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { st.q = e.target.value.trim(); paint(); } });
    ctx.on(el, 'click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'tp-waba') { st.waba = b.dataset.v; paint(); }
      else if (b.dataset.act === 'tp-st') { st.status = b.dataset.v; paint(); }
      else if (b.dataset.act === 'tp-variant') {
        const nn = suggestName(b.dataset.n, new Set(data.templates.map((t) => t.name)));
        const pre = await ctx.api.post('template-variant', { waba: b.dataset.w, name: b.dataset.n, new_name: nn }).catch((x) => { toast('השרת סירב: ' + x.message, 'crit'); return null; }); if (!pre) return;
        const ok = await confirmTyped({ title: 'הגשת גרסה חדשה למטא', body: `<p>העתק של <b class="mono" dir="ltr">${esc(b.dataset.n)}</b> בשם <b class="mono" dir="ltr">${esc(nn)}</b> יוגש לאישור מטא (${esc((pre.preview || {}).category || '')}). לא נשלחת אף הודעה; התבנית החדשה לא תשמש עד שתופעל.</p>`, word: pre.confirm_required, action: 'הגש' });
        if (!ok) return;
        await busy(b, async () => { const r = await ctx.api.post('template-variant', { waba: b.dataset.w, name: b.dataset.n, new_name: nn, confirm: nn }, { soft: true }); toast(r.ok ? 'הוגשה למטא' : 'מטא סירבה: ' + JSON.stringify((r.meta && r.meta.error && r.meta.error.message) || r.error || ''), r.ok ? 'good' : 'crit'); if (r.ok) await load(true); });
      }
    });
    const c = ctx.api.cached('templates', {}); if (c) { data = c.data; paint(); }
    await load();
  },
};
