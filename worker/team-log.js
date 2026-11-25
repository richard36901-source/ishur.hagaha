/* ============================================================================
   ishur.io · team-log.js · what the team CHANGED, in words (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   The users page ("פעולות אחרונות") listed "stream", "לחץ: עוד", "בחר: kindSel = …":
   the live log's own 5-second polling was written as a user action (authGate logs every
   POST it does not know to be a read), next to the bar's click tracker.

   This file:
     §1 quietRead(path, body)   the read/poll routes that are never "an action" (authGate's
                                isRead and the admin stream tap both ask it)
     §2 describe(path, b, j, names, changeRoutes)
                                → one Hebrew line for a change that succeeded, or '' (not a change)
     §3 teamActionAfter()       after the handler answered OK for a signed-in user: writes ONE
                                act: row flagged m:1 (meaningful). /api/auth/actions {meaningful:true}
                                returns only those. The raw act: rows (clicks, screens) stay stored.
   Names come from evmeta:<token> / gmap:<token> (audit.js refreshMeta), never the bare token.
   ========================================================================== */
import { logAction } from './auth.js';

/* ── §1 reads ─────────────────────────────────────────────────────────────── */
const READ_ACTIONS = new Set(['', 'proof', 'read', 'list', 'live', 'plan', 'calls', 'get']);
const QUIET = new Set(['/api/stream', '/api/answers-log', '/api/future-log', '/api/guest-card', '/api/calls-log', '/api/delivery-report', '/api/audit', '/api/call-get', '/api/board-event', '/api/send-board', '/api/evlog', '/api/wave-audit']);
export function quietRead(path, body) {
  const p = String(path || '').split('?')[0];
  if (!QUIET.has(p)) return false;
  const b = body && typeof body === 'object' ? body : {};
  const a = String(b.action || b.act || '');
  if (p === '/api/answers-log' && a === 'set') return false;
  if (p === '/api/guest-card' && !READ_ACTIONS.has(a)) return false;
  if (p === '/api/future-log' && !READ_ACTIONS.has(a)) return false;
  if (p === '/api/audit' || p === '/api/stream' || p === '/api/calls-log' || p === '/api/delivery-report' || p === '/api/call-get' || p === '/api/evlog' || p === '/api/wave-audit') return true;
  return READ_ACTIONS.has(a);
}

/* ── §2 the words ─────────────────────────────────────────────────────────── */
const dm = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}` : String(iso || ''); };
const FLAG_HE = { hold: ['הקפאת שליחות', 'שחרור הקפאת שליחות'], cancel: ['ביטול אירוע', 'החזרת אירוע מביטול'], extrasend: ['הפעלת שליחה נוספת', 'ביטול שליחה נוספת'], postponeok: ['אישור הודעת דחייה', 'ביטול אישור הודעת דחייה'], clearsends: ['ביטול מועדי השליחה', 'החזרת מועדי השליחה'] };
const SEND_N = { invite: 1, reminder: 2, extra: 3 };
const SKIP_HE = { 1: 'הזמנה (גל 1)', 2: 'תזכורת (גל 2)', 3: 'שליחה נוספת (גל 3)', daybefore: 'יום-לפני', shulchan: 'הודעת השולחן', toda: 'תודה' };
const RSVP_HE = { 'מגיע': 'מגיע', 'לא מגיע': 'לא מגיע', 'מתלבט': 'מתלבט' };

/* names = { event: 'החתונה של …', guest(idOrPhone) → 'דנה כהן' } */
export function describe(path, b = {}, j = {}, names = {}, changeRoutes = {}) {
  const p = String(path || '').split('?')[0];
  const ev = names.event ? ` · ${names.event}` : '';
  const gname = (names.guest && (names.guest(b.guest_id) || names.guest(b.phone))) || String(b.name || '').trim() || 'אורח';
  if (!j || j.ok === false || j.dry) return '';
  switch (p) {
    case '/api/answers-log':
      if (b.action !== 'set') return '';
      return `סימון ${gname}: ${RSVP_HE[b.rsvp] || b.rsvp}${b.rsvp === 'מגיע' && j.party ? ` (${j.party})` : ''}${ev}`;
    case '/api/guest-rsvp':
      return `סימון ${gname}: ${RSVP_HE[j.outcome || b.outcome] || 'מגיע'}${j.party ? ` (${j.party})` : ''}${ev}`;
    case '/api/guest-edit': return `עריכת פרטי האורח ${gname}${ev}`;
    case '/api/guest-add': return `הוספת אורח: ${String(b.name || '').trim() || 'אורח'}${ev}`;
    case '/api/send-date': {
      const n = SEND_N[String(b.send || '')] || '';
      return b.date ? `שינוי תאריך שליחה ${n} ל-${dm(b.date)}${ev}` : `ביטול תאריך שליחה ${n}${ev}`;
    }
    case '/api/event-flag': {
      if (typeof b.on !== 'boolean') return '';
      const w = FLAG_HE[b.flag]; return w ? `${b.on ? w[0] : w[1]}${ev}` : '';
    }
    case '/api/skip': return `${b.on === false ? 'החזרת' : 'ביטול'} ${SKIP_HE[b.kind] || 'שליחה'} לאורח ${gname}${ev}`;
    case '/api/block-phone':
      if (typeof b.blocked !== 'boolean') return '';
      return b.blocked ? `חסימת מספר לכל השליחות והשיחות (${gname})` : `החזרת מספר לשליחה (${gname})`;
    case '/api/guest-card': return String(j.done_he || '') ? `${j.done_he}${ev}` : '';
    default: break;
  }
  const spec = changeRoutes[p];
  if (spec) {
    try { if (spec.when(b, {}) && spec.when(b, j)) return String(spec.summary(b, j) || '').replace(/(אירוע|לאירוע) [0-9a-f]{8}\b/, m => names.event ? `${m.split(' ')[0]} ${names.event}` : m); } catch { return ''; }
  }
  return '';
}

/* ── §3 the writer ────────────────────────────────────────────────────────── */
async function kvJson(env, k) { try { return JSON.parse((await env.RATE.get(k)) || 'null'); } catch { return null; } }
export async function namesFor(env, token) {
  const out = { event: '', guest: () => '' };
  if (!env.RATE || !/^[0-9a-f-]{36}$/.test(String(token || ''))) return out;
  const em = await kvJson(env, 'evmeta:' + token);
  if (em) out.event = String(em.event || em.client || '').slice(0, 60);
  const gm = (await kvJson(env, 'gmap:' + token)) || {};
  out.guest = (k) => {
    const s = String(k || '').trim(); if (!s) return '';
    const ph = s.replace(/\D/g, '').replace(/^0/, '972');
    if (gm[ph]) return gm[ph].name || '';
    for (const v of Object.values(gm)) if (v && v.id === s) return v.name || '';
    return '';
  };
  return out;
}
/* reqClone / resClone: clones taken BEFORE the handler / the client read the bodies */
export async function teamActionAfter(env, { path, reqClone, resClone, user, changeRoutes = {} }) {
  if (!env.RATE || !user || !user.email || !reqClone || !resClone || !resClone.ok) return '';
  const b = await reqClone.json().catch(() => null); if (!b || typeof b !== 'object') return '';
  if (quietRead(path, b)) return '';
  const j = await resClone.json().catch(() => null); if (!j) return '';
  const tok = String(b.token || b.parent_token || '');
  const text = describe(path, b, j, await namesFor(env, tok), changeRoutes);
  if (!text) return '';
  return logAction(env, { u: user.email, a: text, p: path, m: 1, t: tok.slice(0, 8) });
}
/* the users page: only the meaningful rows (m:1); `all` keeps the old behaviour */
export function meaningfulOnly(rows) { return (rows || []).filter(r => r && r.m); }
