/* The App Store reviewer's demo client (spec R11; Apple 2.1: a demo account that "must not expire").
   Switched on only when env REVIEW_TOKEN (the demo event's token) and REVIEW_PHONE (its owner, a test phone) are set.

   The demo event is NOT in the Google Sheet. Its rows live in KV review:rows and are added only to the snapshots that
   show things (sign-in, the account's event list, the board's /api/status). The sending engine, the dialer and every
   cron read the sheet without them, so nothing can ever be sent for the demo event: they never see it.
   On top of that, any POST whose body names the demo token or the demo phone is refused, except the routes that only
   read or save the client's own notes (SAFE). A 21/11 audit found no send path in the engine that skips test events,
   which is why the demo stays out of the sheet instead of relying on a test-phone check. */
export const reviewOn = env => !!(env && /^[0-9a-f-]{36}$/.test(String(env.REVIEW_TOKEN || '')) && /\d{9,}/.test(String(env.REVIEW_PHONE || '')));
const phone972 = p => String(p || '').replace(/\D/g, '').replace(/^0(?=\d{9}$)/, '972');

/* routes the demo may use: reading, signing in, and saving its own notes (no message, call, payment or template) */
export const SAFE = new Set([
  '/api/status', '/api/account/pin-login', '/api/account/me', '/api/account/logout', '/api/account/contact',
  '/api/budget', '/api/seatplan', '/api/lineup', '/api/venue-commit', '/api/preview-messages',
  '/api/app/events', '/api/app/push-register', '/api/app/push-unregister', '/api/app/push-prefs', '/api/app/delete-request',
  '/api/client-pin', '/api/app/review-seed',   /* admin-only: read the demo's code, seed it */
]);

/* → a Response-shaped decision: null (go on) or { error } (refuse) */
export function demoGate(env, method, path, bodyText) {
  if (!reviewOn(env) || method !== 'POST' || SAFE.has(path) || !path.startsWith('/api/')) return null;
  const t = String(bodyText || '');
  if (t.includes(env.REVIEW_TOKEN)) return { error: 'demo-readonly' };
  const p = phone972(env.REVIEW_PHONE), local = '0' + p.slice(3);
  if (t.includes(p) || t.includes(local) || t.includes(local.slice(0, 3) + '-' + local.slice(3))) return { error: 'demo-readonly' };
  return null;
}

/* the snapshot with the demo event and its guests added (only for the routes that show it) */
export async function withDemo(env, raw) {
  if (!raw || !reviewOn(env) || !env.RATE) return raw;
  let d = null; try { d = JSON.parse(await env.RATE.get('review:rows')); } catch {}
  if (!d || !Array.isArray(d.events) || !d.events.length) return raw;
  const add = (tab, rows) => (rows && rows.length ? { ...(raw[tab] || {}), values: [...(((raw[tab] || {}).values) || []), ...rows] } : raw[tab]);
  return { ...raw, events: add('events', d.events), guests: add('guests', d.guests) };
}

/* admin seed: rows of an invented event (sheet shape), re-keyed to the demo token and owner */
export function rekey(env, rows) {
  const tok = env.REVIEW_TOKEN, owner = phone972(env.REVIEW_PHONE);
  const events = (rows.events || []).slice(0, 1).map(r => { const x = [...r]; x[1] = tok; x[3] = owner; x[7] = 'כן'; x[27] = ''; return x; });
  const from = (rows.events && rows.events[0] && rows.events[0][1]) || '';
  const guests = (rows.guests || []).filter(g => String(g[28] || '').trim() === from).slice(0, 400).map(g => { const x = [...g]; x[28] = tok; return x; });
  return { events, guests };
}
