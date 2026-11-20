/* Android push through Firebase Cloud Messaging, HTTP v1 (https://firebase.google.com/docs/cloud-messaging/send/v1-api).
   Secret FCM_SERVICE_ACCOUNT = the service-account JSON file from Firebase (project settings → service accounts).
   A short-lived OAuth token is made from it (JWT RS256 → oauth2.googleapis.com/token) and reused for 50 minutes.
   Written 21/11/2026 before the Firebase project existed: tested against a generated key and a stubbed Google, not yet
   against Firebase itself. */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uText = s => b64u(new TextEncoder().encode(s));
let tokCache = { at: 0, token: '', email: '' };
export const fcmReady = env => { try { const j = JSON.parse(env.FCM_SERVICE_ACCOUNT || ''); return !!(j.client_email && j.private_key && j.project_id); } catch { return false; } };

export async function accessToken(env, { now = Date.now(), fetchFn = fetch } = {}) {
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  if (tokCache.token && tokCache.email === sa.client_email && now - tokCache.at < 50 * 60e3) return tokCache.token;
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(now / 1000);
  const head = b64uText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64uText(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claims));
  const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claims + '.' + b64u(sig) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('fcm-oauth ' + r.status + ' ' + String(j.error || '').slice(0, 60));
  tokCache = { at: now, token: j.access_token, email: sa.client_email };
  return j.access_token;
}
export function resetFcmCache() { tokCache = { at: 0, token: '', email: '' }; }

/* one notification to one Android device → { status, reason } in the same shape as APNs (410 = remove the device) */
export async function sendFcm(env, dev, payload, { fetchFn = fetch, now } = {}) {
  if (!fcmReady(env)) return { status: 0, error: 'fcm-not-configured' };
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT);
  const data = {}; for (const [k, v] of Object.entries(payload.data || {})) data[k] = String(v);   /* FCM data values must be strings */
  const r = await fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + await accessToken(env, { fetchFn, now }), 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token: dev.device, notification: { title: payload.title, body: payload.body }, data, android: { priority: 'high' } } }),
  });
  if (r.status === 200) return { status: 200, reason: '' };
  let reason = ''; try { const j = await r.json(); reason = ((j.error && j.error.details) || []).map(x => x.errorCode).filter(Boolean)[0] || (j.error && j.error.status) || ''; } catch {}
  /* the device token is gone: the same signal APNs gives with 410 */
  if (reason === 'UNREGISTERED' || (r.status === 404 && /NOT_FOUND/.test(reason))) return { status: 410, reason: 'Unregistered' };
  return { status: r.status, reason };
}
