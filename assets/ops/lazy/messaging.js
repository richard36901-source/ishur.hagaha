/* הודעות (Phase 4a rewrite): one row per MESSAGE. GET /api/ops/messages joins audit wa_out + wa_status
   (by wamid; the row shows the latest status) + wa_in (the guest's reply within 24 h). Tabs הכל / נכשלו / תשובות.
   Click a row → full text, the reply, template, reason, status history. Number cards on top come from realtime. */
import { esc, fmtN, fmtTime, fmtDT, Tabs, Skeleton, Button, Phone, EventLink, thSort, savedSort } from '../ui.js';
import { fmtPhone, roleBadge, statusBadge, errHe, ilDay, shiftDay } from './shared4a.js';

export function numberStrip(rt) {
  const ns = (rt && rt.wa && rt.wa.numbers) || [];
  if (!ns.length) return '';
  return `<div class="grid g-3">${ns.map((n) => `<article class="card"><div class="sec-h"><h3 class="h2">${esc(n.label)}</h3><span class="sp"></span><span class="sub mono" dir="ltr">${esc(n.tier || n.role || '')}</span></div>
<p class="sub" style="margin:4px 0 0"><b class="num">${fmtN(n.sent_today)}</b> נשלחו היום${n.limit != null ? ` · תקרה ${fmtN(n.limit)} · נשאר ${fmtN(n.remaining)}` : ''} · <span class="num">${fmtN((n.rejected_today || 0) + (n.failed_async_today || 0))}</span> נכשלו</p></article>`).join('')}</div>`;
}
const who = (name, phone, role) => `<span class="who-n">${esc(name || 'לא מזוהה')} ${role ? roleBadge(role) : ''}</span><span class="who-p">${Phone(phone, { name })}</span>`;
void fmtPhone;
export function detail(x) {
  if (x.dir === 'in') return `<div class="msg-txt in">${esc(x.text || '—')}</div><dl class="kv"><dt>זמן</dt><dd class="num">${esc(fmtDT(x.at))}</dd><dt>תשובה ל</dt><dd>${x.in_reply_to ? esc((x.in_reply_to.template || x.in_reply_to.type) + ' · ' + fmtDT(x.in_reply_to.at)) : 'לא נמצאה שליחה ב-24 השעות שלפני'}</dd></dl>
<p class="sub"><a href="#/inbox/${esc(x.from)}">לשיחה באינבוקס ←</a></p>`;
  return `<div class="msg-txt">${esc(x.text || '(אין טקסט בלוג)')}</div>
${x.reply ? `<div class="sub">התשובה (${esc(fmtTime(x.reply.at))}):</div><div class="msg-txt in">${esc(x.reply.text)}</div>` : '<p class="sub">אין תשובה בתוך 24 שעות.</p>'}
<dl class="kv"><dt>תבנית</dt><dd class="mono" dir="ltr">${esc(x.template || '— (טקסט חופשי)')}</dd><dt>למה נשלח</dt><dd>${esc(x.reason || x.type_he || '')}</dd>
<dt>מצב</dt><dd>${statusBadge(x.status, x.error_code)}${x.status === 'failed' ? ' ' + esc(errHe(x.error_code, x.error)) : ''}</dd>
<dt>היסטוריה</dt><dd class="num">${esc(['נשלח ' + fmtTime(x.at), ...(x.statuses || []).filter((s) => s.status !== 'sent').map((s) => ({ delivered: 'נמסר', read: 'נקרא', failed: 'נכשל' }[s.status] || s.status) + ' ' + fmtTime(s.at))].join(' → '))}</dd>
${x.wamid ? `<dt>wamid</dt><dd class="mono sub" dir="ltr">${esc(x.wamid)}</dd>` : ''}</dl><p class="sub"><a href="#/inbox/${esc(x.to)}">לשיחה באינבוקס ←</a></p>`;
}
export function table(items, tab, open = new Set()) {
  if (!items.length) return `<div class="empty">${tab === 'failed' ? 'אין הודעות שנכשלו ביום הזה' : tab === 'replies' ? 'אין תשובות ביום הזה' : 'אין הודעות ביום הזה'}</div>`;
  const inb = tab === 'replies';
  const head = inb ? ['שעה', 'מספר', 'מאת', 'אירוע', 'הודעה'] : ['שעה', 'מספר', 'נמען', 'אירוע', 'סוג', 'מצב'];
  const hideM = inb ? [false, true, false, true, false] : [false, true, false, true, true, false];
  const cols = head.length;
  const rows = items.map((x) => {
    const ex = open.has(x.id);
    const cells = inb ? [`<span class="num">${esc(fmtTime(x.at))}</span>`, esc(x.number.label), who(x.from_name, x.from, x.from_role), EventLink(x.event, x.token8), `<span class="ellip">${esc(String(x.text).slice(0, 80))}</span>`]
      : [`<span class="num">${esc(fmtTime(x.at))}</span>`, esc(x.number.label), who(x.to_name, x.to, x.to_role), EventLink(x.event, x.token8), `<span class="badge">${esc(x.type_he || x.type)}</span>`, statusBadge(x.status, x.error_code) + (x.reply ? ' <span title="ענו" aria-label="ענו">💬</span>' : '')];
    const sv = inb ? [x.ts, x.number.label, x.from_name || x.from, x.event, x.text] : [x.ts, x.number.label, x.to_name || x.to, x.event, x.type_he, x.status];
    return `<tr class="msg-row" data-row="${esc(x.id)}" data-act="msg-x" tabindex="0" aria-expanded="${ex}">${cells.map((c, i) => `<td${hideM[i] ? ' class="hide-m"' : ''} data-sv="${esc(sv[i] == null ? '' : sv[i])}">${c}</td>`).join('')}</tr>${ex ? `<tr class="msg-det" data-det="${esc(x.id)}"><td colspan="${cols}">${detail(x)}</td></tr>` : ''}`;
  }).join('');
  const sid = 'messages:' + (inb ? 'in' : 'out'), st = savedSort(sid);
  return `<div class="tbl-wrap"><table class="tbl" data-sort-id="${sid}" data-sort-dom><thead><tr>${head.map((h, i) => thSort(h, i, st, hideM[i] ? 'hide-m' : '')).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
export function view(s) {
  const d = s.data, today = ilDay();
  return `${numberStrip(s.rt)}
<section class="card flush"><div class="sec-h msg-tb" style="padding:12px 16px">
${Button('‹', { size: 'sm', act: 'msg-day', attr: { 'data-d': '-1', 'aria-label': 'יום קודם' } })}<span class="day">${esc(s.day.split('-').reverse().slice(0, 2).join('/'))}${s.day === today ? ' · היום' : ''}</span>${Button('›', { size: 'sm', act: 'msg-day', attr: { 'data-d': '1', 'aria-label': 'יום הבא' }, disabled: s.day >= today })}${s.day !== today ? Button('היום', { size: 'sm', variant: 'ghost', act: 'msg-today' }) : ''}
<span class="sp"></span>${Tabs({ name: 'msgtab', value: s.tab, items: [{ value: 'all', label: 'הכל', count: d ? d.counts.all : null }, { value: 'failed', label: 'נכשלו', count: d ? d.counts.failed : null }, { value: 'replies', label: 'תשובות', count: d ? d.counts.replies : null }] })}</div>
${d ? table(d.items, s.tab, s.open) + (d.next_cursor ? `<div style="text-align:center;padding:10px">${Button('עוד הודעות', { act: 'msg-more' })}</div>` : '') + (d.truncated ? '<p class="sub" style="padding:0 16px 12px">הלוג נחתך (יותר מדי שורות ביום), ייתכן שחסרות הודעות.</p>' : '') : Skeleton.table(8)}</section>`;
}

export default {
  skeleton: () => `${Skeleton.table(8)}`,
  async mount(el, ctx) {
    const s = { day: ilDay(), tab: 'all', data: null, open: new Set(), rt: ctx.api.cached('realtime')?.data || null };
    const paint = () => { el.innerHTML = view(s); };
    const load = async (more = false) => {
      const d = await ctx.api.get('messages', { day: s.day, tab: s.tab, ...(more && s.data ? { cursor: s.data.next_cursor } : {}) }, { cache: !more });
      s.data = more && s.data ? { ...d, items: s.data.items.concat(d.items) } : d; paint();
    };
    paint();
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'msgtab') { s.tab = e.detail.value; s.data = null; s.open.clear(); paint(); load().catch((er) => { el.innerHTML = ctx.errorBox(er); }); } });
    const toggle = (row) => { const id = row.dataset.row; if (s.open.has(id)) s.open.delete(id); else s.open.add(id); paint(); el.querySelector(`tr[data-row="${CSS.escape(id)}"]`)?.focus(); };
    ctx.on(el, 'click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a || e.target.closest('a,.ph,.th-s')) return;
      if (a.dataset.act === 'msg-x') toggle(a);
      else if (a.dataset.act === 'msg-day' && a.getAttribute('aria-disabled') !== 'true') { s.day = shiftDay(s.day, +a.dataset.d); s.data = null; s.open.clear(); paint(); load(); }
      else if (a.dataset.act === 'msg-today') { s.day = ilDay(); s.data = null; paint(); load(); }
      else if (a.dataset.act === 'msg-more') load(true);
    });
    ctx.on(el, 'keydown', (e) => { const r = e.target.closest && e.target.closest('tr.msg-row'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(r); } });
    await load();
    ctx.api.get('realtime').then((rt) => { s.rt = rt; paint(); }).catch(() => {});
    ctx.poll(() => (s.day === ilDay() && !s.open.size ? load() : Promise.resolve()), 20000);
  },
};
