/* ══ identity.js · Sign in with Apple / Google for the client app (22/11/2026, plan round 6 §3, Richard) ══════════
   First time: phone + code, then "connect Apple or Google". From then on that phone signs in to the APP only with the
   linked Apple or Google account; the website keeps the code. The App Store reviewer's demo phone stays on the code.
   Kept free of ishur-only rules where cheap (memory: the next apps reuse the app backend): the token check knows
   only providers, keys and audiences; the account glue is three KV keys.
     ident:<provider>:<sub>  → {phone, email, at}        who this Apple/Google account belongs to
     identof:<phone>         → [{provider, sub, email, at}] the accounts linked to a phone
   Audiences: Apple = the app's bundle id(s) (env APPLE_AUDIENCES, default io.ishur.client); Google = the OAuth client
   ids (env GOOGLE_CLIENT_IDS, comma separated). With no Google ids, Google tokens are refused (not configured). */

const JWKS_URL = { apple: 'https://appleid.apple.com/auth/keys', google: 'https://www.googleapis.com/oauth2/v3/certs' };
const ISSUERS = { apple: ['https://appleid.apple.com'], google: ['https://accounts.google.com', 'accounts.google.com'] };
export const PROVIDERS = Object.keys(JWKS_URL);
const keyCache = {};   /* provider → {at, keys}; an isolate keeps Apple's/Google's keys for an hour */

const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
export function audiences(env, provider) {
  if (provider === 'apple') return list(env && env.APPLE_AUDIENCES).length ? list(env.APPLE_AUDIENCES) : ['io.ishur.client'];
  if (provider === 'google') return list(env && env.GOOGLE_CLIENT_IDS);
  return [];
}
const b64urlBytes = s => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function providerKeys(provider, fetchImpl, force) {
  const c = keyCache[provider];
  if (!force && c && Date.now() - c.at < 3600e3) return c.keys;
  const r = await fetchImpl(JWKS_URL[provider]);
  if (!r || !r.ok) throw new Error('keys-unreachable');
  const j = await r.json();
  keyCache[provider] = { at: Date.now(), keys: Array.isArray(j.keys) ? j.keys : [] };
  return keyCache[provider].keys;
}
export function _resetKeyCache() { for (const k of Object.keys(keyCache)) delete keyCache[k]; }

/* → {ok:true, provider, sub, email, emailVerified} or {ok:false, error} */
export async function verifyIdToken(env, provider, token, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!JWKS_URL[provider]) return { ok: false, error: 'unknown-provider' };
  const aud = audiences(env, provider);
  if (!aud.length) return { ok: false, error: 'not-configured' };
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'bad-token' };
  let head, claims;
  try { head = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return { ok: false, error: 'bad-token' }; }
  if (head.alg !== 'RS256' || !head.kid) return { ok: false, error: 'bad-token' };
  let keys; try { keys = await providerKeys(provider, fetchImpl); } catch { return { ok: false, error: 'keys-unreachable' }; }
  let jwk = keys.find(k => k.kid === head.kid);
  if (!jwk) { try { keys = await providerKeys(provider, fetchImpl, true); jwk = keys.find(k => k.kid === head.kid); } catch {} }
  if (!jwk) return { ok: false, error: 'unknown-key' };
  let good = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch { good = false; }
  if (!good) return { ok: false, error: 'bad-signature' };
  if (!ISSUERS[provider].includes(claims.iss)) return { ok: false, error: 'bad-issuer' };
  const tokAud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!tokAud.some(a => aud.includes(a))) return { ok: false, error: 'bad-audience' };
  const t = Math.floor(now / 1000);
  if (!(Number(claims.exp) > t - 60)) return { ok: false, error: 'expired' };
  if (Number(claims.iat) > t + 300) return { ok: false, error: 'not-yet-valid' };
  if (!claims.sub) return { ok: false, error: 'bad-token' };
  return { ok: true, provider, sub: String(claims.sub), email: claims.email ? String(claims.email) : '', emailVerified: claims.email_verified === true || claims.email_verified === 'true' };
}

const kvJson = async (env, k) => { try { return JSON.parse((await env.RATE.get(k)) || 'null'); } catch { return null; } };

export async function linkedTo(env, phone) { return (await kvJson(env, 'identof:' + phone)) || []; }

/* link a verified identity to a phone; refuses an Apple/Google account already linked to another phone */
export async function linkIdentity(env, phone, id) {
  const k = 'ident:' + id.provider + ':' + id.sub, cur = await kvJson(env, k);
  if (cur && cur.phone && cur.phone !== phone) return { ok: false, error: 'linked-elsewhere' };
  const at = new Date().toISOString();
  await env.RATE.put(k, JSON.stringify({ phone, email: id.email || '', at }));
  const mine = (await linkedTo(env, phone)).filter(x => !(x.provider === id.provider && x.sub === id.sub));
  mine.push({ provider: id.provider, sub: id.sub, email: id.email || '', at });
  await env.RATE.put('identof:' + phone, JSON.stringify(mine));
  return { ok: true, linked: mine.map(x => x.provider) };
}

export async function phoneForIdentity(env, id) { const cur = await kvJson(env, 'ident:' + id.provider + ':' + id.sub); return (cur && cur.phone) || ''; }

/* an admin unlinks (a client lost access to the Apple/Google account), and account deletion removes every link */
export async function unlinkAll(env, phone) {
  const mine = await linkedTo(env, phone);
  for (const x of mine) await env.RATE.delete('ident:' + x.provider + ':' + x.sub).catch(() => {});
  await env.RATE.delete('identof:' + phone).catch(() => {});
  return mine.length;
}
