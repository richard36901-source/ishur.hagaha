/* ============================================================================
   The invitation in the wording the client chose (17/11/2026, Richard).
   The setup form always offered four styles, but every event was sent the one
   general template. Each style now has its own Meta template with the same six
   parameters as the general one ([guest, occasion, hosts, date, time, place]),
   in three forms: text, image header, video header.
     · KV invstyle:<token> = 'serious' | 'respectful' | 'playful' ('happy' or
       nothing = the general template, as before)
     · a style template is used only once Meta approved it (KV stmplok:<name>);
       until then, and on any doubt, the general template goes out as before
   §1 pure (unit-tested in test/invite-styles.test.mjs) · §2 I/O
   ============================================================================ */
export const STYLES = {
  happy:      { he: 'שמחה',  note: 'חמה וישירה, מתאימה לרוב האירועים' },
  serious:    { he: 'רשמי',  note: 'מנוסחת בגוף שלישי, ללא סלנג',
    body: 'שלום {{1}},\n\nאנו מתכבדים להזמינכם ל{{2}} של {{3}}.\n\n📅 בתאריך {{4}}\n🕐 קבלת פנים בשעה {{5}}\n📍 {{6}}\n\nנודה לכם אם תאשרו את הגעתכם באחת התשובות למטה. ניתן לעדכן בכל שלב:' },
  respectful: { he: 'מכובד', note: 'לשון גבוהה, לאירועים דתיים ומסורתיים',
    body: 'שלום רב {{1}},\n\nהננו מתכבדים להזמינכם ל{{2}} של {{3}}.\n\n📅 בתאריך {{4}}\n🕐 קבלת פנים בשעה {{5}}\n📍 {{6}}\n\nנשמח אם תאשרו את השתתפותכם באחת התשובות למטה. ניתן לעדכן בכל עת:' },
  playful:    { he: 'שובב',  note: 'קלילה, לחברים ולאירועים צעירים',
    body: 'היי {{1}}! 🥳\n\nיש {{2}} של {{3}} ואתם מוזמנים!\n\n📅 {{4}}\n🕐 מתחילים ב-{{5}}\n📍 {{6}}\n\nבאים? לחצו על אחת התשובות למטה, ותמיד אפשר לעדכן:' },
};
export const STYLE_KEYS = Object.keys(STYLES);
export const OWN_TEMPLATE = k => k !== 'happy' && !!(STYLES[k] && STYLES[k].body);
export const normStyle = v => (STYLE_KEYS.includes(String(v || '')) ? String(v) : '');
export const KINDS = ['text', 'img', 'vid'];
export const tmplName = (style, kind) => `hazmana_ishur_${style}${kind === 'img' ? '_img' : kind === 'vid' ? '_vid' : ''}`;
export const WABA = '1378764257421712';
const FOOTER = 'נשלח ע"י ishur.io · הגיע בטעות? השיבו "טעות"';
const BUTTONS = [{ type: 'QUICK_REPLY', text: 'מגיע/ה' }, { type: 'QUICK_REPLY', text: 'לא מגיע/ה' }, { type: 'QUICK_REPLY', text: 'עדיין לא ידוע' }];
export function templatePayload(style, kind, handle) {
  if (!OWN_TEMPLATE(style)) return null;
  const comps = [];
  if (kind !== 'text') { if (!handle) return null; comps.push({ type: 'HEADER', format: kind === 'vid' ? 'VIDEO' : 'IMAGE', example: { header_handle: [handle] } }); }
  comps.push({ type: 'BODY', text: STYLES[style].body, example: { body_text: [['דנה', 'חתונה', 'נועה ויונתן', '12.09.2026', '19:30', 'הגן הקסום, רמת גן']] } });
  comps.push({ type: 'FOOTER', text: FOOTER }); comps.push({ type: 'BUTTONS', buttons: BUTTONS });
  return { name: tmplName(style, kind), language: 'he', category: 'UTILITY', allow_category_change: true, components: comps };
}
/* which template name an event's wave should use; `base` = what would go out anyway (general template of that kind) */
export function pickStyled(style, kind, base, approved) {
  if (!OWN_TEMPLATE(style)) return base;
  const n = tmplName(style, kind); return approved && approved[n] ? n : base;
}

/* ── §2 I/O ─────────────────────────────────────────────────────────────── */
export async function eventStyle(env, token) { try { return normStyle(await env.RATE.get('invstyle:' + token)); } catch { return ''; } }
export async function approvedMap(env) {
  const out = {}; if (!env.RATE) return out;
  await Promise.all(STYLE_KEYS.filter(OWN_TEMPLATE).flatMap(s => KINDS.map(async k => { const n = tmplName(s, k); if (await env.RATE.get('stmplok:' + n).catch(() => null)) out[n] = true; })));
  return out;
}
/* the template for this event and form, or `base` when the event has no style or its template is not approved yet */
const memo = new WeakMap();   /* per KV binding: a wave asks the same question for every guest, so the answer is kept a minute */
export async function styledTemplate(env, token, kind, base) {
  try {
    let m = memo.get(env.RATE); if (!m) { m = new Map(); memo.set(env.RATE, m); }
    const k = token + '|' + kind, hit = m.get(k);
    let name = hit && Date.now() - hit.at < 60000 ? hit.name : undefined;
    if (name === undefined) { const st = await eventStyle(env, token); name = OWN_TEMPLATE(st) ? pickStyled(st, kind, '', await approvedMap(env)) : ''; m.set(k, { name, at: Date.now() }); if (m.size > 400) m.clear(); }
    return name || base;
  } catch { return base; }
}
export function forgetStyle(env) { memo.delete(env.RATE); }
/* reads Meta once for all nine and records which are approved */
export async function refreshStatus(env, fetchFn = fetch) {
  const tok = env.WA_TOKEN_GUESTS; if (!tok || !env.RATE) return { ok: false, why: 'not-configured' };
  const r = await fetchFn(`https://graph.facebook.com/v21.0/${WABA}/message_templates?fields=name,status,category,rejected_reason&limit=400`, { headers: { Authorization: 'Bearer ' + tok } }).catch(() => null);
  const j = r ? await r.json().catch(() => null) : null; if (!j || !Array.isArray(j.data)) return { ok: false, why: 'meta-read-failed' };
  const by = {}; for (const t of j.data) by[t.name] = t;
  const out = [];
  for (const s of STYLE_KEYS.filter(OWN_TEMPLATE)) for (const k of KINDS) {
    const n = tmplName(s, k), t = by[n], st = t ? String(t.status || '').toUpperCase() : 'MISSING';
    if (st === 'APPROVED') await env.RATE.put('stmplok:' + n, '1'); else await env.RATE.delete('stmplok:' + n).catch(() => {});
    out.push({ name: n, style: s, kind: k, status: st, category: t ? t.category : '', reason: t && t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : '' });
  }
  return { ok: true, templates: out };
}
export async function submitAll(env, { headerHandle, fetchFn = fetch } = {}) {
  const tok = env.WA_TOKEN_GUESTS; if (!tok) return { ok: false, why: 'not-configured' };
  const cur = await refreshStatus(env, fetchFn); if (!cur.ok) return cur;
  const res = [];
  for (const t of cur.templates) {
    if (t.status !== 'MISSING') { res.push({ name: t.name, skipped: t.status }); continue; }
    const handle = t.kind === 'text' ? '' : await headerHandle(t.kind).catch(() => '');
    const payload = templatePayload(t.style, t.kind, handle); if (!payload) { res.push({ name: t.name, error: 'no-header-sample' }); continue; }
    const r = await fetchFn(`https://graph.facebook.com/v21.0/${WABA}/message_templates`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    res.push(j.id ? { name: t.name, submitted: String(j.status || 'PENDING') } : { name: t.name, error: String((j.error && (j.error.error_user_msg || j.error.message)) || 'submit-failed').slice(0, 160) });
  }
  return { ok: true, results: res };
}
