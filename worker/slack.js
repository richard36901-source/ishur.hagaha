/* ============================================================================
   ishur.io · Slack: posting, quiet hours, the overnight queue, alert()
   ----------------------------------------------------------------------------
   Extracted from index.js on 20/10/2026 — behaviour unchanged. Everything that
   talks to Slack goes through here: slackSend (raw, honours quiet hours),
   slackPost (the normal call, with the quiet tier), flushSlackQueue (09:00
   digest of what queued overnight), alert (journal row + Slack).
   ========================================================================== */
import { logEvent } from './evlog.js';

/* ══ Slack quiet hours (Phase 6, rule 9) ══════════════════════════════════════
   Nothing non-urgent lands in Slack before 09:00 or after 21:00 Israel time —
   it queues (slackq:list) and flushes as ONE combined message at the 09:00
   window instead. Urgent bypasses the queue and posts immediately, same as
   before this phase. `now` is injectable so the decision is testable without
   waiting on the real clock (see verify-loop check for this phase). */
export function slackQuietHours(now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(now));
  return hour < 9 || hour >= 21;
}

/* Richard 06/10: Slack must be readable. Every message gets a bold title on
   its own line, one fact per line with a blank line between, and alerts end
   with whether he has to act, plus what the system does about it. */
export const SLACK_FOOTERS = [
  [/בדיקת יתרות וחיוב|יתרת שיחות נגמרה/, '🔴 *נדרשת פעולה ממך:* לטעון יתרה. Telnyx: portal.telnyx.com/#/app/billing · Retell: dashboard.retellai.com · WhatsApp: business.facebook.com/billing_hub'],
  [/131042|בעיית תשלום בחשבון מטא/, '🔴 *נדרשת פעולה ממך:* להוסיף אמצעי תשלום ב-WhatsApp Manager. עד אז נועה (4499) לא יכולה לשלוח הודעות.'],
  [/131026|לא בוואטסאפ \/ חסם/, '✅ *לא נדרשת פעולה ממך.* המספר לא בוואטסאפ או חסם אותנו. המערכת מנסה עד 3 פעמים ואז מפסיקה לשלוח אליו.'],
  [/130472|בניסוי של מטא/, '✅ *לא נדרשת פעולה ממך.* מטא מגבילה זמנית את המספר הזה. המערכת תנסה שוב לבד.'],
  [/131049|מגבלת הודעות שיווקיות/, '✅ *לא נדרשת פעולה ממך.* מטא הגבילה הודעות שיווקיות לאיש הקשר הזה. אין מה לעשות מצדנו.'],
  [/131047|עברו 24 שעות/, 'ℹ️ *לא נדרשת פעולה ממך.* עברו 24 שעות מאז שהאדם כתב לנו, אז מטא דורשת תבנית מאושרת. רשום אצל קלוד לתיקון.'],
  [/WITH_ISSUES|ADSET_PAUSED/, '✅ *לא נדרשת פעולה ממך.* אלה מודעות מושהות או כפולות. הן לא מוציאות כסף.'],
  [/תשלומים שחנו/, '✅ *לא נדרשת פעולה ממך.* אלה תשלומים של עסק אחר באותו חשבון Grow.'],
  [/קוד אימות/, '✅ *לא נדרשת פעולה ממך.* תקלה זמנית בצד מטא. המערכת תנסה שוב מחר.'],
];
export function slackFormat(text) {
  let t = String(text || '').trim();
  if (!t) return t;
  if (!t.includes('\n') && t.includes(' · ')) {
    const parts = t.split(' · ').map(x => x.trim()).filter(Boolean);
    t = parts[0] + '\n\n' + parts.slice(1).map(x => '• ' + x).join('\n\n');
  } else if (t.includes('\n') && !/\n\n/.test(t)) {
    t = t.replace(/\n/g, '\n\n');
  }
  if (/נדרשת פעולה ממך|ייתכן שנדרשת בדיקה/.test(t)) return t;
  const hit = SLACK_FOOTERS.find(([re]) => re.test(t));
  if (hit) return t + '\n\n───\n' + hit[1];
  if (/^(⚠️|:warning:|🚨|:rotating_light:)/.test(t)) return t + '\n\n───\n🔶 *ייתכן שנדרשת בדיקה.* כתוב לקלוד "בדוק את ההתראה הזו" והוא יטפל.';
  return t;
}

export async function slackSend(env, text, opts = {}) {
  if (!env.SLACK_ALERT_HOOK) return;
  text = slackFormat(text);
  const now = opts.now || new Date();
  if (!opts.urgent && env.RATE && slackQuietHours(now)) {
    const key = 'slackq:list';
    let list = [];
    try { list = JSON.parse(await env.RATE.get(key)) || []; } catch {}
    if (!Array.isArray(list)) list = [];
    list.push(String(text || '').slice(0, 500));
    if (list.length > 200) list = list.slice(-200);
    await env.RATE.put(key, JSON.stringify(list), { expirationTtl: 3 * 86400 }).catch(() => {});
    return;
  }
  await fetch(env.SLACK_ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

/* Called once per Israel day once the 09:00 window opens (from the pacer,
   which already ticks every 10 minutes — no new cron needed). Combines
   whatever queued overnight into one message instead of replaying each line. */
export async function flushSlackQueue(env, now) {
  if (!env.RATE || !env.SLACK_ALERT_HOOK) return { ok: false, why: 'not-configured' };
  const key = 'slackq:list';
  let list = [];
  try { list = JSON.parse(await env.RATE.get(key)) || []; } catch {}
  if (!Array.isArray(list) || !list.length) return { ok: true, flushed: 0 };
  const text = `📋 *מה קרה בלילה* (${list.length})\n\n` + list.map((t, i) => `${i + 1}. ${t}`).join('\n\n');
  await fetch(env.SLACK_ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
  await env.RATE.delete(key).catch(() => {});
  return { ok: true, flushed: list.length };
}

/* Anything the team should just SEE (purchases, milestones) — not failures.
   Purchases specifically default to urgent (Richard wants to see money land
   immediately — Phase 9 decision ב is still his to override if he'd rather
   wait for the 09:00 window instead). */
/* Richard 14/10: "יותר מדי התראות, מבולגן". Two tiers now: the default is
   something a human should see (money, a lead, a failure, a question); quiet
   is housekeeping that only matters when debugging. Quiet posts are dropped
   unless SLACK_VERBOSE=1, and still land in the journal via logEvent where
   the call site already does that. */
export async function slackPost(env, text, opts = {}) {
  if (opts.quiet && String(env.SLACK_VERBOSE || '') !== '1') return;
  await slackSend(env, text, { urgent: opts.urgent !== false, now: opts.now });
}

/* every failure anywhere → the journal always, Slack per quiet hours
   (Phase 6): urgent categories ping now, everything else queues for the
   09:00 window. Telegram (ALERT_HOOK → Make) is only the fallback when the
   Slack secret is missing — Richard asked for Slack-only, 30.8. */
export const URGENT_ALERT_RE = /131042|מנוע היומי|לא רץ כבר|ניסיון לחלץ הוראות|פנייה מספק|שאלה על מתחרה|תקרת וואטסאפ/;
export async function alert(env, where, what, detail, opts = {}) {
  const what300 = String(what || '').slice(0, 300);
  const detail500 = String(detail || '').slice(0, 500);
  /* the journal is the record; Slack is the notification */
  await logEvent(env, { area: where, action: what300, ok: false, review: true, detail: detail500 });
  /* Richard reads Slack alerts; a second ping on WhatsApp was noise (his call, 06/09) */
  if (opts.quiet && String(env.SLACK_VERBOSE || '') !== '1') return;
  if (env.SLACK_ALERT_HOOK) {
    const urgent = URGENT_ALERT_RE.test(where + ' ' + what300 + ' ' + detail500);
    /* Richard 28/09: one line, organised; a newline only when the detail is long */
    /* Richard 06/10: title line, then the facts on their own lines */
    await slackSend(env, `⚠️ *${where}*\n\n${what300}` + (detail500 ? `\n\n${detail500}` : ''), { urgent });
    return;
  }
  if (!env.ALERT_HOOK) return;
  await fetch(env.ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      where, what: what300,
      detail: detail500, ts: new Date().toISOString(),
    }),
  }).catch(() => {});
}
