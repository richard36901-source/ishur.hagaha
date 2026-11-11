/* לייב (11/11, Richard: "המונה לייב ומתי משתחרר"): one screen for every question of the 10–11/11 chat.
   Data: GET /api/ops/sendlive (ops.js buildSendLive, math in worker/sendlive.js). Read-only, polls every 60 s.
   Lazy module (the counted bundle is at its 130 KB budget). */
import { esc, fmtN, fmtTime, fmtDate, relTime, StatTile, Skeleton, Badge, Table, EventLink } from '../ui.js';

const WHY = { paused: 'השליחה מושהית ידנית', hours: 'מחוץ לשעות השליחה', 'friday-window': 'שישי: עד 13:00', shabbat: 'שבת', 'window-closed': 'החלון סגור', 'wacap:guests': 'מטא חסמה את המספר (תקרה)', cap: 'התקרה מלאה — ממתין לשחרור', 'nothing-pending': 'אין מה לשלוח', sending: 'שולח' };
const GATE = { queue: ['open', 'בתור'], done: ['ok', 'הושלם'], hold: ['partial', 'מוחזק'], 'not-yet': ['', 'עוד לא הגיע התאריך'], abandoned: ['failed', 'ננטש (3 ימים)'], 'share-used': ['partial', 'מנת היום נוצלה'] };
const KIND = { w1: 'גל 1', w2: 'גל 2', w3: 'גל 3', daybefore: 'יום לפני', table: 'שולחנות', eventday: 'יום האירוע', gift: 'מתנה', thanks: 'תודה', cancel: 'ביטול' };
const VERIF = { verified: ['ok', 'מאומת'], not_verified: ['partial', 'לא מאומת'], pending: ['partial', 'בבדיקה'], pending_submission: ['partial', 'ממתין להגשה'], pending_need_more_info: ['failed', 'מטא מבקשת עוד מידע'], rejected: ['failed', 'נדחה'], unknown: ['', 'לא ידוע'] };

export function counterView(c, e) {
  const o = c.ours, m = c.meta;
  return `<div class="grid g-tiles">
${StatTile({ label: 'המונה שלנו (24 שעות)', value: fmtN(o.used), unit: '/ ' + fmtN(o.cap), meter: { value: o.used, max: o.cap }, sub: `תקרה ${fmtN(o.limit)} פחות מרווח ${fmtN(o.margin)}` })}
${StatTile({ label: 'פנוי עכשיו', value: fmtN(o.free), status: o.free > 0 ? 'ok' : 'partial', sub: o.free > 0 ? 'אפשר לשלוח' : 'ממתין לשחרור' })}
${StatTile({ label: 'מטא סופרת', value: fmtN(m.used), unit: '/ ' + fmtN(m.limit), sub: 'שיחות שהתחלנו ב-24 השעות האחרונות' })}
${StatTile({ label: 'נשלח היום', value: fmtN(c.sent_today), sub: (c.numbers || []).map((n) => esc(n.label) + ' ' + fmtN(n.used)).join(' · ') })}
</div>`;
}
export function releasesView(rel, now = Date.now()) {
  if (!rel || !rel.length) return '<div class="empty">אין הודעות בחלון — הכל פנוי.</div>';
  return `<ul class="tl" aria-label="שחרורים">${rel.map((r) => { const past = new Date(r.at).getTime() <= now; return `<li><time class="num" datetime="${esc(r.at)}">${esc(fmtTime(r.at))}</time><span class="ax"${past ? ' style="box-shadow:inset 0 0 0 2px var(--good)"' : ''}></span><span><b>+${fmtN(r.n)}</b> ${new Date(r.at).getTime() - now > 12 * 3600e3 ? `<span class="sub">(${esc(fmtDate(r.at))})</span> ` : ''}<span class="sub">→ פנוי ${fmtN(r.free_after)}</span>${past ? ' <span class="sub">שוחרר</span>' : ''}</span></li>`; }).join('')}</ul>`;
}
export function engineView(e) {
  const why = WHY[e.why] || e.why || '—';
  return `<p class="sub" style="margin:0">${e.paused ? Badge('failed', 'מושהה') : e.window_open ? Badge('ok', 'חלון פתוח') : Badge('partial', 'חלון סגור')} <b>${esc(why)}</b>${e.window_closes_at ? ` · החלון נסגר ב-${esc(fmtTime(e.window_closes_at))}` : ''}${e.last_tick ? ` · פעימה אחרונה ${esc(relTime(e.last_tick))}` : ''}${e.last_truncated ? ' · הפעימה האחרונה נקטעה (תקרה/מנה)' : ''}${e.cap_held_hours && e.cap_held_hours.length ? ` · היום נחתך בגלל התקרה ב-${e.cap_held_hours.map((h) => String((h + 2) % 24).padStart(2, '0') + ':00').join(', ')}` : ''}</p>`;
}
const etaCell = (r) => {
  if (r.gate === 'done') return '<span class="sub">הושלם</span>';
  if (!r.eta) return `<span class="sub">${esc((GATE[r.gate] || ['', r.gate])[1])}</span>`;
  const e = r.eta;
  if (e.done) return `<b>${esc(fmtTime(e.at))}</b>${e.daily_share != null ? ` <span class="sub">(${fmtN(e.daily_share)} היום)</span>` : ''}`;
  if (e.today > 0) return `היום ${fmtN(e.today)}, מחר ${fmtN(e.carried)}`;
  return `<span class="sub">${e.why === 'window-closed' ? 'מחר מ-09:00' : 'אין מקום היום — מחר'}</span>`;
};
export function eventsView(rows, today) {
  return Table({ id: 'sendlive-events', empty: 'אין גלים פעילים',
    columns: [
      { label: '#', num: true, render: (r) => (r.eta && r.eta.position ? fmtN(r.eta.position) : '') },
      { label: 'אירוע', render: (r) => `${EventLink(r.name || r.tok8, r.token)}<br><span class="sub">${esc(fmtDate(r.date))}</span>` },
      { label: 'גל', render: (r) => `גל ${r.wave}${r.prio ? ` <span class="badge info">עד ${fmtN(r.prio)} ביום</span>` : ''}` },
      { label: 'מצב', render: (r) => Badge((GATE[r.gate] || [''])[0] || 'info', (GATE[r.gate] || ['', r.gate])[1]) },
      { label: 'נשלחו', num: true, render: (r) => fmtN(r.sent) + ` <span class="sub">/ ${fmtN(r.eligible)}</span>` },
      { label: 'היום', num: true, render: (r) => fmtN(r.sent_today) },
      { label: 'נשאר', num: true, render: (r) => fmtN(r.left) },
      { label: 'סיום משוער', render: etaCell },
      { label: 'לפי ימים', render: (r) => Object.entries(r.by_day || {}).sort().slice(-4).map(([d, n]) => `<span class="sub">${esc(fmtDate(d))}</span> ${fmtN(n)}`).join(' · ') || '<span class="sub">—</span>' },
    ], rows, rowKey: (r) => r.tok8 + ':' + r.wave });
}
export function sideView(d) {
  const v = VERIF[(d.verification || {}).status] || VERIF.unknown;
  return `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">
<div class="card"><div class="sec-h"><h2 class="h2">4499 · נועה</h2><span class="sp"></span>${d.client.blocked ? Badge('failed', 'חסום (131042)') : Badge('ok', 'תקין')}</div><p class="sub" style="margin:0">${d.client.blocked ? 'תבניות ללקוחות לא יוצאות עד שהחיוב יאושר. ההתראה השעתית בסלאק תקפוץ כשישתחרר.' : 'תבניות ללקוחות יוצאות כרגיל.'}</p></div>
<div class="card"><div class="sec-h"><h2 class="h2">אימות העסק</h2><span class="sp"></span>${Badge(v[0] || 'info', v[1])}</div><p class="sub" style="margin:0">נבדק ${esc(relTime((d.verification || {}).at))}${(d.verification || {}).source === 'meta' ? ' מול מטא' : ''} · <a href="https://business.facebook.com/latest/settings/security_center/?business_id=2361932944259784" target="_blank" rel="noopener">מרכז האבטחה</a></p></div>
<div class="card"><div class="sec-h"><h2 class="h2">הזמנות מאוחרות בתור</h2><span class="sp"></span>${Badge((d.late || []).length ? 'partial' : 'ok', fmtN((d.late || []).length))}</div>${(d.late || []).length ? `<p class="sub" style="margin:0 0 6px">אורחים שנוספו אחרי שהגל נסגר. יוצאים כל 10 דקות כשהחלון פתוח ויש מקום במונה.</p><ul class="sub" style="margin:0;padding-inline-start:18px">${d.late.map((l) => `<li>${esc(l.guest || l.phone)} <span class="sub">${esc(l.phone)}</span> · ${EventLink(l.name || l.tok8, l.token)}${l.since ? ` · <span class="sub">מחכה ${esc(relTime(l.since))}</span>` : ''}</li>`).join('')}</ul>` : '<p class="sub" style="margin:0">אין אורחים שמחכים.</p>'}</div>
<div class="card"><div class="sec-h"><h2 class="h2">נשלח לאורחים · היום</h2><span class="sp"></span>${Badge(d.notes.length ? 'ok' : 'info', fmtN(d.notes.length))}</div>${d.notes.length ? `<ul class="sub" style="margin:0;padding-inline-start:18px">${d.notes.map((n) => `<li>${esc(KIND[n.kind] || n.kind)} · ${EventLink(n.name || n.tok8, n.token)}</li>`).join('')}</ul>` : '<p class="sub" style="margin:0">עוד לא יצא סבב היום.</p>'}</div>
</div>`;
}
export function view(d, now = Date.now()) {
  if (!d) return Skeleton.tiles(4) + Skeleton.card(3) + Skeleton.table(4);
  return `${counterView(d.counter, d.engine)}
<div class="card"><div class="sec-h"><h2 class="h2">מתי משתחרר</h2><span class="sp"></span><span class="sub">כל שעה של שליחות יוצאת מהחלון 25 שעות אחריה</span></div>${engineView(d.engine)}<div style="margin-top:10px">${releasesView(d.counter.releases, now)}</div></div>
<div class="card flush"><div class="sec-h"><h2 class="h2">היום ומחר · לפי אירוע</h2><span class="sp"></span><span class="sub">הסדר = סדר השליחה בפועל (גרירה במרכז הבקרה)</span></div>${eventsView(d.events, d.today)}</div>
${sideView(d)}`;
}
export default {
  skeleton: () => view(null),
  async mount(el, ctx) {
    const paint = (d) => { el.innerHTML = view(d); };
    const c = ctx.api.cached('sendlive'); if (c) paint(c.data);
    paint(await ctx.api.get('sendlive', {}, { cache: false }));
    ctx.poll(async () => paint(await ctx.api.get('sendlive', {}, { cache: false })), 60000);
  },
};
