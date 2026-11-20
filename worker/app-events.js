/* ishur client app · usage events (spec R20–R25, 20/11/2026).
   Our own log of what a signed-in client does in the app. No third-party SDK, no advertising id.
   KV layout (binding RATE):
     appev:<YYYYMMDD>:<uid>:<id>   one batch from one device: { uid, plat, ver, at, ev: [{ n, t, s, p }] }   400 days
     appfirst:<uid>                the first day this client sent anything                                     800 days
     appsum:<YYYYMMDD>             a finished day, summarised once                                             400 days
     rl:appev:<uid>:<hour>         batches this hour (cap)
   uid is a keyed hash of the phone; the phone itself is never stored here.

   20/11 night: when the Worker has a D1 database bound as APP_DB (tables in migrations-app/), events go there
   instead, one row each, and the report reads from it. Without APP_DB everything above still works. The answer of
   report() is the same from both. */

export const NAMES = new Set([
  'app_open', 'app_background', 'signin_view', 'signin_ok', 'signin_fail', 'signout',
  'tab_view', 'event_switch', 'guest_filter', 'guest_search', 'share_link', 'whatsapp_tap', 'privacy_open',
  'pull_refresh', 'offline_view', 'events_open', 'ref_open', 'terms_open', 'review_prompt', 'review_go', 'review_later', 'rate_prompt', 'calendar_open', 'lang_set',
  'push_sheet_view', 'push_yes', 'push_no', 'push_granted', 'push_denied', 'push_pref', 'push_open',
  'help_open', 'help_topic', 'help_done',
  'delete_open', 'delete_request', 'js_error',
  'board_view', 'board_click',
  'purchase_view', 'purchase_start', 'purchase_done',   /* reserved for 1.1 */
]);
const PROP_KEYS = new Set(['tab', 'page', 'id', 'topic', 'step', 'kind', 'from', 'ok', 'ms', 'n', 'msg', 'signed']);
const SAFE = /^[A-Za-z0-9_.:\/ -]{0,60}$/;
const TTL = 400 * 86400, BATCH_MAX = 50, PER_HOUR = 240;

/* A value is kept only when it cannot be a person's name or phone: plain ASCII, short, no run of 7+ digits. */
export function cleanProps(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  for (const k of Object.keys(p).slice(0, 12)) {
    if (!PROP_KEYS.has(k)) continue;
    const v = p[k];
    if (typeof v === 'number') { if (Number.isFinite(v) && Math.abs(v) < 1e6) out[k] = Math.round(v); continue; }
    if (typeof v === 'boolean') { out[k] = v ? 1 : 0; continue; }
    if (typeof v !== 'string') continue;
    const s = k === 'msg' ? v.replace(/[^\x20-\x7E]/g, '').replace(/\d{5,}/g, '#').replace(/[^A-Za-z0-9_.:\/ -]/g, ' ').slice(0, 60) : v;
    if (SAFE.test(s) && !/\d{7,}/.test(s)) out[k] = s;
  }
  return out;
}
export function cleanEvent(e, now) {
  if (!e || typeof e !== 'object' || !NAMES.has(e.n)) return null;
  let t = Number(e.t); if (!Number.isFinite(t) || t > now + 300e3 || t < now - 7 * 86400e3) t = now;
  const s = typeof e.s === 'string' && /^[a-z0-9]{4,16}$/.test(e.s) ? e.s : '';
  return { n: e.n, t: Math.round(t), s, p: cleanProps(e.p) };
}
export function dayOf(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts.replace(/-/g, '');
}
export async function uidFor(env, phone) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('app-events:' + String(env.APP_UID_SALT || env.ADMIN_KEY || 'ishur')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(phone).replace(/\D/g, '').replace(/^0(?=\d{9}$)/, '972'))));
  return Array.from(sig.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}
const rand = () => Math.random().toString(36).slice(2, 8);

export async function ingest(env, phone, b = {}, { now = new Date() } = {}) {
  const ms = now.getTime(), uid = await uidFor(env, phone), day = dayOf(now);
  /* the hourly cap. With the database it is counted there (a read, cheap); KV writes are the costly item on
     Cloudflare, so the KV counter is used only when there is no database. */
  const hourKey = 'rl:appev:' + uid + ':' + Math.floor(ms / 3600e3);
  let used = 0;
  if (env.APP_DB) { const r = await env.APP_DB.prepare('SELECT COUNT(*) AS c FROM app_events WHERE uid = ? AND ts >= ?').bind(uid, ms - 3600e3).first(); if ((Number(r && r.c) || 0) >= PER_HOUR * BATCH_MAX) return { ok: false, error: 'slow-down' }; }
  else { used = Number(await env.RATE.get(hourKey)) || 0; if (used >= PER_HOUR) return { ok: false, error: 'slow-down' }; }
  const raw = Array.isArray(b.events) ? b.events.slice(0, BATCH_MAX) : [];
  const ev = raw.map(e => cleanEvent(e, ms)).filter(Boolean);
  const dropped = (Array.isArray(b.events) ? b.events.length : 0) - ev.length;
  if (!ev.length) return { ok: true, kept: 0, dropped };
  const plat = ['ios', 'android', 'web'].includes(b.plat) ? b.plat : 'web';
  const ver = typeof b.ver === 'string' && /^[0-9A-Za-z.-]{1,16}$/.test(b.ver) ? b.ver : '';
  if (env.APP_DB) {
    const ins = env.APP_DB.prepare('INSERT INTO app_events (ts, day, uid, sid, name, plat, ver, tab, page, ctl, msg, props) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const str = v => (v == null ? null : String(v));
    await env.APP_DB.batch([
      ...ev.map(e => ins.bind(e.t, day, uid, e.s, e.n, plat, ver, str(e.p.tab), str(e.p.page), str(e.p.id), str(e.p.msg), JSON.stringify(e.p))),
      env.APP_DB.prepare('INSERT INTO app_users (uid, first_day, last_day, plat, ver, events) VALUES (?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET last_day = excluded.last_day, plat = excluded.plat, ver = excluded.ver, events = events + excluded.events').bind(uid, day, day, plat, ver, ev.length),
    ]);
    return { ok: true, kept: ev.length, dropped, store: 'db' };
  }
  await env.RATE.put(hourKey, String(used + 1), { expirationTtl: 7200 });
  await env.RATE.put('appev:' + day + ':' + uid + ':' + ms.toString(36) + rand(), JSON.stringify({ uid, plat, ver, at: now.toISOString(), ev }), { expirationTtl: TTL });
  if (!(await env.RATE.get('appfirst:' + uid))) await env.RATE.put('appfirst:' + uid, day, { expirationTtl: 2 * TTL });
  return { ok: true, kept: ev.length, dropped };
}

async function listAll(env, prefix) {
  const names = []; let cursor;
  for (let i = 0; i < 200; i++) {
    const r = await env.RATE.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys || []) names.push(k.name);
    if (r.list_complete || !r.cursor) break; cursor = r.cursor;
  }
  return names;
}
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

/* One day, all clients. A finished day is computed once and kept. */
export async function daySummary(env, day, { today = dayOf() } = {}) {
  if (day < today) { const c = await env.RATE.get('appsum:' + day); if (c) { try { return JSON.parse(c); } catch {} } }
  const sum = { day, batches: 0, events: 0, users: {}, names: {}, tabs: {}, pages: {}, clicks: {}, errors: {}, plat: {}, ver: {} };
  const keys = await listAll(env, 'appev:' + day + ':');
  for (let i = 0; i < keys.length; i += 40) {
    const vals = await Promise.all(keys.slice(i, i + 40).map(k => env.RATE.get(k)));
    for (const v of vals) {
      let rec; try { rec = JSON.parse(v); } catch { continue; }
      if (!rec || !rec.uid || !Array.isArray(rec.ev)) continue;
      sum.batches++;
      const u = sum.users[rec.uid] || (sum.users[rec.uid] = { n: {}, tabs: {}, plat: rec.plat, ver: rec.ver });
      for (const e of rec.ev) {
        sum.events++; bump(sum.names, e.n); bump(u.n, e.n);
        const p = e.p || {};
        if (e.n === 'tab_view' && p.tab) { bump(sum.tabs, p.tab); bump(u.tabs, p.tab); }
        if (e.n === 'board_view' && p.page) bump(sum.pages, p.page);
        if (e.n === 'board_click' && p.id) bump(sum.clicks, (p.page || '') + '#' + p.id);
        if (e.n === 'js_error') bump(sum.errors, p.msg || 'unknown');
      }
    }
  }
  for (const u of Object.values(sum.users)) { bump(sum.plat, u.plat || 'web'); bump(sum.ver, u.ver || '?'); }
  if (day < today) await env.RATE.put('appsum:' + day, JSON.stringify(sum), { expirationTtl: TTL }).catch(() => {});
  return sum;
}

/* The same per-day summaries, built from the database: one grouped query for the whole range. */
async function dbSummaries(env, list) {
  const by = {}; for (const d of list) by[d] = { day: d, batches: 0, events: 0, users: {}, names: {}, tabs: {}, pages: {}, clicks: {}, errors: {}, plat: {}, ver: {} };
  const q = await env.APP_DB.prepare('SELECT day, uid, name, plat, ver, tab, page, ctl, msg, COUNT(*) AS c FROM app_events WHERE day >= ? AND day <= ? GROUP BY day, uid, name, plat, ver, tab, page, ctl, msg').bind(list[0], list[list.length - 1]).all();
  for (const r of (q.results || [])) {
    const sum = by[r.day]; if (!sum) continue;
    const c = Number(r.c) || 0, u = sum.users[r.uid] || (sum.users[r.uid] = { n: {}, tabs: {}, plat: r.plat, ver: r.ver });
    sum.events += c; bump(sum.names, r.name, c); bump(u.n, r.name, c);
    if (r.name === 'tab_view' && r.tab) { bump(sum.tabs, r.tab, c); bump(u.tabs, r.tab, c); }
    if (r.name === 'board_view' && r.page) bump(sum.pages, r.page, c);
    if (r.name === 'board_click' && r.ctl) bump(sum.clicks, (r.page || '') + '#' + r.ctl, c);
    if (r.name === 'js_error') bump(sum.errors, r.msg || 'unknown', c);
  }
  for (const sum of Object.values(by)) for (const u of Object.values(sum.users)) { bump(sum.plat, u.plat || 'web'); bump(sum.ver, u.ver || '?'); }
  return list.map(d => by[d]);
}

const addDays = (day, n) => { const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8) + n, 12)); return d.toISOString().slice(0, 10).replace(/-/g, ''); };

export async function report(env, { days = 14, now = new Date(), phone = '' } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 14)), today = dayOf(now);
  const list = []; for (let i = n - 1; i >= 0; i--) list.push(addDays(today, -i));
  const sums = env.APP_DB ? await dbSummaries(env, list) : await Promise.all(list.map(d => daySummary(env, d, { today })));
  const out = { ok: true, days: n, from: list[0], to: today, daily: [], events: {}, tabs: {}, board_pages: {}, board_controls: {}, errors: {}, platforms: {}, versions: {} };
  const seen = {};   /* uid → { days:Set, n:{} , tabs:{} } */
  for (const s of sums) {
    out.daily.push({ day: s.day, clients: Object.keys(s.users).length, events: s.events, opens: s.names.app_open || 0 });
    for (const [k, v] of Object.entries(s.names)) bump(out.events, k, v);
    for (const [k, v] of Object.entries(s.tabs)) bump(out.tabs, k, v);
    for (const [k, v] of Object.entries(s.pages)) bump(out.board_pages, k, v);
    for (const [k, v] of Object.entries(s.clicks)) bump(out.board_controls, k, v);
    for (const [k, v] of Object.entries(s.errors)) bump(out.errors, k, v);
    for (const [uid, u] of Object.entries(s.users)) {
      const x = seen[uid] || (seen[uid] = { days: new Set(), n: {}, tabs: {}, plat: u.plat, ver: u.ver });
      x.days.add(s.day); x.plat = u.plat; x.ver = u.ver;
      for (const [k, v] of Object.entries(u.n)) bump(x.n, k, v);
      for (const [k, v] of Object.entries(u.tabs || {})) bump(x.tabs, k, v);
    }
  }
  const users = Object.values(seen);
  for (const u of users) { bump(out.platforms, u.plat || 'web'); bump(out.versions, u.ver || '?'); }
  out.clients = users.length;
  const has = f => users.filter(f).length;
  out.funnel = [
    ['signed_in', has(u => u.n.signin_ok || u.n.app_open)],
    ['saw_board', has(u => u.n.board_view)],
    ['opened_guests', has(u => u.tabs.guests)],
    ['opened_sends', has(u => u.tabs.sends)],
    ['asked_about_notifications', has(u => u.n.push_sheet_view)],
    ['said_yes_to_notifications', has(u => u.n.push_yes)],
    ['opened_help', has(u => u.n.help_open)],
    ['shared_link', has(u => u.n.share_link)],
  ].map(([step, clients]) => ({ step, clients }));
  /* return: of the clients first seen inside this window, how many came back the next day / a week later */
  const uids = Object.keys(seen);
  let firsts;
  if (env.APP_DB) { const fq = await env.APP_DB.prepare('SELECT uid, first_day FROM app_users WHERE last_day >= ?').bind(list[0]).all(); const fm = {}; for (const r of (fq.results || [])) fm[r.uid] = r.first_day; firsts = uids.map(u => fm[u] || null); }
  else firsts = await Promise.all(uids.map(u => env.RATE.get('appfirst:' + u)));
  const ret = { new_clients: 0, day1_eligible: 0, day1: 0, day7_eligible: 0, day7: 0 };
  uids.forEach((uid, i) => {
    const f = firsts[i]; if (!f || f < list[0]) return;
    ret.new_clients++;
    const d1 = addDays(f, 1), d7 = addDays(f, 7);
    if (d1 <= today) { ret.day1_eligible++; if (seen[uid].days.has(d1)) ret.day1++; }
    if (d7 <= today) { ret.day7_eligible++; if (seen[uid].days.has(d7)) ret.day7++; }
  });
  out.return = ret;
  if (phone) { const uid = await uidFor(env, phone), u = seen[uid]; out.client = u ? { active_days: [...u.days].sort(), events: u.n, tabs: u.tabs, platform: u.plat, version: u.ver } : null; }
  return out;
}

/* Remove everything one client sent. Used by the delete-account request and by an admin. */
export async function purge(env, phone) {
  const uid = await uidFor(env, phone);
  let removedDb = 0;
  if (env.APP_DB) {
    const n = await env.APP_DB.prepare('SELECT COUNT(*) AS c FROM app_events WHERE uid = ?').bind(uid).first();
    await env.APP_DB.batch([env.APP_DB.prepare('DELETE FROM app_events WHERE uid = ?').bind(uid), env.APP_DB.prepare('DELETE FROM app_users WHERE uid = ?').bind(uid)]);
    removedDb = Number(n && n.c) || 0;
  }
  const keys = (await listAll(env, 'appev:')).filter(k => k.split(':')[2] === uid);   /* and anything still in KV from before the database */
  const days = new Set(keys.map(k => k.split(':')[1]));
  for (let i = 0; i < keys.length; i += 40) await Promise.all(keys.slice(i, i + 40).map(k => env.RATE.delete(k)));
  await Promise.all([...days].map(d => env.RATE.delete('appsum:' + d)));
  await env.RATE.delete('appfirst:' + uid);
  return { ok: true, removed: keys.length + removedDb };
}
