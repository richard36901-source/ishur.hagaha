/* ============================================================================
   ishur.io · actor.js · who did it on the client board (25/11/2026, track-board)
   ----------------------------------------------------------------------------
   The team opens a client's board with the same link the client has. Every
   board action used to be recorded as the client's. Now:

   · Team: dashboard.html sends the back-office session it finds in the
     browser (localStorage ishur_calls_key — only a session token: 'us.<hex>'
     Google sign-in or 'sess.<…>' admin-phone session, never the raw admin
     key) in the header x-ishur-staff. It is resolved here for ATTRIBUTION
     ONLY: it grants nothing, and an invalid / expired / raw-key value is
     ignored (the request is the client's, as before). authGate never reads
     this header, so it can not turn a board call into an admin call.
   · Client: how they got in — 'pin' (a personal-area session acct.<…>, from
     the phone + code sign-in, account.js) or 'link' (the ?t= link) — and a
     short session id (sha-256 of the session token, 10 hex; the token itself
     is never stored).

   actor = {kind:'staff', email, name, via:'google'|'admin-device'}
         | {kind:'client', via:'pin'|'link', session:'<10 hex>'|''}
   ========================================================================== */

export const STAFF_HEADER = 'x-ishur-staff';

async function sha10(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}

/* d: { readSession(env, tok) → user|null, adminSessionOk(env, tok) → bool } */
export async function staffOf(env, request, d) {
  let v = '';
  try { v = String(request.headers.get(STAFF_HEADER) || '').trim(); } catch { return null; }
  if (!v || v.length > 200) return null;
  try {
    if (/^us\./.test(v) && d.readSession) {
      const u = await d.readSession(env, v);
      if (u && u.email) return { kind: 'staff', email: String(u.email), name: String(u.name || u.email.split('@')[0]), via: 'google' };
      return null;
    }
    if (/^sess\./.test(v) && d.adminSessionOk) {
      if (await d.adminSessionOk(env, v)) return { kind: 'staff', email: '', name: 'מכשיר מנהל', via: 'admin-device' };
    }
  } catch {}
  return null;
}

/* d: { verifySession(env, tok) → phone|null } */
export async function clientOf(env, body, d) {
  const s = String((body && body.board_session) || '');
  if (s && d.verifySession) {
    try { if (await d.verifySession(env, s)) return { kind: 'client', via: 'pin', session: await sha10(s) }; } catch {}
  }
  return { kind: 'client', via: 'link', session: '' };
}

export async function actorOf(env, request, body, d) {
  return (await staffOf(env, request, d)) || clientOf(env, body, d);
}

export function actorLabel(a) {
  if (!a) return 'הלקוח';
  if (a.kind === 'staff') return 'צוות: ' + (a.name || a.email || 'צוות');
  return a.via === 'pin' ? `הלקוח (כניסה בקוד${a.session ? ', מכשיר ' + a.session.slice(0, 6) : ''})` : 'הלקוח (מהקישור)';
}

/* what the board shows: the team badge (name only) */
export function boardActor(a) {
  return a && a.kind === 'staff' ? { staff: true, name: a.name || a.email || 'צוות' } : null;
}
