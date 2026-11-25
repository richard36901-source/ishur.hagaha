/* ============================================================================
   ishur.io · client-stop.js · the client's red stop button (25/11/2026, track-board)
   ----------------------------------------------------------------------------
   The client stops everything from the board's personal area: no more
   invitations, reminders, extra sends, day-before / event-day messages, no
   calls. It reuses the existing freezes:
     hold:<token>      every guest send (waves, event day, day before, thanks…)
     callstop:<token>  every Shir dial for the event
     sendsoff:<token>  "no dates on purpose" for the paid-but-no-settings nudge
   plus its own record clientstop:<token> = {at, mode, reason, reason_he, note, ip}.
   holdtill:<token> and relonappr:<token> are deleted: both would lift hold:
   by themselves (timed release, template approval). Only the team lifts a
   client stop (POST /api/client-stop-lift, admin).

   mode 'stop'   = confirm word "עצירה"  (stop all sends)
   mode 'cancel' = confirm word "ביטול"  (the client asks to cancel the event)
   Nothing is written to the sheet and nothing goes to any guest: marking the
   event cancelled (AB='כן') makes the engine message the guests, so that stays
   a team decision (event-flag cancel) after they talk to the client.

   POST /api/client-stop       {token, reason, note, confirm}  → {ok, stop}
   POST /api/client-stop-lift  {admin_key, token, note?}       → {ok, lifted}
   ========================================================================== */

export const STOP_REASONS = {
  unhappy: 'לא מרוצה מהשירות',
  cancelled: 'האירוע בוטל',
  postponed: 'האירוע נדחה',
  wrong_details: 'טעות בפרטים',
  other: 'אחר',
};
export const STOP_WORDS = { 'עצירה': 'stop', 'ביטול': 'cancel' };
export const NOTE_MIN = 20;
const TTL = 400 * 86400;

/* → {ok:true, reason, note, mode} | {ok:false, error} */
export function validateStop(b = {}) {
  const reason = String(b.reason || '').trim();
  if (!STOP_REASONS[reason]) return { ok: false, error: 'bad-reason' };
  const note = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (note.length < NOTE_MIN) return { ok: false, error: 'note-too-short' };
  const mode = STOP_WORDS[String(b.confirm || '').trim()];
  if (!mode) return { ok: false, error: 'bad-confirm' };
  return { ok: true, reason, note, mode };
}

export async function clientStopOf(env, token) {
  if (!env.RATE || !token) return null;
  try { return JSON.parse((await env.RATE.get('clientstop:' + token)) || 'null'); } catch { return null; }
}
export async function isClientStopped(env, token) { return !!(await clientStopOf(env, token)); }

/* the freeze itself, keys first — the alerts after it may fail, the stop may not */
export async function applyClientStop(env, token, rec) {
  const at = rec.at || new Date().toISOString();
  await env.RATE.put('clientstop:' + token, JSON.stringify({ ...rec, at }), { expirationTtl: TTL });
  await env.RATE.put('hold:' + token, at, { expirationTtl: TTL });
  await env.RATE.put('callstop:' + token, JSON.stringify({ at, by: 'client', reason: 'עצירה מלוח הלקוח' }), { expirationTtl: TTL });
  await env.RATE.put('sendsoff:' + token, at, { expirationTtl: TTL });
  await env.RATE.delete('holdtill:' + token).catch(() => {});
  await env.RATE.delete('relonappr:' + token).catch(() => {});
  return { ...rec, at };
}

export async function liftClientStop(env, token) {
  const before = await clientStopOf(env, token);
  for (const k of ['clientstop:', 'hold:', 'callstop:', 'sendsoff:']) await env.RATE.delete(k + token).catch(() => {});
  await env.RATE.put('pacer:pending', new Date().toISOString().slice(0, 10), { expirationTtl: 86400 }).catch(() => {});
  return before;
}

/* what the board shows (no ip) */
export function publicStop(rec) {
  if (!rec) return null;
  return { at: rec.at || '', mode: rec.mode === 'cancel' ? 'cancel' : 'stop', reason: rec.reason || '', reason_he: STOP_REASONS[rec.reason] || '' };
}

/* d: { json(request), okJson, deny, tokenRecord, overBudget, logEvent, slackSend, notifyEvent, eventName(token) } */
export async function handleClientStop(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const token = String(b.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token) || !(await d.tokenRecord(env, token))) return d.deny(404, 'unknown-token', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  if (await d.overBudget(env, 'rl:clientstop:' + token, 10, 3600)) return d.deny(429, 'slow-down', origin);
  const v = validateStop(b);
  if (!v.ok) return d.deny(422, v.error, origin);
  const already = await clientStopOf(env, token);
  if (already) return d.okJson({ ok: true, already: true, stop: publicStop(already) }, origin);
  const who = d.who ? await Promise.resolve(d.who(request, b)).catch(() => '') : '';   /* 'צוות: …' or 'הלקוח (…)' (actor.js) */
  const rec = await applyClientStop(env, token, { mode: v.mode, reason: v.reason, reason_he: STOP_REASONS[v.reason], note: v.note, ip: request.headers.get('cf-connecting-ip') || '', by: who || 'הלקוח' });
  const name = await Promise.resolve(d.eventName ? d.eventName(token) : '').catch(() => '') || token.slice(0, 8);
  const what = v.mode === 'cancel' ? 'הלקוח ביקש לבטל את האירוע' : 'הלקוח עצר את כל השליחות';
  await d.logEvent(env, { area: 'אירוע', action: `${what} (כפתור העצירה בלוח)`, ok: true, review: true, token, detail: `${name} · ${STOP_REASONS[v.reason]} · ${v.note.slice(0, 300)}` }).catch(() => {});
  const body = `• ${name} · ${token.slice(0, 8)}\n• נלחץ ע"י: ${who || 'הלקוח'}\n• סיבה: ${STOP_REASONS[v.reason]}\n• בלשון הלקוח: ${v.note.slice(0, 500)}\n\nנעצרו מיד: הזמנות, תזכורות, שליחה נוספת, הודעות יום לפני ויום האירוע, שיחות.` +
    (v.mode === 'cancel' ? '\nלאורחים לא נשלחה הודעת ביטול. אחרי שיחה עם הלקוח: "ביטול האירוע" במסך הלקוחות.' : '') +
    `\n\n─── \n✅ *מה לעשות:* לחזור ללקוח היום. שחרור רק מהצוות: "שחרור עצירת לקוח" במסך הלקוחות.`;
  await d.slackSend(env, `⛔ *${what}*\n\n${body}`, { urgent: true, oneoff: true }).catch(() => {});
  if (d.notifyEvent) await d.notifyEvent(env, { slackSend: async () => {} }, 'incident', { severity: 'P1', title_he: `${what} · ${name}`, body_he: `${STOP_REASONS[v.reason]} · ${v.note.slice(0, 200)}`, deep_link: '#clients', entity: 'clientstop:' + token }).catch(() => {});
  return d.okJson({ ok: true, stop: publicStop(rec) }, origin);
}

export async function handleClientStopLift(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!(await d.isAdmin(env, b.admin_key))) return d.deny(403, 'bad-admin-key', origin);
  const token = String(b.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token) || !env.RATE) return d.deny(400, 'bad-token', origin);
  const before = await liftClientStop(env, token);
  await d.logEvent(env, { area: 'אירוע', action: 'עצירת הלקוח שוחררה ע"י הצוות', ok: true, token, detail: String(b.note || '').slice(0, 300) || (before ? before.reason_he || '' : 'לא הייתה עצירה') }).catch(() => {});
  await d.slackSend(env, `▶️ *עצירת הלקוח שוחררה* · אירוע ${token.slice(0, 8)}\n\nהשליחות והשיחות חוזרות לפי התכנון.`, { oneoff: true }).catch(() => {});
  return d.okJson({ ok: true, lifted: !!before }, origin);
}
