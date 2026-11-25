/* ============================================================================
   ishur.io · send-plan.js · who an added round goes to, when it may run, and
   how the board says where each round stands (25/11/2026, track-board)
   ----------------------------------------------------------------------------
   Audience of an added message round / calls round (KV extrasend:<token>,
   callsaddon:<token>, field `scope`):
     all         כולם (messages only; never a guest with a final "לא מגיע")
     unanswered  לא ענו + מתלבטים   (the value the paid path always wrote, kept)
     noanswer    רק מי שלא ענה
     undecided   מתלבטים בלבד
   A calls round never rings a guest with a final answer, so 'all' on a calls
   round is clamped to 'unanswered'.

   Record shape (old values stay readable):
     extrasend:<token>  ISO date (old) | {at, scope, ref, client_decides?}
     callsaddon:<token> ISO date (old) | {at, ref, sum?, scope?, start?, client_decides?}
       at    = when it was granted / paid
       start = the day the calls round may start (YYYY-MM-DD), '' = the engine picks
   ========================================================================== */
import { planMaxCallTries } from './dashboard.js';

export const AUDIENCES = ['all', 'unanswered', 'noanswer', 'undecided'];
export const AUDIENCE_HE = { all: 'כולם', unanswered: 'לא ענו + מתלבטים', noanswer: 'רק מי שלא ענה', undecided: 'מתלבטים' };

export function normAudience(v, { calls = false } = {}) {
  const s = AUDIENCES.includes(String(v || '')) ? String(v) : (calls ? 'unanswered' : 'all');
  return calls && s === 'all' ? 'unanswered' : s;
}

/* rsvp = the sheet's column P: '' (no answer yet), 'מתלבט', 'מגיע', 'לא מגיע' */
export function audienceIncludes(aud, rsvp) {
  const r = String(rsvp || '').trim();
  if (r === 'לא מגיע') return false;   /* a declined guest is out of every round, always */
  switch (aud) {
    case 'unanswered': return r === '' || r === 'מתלבט';
    case 'noanswer': return r === '';
    case 'undecided': return r === 'מתלבט';
    default: return true;
  }
}

/* either add-on record → one shape */
export function parseAddon(stored) {
  const out = { at: '', start: '', scope: '', client_decides: false, ref: '' };
  if (stored == null || stored === '') return null;
  let j = null; try { j = JSON.parse(String(stored)); } catch {}
  if (!j || typeof j !== 'object') { out.at = String(stored); return out; }
  out.at = String(j.at || ''); out.ref = String(j.ref || '');
  out.scope = AUDIENCES.includes(String(j.scope || '')) ? String(j.scope) : '';
  out.start = /^\d{4}-\d{2}-\d{2}$/.test(String(j.start || '')) ? String(j.start) : '';
  out.client_decides = j.client_decides === true;
  return out;
}

/* "HH:MM" in Israel */
export function ilHM(now = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

/* Rule 5: no date in the past, and today only while it is before 19:00 (the guests' send window closes at 19:00).
   → '' when the date is fine, else the refusal code. */
export const LAST_HM_TODAY = '19:00';
export function dateGuard(date, { today, hm }) {
  const d = String(date || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'bad-date';
  if (d < today) return 'date-in-past';
  if (d === today && String(hm || '') >= LAST_HM_TODAY) return 'too-late-today';
  return '';
}

/* runShirDispatch: may this queued guest be dialled now, as far as a calls add-on is concerned?
   A guest still inside the plan's own tries is the plan's business. Past them the dial belongs to the
   add-on round: it waits for its day (or for the client to pick one) and rings only its audience. */
export function addonDialOk(stored, g, today) {
  const spec = parseAddon(stored);
  if (!spec) return true;
  if ((Number(g.tries) || 0) < planMaxCallTries(g.plan)) return true;
  if (spec.client_decides && !spec.start) return false;
  if (spec.start && spec.start > today) return false;
  return audienceIncludes(normAudience(spec.scope, { calls: true }), g.rsvp);
}

/* the engine's add-on escalation: is the bought round's own day here? */
export function addonDayReady(stored, today) {
  const spec = parseAddon(stored);
  if (!spec) return false;
  if (spec.client_decides && !spec.start) return false;
  return !(spec.start && spec.start > today);
}

/* ── the board: one line per round saying exactly where it stands ─────────── */
const dm = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}` : ''; };
const isCallRow = k => k === 'calls' || k === 'calls2' || /^calls_r\d$/.test(k);

/* row: a buildDashboard send row (+ sent_at 'YYYY-MM-DD HH:MM', delivered_n, sent_n, pick).
   ctx: { today, stopped } */
export function rowStateHe(row, ctx = {}) {
  const s = row || {};
  const call = isCallRow(s.key);
  const day = String(s.date || '').slice(0, 10);
  if (ctx.stopped && s.status !== 'sent' && s.status !== 'passed') return 'נעצר לבקשתכם';
  if (s.pick || (!day && s.status !== 'sent')) return 'ממתין לבחירת תאריך';
  if (s.status === 'sent') {
    if (call) {
      const t = s.stats || {};
      return `בוצע${day ? ' ב-' + dm(day) : ''}` + (t.dialed != null ? ` · חויגו ${t.dialed}` : '') + (t.answered != null ? ` · ענו ${t.answered}` : '');
    }
    const at = String(s.sent_at || '');
    const when = at ? `${dm(at)} ${at.slice(11, 16)}`.trim() : dm(day);
    const n = Number(s.delivered_n) || 0, sentN = Number(s.sent_n) || 0;
    return `נשלח${when ? ' ב-' + when : ''}` + (n ? ` · ${n} נמסרו` : sentN ? ` · ${sentN} נשלחו` : '');
  }
  if (s.status === 'running') {
    if (call) return `בתהליך · שיחות עד 20:30${s.queued ? ' · ממתינים ' + s.queued : ''}`;
    return `בשליחה עכשיו${Number(s.sent_n) ? ' · נשלחו ' + s.sent_n : ''}`;
  }
  if (s.status === 'passed') return `המועד עבר (${dm(day)})`;
  return `מתוזמן ל-${dm(day)} · מ-${call ? '10:00' : '09:00'}`;
}

/* POST /api/calls-addon-date {token, date} — the client picks the day of a calls round the team added with
   "הלקוח יחליט". → {ok, date}. d: { okJson, deny, tokenRecord, overBudget, logEvent, clientStopOf, eventDate(token), ilDate, now? } */
export async function handleCallsAddonDate(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const token = String(b.token || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token) || !(await d.tokenRecord(env, token))) return d.deny(404, 'unknown-token', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  if (await d.overBudget(env, 'rl:callsdate:' + token, 20, 3600)) return d.deny(429, 'slow-down', origin);
  if (await d.clientStopOf(env, token)) return d.deny(409, 'client-stopped', origin);
  const stored = await env.RATE.get('callsaddon:' + token).catch(() => null);
  const spec = parseAddon(stored);
  if (!spec) return d.deny(402, 'no-calls-addon', origin);
  if (await env.RATE.get('esc2:' + token).catch(() => null)) return d.deny(409, 'already-started', origin);
  const date = String(b.date || '').trim().slice(0, 10);
  const now = d.now ? d.now() : new Date();
  const why = dateGuard(date, { today: d.ilDate(now), hm: ilHM(now) });
  if (why) return d.deny(422, why, origin);
  const evDate = String((await Promise.resolve(d.eventDate(token)).catch(() => '')) || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(evDate) && date >= evDate) return d.deny(422, 'after-event', origin);
  if (new Date(date + 'T12:00:00Z').getUTCDay() === 6) return d.deny(422, 'shabbat', origin);
  let j = {}; try { j = JSON.parse(String(stored)); } catch {}
  if (!j || typeof j !== 'object') j = { at: String(stored || '') };
  await env.RATE.put('callsaddon:' + token, JSON.stringify({ ...j, start: date }), { expirationTtl: 200 * 86400 });
  await d.logEvent(env, { area: 'לוח', action: 'הלקוח בחר את יום סבב השיחות הנוסף', ok: true, token, detail: date }).catch(() => {});
  return d.okJson({ ok: true, date }, origin);
}

/* how many guests of one wave Meta reported delivered or read (wst:<token>:<n>:<phone>), cached 10 minutes so a board
   refresh does not read every guest again */
export async function deliveredCount(env, token, n) {
  const ck = `wdlvc:${token}:${n}`;
  const hit = await env.RATE.get(ck).catch(() => null);
  if (hit != null && hit !== '') return Number(hit) || 0;
  const names = [];
  try { let cursor; do { const l = await env.RATE.list({ prefix: `wst:${token}:${n}:`, limit: 1000, cursor }); for (const k of l.keys || []) names.push(k.name); cursor = l.list_complete ? undefined : l.cursor; } while (cursor && names.length < 3000); } catch { return null; }
  let c = 0;
  for (let i = 0; i < names.length; i += 50) {
    const vals = await Promise.all(names.slice(i, i + 50).map(k => env.RATE.get(k).catch(() => null)));
    for (const v of vals) if (v === 'delivered' || v === 'read') c++;
  }
  await env.RATE.put(ck, String(c), { expirationTtl: 600 }).catch(() => {});
  return c;
}

/* 'YYYY-MM-DD HH:MM' (Israel) of the first wsent: key of a wave — its expiration minus the TTL it was written with */
export function firstSentAt(expirations, ttlS) {
  const t = (expirations || []).filter(x => Number(x) > 0).map(x => x * 1000 - ttlS * 1000).sort((a, b) => a - b)[0];
  if (!t) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(t));
  const g = k => (p.find(x => x.type === k) || {}).value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
