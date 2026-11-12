/* ============================================================================
   ishur.io · Slack: posting, quiet hours, the overnight queue, alert()
   ----------------------------------------------------------------------------
   Extracted from index.js on 20/10/2026 — behaviour unchanged. Everything that
   talks to Slack goes through here: slackSend (raw, honours quiet hours),
   slackPost (the normal call, with the quiet tier), flushSlackQueue (09:00
   digest of what queued overnight), alert (journal row + Slack).
   ========================================================================== */
import { logEvent, stream } from './evlog.js';
import { gate as slackGate, info as slackInfo, autoKey, resolve as gateResolve } from './slack-gate.js';

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
  if (/נדרשת פעולה ממך|ייתכן שנדרשת בדיקה|מה לעשות:/.test(t)) return t;
  const hit = SLACK_FOOTERS.find(([re]) => re.test(t));
  if (hit) return t + '\n\n───\n' + hit[1];
  if (/^(⚠️|:warning:|🚨|:rotating_light:)/.test(t)) return t + '\n\n───\n🔶 *ייתכן שנדרשת בדיקה.* כתוב לקלוד "בדוק את ההתראה הזו" והוא יטפל.';
  return t;
}

/* 04/11 the state-change gate (slack-gate.js) sits HERE, so every poster —
   slackPost, alert(), notify.js, the brain — goes through it. opts:
     key      condition identity (`131042:4499`, `cap_high`, `finding:<id>`)
     sev      P0–P3 (default P2)       level/bands  numeric, "worse" on a band up
     cls      'p1' (Slack, default) | 'info' (notifications center + 09:00 digest only)
     action   the "מה לעשות:" footer      oneoff  true = a single event, no gate
   No key and no oneoff → autoKey(text): deduped on the title line, never dropped
   silently (the stream row says gate:auto so it shows up in the journal). */
export async function slackSend(env, text, opts = {}) {
  if (!env.SLACK_ALERT_HOOK) return;
  /* 04/11 Richard: "רק דברים חשובים באמת". Slack is an allowlist now: money in,
     a new lead, Make down/up, and the 09:00 digest. Everything else goes to the
     ops notifications center only. And every allowed title posts at most once
     per 24h (digits stripped, so "27/28/29 failed" is one title). */
  const strict = String(env.SLACK_STRICT || '') === '1';
  if (strict && !opts.digest && !slackImportant(text, opts)) opts = { ...opts, cls: 'info' };
  if (strict && opts.cls !== 'info' && !opts.digest && env.RATE) {
    const mk = 'slackmute:' + muteKey(text, opts);
    if (await env.RATE.get(mk).catch(() => null)) { opts = { ...opts, cls: 'info' }; }
    else await env.RATE.put(mk, '1', { expirationTtl: 86400 }).catch(() => {});
  }
  if (opts.cls === 'info') {
    stream(env, { kind: 'slack', area: 'סלאק·מידע', action: String(text || '').split('\n')[0].replace(/[*_>]/g, '').slice(0, 120), detail: String(text || '').slice(0, 600), ok: true }).catch(() => {});
    return slackInfo(env, text, { key: opts.key || null, now: opts.now ? +opts.now : Date.now(), notify: opts.notify || defaultInfoNotify });
  }
  if (!opts.oneoff) {
    const key = opts.key || autoKey(text);
    const g = await slackGate(env, { key, text, sev: opts.sev, level: opts.level, bands: opts.bands, cls: opts.cls, action: opts.action, now: opts.now ? +opts.now : Date.now() });
    if (!g.post) { stream(env, { kind: 'slack', area: 'סלאק·שקט', action: `${key} · חזרה ${g.state ? g.state.count : '?'}`, detail: String(text || '').slice(0, 300), ok: true }).catch(() => {}); return; }
    text = g.text; opts = { ...opts, _gate: g.kind + (opts.key ? '' : ':auto') };
  }
  text = slackFormat(text);
  stream(env, { kind: 'slack', area: 'סלאק', action: String(text || '').split('\n')[0].replace(/[*_>]/g, '').slice(0, 120), detail: (opts._gate ? '[' + opts._gate + '] ' : '') + String(text || '').slice(0, 600), ok: true }).catch(() => {});
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
  /* 10/11 (wavenote.js): a note may carry Block Kit blocks (header, quoted wording, the artwork) */
  await fetch(env.SLACK_ALERT_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Array.isArray(opts.blocks) && opts.blocks.length ? { text, blocks: opts.blocks } : { text }),
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
  const { quiet, urgent, ...rest } = opts;
  await slackSend(env, text, { ...rest, urgent: urgent !== false, now: opts.now });
}
/* the condition behind `key` resolved → ONE "✅ נפתר" line (nothing when it was never open).
   `note` is appended under the title (e.g. "התקרה נפתחה"). The CLOSE line is itself the single event → oneoff. */
export async function slackResolve(env, key, note) {
  return gateResolve(env, key, { post: t => slackSend(env, note ? t.replace('\n\n• פתוח', '\n\n• ' + String(note).replace(/[*]/g, '') + '\n\n• פתוח') : t, { oneoff: true, urgent: false }) });
}
/* info-class posts land in the ops notifications center through notify.js (rule 'info') */
async function defaultInfoNotify(env, cand) {
  const m = await import('./notify.js');
  return m.notifyEvent(env, null, 'info', cand);
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
    /* 04/11 gate: opts.key/sev/level/cls/action/oneoff pass through; no key → autoKey on "⚠️ where / what" */
    const { quiet: _q, ...gateOpts } = opts;
    await slackSend(env, `⚠️ *${where}*\n\n${what300}` + (detail500 ? `\n\n${detail500}` : ''), { ...gateOpts, urgent });
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

/* 04/11: the only things that reach Slack (besides the digest) */
const IMPORTANT_RE = /(שולם|שילם|תשלום התקבל|תשלום חדש|שדרוג נרכש|נרכש|רכש\/ה|💰|🎉|ליד חדש|🆕|Make מושהה|Make חזר|make_down)/;
export function slackImportant(text, opts = {}) {
  if (opts.important === true) return true;
  if (opts.important === false) return false;
  const k = String(opts.key || '');
  if (/^(finding:)?make_down/.test(k)) return true;
  /* 04/11 brain planned_not_progressing: something planned for today stopped moving inside its window */
  if (/^(finding:)?stuck:/.test(k)) return true;
  const head = String(text || '').split('\n')[0];
  if (/131042|הפייסר|בהחזקה|131047|תקרה|קיבולת|תבנית|קוד אימות/.test(head)) return false;
  return IMPORTANT_RE.test(head);
}
export function muteKey(text, opts = {}) {
  const head = String(text || '').split('\n')[0].replace(/[*_>`]/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return (opts.key ? String(opts.key).replace(/\d+/g, '#') + '|' : '') + head.slice(0, 120);
}
