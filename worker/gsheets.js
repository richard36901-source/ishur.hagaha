/* ============================================================================
   ishur.io · gsheets.js · the snapshot read straight from Google (23/11/2026)
   ----------------------------------------------------------------------------
   Why: the Make org ran out of credits for the third time in November. The
   whole-sheet read behind HOOK_STATUS costs 5 credits a time and ran ~300
   times an hour; on 23/11 22:21 every board stopped saving until credits were
   bought. A read needs no Make: Google's Sheets API answers it for free.

   GOOGLE_SA (secret) = the JSON key of a Google service account that was given
   VIEW access to the sheet. With it set, fetchRaw() in snapshot.js reads here
   first and falls back to Make only when Google does not answer. Without it
   nothing changes. Writes still go through Make.

   The answer has the exact shape the Make scenario returns:
     { ok:true, events:{range,majorDimension,values}, guests:{…}, leads:{…} }
   ========================================================================== */
export const SNAPSHOT_RANGES = ['אירועים!A2:AY500', 'אורחים!A2:AF30000', 'לידים - לא סגרו!A2:Z3000'];
export const PROD_SHEET_ID = '1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q';
const TOKEN_KEY = 'gsa:token', SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = s => b64url(new TextEncoder().encode(s));

export function parseSa(env) {
  try { const j = JSON.parse(String((env && env.GOOGLE_SA) || '')); return j && j.client_email && j.private_key ? j : null; } catch { return null; }
}
/* the signed request Google exchanges for an access token (RS256) */
export async function signedJwt(sa, nowSec = Math.floor(Date.now() / 1000), scope = SCOPE) {   /* scope: sheetsdirect.js asks for the write scope with its own token */
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64urlText(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }));
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claim));
  return head + '.' + claim + '.' + b64url(sig);
}
const MEMO = new WeakMap();   /* per isolate, per KV binding */
export async function accessToken(env, sa, fetcher = fetch) {
  const now = Date.now();
  const memo = env.RATE ? MEMO.get(env.RATE) : null;
  if (memo && memo.exp - now > 120e3) return memo.token;
  if (env.RATE) {
    try { const hit = JSON.parse((await env.RATE.get(TOKEN_KEY)) || 'null'); if (hit && hit.token && hit.exp - now > 120e3) { MEMO.set(env.RATE, hit); return hit.token; } } catch {}
  }
  const r = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + (await signedJwt(sa)) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || !j.access_token) return null;
  const rec = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  if (env.RATE) { MEMO.set(env.RATE, rec); await env.RATE.put(TOKEN_KEY, JSON.stringify(rec), { expirationTtl: 3300 }).catch(() => {}); }
  return rec.token;
}
/* Google's batchGet answer → the Make scenario's shape. null when it is not the three tabs we asked for. */
export function shapeSnapshot(body) {
  const v = body && Array.isArray(body.valueRanges) ? body.valueRanges : null;
  if (!v || v.length !== 3) return null;
  const tab = (x, name) => !!(x && typeof x.range === 'string' && x.range.replace(/'/g, '').startsWith(name + '!'));
  if (!tab(v[0], 'אירועים') || !tab(v[1], 'אורחים') || !tab(v[2], 'לידים - לא סגרו')) return null;
  if (!Array.isArray(v[0].values) || !v[0].values.length) return null;   /* a sheet with no events at all is a wrong answer, not an empty business */
  return { ok: true, events: v[0], guests: v[1], leads: v[2] };
}
/* the whole read. null = not configured or Google did not answer (the caller falls back to Make). */
export async function readSnapshotDirect(env, fetcher = fetch) {
  const sa = parseSa(env);
  if (!sa) return null;
  const token = await accessToken(env, sa, fetcher);
  if (!token) return null;
  const id = String(env.SHEET_ID || PROD_SHEET_ID);
  const qs = SNAPSHOT_RANGES.map(r => 'ranges=' + encodeURIComponent(r)).join('&');
  const r = await fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${qs}`, { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!r || !r.ok) {
    if (r && (r.status === 401 || r.status === 403) && env.RATE) { MEMO.delete(env.RATE); await env.RATE.delete(TOKEN_KEY).catch(() => {}); }
    return null;
  }
  return shapeSnapshot(await r.json().catch(() => null));
}
