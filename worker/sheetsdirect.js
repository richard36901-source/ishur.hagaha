/* ============================================================================
   ishur.io · sheetsdirect.js · the sheet WRITES straight to Google (25/11/2026)
   ----------------------------------------------------------------------------
   Richard 25/11, after Make ran out of credits a fourth time this month (91% of
   the org's credits were ishur): "מעולה" to moving the writes off Make.

   Two Make scenarios did every write; both are replaced here 1:1:
     · BRAIN_HOOK  (7150125 "ishur sheets proxy") — a bare pass-through:
         {url, method, payload, qk1, qv1, qk2, qv2} → sheets.googleapis.com/v4/<url>
         and Google's body back with 200.
     · HOOK_EVENTS (6959458 "העלאת אורחים + הגדרות אירוע") — by event_type:
         guests_file  → append append_body to אורחים (USER_ENTERED), AR='כן' on the event row
         event_setup  → the settings cells of the event row (found by token in column B)
         call_result  → N P V W X Z AD of the guest row (found by id in column C);
                        "__keep__" leaves a cell alone
         anything else→ {"ok":true,"noted":type}
       A missing row answers 200 "Accepted", which is what Make answered when
       its filter stopped the route.

   Empty values (decided 25/11, Make kept no per-module log to settle it):
     · call_result: "" is written as "" — the callers mean it (an answered
       guest's call flag is cleared with call_status "").
     · event_setup: an empty or absent field is left alone — a settings save
       without a new image must never wipe the image cell.

   Safety:
     · Off unless KV cfg:sheets_direct is {"value":"on"} and GOOGLE_SA is set.
       Deploying is not the cutover.
     · Falls back to Make only when nothing was written: no token, 401/403.
       A timeout, 5xx or 429 may already have been applied, so it is answered
       as a failure (the callers' own outbox/retry takes it) and never sent to
       Make a second time — an append replayed twice is a duplicate guest.
     · The write token has its own KV key; the read path (gsheets.js) that keeps
       the boards up is not touched.
     · Every row write confirms the id cell at that row right before writing.
   ========================================================================== */
import { parseSa, signedJwt, PROD_SHEET_ID } from './gsheets.js';

const API = 'https://sheets.googleapis.com/v4/';
const RW_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const RW_KEY = 'gsa:tokenrw';
const MEMO = new WeakMap();
const KEEP = '__keep__';

const sheetOf = env => String((env && env.SHEET_ID) || PROD_SHEET_ID);
export const colLetter = i => { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

export async function directOn(env) {
  if (!env || !env.GOOGLE_SA || !env.RATE) return false;
  try { const v = JSON.parse((await env.RATE.get('cfg:sheets_direct')) || 'null'); return !!v && (v.value === 'on' || v.value === true); } catch { return false; }
}

export async function writeToken(env, fetcher = fetch) {
  const sa = parseSa(env);
  if (!sa) return null;
  const now = Date.now();
  const memo = env.RATE ? MEMO.get(env.RATE) : null;
  if (memo && memo.exp - now > 120e3) return memo.token;
  if (env.RATE) { try { const hit = JSON.parse((await env.RATE.get(RW_KEY)) || 'null'); if (hit && hit.token && hit.exp - now > 120e3) { MEMO.set(env.RATE, hit); return hit.token; } } catch {} }
  const r = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + (await signedJwt(sa, undefined, RW_SCOPE)) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || !j.access_token) return null;
  const rec = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
  if (env.RATE) { MEMO.set(env.RATE, rec); await env.RATE.put(RW_KEY, JSON.stringify(rec), { expirationTtl: 3300 }).catch(() => {}); }
  return rec.token;
}
async function dropToken(env) { if (env.RATE) { MEMO.delete(env.RATE); await env.RATE.delete(RW_KEY).catch(() => {}); } }

/* one Google call. → {status, text} | {fallback:true} (nothing was written) | {status:502} (unknown) */
async function google(env, token, path, { method = 'GET', qs = [], body } = {}, fetcher = fetch) {
  let url = API + encodeURI(String(path).replace(/^\/+/, ''));
  const q = qs.filter(([k]) => k).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : v)).join('&');
  if (q) url += (url.includes('?') ? '&' : '?') + q;
  const init = { method, headers: { Authorization: 'Bearer ' + token } };
  if (body !== undefined && method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  let r;
  try { r = await fetcher(url, init); } catch { return { status: 502, text: '{"error":"network"}' }; }
  if (r.status === 401 || r.status === 403) { await dropToken(env); return { fallback: true, status: r.status }; }
  return { status: r.status, text: await r.text().catch(() => '') };
}
const respond = (status, text, type = 'application/json') => new Response(text, { status, headers: { 'Content-Type': type } });

/* ── BRAIN_HOOK: the pass-through ─────────────────────────────────────── */
export async function brainDirect(env, bodyText, fetcher = fetch) {
  let b; try { b = JSON.parse(bodyText || '{}'); } catch { return respond(400, '{"error":"bad-json"}'); }
  if (!b || typeof b.url !== 'string' || !b.url) return respond(400, '{"error":"no-url"}');
  const token = await writeToken(env, fetcher);
  if (!token) return null;
  const method = String(b.method || 'GET').toUpperCase();
  const g = await google(env, token, b.url, { method, qs: [[b.qk1, b.qv1], [b.qk2, b.qv2]], body: method === 'GET' ? undefined : (b.payload === undefined ? undefined : String(b.payload)) }, fetcher);
  if (g.fallback) return null;
  return respond(g.status >= 200 && g.status < 300 ? 200 : g.status, g.text || '');
}

/* ── HOOK_EVENTS: the three writers ───────────────────────────────────── */
/* the sheet row of the first cell in `col` equal to `value` (rows from 2), or 0 */
async function findRow(env, token, tab, col, value, fetcher) {
  const g = await google(env, token, `spreadsheets/${sheetOf(env)}/values/${tab}!${col}2:${col}`, {}, fetcher);
  if (g.fallback) return { fallback: true };
  if (g.status !== 200) return { error: g.status };
  let vals = []; try { vals = JSON.parse(g.text).values || []; } catch {}
  const want = String(value).trim();
  for (let i = 0; i < vals.length; i++) if (String((vals[i] || [])[0] || '').trim() === want) return { row: i + 2 };
  return { row: 0 };
}
async function writeCells(env, token, tab, row, cells, fetcher) {
  const data = cells.filter(([, v]) => v !== null && v !== undefined).map(([c, v]) => ({ range: `${tab}!${colLetter(c)}${row}`, values: [[String(v)]] }));
  if (!data.length) return { status: 200, text: '{}' };
  return google(env, token, `spreadsheets/${sheetOf(env)}/values:batchUpdate`, { method: 'POST', body: { valueInputOption: 'USER_ENTERED', data } }, fetcher);
}

export const CALL_COLS = { party: 13, rsvp: 15, call_status: 21, answer: 22, ts1: 23, ts2: 25, tries: 29 };
export function callCells(b) {
  const keep = v => (v === KEEP ? null : (v == null ? '' : v));
  return [[CALL_COLS.party, keep(b.party)], [CALL_COLS.rsvp, keep(b.rsvp)], [CALL_COLS.call_status, keep(b.call_status)],
    [CALL_COLS.answer, b.answer == null ? '' : b.answer], [CALL_COLS.ts1, b.ts == null ? '' : b.ts], [CALL_COLS.ts2, b.ts == null ? '' : b.ts], [CALL_COLS.tries, keep(b.tries)]];
}
export function setupCells(b) {
  const s = k => (b[k] == null ? '' : String(b[k]));
  const ifempty = (a, c) => (s(a) !== '' ? s(a) : s(c));
  const cells = [[4, s('venue_name')], [5, ifempty('occasion_label', 'occasion')], [6, s('event_date')], [33, s('style')], [34, ifempty('event_title', 'name1')],
    [35, s('event_description')], [36, s('reception_time')], [37, s('venue_city')], [38, (s('venue_name') + ' ' + s('venue_addr')).trim()],
    [39, s('send_date_1')], [40, s('send_date_2')], [41, s('send_date_3')], [42, s('schedule_mode')], [44, s('image_url')]];
  return cells.map(([c, v]) => [c, v === '' ? null : v]);
}

export async function eventsDirect(env, bodyText, fetcher = fetch) {
  let b; try { b = JSON.parse(bodyText || '{}'); } catch { return respond(400, '{"error":"bad-json"}'); }
  const type = String((b && b.event_type) || '');
  if (!['guests_file', 'event_setup', 'call_result'].includes(type)) return respond(200, JSON.stringify({ ok: true, noted: type }));
  const token = await writeToken(env, fetcher);
  if (!token) return null;

  if (type === 'call_result') {
    const gid = String(b.guest_id || '').trim();
    if (!gid) return respond(200, 'Accepted', 'text/plain');
    const f = await findRow(env, token, 'אורחים', 'C', gid, fetcher);
    if (f.fallback) return null;
    if (f.error) return respond(f.error, '{"error":"lookup"}');
    if (!f.row) return respond(200, 'Accepted', 'text/plain');
    const w = await writeCells(env, token, 'אורחים', f.row, callCells(b), fetcher);
    if (w.fallback) return null;
    return w.status === 200 ? respond(200, '{"ok":true}') : respond(w.status, w.text || '{"error":"write"}');
  }

  const tok = String(b.token || '').trim();
  const f = await findRow(env, token, 'אירועים', 'B', tok, fetcher);
  if (f.fallback) return null;

  if (type === 'event_setup') {
    if (f.error) return respond(f.error, '{"error":"lookup"}');
    if (!f.row) return respond(200, 'Accepted', 'text/plain');
    const w = await writeCells(env, token, 'אירועים', f.row, setupCells(b), fetcher);
    if (w.fallback) return null;
    return w.status === 200 ? respond(200, '{"ok":true}') : respond(w.status, w.text || '{"error":"write"}');
  }

  /* guests_file: the append is the write that matters; it happens whatever the lookup said (as in Make) */
  const a = await google(env, token, `spreadsheets/${sheetOf(env)}/values/אורחים!A1:append`, { method: 'POST', qs: [['valueInputOption', 'USER_ENTERED']], body: String(b.append_body || '{"values":[]}') }, fetcher);
  if (a.fallback) return null;
  if (a.status !== 200) return respond(a.status, a.text || '{"error":"append"}');
  /* the guests are in: from here on the answer is success, or a retry would add them twice */
  if (f.row) await writeCells(env, token, 'אירועים', f.row, [[43, 'כן']], fetcher).catch(() => null);
  return respond(200, `{"ok":true,"guests":${Number(b.guest_count) || 0}}`);
}

/* ── the one door every BRAIN_HOOK / HOOK_EVENTS call goes through ───── */
export async function sheetHookFetch(env, url, init = {}, fetcher = fetch) {
  const isBrain = !!url && url === env.BRAIN_HOOK, isEvents = !!url && url === env.HOOK_EVENTS;
  /* only a JSON text body is understood here; anything else goes to Make exactly as before (never a silent "ok") */
  const body = init && typeof init.body === 'string' && init.body.trim().startsWith('{') ? init.body : null;
  if ((isBrain || isEvents) && body !== null && await directOn(env)) {
    const r = await (isBrain ? brainDirect(env, body, fetcher) : eventsDirect(env, body, fetcher)).catch(() => respond(502, '{"error":"direct"}'));
    if (r) return r;
  }
  return fetcher(url, init);
}
