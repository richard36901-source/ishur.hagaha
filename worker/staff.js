/* ============================================================================
   ishur.io · staff.js · דיילות: יומן נוכחות דרך נועה (Richard 12/11/2026)
   ----------------------------------------------------------------------------
   A hostess whose number is registered writes to Noa's line: "הגעתי", "חופה",
   "עזבתי" (a time may follow: "הגעתי 18:20"). Each line is kept with the moment
   it arrived and the event she is booked on that day — the record we show a
   client who later claims she came late or left early.

   KV: staff:<phone>                       = {name, role, at}
       stafflog:<IL day>:<ts>:<phone>      = '1' + metadata {n, k, t, x, tok, ev}   (list, no reads)
   ========================================================================== */
export const KIND_HE = { arrive: 'הגעה', chuppah: 'חופה', leave: 'עזיבה', note: 'הערה' };
const HM = /(?:^|\D)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/;
/* → {kind, time} — time is what she wrote, else '' (the caller stamps the arrival moment) */
export function parseStaff(text) {
  const t = String(text || '').trim(); if (!t) return null;
  const m = HM.exec(t); const time = m ? String(m[1]).padStart(2, '0') + ':' + m[2] : '';
  let kind = 'note';
  if (/עזבתי|עזבנו|סיימתי|סיימנו|יצאתי|יצאנו|הלכתי|סיום/.test(t)) kind = 'leave';
  else if (/חופה/.test(t)) kind = 'chuppah';
  else if (/הגעתי|הגענו|באתי|אני פה|אני כאן|נמצאת|הגעה/.test(t)) kind = 'arrive';
  return { kind, time };
}
export function ackText(name, p, hm, evName) {
  const what = { arrive: 'הגעה נרשמה', chuppah: 'שעת החופה נרשמה', leave: 'עזיבה נרשמה', note: 'נרשם' }[p.kind];
  return `${what} ✓ ${p.time || hm}${evName ? ' · ' + evName : ''}${p.kind === 'note' ? '\nאפשר לכתוב: הגעתי / חופה / עזבתי (ואפשר להוסיף שעה).' : ''}\nדיווח מחייב נעשה בקישור האישי שלך, עם צילום.`;
}
/* 12/11 evening (Richard): proof needs a photo that cannot be an old one. WhatsApp strips the capture time from
   photos, so the report comes from a page that opens the LIVE camera and uploads at once: the time is the
   server's, the picture is from that second, the location rides along. A WhatsApp line stays as a note without proof.
   KV: staffsid:<sid> = phone · staffimg:<day>:<ts>:<phone> = jpeg bytes (3 years) */
export const SID_RE = /^[0-9a-f]{24}$/;
const hexN = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const checkinUrl = sid => `https://ishur.io/staff.html?s=${sid}`;
async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.ADMIN_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function todaysEvent(env, day) {
  try {
    const hits = [];
    for (const k of (await env.RATE.list({ prefix: 'hostessbook:', limit: 500 })).keys || []) { const b = await kvJson(env, k.name); if (b && b.date === day) hits.push({ tok: k.name.slice(12), name: b.name || b.event || '' }); }
    return hits.length === 1 ? hits[0] : { tok: '', name: '' };
  } catch { return { tok: '', name: '' }; }
}
/* the hostess's own page: POST form {s, kind, photo, lat, lon, acc} · POST json {s} → who am I + today's lines */
export async function handleCheckin(request, env, origin, d) {
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  const type = request.headers.get('Content-Type') || '';
  if (!/multipart/.test(type)) {
    let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
    const sid = String(b.s || '').toLowerCase(); const phone = SID_RE.test(sid) ? await env.RATE.get('staffsid:' + sid) : '';
    const st = phone ? await kvJson(env, 'staff:' + phone) : null;
    if (!st) return d.deny(403, 'bad-link', origin);
    const day = d.ilDate(new Date()); const mine = [];
    for (const k of (await env.RATE.list({ prefix: 'stafflog:' + day + ':', limit: 200 })).keys || []) { const p = k.name.split(':'); if (p[3] === phone) mine.push({ kind: (k.metadata || {}).k, kind_he: KIND_HE[(k.metadata || {}).k] || '', time: (k.metadata || {}).at || '', photo: !!(k.metadata || {}).img }); }
    return d.okJson({ ok: true, name: st.name, day, today: mine, event: (await todaysEvent(env, day)).name }, origin);
  }
  let form; try { form = await request.formData(); } catch { return d.deny(400, 'bad-form', origin); }
  const sid = String(form.get('s') || '').toLowerCase(); const phone = SID_RE.test(sid) ? await env.RATE.get('staffsid:' + sid) : '';
  const st = phone ? await kvJson(env, 'staff:' + phone) : null;
  if (!st) return d.deny(403, 'bad-link', origin);
  const kind = String(form.get('kind') || ''); if (!['arrive', 'chuppah', 'leave'].includes(kind)) return d.deny(400, 'bad-kind', origin);
  if (await d.overBudget(env, 'rl:checkin:' + phone, 30, 3600)) return d.deny(429, 'slow-down', origin);
  const photo = form.get('photo');
  if (!photo || typeof photo !== 'object' || !photo.arrayBuffer) return d.okJson({ ok: false, error: 'photo-required' }, origin);
  if (photo.size > 1500 * 1024 || photo.size < 2000) return d.okJson({ ok: false, error: 'bad-photo' }, origin);
  const buf = await photo.arrayBuffer(); const h = new Uint8Array(buf.slice(0, 3));
  if (!(h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff)) return d.okJson({ ok: false, error: 'bad-photo' }, origin);
  const ts = Date.now(), day = d.ilDate(new Date(ts)), hm = d.ilTime(new Date(ts));
  const num = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e5) / 1e5 : null; };
  const lat = num(form.get('lat')), lon = num(form.get('lon')), acc = num(form.get('acc'));
  const ev = await todaysEvent(env, day);
  await env.RATE.put(`staffimg:${day}:${ts}:${phone}`, buf, { expirationTtl: 3 * 365 * 86400, metadata: { mime: 'image/jpeg' } });
  await env.RATE.put(`stafflog:${day}:${ts}:${phone}`, '1', { expirationTtl: 3 * 365 * 86400,
    metadata: { n: String(st.name || '').slice(0, 40), k: kind, t: hm, at: hm, x: 'דיווח עם צילום חי', tok: ev.tok.slice(0, 36), ev: String(ev.name).slice(0, 60), img: 1, ...(lat != null && lon != null ? { lat, lon, acc: acc == null ? null : Math.round(acc) } : {}) } });
  await d.logEvent(env, { area: 'דיילות', action: `${KIND_HE[kind]} עם צילום · ${st.name || phone} · ${hm}`, ok: true, phone, token: ev.tok, detail: lat != null ? `מיקום ${lat},${lon} (±${acc == null ? '?' : Math.round(acc)} מ')` : 'בלי מיקום' }).catch(() => {});
  return d.okJson({ ok: true, kind, kind_he: KIND_HE[kind], time: hm, event: ev.name, located: lat != null }, origin);
}
/* the admin opens a photo through a signed link (the admin key never rides a URL) */
export async function handleStaffPhoto(env, url) {
  const day = url.searchParams.get('d') || '', ts = url.searchParams.get('ts') || '', phone = url.searchParams.get('p') || '', sig = url.searchParams.get('sig') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{10,16}$/.test(ts) || !/^\d{9,15}$/.test(phone) || sig !== await sign(env, `${day}:${ts}:${phone}`)) return new Response('forbidden', { status: 403 });
  const hit = await env.RATE.get(`staffimg:${day}:${ts}:${phone}`, { type: 'arrayBuffer' }).catch(() => null);
  if (!hit) return new Response('not found', { status: 404 });
  return new Response(hit, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}
const kvJson = async (env, k) => { try { return JSON.parse(await env.RATE.get(k) || 'null'); } catch { return null; } };

/* called for every inbound message on Noa's line; null = not a staff member */
export async function staffOnMessage(env, phone, text, ts, d) {
  if (!env.RATE || !phone) return null;
  const st = await kvJson(env, 'staff:' + phone); if (!st) return null;
  const p = parseStaff(text); if (!p) return null;
  const day = d.ilDate(new Date(ts)), hm = d.ilTime(new Date(ts));
  /* the event she works today: the one hostess booking on this date (none or several → left open) */
  let tok = '', ev = '';
  try {
    const hits = [];
    for (const k of (await env.RATE.list({ prefix: 'hostessbook:', limit: 500 })).keys || []) { const b = await kvJson(env, k.name); if (b && b.date === day) hits.push({ tok: k.name.slice(12), name: b.name || b.event || '' }); }
    if (hits.length === 1) { tok = hits[0].tok; ev = hits[0].name; }
  } catch {}
  await env.RATE.put(`stafflog:${day}:${ts}:${phone}`, '1', { expirationTtl: 3 * 365 * 86400,
    metadata: { n: String(st.name || '').slice(0, 40), k: p.kind, t: p.time || hm, at: hm, x: String(text || '').slice(0, 120), tok: tok.slice(0, 36), ev: String(ev).slice(0, 60) } });
  await d.logEvent(env, { area: 'דיילות', action: `${KIND_HE[p.kind]} · ${st.name || phone} · ${p.time || hm}`, ok: true, phone, token: tok, detail: String(text || '').slice(0, 200) }).catch(() => {});
  return { staff: st, parsed: p, hm, tok, ev, ack: ackText(st.name, p, hm, ev) };
}

/* 12/11 Richard: the hostess gets her personal link by WhatsApp when she is added, and again every 30 days so it
   stays near the top of the chat (the API cannot pin a message in someone's chat — the text asks her to pin it).
   Free text only reaches her inside WhatsApp's 24-hour window; outside it nothing is sent and the admin gets a
   ready wa.me link to send from his own phone. */
export function linkText(name) { return `היי ${String(name || '').split(' ')[0]}, זה הקישור האישי שלך לדיווח נוכחות באירועים של ishur.io. בכל אירוע לוחצים: הגעתי, חופה, עזבתי, ומצלמים. כדאי להצמיד את ההודעה הזאת 📌`; }
export async function sendStaffLink(env, phone, st, d) {
  const url = checkinUrl(st.sid), text = linkText(st.name);
  let ok = false, error = '';
  try { const r = await d.sendCtaUrl(env, phone, text, 'דיווח נוכחות', url, 'client', { who: 'נועה (דיילות)' }); ok = !!(r && r.ok); error = (r && r.error) || ''; } catch (e) { error = String(e && e.message || e).slice(0, 80); }
  if (ok) await env.RATE.put('staff:' + phone, JSON.stringify({ ...st, link_sent_at: new Date().toISOString() })).catch(() => {});
  await d.logEvent(env, { area: 'דיילות', action: ok ? `קישור דיווח נשלח ל${st.name}` : `קישור דיווח לא נשלח ל${st.name} — לשלוח ידנית`, ok, review: !ok, phone, detail: error }).catch(() => {});
  return { ok, error, wa: `https://wa.me/${phone}?text=${encodeURIComponent(text + '\n' + url)}` };
}
/* cron (once a day is enough): whoever got the link 30+ days ago gets it again */
export async function staffLinkRefresh(env, d, now = Date.now()) {
  if (!env.RATE) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0; const missed = [];
  for (const k of (await env.RATE.list({ prefix: 'staff:', limit: 200 })).keys || []) {
    const st = await kvJson(env, k.name); if (!st || !st.sid) continue;
    const last = Date.parse(st.link_sent_at || st.at || 0) || 0;
    if (now - last < 30 * 86400e3) continue;
    const r = await sendStaffLink(env, k.name.slice(6), st, d);
    if (r.ok) sent++; else { failed++; missed.push(st.name); await env.RATE.put(k.name, JSON.stringify({ ...st, link_sent_at: new Date(now - 29 * 86400e3).toISOString() })).catch(() => {}); }   /* try again tomorrow, not every tick */
  }
  if (missed.length && d.slackSend) await d.slackSend(env, `📌 *דיילות · קישור דיווח חודשי* לא נשלח אוטומטית ל: ${missed.join(', ')} (מחוץ לחלון 24 השעות). לשלוח מהמסך: https://ishur.io/clients.html#staff`, { oneoff: true }).catch(() => {});
  return { sent, failed };
}
export async function handleStaff(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  let sent = null;
  if (b.act === 'add') {
    const phone = d.normPhone(b.phone || ''), name = String(b.name || '').trim().slice(0, 40);
    if (!/^9725\d{8}$/.test(phone) || name.length < 2) return d.okJson({ ok: false, error: 'bad-input' }, origin);
    const prev = await kvJson(env, 'staff:' + phone); const sid = (prev && prev.sid) || hexN(12);
    await env.RATE.put('staff:' + phone, JSON.stringify({ name, role: 'hostess', sid, at: (prev && prev.at) || new Date().toISOString() }));
    await env.RATE.put('staffsid:' + sid, phone);
    if (!prev || b.resend) sent = await sendStaffLink(env, phone, { name, role: 'hostess', sid, at: (prev && prev.at) || new Date().toISOString() }, d);
  } else if (b.act === 'remove') {
    const phone = d.normPhone(b.phone || ''); if (phone) { const prev = await kvJson(env, 'staff:' + phone); if (prev && prev.sid) await env.RATE.delete('staffsid:' + prev.sid).catch(() => {}); await env.RATE.delete('staff:' + phone); }
  }
  const staff = [];
  for (const k of (await env.RATE.list({ prefix: 'staff:', limit: 200 })).keys || []) { const s = await kvJson(env, k.name); if (s) staff.push({ phone: k.name.slice(6), ...s, checkin: s.sid ? checkinUrl(s.sid) : '', wa: s.sid ? `https://wa.me/${k.name.slice(6)}?text=${encodeURIComponent(linkText(s.name) + '\n' + checkinUrl(s.sid))}` : '' }); }
  const log = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await env.RATE.list({ prefix: 'stafflog:', cursor, limit: 1000 }).catch(() => null); if (!page) break;
    for (const k of page.keys) { const p = k.name.split(':'); const m = k.metadata || {}; log.push({ day: p[1], ts: Number(p[2]), phone: p[3], name: m.n || '', kind: m.k || 'note', kind_he: KIND_HE[m.k] || '', time: m.t || '', received: m.at || '', text: m.x || '', token: m.tok || '', event: m.ev || '', photo: m.img ? `/api/staff-photo?d=${p[1]}&ts=${p[2]}&p=${p[3]}&sig=${await sign(env, `${p[1]}:${p[2]}:${p[3]}`)}` : '', lat: m.lat ?? null, lon: m.lon ?? null, acc: m.acc ?? null }); }
    if (page.list_complete) break; cursor = page.cursor;
  }
  log.sort((a, c) => c.ts - a.ts);
  return d.okJson({ ok: true, staff, log: log.slice(0, 500), ...(sent ? { link_sent: sent.ok, wa: sent.wa } : {}) }, origin);
}
