/* שליטה ידנית (Phase 4a, port of ops-manual.html). Every destructive action shows its blast radius and needs a
   typed word; the server logs each one in the change log (CHANGE_ROUTES in worker/index.js). State from
   GET /api/ops/control; actions through the existing routes: /api/pause, /api/pacer, /api/daily-run,
   /api/event-flag, /api/block-phone, /api/brain-toggle, /api/ipn-replay. */
import { esc, fmtN, relTime, Button, Select, Skeleton, confirmTyped, toast, busy } from '../ui.js';
import { fmtPhone } from './shared4a.js';

const WHO = 'Richard (מרכז שליטה)';
/* action id → typed word, blast-radius text, request. Exported so the smoke test can check every action is gated. */
export const ACTIONS = {
  pause: { word: 'עצור', title: 'עצירה כללית', blast: () => 'אף הודעה (שיר + נועה) ואף שיחה של שיר לא יוצאות, כולל המנוע היומי, הפעימה כל 10 דקות, השלמות ושליחה חוזרת, עד שמחזירים.', req: () => ['/pause', { paused: true }] },
  resume: { word: 'המשך', title: 'החזרת השליחה', blast: () => 'הפעימה הקרובה (עד 10 דקות) ממשיכה מאיפה שעצרנו: הודעות ושיחות שממתינות להיום יוצאות בפועל.', req: () => ['/pause', { paused: false }] },
  pacer: { word: 'פעימה', title: 'פעימה אמיתית עכשיו', blast: () => 'הודעות ושיחות שממתינות יוצאות עכשיו בפועל (עד תקרת הפעימה), במקום לחכות לפעימה הבאה.', req: () => ['/pacer', {}] },
  dry: { word: null, title: 'הרצה יבשה של המנוע', blast: () => 'לא שולח כלום. מראה כמה פעולות היו קורות.', req: () => ['/daily-run', { dry: true }] },
  real: { word: 'מנוע', title: 'הרצה אמיתית של המנוע היומי', blast: () => 'כל הגלים, התזכורות והשליחות של היום לכל האירועים יוצאים בפועל, כמו בריצת הבוקר.', req: () => ['/daily-run', { dry: false }] },
  hold: { word: (e) => 'hold:' + e.tok8, title: 'השהיית אירוע', blast: (e) => `שום הודעה ושום שיחה לא יוצאת לאורחי "${e.name}" (${fmtN(e.guests)} אורחים, ${fmtN(e.pending)} עוד לא ענו) עד שמבטלים את ההשהיה.`, req: (e) => ['/event-flag', { token: e.token, flag: 'hold', on: true }] },
  unhold: { word: (e) => 'unhold:' + e.tok8, title: 'ביטול השהיה', blast: (e) => `האירוע "${e.name}" חוזר לפעול: הגלים והתזכורות שלו ממשיכים בפעימה הקרובה.`, req: (e) => ['/event-flag', { token: e.token, flag: 'hold', on: false }] },
  cancel: { word: (e) => 'cancel:' + e.tok8, title: 'ביטול אירוע', blast: (e) => `האירוע "${e.name}" מסומן כמבוטל בגיליון (בוטל? = כן): הגלים נעצרים, ולאורחים של הכל-כלול יוצאת הודעת ביטול בריצה הבאה של המנוע.`, req: (e) => ['/event-flag', { token: e.token, flag: 'cancel', on: true }] },
  uncancel: { word: (e) => 'uncancel:' + e.tok8, title: 'החזרת אירוע מבוטל', blast: (e) => `הסימון "בוטל" יוסר מ"${e.name}" והאירוע יחזור לפעול.`, req: (e) => ['/event-flag', { token: e.token, flag: 'cancel', on: false }] },
  block: { word: 'חסום', title: 'חסימת מספר', blast: (p) => `המספר ${fmtPhone(p)} לא יקבל יותר כלום משום מספר שלנו, עד שמשחררים.`, req: (p) => ['/block-phone', { phone: p, blocked: true }] },
  unblock: { word: 'שחרר', title: 'שחרור מספר', blast: (p) => `המספר ${fmtPhone(p)} חוזר לקבל הודעות, כולל אם ביקש הסרה בעצמו (ההסרה נמחקת).`, req: (p) => ['/block-phone', { phone: p, blocked: false }] },
  brain_on: { word: 'נועה', title: 'הדלקת נועה AI', blast: () => 'נועה תתחיל לענות אוטומטית לכל הלקוחות והלידים ב-4499. ההחלטה הנוכחית שלך: המענה האוטומטי כבוי.', req: () => ['/brain-toggle', { active: true }] },
  brain_off: { word: 'כבה', title: 'כיבוי נועה AI', blast: () => 'נועה מפסיקה לענות אוטומטית ב-4499. הודעות מערכת ותבניות ממשיכות לצאת.', req: () => ['/brain-toggle', { active: false }] },
  ipn: { word: (id) => id, title: 'הרצה מחדש של תשלום שחנה', blast: (id) => `התשלום ${id} עובר שוב בצינור הרגיל: חבילה/תוסף נפתחים ללקוח, נשלחות הודעות אישור וחשבונית אם מופעלים. פעם אחת בלבד.`, req: (id) => ['/ipn-replay', { id }] },
};
export const wordOf = (id, arg) => { const w = ACTIONS[id].word; return typeof w === 'function' ? w(arg) : w; };

const card = (title, body) => `<article class="card"><h3 class="h2">${esc(title)}</h3>${body}</article>`;
const st = (id) => `<p class="st sub" id="st-${id}" role="status"></p>`;
export function view(c, s = {}) {
  const evs = (c && c.events) || [];
  const ev = evs.find((e) => e.token === s.ev) || evs[0] || null;
  const pill = (on, a, b) => `<span class="badge ${on ? 'crit' : 'good'}">${esc(on ? a : b)}</span>`;
  return `<p class="sub">כל פעולה כאן מציגה מה היא עוצרת או שולחת, ודורשת להקליד מילה לפני שהיא רצה. כל פעולה נרשמת ב<a href="#/changes">יומן השינויים</a>.</p>
<div class="ctl-grid">
${card('עצירה כללית', `${c ? pill(c.paused, 'השליחה עצורה', 'המערכת פועלת') : ''}<div class="row">${c && c.paused ? Button('החזרת השליחה…', { variant: 'primary', act: 'ctl', attr: { 'data-a': 'resume' } }) : Button('עצירת כל השליחה…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'pause' } })}</div>${st('pause')}`)}
${card('מנוע ופעימה', `<p class="sub">פעימה אחרונה: ${c && c.pacer.last_tick_at ? esc(relTime(c.pacer.last_tick_at)) : '—'}</p><div class="row">${Button('הרצה יבשה', { act: 'ctl', attr: { 'data-a': 'dry' } })}${Button('פעימה עכשיו…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'pacer' } })}${Button('הרצת המנוע (אמיתי)…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'real' } })}</div>${st('run')}`)}
${card('אירוע: השהיה / ביטול', evs.length ? `${Select({ name: 'ctl-ev', value: ev.token, label: 'אירוע', options: evs.map((e) => ({ value: e.token, label: `${e.name} · ${e.date ? e.date.split('-').reverse().slice(0, 2).join('/') : ''}${e.hold ? ' · מושהה' : ''}${e.cancel ? ' · מבוטל' : ''}` })) })}
<p class="sub">${esc(ev.client || '')} · ${fmtN(ev.guests)} אורחים · ${fmtN(ev.pending)} לא ענו · ${ev.hold ? pill(true, 'מושהה', '') : ''} ${ev.cancel ? pill(true, 'מבוטל', '') : ''}</p>
<div class="row">${ev.hold ? Button('ביטול השהיה…', { variant: 'primary', act: 'ctl', attr: { 'data-a': 'unhold' } }) : Button('השהיה…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'hold' } })}${ev.cancel ? Button('החזרת האירוע…', { act: 'ctl', attr: { 'data-a': 'uncancel' } }) : Button('ביטול האירוע…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'cancel' } })}</div>${st('ev')}` : '<p class="sub">אין אירועים פעילים.</p>')}
${card('חסימת מספר', `<input class="in" id="ctl-phone" dir="ltr" inputmode="tel" placeholder="05X-XXX-XXXX" aria-label="מספר טלפון" value="${esc(s.phone || '')}"><div class="row">${Button('בדיקה', { act: 'ctl-check' })}${Button('חסימה…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'block' } })}${Button('שחרור…', { act: 'ctl', attr: { 'data-a': 'unblock' } })}</div>${st('blk')}`)}
${card('נועה AI (4499)', `${c ? (c.brain_active == null ? '<span class="badge">לא ידוע</span>' : pill(!c.brain_active, 'המענה החכם כבוי', 'המענה החכם פעיל')) : ''}<div class="row">${c && c.brain_active ? Button('כיבוי…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'brain_off' } }) : Button('הדלקה…', { act: 'ctl', attr: { 'data-a': 'brain_on' } })}</div>${st('brain')}`)}
${card('תשלום שחנה (IPN)', `<input class="in" id="ctl-ipn" dir="ltr" placeholder="ipnmiss:1234567890" aria-label="מזהה תשלום"><div class="row">${Button('הרצה מחדש…', { variant: 'danger', act: 'ctl', attr: { 'data-a': 'ipn' } })}</div>${st('ipn')}`)}
</div>`;
}
const STATUS_SLOT = { pause: 'pause', resume: 'pause', pacer: 'run', dry: 'run', real: 'run', hold: 'ev', unhold: 'ev', cancel: 'ev', uncancel: 'ev', block: 'blk', unblock: 'blk', brain_on: 'brain', brain_off: 'brain', ipn: 'ipn' };
export function resultHe(id, r) {
  if (!r || r.ok === false) return 'נכשל' + (r && (r.error || r.why) ? ': ' + (r.error || r.why) : '');
  if (id === 'dry') return `הרצה יבשה: ${fmtN((r.events || []).length)} פעולות היו קורות. הפירוט במסך הריצות.`;
  if (id === 'real') return `המנוע רץ: ${fmtN((r.events || []).length)} פעולות.`;
  if (id === 'pacer') return `הפעימה רצה. ${r.sends && (r.sends.ran || r.sends.sent) ? 'הודעות נשלחו' : 'אין הודעות ממתינות'}, ${fmtN((r.calls && r.calls.dialed) || 0)} שיחות.`;
  if (id === 'ipn') return 'התשלום הורץ מחדש דרך הצינור הרגיל.';
  return 'בוצע. נרשם ביומן השינויים.';
}

export default {
  skeleton: () => `<div class="ctl-grid">${Skeleton.card(4)}${Skeleton.card(4)}${Skeleton.card(4)}</div>`,
  async mount(el, ctx) {
    const s = { ev: '', phone: '' }; let c = ctx.api.cached('control')?.data || null;
    const paint = () => { const ph = el.querySelector('#ctl-phone'); if (ph) s.phone = ph.value; el.innerHTML = view(c, s); };
    const load = async () => { c = await ctx.api.get('control'); if (!s.ev && c.events[0]) s.ev = c.events[0].token; paint(); };
    if (c) paint();
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'ctl-ev') { s.ev = e.detail.value; paint(); } });
    const phone = () => { let d = (el.querySelector('#ctl-phone')?.value || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1); return d; };
    const say = (slot, t, bad) => { const x = el.querySelector('#st-' + slot); if (x) { x.textContent = t; x.style.color = bad ? 'var(--crit-ink)' : ''; } };
    ctx.on(el, 'click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'ctl-check') { const p = phone(); if (p.length < 11) return say('blk', 'מספר לא תקין', 1); const r = await ctx.api.post('/block-phone', { phone: p }, { soft: true }); return say('blk', r && r.ok ? (r.blocked ? 'חסום ידנית. ' : '') + (r.opted_out ? 'ביקש הסרה. ' : '') + (!r.blocked && !r.opted_out ? 'פתוח לשליחה רגילה.' : '') : 'נכשל', !(r && r.ok)); }
      if (b.dataset.act !== 'ctl') return;
      const id = b.dataset.a, A = ACTIONS[id], slot = STATUS_SLOT[id];
      let arg = null;
      if (['hold', 'unhold', 'cancel', 'uncancel'].includes(id)) { arg = (c.events || []).find((x) => x.token === s.ev) || c.events[0]; if (!arg) return; }
      if (id === 'block' || id === 'unblock') { arg = phone(); if (arg.length < 11) return say(slot, 'מספר לא תקין', 1); }
      if (id === 'ipn') { arg = (el.querySelector('#ctl-ipn')?.value || '').trim(); if (!/^ipnmiss:\d+$/.test(arg)) return say(slot, 'המזהה נראה כמו ipnmiss: ואז מספר', 1); }
      const word = wordOf(id, arg);
      if (word && !(await confirmTyped({ title: A.title, word, action: A.title, body: `<p class="blast">${esc(A.blast(arg))}</p>` }))) return;
      const [path, body] = A.req(arg);
      try {
        const r = await busy(b, () => ctx.api.post(path, { ...body, who: WHO }, { soft: true }));
        say(slot, resultHe(id, r), !r || r.ok === false);
        if (r && r.ok !== false) { toast(resultHe(id, r)); if (id !== 'dry' && id !== 'ipn') load().then(() => say(slot, resultHe(id, r))).catch(() => {}); }
      } catch (er) { say(slot, 'נכשל: ' + (er.message || ''), 1); }
    });
    await load();
  },
};
