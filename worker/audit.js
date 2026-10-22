/* ============================================================================
   ishur.io · audit.js · the full audit trail ("יומן ביקורת")
   ----------------------------------------------------------------------------
   Richard, 22/10/2026: "ממש מא ועד ת בלי לפספס דבר" — one record for every
   thing that happens in the business, so we can prove later what a client
   did and when, find out what went wrong at every step, and hand a lawyer
   an export that verifies itself.

   This file owns:
     §1  record()    — the ONE writer. Every stream()/logEvent()/tap ends here.
                       Adds id, server time, request context (ip/country/ua),
                       and a SHA-256 hash of the content.
     §2  context()   — pulls ip/country/user-agent out of a Request.
     §3  calls       — keeps a call's transcript + recording bytes (Retell
                       deletes recordings after a while; we don't).
     §4  cron jobs   — job() wraps every scheduled task: start/end/duration/
                       error, so "what did the worker do at 09:10" is answerable.
     §5  export      — query + CSV/JSON with per-row verification.
     §6  daily root  — a hash over the whole day's records, anchored in Slack
                       (an external copy nobody can rewrite quietly).
     §7  sheet mirror— hourly append of the last hour to the "ביקורת" tab.

   Storage (KV, binding RATE):
     stream:<YYYYMMDD>:<ms>:<rand>  one record, 400 days (live.html reads these)
     rec:<call_id>                  recording bytes (audio/wav|mp3), 400 days
     recmeta:<call_id>              {at, phone, agent, mime, bytes, name}
     auditroot:<YYYYMMDD>           {root, count, at}
     auditmirror:<YYYYMMDD>         last ms mirrored to the sheet

   Record shape (every field always present, '' or null when unknown):
     { id, at, ts, kind, area, action, ok, review, token, phone,
       ip, country, ua, detail, data, hash }
   kind ∈ client | guest | wa_out | wa_status | wa_in | call | pay | meta |
          cron | admin | slack | event | system
   ========================================================================== */

import { sha256Hex } from './lib.js';

export const AUDIT_TTL = 400 * 86400;

/* human explanations, shown in live.html's legend and in the export header */
export const KIND_INFO = {
  client:    { he: 'לקוח',     desc: 'פעולה של לקוח בלוח הבקרה, כולל כל פתיחה/צפייה. נשמרים IP, מדינה, דפדפן והקלט המלא.' },
  guest:     { he: 'אורח',     desc: 'אורח ענה בכפתור/בקישור, נרשם מהקישור, או סומן ביום האירוע.' },
  wa_out:    { he: 'יוצאת',    desc: 'הודעת וואטסאפ שיצאה מאיתנו: למי, מאיזה מספר, איזו תבנית/טקסט, מזהה ההודעה אצל מטא.' },
  wa_status: { he: 'מסירה',    desc: 'מטא דיווחה על הודעה שיצאה: נמסרה / נקראה / נכשלה (עם קוד השגיאה של מטא).' },
  wa_in:     { he: 'נכנסת',    desc: 'הודעה נכנסת מאורח, לקוח או ליד, והטקסט המלא.' },
  call:      { he: 'שיחה',     desc: 'שיחה של שיר/נועה: למי, משך, תוצאה, התמלול המלא וקישור להקלטה.' },
  pay:       { he: 'תשלום',    desc: 'תשלום שהתקבל (Grow), חשבונית שהונפקה, שדרוג/תוספת.' },
  meta:      { he: 'מטא',      desc: 'כל מה שמטא החליטה: אישור/דחיית תבנית, איכות מספר, מגבלות שליחה, אימות עסק.' },
  cron:      { he: 'וורקר',    desc: 'ריצה אוטומטית של הוורקר: איזו משימה רצה, מה בדקה, מה עשתה, כמה זמן לקח, אם נפלה.' },
  admin:     { he: 'אדמין',    desc: 'פעולה של ריצארד/שלו/Claude דרך ה-API או מסכי האדמין.' },
  slack:     { he: 'סלאק',     desc: 'הודעה שהמערכת שלחה לסלאק (התראות, דוחות).' },
  event:     { he: 'יומן',     desc: 'רשומת יומן המערכת (הטאב "יומן מערכת" בגיליון): פעולות, כשלים, דברים שדורשים בדיקה.' },
  system:    { he: 'מערכת',    desc: 'פריסת גרסה, שגיאה לא צפויה, דברים של התשתית עצמה.' },
};

/* ── §2 request context ───────────────────────────────────────────────────── */
export function context(request) {
  if (!request || !request.headers) return { ip: '', country: '', ua: '' };
  /* Cloudflare's coarse geolocation of the IP (city/region level, no GPS):
     lawful as security/audit logging under Israel's privacy regulations when
     it is disclosed in the privacy policy and kept for a stated purpose. */
  const cf = request.cf || {};
  return {
    ip: request.headers.get('cf-connecting-ip') || '',
    country: request.headers.get('cf-ipcountry') || '',
    ua: String(request.headers.get('user-agent') || '').slice(0, 240),
    geo: [cf.city, cf.region].filter(Boolean).join(', ') + (cf.asOrganization ? ' · ' + cf.asOrganization : '') + (cf.timezone ? ' · ' + cf.timezone : ''),
  };
}

function ilDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d).replace(/-/g, '');
}

/* the hash covers everything except the hash itself; field order is fixed so
   a verifier can recompute it from an export */
export function hashInput(r) {
  return JSON.stringify([r.id, r.at, r.kind, r.area, r.action, r.ok, r.review, r.token, r.phone, r.ip, r.country, r.ua, r.detail, r.data, r.event || null, r.guest || null, r.geo || '']);
}

/* ── §1b enrichment (Richard 22/10: "איזה אירוע, איזה לקוח, איזה אורח") ─────
   evmeta:<token>  = { event, occasion, date, time, venue, city, client, client_phone, plan, tier, cancelled }
   gmap:<token>    = { "<phone>": { id, name, seats, rsvp, table, group } }
   refreshMeta() rebuilds both every 10 minutes from the sheet snapshot (one
   read for everything), so record() costs at most two KV gets. */
export async function refreshMeta(env, raw) {
  if (!env.RATE || !raw) return { events: 0 };
  const evs = ((raw.events && raw.events.values) || []).filter(r => /^[0-9a-f-]{36}$/.test(String((r || [])[1] || '').trim()));
  const guests = ((raw.guests && raw.guests.values) || []);
  const byTok = {};
  for (const g of guests) { const t = String((g || [])[28] || '').trim(); if (!t) continue; const ph = String(g[4] || '').replace(/\D/g, '').replace(/^0/, '972'); if (!ph) continue; (byTok[t] = byTok[t] || {})[ph] = { id: String(g[2] || '').trim(), name: String(g[3] || '').trim(), seats: String(g[13] || g[5] || '').trim(), rsvp: String(g[15] || '').trim(), table: String(g[30] || '').trim(), call: String(g[21] || '').trim() }; }
  let n = 0;
  for (const r of evs) {
    const c = i => String(r[i] ?? '').trim();
    const tok = c(1);
    const meta = { event: c(34) || c(2), occasion: c(5), date: c(6).slice(0, 10), time: c(36), venue: c(4), city: c(37), client: c(2), client_phone: c(3), plan: c(31) || '', tier: c(32) || '', paid: c(8) || '', cancelled: c(27) === 'כן', invite_date: c(39), reminder_date: c(40) };
    await env.RATE.put('evmeta:' + tok, JSON.stringify(meta), { expirationTtl: 2 * 86400 }).catch(() => {});
    await env.RATE.put('gmap:' + tok, JSON.stringify(byTok[tok] || {}), { expirationTtl: 2 * 86400 }).catch(() => {});
    n++;
  }
  return { events: n };
}
async function enrich(env, r) {
  if (!r.token || r.token.length < 36) return;
  try {
    const em = JSON.parse((await env.RATE.get('evmeta:' + r.token)) || 'null');
    if (em) r.event = em;
    if (r.phone) { const gm = JSON.parse((await env.RATE.get('gmap:' + r.token)) || 'null'); if (gm && gm[r.phone]) r.guest = gm[r.phone]; }
  } catch {}
}

/* ── §1 the writer ─────────────────────────────────────────────────────────
   rec: { kind, area, action, ok, review, token, phone, detail, data|extra, req }
   Never throws. Returns the record (with id) or null. */
export async function record(env, rec) {
  if (!env || !env.RATE) return null;
  try {
    const now = new Date();
    const ms = now.getTime();
    const rand = Math.random().toString(36).slice(2, 6);
    const day = ilDay(now);
    const ctx = rec.req ? context(rec.req) : { ip: String(rec.ip || ''), country: String(rec.country || ''), ua: String(rec.ua || ''), geo: String(rec.geo || '') };
    const data = rec.data && typeof rec.data === 'object' ? rec.data : (rec.extra && typeof rec.extra === 'object' ? rec.extra : null);
    const r = {
      id: `${day}-${ms}-${rand}`,
      at: now.toISOString(),
      ts: ms,
      kind: String(rec.kind || 'event').slice(0, 12),
      area: String(rec.area || '').slice(0, 30),
      action: String(rec.action || '').slice(0, 160),
      ok: rec.ok === undefined ? null : !!rec.ok,
      review: !!rec.review,
      token: String(rec.token || '').slice(0, 36),
      phone: String(rec.phone || '').slice(0, 20),
      ip: ctx.ip, country: ctx.country, ua: ctx.ua, geo: ctx.geo || '',
      detail: String(rec.detail || '').slice(0, 2000),
      data: data ? JSON.parse(JSON.stringify(data).slice(0, 12000).replace(/[^\]}"]*$/, '') || 'null') : null,
    };
    if (data && r.data === null) { try { r.data = JSON.parse(JSON.stringify(data)); } catch { r.data = null; } }
    r.event = null; r.guest = null;
    await enrich(env, r);
    r.hash = await sha256Hex(hashInput(r));
    await env.RATE.put(`stream:${day}:${ms}:${rand}`, JSON.stringify(r), { expirationTtl: AUDIT_TTL });
    return r;
  } catch { return null; }
}

/* ── §3 calls: transcript + recording kept forever ─────────────────────────
   Called from the Retell call_analyzed handler. Fetches the recording bytes
   while Retell still serves them and files them under rec:<call_id>.
   name = YYYY-MM-DD_HHMM_05xxxxxxxx_<agent>.<ext>  (Richard: "בצורה מאוד מסודרת") */
export async function keepCall(env, call, meta = {}) {
  if (!env || !env.RATE || !call || !call.call_id) return null;
  const phone = String(call.to_number || call.from_number || '').replace('+', '');
  const agent = meta.agent || ((meta.kind === 'lead') ? 'נועה' : 'שיר');
  const started = call.start_timestamp ? new Date(call.start_timestamp) : new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(started);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  const local = phone.startsWith('972') ? '0' + phone.slice(3) : phone;
  let mime = '', bytes = 0, ext = 'wav';
  if (call.recording_url) {
    try {
      const r = await fetch(call.recording_url);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 0 && buf.byteLength < 24 * 1024 * 1024) {
          mime = r.headers.get('content-type') || 'audio/wav';
          ext = /mp3|mpeg/.test(mime) ? 'mp3' : /ogg/.test(mime) ? 'ogg' : 'wav';
          bytes = buf.byteLength;
          /* R2 when bound (cheap, no size worries), KV otherwise */
          if (env.AUDIT_R2) await env.AUDIT_R2.put('rec/' + call.call_id, buf, { httpMetadata: { contentType: mime } });
          else await env.RATE.put('rec:' + call.call_id, buf, { expirationTtl: AUDIT_TTL });
        }
      }
    } catch {}
  }
  const name = `${g('year')}-${g('month')}-${g('day')}_${g('hour')}${g('minute')}_${local}_${agent}.${ext}`;
  const recmeta = { at: started.toISOString(), phone, agent, mime, bytes, name, token: String(meta.token || ''), duration_ms: call.duration_ms || (call.end_timestamp && call.start_timestamp ? call.end_timestamp - call.start_timestamp : 0), outcome: String(meta.outcome || '') };
  await env.RATE.put('recmeta:' + call.call_id, JSON.stringify(recmeta), { expirationTtl: AUDIT_TTL }).catch(() => {});
  return { ...recmeta, has_recording: bytes > 0, transcript: String(call.transcript || '') };
}

/* a short-lived signed link so an email can carry downloadable recordings
   without the admin key: /rec/<call_id>?e=<expiry>&s=<sig> */
export async function recordingLink(env, callId, days = 30) {
  const e = Date.now() + days * 86400e3;
  const s = (await sha256Hex(`rec|${callId}|${e}|${env.ADMIN_KEY || ''}`)).slice(0, 32);
  return `https://go.ishur.io/rec/${encodeURIComponent(callId)}?e=${e}&s=${s}`;
}
export async function serveRecording(env, url, isAdmin) {
  const id = decodeURIComponent(url.pathname.replace(/^\/rec\//, ''));
  if (!id || !env.RATE) return new Response('not found', { status: 404 });
  if (!isAdmin) {
    const e = Number(url.searchParams.get('e') || 0), s = String(url.searchParams.get('s') || '');
    if (!e || e < Date.now() || s !== (await sha256Hex(`rec|${id}|${e}|${env.ADMIN_KEY || ''}`)).slice(0, 32)) return new Response('link expired', { status: 403 });
  }
  let buf = null;
  if (env.AUDIT_R2) { const o = await env.AUDIT_R2.get('rec/' + id).catch(() => null); if (o) buf = await o.arrayBuffer(); }
  if (!buf) buf = await env.RATE.get('rec:' + id, 'arrayBuffer');
  const metaRaw = await env.RATE.get('recmeta:' + id);
  if (!buf) return new Response('no recording', { status: 404 });
  let meta = {}; try { meta = JSON.parse(metaRaw || '{}'); } catch {}
  return new Response(buf, { headers: { 'Content-Type': meta.mime || 'audio/wav', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name || id + '.wav')}`, 'Cache-Control': 'private, max-age=3600' } });
}

/* ── §4 cron jobs ──────────────────────────────────────────────────────────
   job(env, 'runPacer', () => runPacer(env)) → one record on finish:
   name, duration, ok/error, and whatever the job returned (trimmed). */
export async function job(env, name, fn) {
  const t0 = Date.now();
  let out = null, err = null;
  try { out = await fn(); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  let summary = '';
  try { summary = out === undefined ? '' : JSON.stringify(out).slice(0, 1500); } catch { summary = String(out).slice(0, 300); }
  await record(env, { kind: 'cron', area: 'וורקר', action: `⚙️ ${name} · ${ms} ms${err ? ' · נפל' : ''}`, ok: !err, review: !!err, detail: err ? String(err && err.stack || err).slice(0, 1500) : summary, data: { job: name, ms, ok: !err } });
  if (err) throw err;
  return out;
}

/* ── §5 export ─────────────────────────────────────────────────────────────
   query: { days (1..400), from 'YYYYMMDD', to 'YYYYMMDD', kind, token, phone, q, limit }
   Reads day by day (newest first) and stops at limit. Each row re-hashed. */
export async function query(env, qy = {}) {
  const out = [];
  if (!env.RATE) return out;
  const limit = Math.max(1, Math.min(20000, Number(qy.limit) || 2000));
  const days = Math.max(1, Math.min(400, Number(qy.days) || 2));
  const dayList = [];
  if (qy.from && qy.to) {
    let d = new Date(`${qy.from.slice(0, 4)}-${qy.from.slice(4, 6)}-${qy.from.slice(6, 8)}T12:00:00Z`);
    const end = new Date(`${qy.to.slice(0, 4)}-${qy.to.slice(4, 6)}-${qy.to.slice(6, 8)}T12:00:00Z`);
    while (d <= end && dayList.length < 400) { dayList.push(ilDay(d)); d = new Date(d.getTime() + 86400e3); }
    dayList.reverse();
  } else {
    for (let i = 0; i < days; i++) dayList.push(ilDay(new Date(Date.now() - i * 86400e3)));
  }
  const tokPrefix = qy.token ? String(qy.token).slice(0, 8) : '';
  const needle = qy.q ? String(qy.q).toLowerCase() : '';
  for (const day of dayList) {
    let cursor; let pages = 0;
    do {
      const page = await env.RATE.list({ prefix: `stream:${day}:`, limit: 1000, cursor }).catch(() => null);
      if (!page) break;
      const keys = page.keys.filter(k => !qy.since || Number(k.name.split(':')[2]) > Number(qy.since));
      const vals = await Promise.all(keys.map(k => env.RATE.get(k.name).catch(() => null)));
      for (let i = 0; i < vals.length; i++) {
        if (!vals[i]) continue;
        let r; try { r = JSON.parse(vals[i]); } catch { continue; }
        if (!r.id) { const p = keys[i].name.split(':'); r.id = `${p[1]}-${p[2]}-${p[3]}`; r.ts = Number(p[2]); }
        if (!r.ts) r.ts = Number(keys[i].name.split(':')[2]) || 0;
        if (qy.kind && r.kind !== qy.kind) continue;
        if (tokPrefix && String(r.token || '').slice(0, 8) !== tokPrefix) continue;
        if (qy.phone && String(r.phone || '') !== String(qy.phone)) continue;
        if (needle && (JSON.stringify(r).toLowerCase().indexOf(needle) < 0)) continue;
        out.push(r);
      }
      cursor = page.list_complete ? null : page.cursor; pages++;
    } while (cursor && pages < 20);
    if (out.length >= limit) break;
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

export async function verifyRows(rows) {
  for (const r of rows) {
    if (!r.hash) { r.verified = null; continue; }      // written before hashing existed
    r.verified = (await sha256Hex(hashInput(r))) === r.hash;
  }
  return rows;
}

const CSV_HEAD = ['id', 'at_utc', 'at_israel', 'kind', 'kind_he', 'area', 'action', 'ok', 'review', 'token', 'event', 'occasion', 'event_date', 'client', 'client_phone', 'phone', 'guest_name', 'guest_id', 'guest_rsvp', 'guest_seats', 'ip', 'country', 'location', 'user_agent', 'detail', 'data', 'hash', 'verified'];
export function toCsv(rows) {
  const esc = v => '"' + String(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)).replace(/"/g, '""') + '"';
  const lines = [CSV_HEAD.join(',')];
  for (const r of rows) {
    const e = r.event || {}, g = r.guest || {};
    lines.push([r.id, r.at, new Date(r.ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), r.kind, (KIND_INFO[r.kind] || {}).he || r.kind, r.area, r.action, r.ok, r.review, r.token, e.event, e.occasion, e.date, e.client, e.client_phone, r.phone, g.name, g.id, g.rsvp, g.seats, r.ip, r.country, r.geo, r.ua, r.detail, r.data, r.hash, r.verified === null ? 'n/a' : (r.verified ? 'yes' : 'NO')].map(esc).join(','));
  }
  return '﻿' + lines.join('\n');
}

/* ── §6 daily root ─────────────────────────────────────────────────────────
   root = sha256 of all the day's hashes in time order. Stored and posted to
   Slack, so a later export can be checked against a copy we don't control. */
export async function dailyRoot(env, day) {
  const rows = (await query(env, { from: day, to: day, limit: 20000 })).sort((a, b) => a.ts - b.ts);
  const root = await sha256Hex(rows.map(r => r.hash || r.id).join('\n'));
  const rec = { root, count: rows.length, at: new Date().toISOString() };
  await env.RATE.put('auditroot:' + day, JSON.stringify(rec), { expirationTtl: AUDIT_TTL }).catch(() => {});
  return rec;
}

/* ── §7 sheet mirror ───────────────────────────────────────────────────────
   Appends every record since the last mirror to the "ביקורת" tab. The caller
   passes the sheet writer (so this file stays free of Make/Sheets details). */
export const MIRROR_TAB = 'ביקורת';
export const MIRROR_HEAD = ['מזהה', 'זמן (ישראל)', 'סוג', 'תחום', 'פעולה', 'תקין', 'לבדיקה', 'טוקן', 'אירוע', 'סוג אירוע', 'תאריך אירוע', 'לקוח', 'טלפון לקוח', 'טלפון', 'אורח', 'מזהה אורח', 'מצב אורח', 'כמות', 'IP', 'מדינה', 'מיקום', 'דפדפן', 'פירוט', 'נתונים', 'hash'];
export async function mirrorRows(env, appendFn) {
  const day = ilDay();
  const since = Number(await env.RATE.get('auditmirror:' + day).catch(() => '0')) || 0;
  const rows = (await query(env, { from: day, to: day, since, limit: 2000 })).sort((a, b) => a.ts - b.ts);
  if (!rows.length) return { appended: 0 };
  const values = rows.map(r => { const e = r.event || {}, g = r.guest || {}; return [r.id, new Date(r.ts).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }), (KIND_INFO[r.kind] || {}).he || r.kind, r.area, r.action, r.ok === null ? '' : (r.ok ? 'כן' : 'לא'), r.review ? 'כן' : '', r.token, e.event || '', e.occasion || '', e.date || '', e.client || '', e.client_phone || '', r.phone, g.name || '', g.id || '', g.rsvp || '', g.seats || '', r.ip, r.country, r.geo || '', r.ua, r.detail, r.data ? JSON.stringify(r.data).slice(0, 5000) : '', r.hash || '']; });
  const ok = await appendFn(MIRROR_TAB, values);
  if (ok) await env.RATE.put('auditmirror:' + day, String(rows[rows.length - 1].ts), { expirationTtl: 3 * 86400 }).catch(() => {});
  return { appended: ok ? rows.length : 0, ok };
}
