/* Client app (app/) · push notifications and the app's own routes. 20/11/2026, .sdlc/client-app/spec.md R6–R8.

   What it holds, per client phone, in KV `apppush:<phone>`:
     { devices: [{ device, platform: 'ios'|'android', sandbox, at }], prefs: { answer, daily, failed }, held: [...] }
   Rules:
     · Nothing is sent unless KV `cfg:app_push` is "1" (off by default; production stays off until Richard says so).
     · No push between 21:00 and 09:00 Israel time. Answers in that window are held and counted in the 09:00 summary.
     · A payload carries a guest's name, counts and the event's name. Never a phone number or the event token: any run of 7+
       digits is removed from every text before it leaves.
     · A device APNs answers 410 / BadDeviceToken for is forgotten.
   Secrets (Worker secrets, never in the repo): APNS_KEY_P8 (the .p8 text), APNS_KEY_ID, APNS_TEAM_ID.
   Android (FCM) is not built yet. */

import { sendFcm } from './fcm.js';
export const BUNDLE_ID = 'io.ishur.client';
const KEY = p => 'apppush:' + p;
const DEFAULT_PREFS = { answer: true, daily: true, failed: true };
const MAX_DEVICES = 5, MAX_HELD = 200;

const scrub = s => String(s == null ? '' : s).replace(/[\d\-‐–\s().+]{7,}/g, m => (m.replace(/\D/g, '').length >= 7 ? ' ' : m)).replace(/\d{7,}/g, '').replace(/\s+/g, ' ').trim();

export async function read(env, phone) {
  let r = null; try { r = JSON.parse(await env.RATE.get(KEY(phone))); } catch {}
  r = r || {};
  return { devices: Array.isArray(r.devices) ? r.devices : [], prefs: { ...DEFAULT_PREFS, ...(r.prefs || {}) }, held: Array.isArray(r.held) ? r.held : [] };
}
const write = (env, phone, rec) => env.RATE.put(KEY(phone), JSON.stringify(rec));
export async function on(env) { try { return (await env.RATE.get('cfg:app_push')) === '1'; } catch { return false; } }

/* 21:00–09:00 in Israel, whatever the server's clock zone */
export function quiet(now = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h >= 21 || h < 9;
}

/* 21/11 the client's chosen language (app/www/i18n.js), kept per device at registration. Hebrew is below in buildPush;
   the others here. Guest and event names stay as they are written. */
const PUSH_I18N = {
  en: { guest: 'A guest', answer: 'New answer', yes: (f, n) => `${f} confirmed, ${n === 1 ? '1 coming' : n + ' coming'}`, no: f => `${f} is not coming`, maybe: f => `${f} is not sure yet`, daily: 'Daily summary', ans: a => (a === 1 ? '1 new answer' : a + ' new answers'), coming: n => n + ' coming', pending: n => n + ' have not replied', sent: 'Invitations sent', failed: n => `The invitation did not reach ${n} guests. See who in the Guests tab.` },
  ru: { guest: 'Гость', answer: 'Новый ответ', yes: (f, n) => `${f}: придёт, гостей: ${n}`, no: f => `${f}: не придёт`, maybe: f => `${f}: ещё не уверен(а)`, daily: 'Итоги дня', ans: a => 'новых ответов: ' + a, coming: n => 'придут: ' + n, pending: n => 'не ответили: ' + n, sent: 'Приглашения отправлены', failed: n => `Приглашение не дошло до гостей: ${n}. Кому — во вкладке «Гости».` },
  ar: { guest: 'ضيف', answer: 'ردّ جديد', yes: (f, n) => `${f} أكّد الحضور، ${n === 1 ? 'شخص واحد' : n + ' أشخاص'}`, no: f => `${f} لن يحضر`, maybe: f => `${f} غير متأكد بعد`, daily: 'ملخص يومي', ans: a => (a === 1 ? 'ردّ جديد واحد' : a + ' ردود جديدة'), coming: n => n + ' سيحضرون', pending: n => n + ' لم يردّوا بعد', sent: 'أُرسلت الدعوات', failed: n => `لم تصل الدعوة إلى ${n} ضيوف. يمكن رؤية من في تبويب الضيوف.` },
  fr: { guest: 'Un invité', answer: 'Nouvelle réponse', yes: (f, n) => `${f} a confirmé, ${n === 1 ? '1 personne' : n + ' personnes'}`, no: f => `${f} ne viendra pas`, maybe: f => `${f} n’est pas encore sûr(e)`, daily: 'Résumé du jour', ans: a => (a === 1 ? '1 nouvelle réponse' : a + ' nouvelles réponses'), coming: n => n + ' viennent', pending: n => n + ' n’ont pas répondu', sent: 'Invitations envoyées', failed: n => `L’invitation n’est pas parvenue à ${n} invités. Voir qui dans l’onglet Invités.` },
  es: { guest: 'Un invitado', answer: 'Nueva respuesta', yes: (f, n) => `${f} confirmó, ${n === 1 ? '1 persona' : n + ' personas'}`, no: f => `${f} no vendrá`, maybe: f => `${f} aún no está seguro/a`, daily: 'Resumen del día', ans: a => (a === 1 ? '1 respuesta nueva' : a + ' respuestas nuevas'), coming: n => n + ' vienen', pending: n => n + ' sin responder', sent: 'Invitaciones enviadas', failed: n => `La invitación no llegó a ${n} invitados. Vean a quiénes en la pestaña Invitados.` },
  yi: { guest: 'א גאַסט', answer: 'אַ נײַער ענטפֿער', yes: (f, n) => `${f} האָט באַשטעטיקט, ${n === 1 ? '1 קומט' : n + ' קומען'}`, no: f => `${f} וועט נישט קומען`, maybe: f => `${f} איז נאָך נישט זיכער`, daily: 'טאָג־סך־הכּל', ans: a => (a === 1 ? '1 נײַער ענטפֿער' : a + ' נײַע ענטפֿערס'), coming: n => n + ' קומען', pending: n => n + ' האָבן נאָך נישט געענטפֿערט', sent: 'די אײַנלאַדונגען זײַנען געשיקט', failed: n => `די אײַנלאַדונג איז נישט אָנגעקומען צו ${n} געסט. זעט ווער אין דער געסט־לשונית.` },
  pt: { guest: 'Um convidado', answer: 'Nova resposta', yes: (f, n) => `${f} confirmou, ${n === 1 ? '1 pessoa' : n + ' pessoas'}`, no: f => `${f} não vem`, maybe: f => `${f} ainda não tem certeza`, daily: 'Resumo do dia', ans: a => (a === 1 ? '1 nova resposta' : a + ' novas respostas'), coming: n => n + ' vêm', pending: n => n + ' sem resposta', sent: 'Convites enviados', failed: n => `O convite não chegou a ${n} convidados. Vejam quem na aba Convidados.` },
  am: { guest: 'እንግዳ', answer: 'አዲስ ምላሽ', yes: (f, n) => `${f} መገኘቱን አረጋግጧል፣ ${n} ሰው`, no: f => `${f} አይመጣም`, maybe: f => `${f} ገና እርግጠኛ አይደለም`, daily: 'የቀኑ ማጠቃለያ', ans: a => a + ' አዲስ ምላሾች', coming: n => n + ' ይመጣሉ', pending: n => n + ' ገና አልመለሱም', sent: 'ግብዣዎቹ ተልከዋል', failed: n => `ግብዣው ለ${n} እንግዶች አልደረሰም። እነማን እንደሆኑ በእንግዶች ትር ይመልከቱ።` },
};
export const PUSH_LANGS = new Set(['he', ...Object.keys(PUSH_I18N)]);

export function buildPush(kind, x = {}, lang = 'he') {
  const L = PUSH_I18N[lang];
  if (L) {
    const f = scrub(x.guest).split(' ').slice(0, 2).join(' ') || L.guest, e = scrub(x.event);
    let t = 'ishur', b = '';
    if (kind === 'answer') { t = e || L.answer; const n = Number(x.seats) || 1; b = x.status === 'confirmed' ? L.yes(f, n) : x.status === 'declined' ? L.no(f) : L.maybe(f); }
    else if (kind === 'daily') { t = e ? L.daily + ' · ' + e : L.daily; const a = Number(x.answered) || 0; b = [a ? L.ans(a) : '', x.confirmed != null ? L.coming(Number(x.confirmed)) : '', x.pending != null ? L.pending(Number(x.pending)) : ''].filter(Boolean).join(' · '); }
    else if (kind === 'failed') { t = e || L.sent; b = L.failed(Number(x.failed) || 0); }
    return { title: scrub(t), body: scrub(b), data: { kind } };
  }
  const first = scrub(x.guest).split(' ').slice(0, 2).join(' ') || 'מוזמן';
  const ev = scrub(x.event);
  let title = 'ishur', body = '';
  if (kind === 'answer') {
    title = ev || 'תשובה חדשה';
    const n = Number(x.seats) || 1;
    body = x.status === 'confirmed' ? `${first} אישר/ה הגעה, ${n === 1 ? 'מגיע/ה אחד/ת' : n + ' מגיעים'}`
      : x.status === 'declined' ? `${first} לא יגיע/ו` : `${first} עדיין לא בטוח/ה`;
  } else if (kind === 'daily') {
    title = ev ? 'סיכום יומי · ' + ev : 'סיכום יומי';
    const a = Number(x.answered) || 0;
    body = [a ? (a === 1 ? 'תשובה חדשה אחת' : a + ' תשובות חדשות') : '', x.confirmed != null ? Number(x.confirmed) + ' מגיעים' : '', x.pending != null ? Number(x.pending) + ' עוד לא ענו' : ''].filter(Boolean).join(' · ') || 'אין שינוי מאתמול';
  } else if (kind === 'failed') {
    title = ev || 'ההזמנות נשלחו';
    body = `ההזמנה לא הגיעה ל-${Number(x.failed) || 0} מוזמנים. אפשר לראות למי בלשונית מוזמנים.`;
  }
  /* the event token is the board's secret and may itself hold long digit runs: it does not travel in a push.
     The title names the event; the app opens and refreshes. */
  return { title: scrub(title), body: scrub(body), data: { kind } };
}

export async function register(env, phone, { device, platform, sandbox = false, lang = 'he' } = {}) {
  device = String(device || '').trim(); platform = platform === 'android' ? 'android' : 'ios';
  if (!/^[A-Za-z0-9_:\-]{32,4096}$/.test(device)) return { ok: false, error: 'bad-device' };
  const rec = await read(env, phone);
  lang = PUSH_LANGS.has(lang) ? lang : 'he';
  rec.devices = [{ device, platform, sandbox: !!sandbox, lang, at: new Date().toISOString() }, ...rec.devices.filter(d => d.device !== device)].slice(0, MAX_DEVICES);
  await write(env, phone, rec);
  return { ok: true, prefs: rec.prefs };
}
export async function unregister(env, phone, device) {
  const rec = await read(env, phone);
  rec.devices = device ? rec.devices.filter(d => d.device !== String(device)) : [];
  await write(env, phone, rec);
  return { ok: true };
}
export async function setPrefs(env, phone, prefs = {}) {
  const rec = await read(env, phone);
  for (const k of Object.keys(DEFAULT_PREFS)) if (typeof prefs[k] === 'boolean') rec.prefs[k] = prefs[k];
  await write(env, phone, rec);
  return { ok: true, prefs: rec.prefs };
}

/* ── APNs (token auth, ES256). The JWT is reused for 50 minutes, as Apple asks (20–60). ── */
let jwtCache = { at: 0, jwt: '', kid: '' };
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uText = s => b64u(new TextEncoder().encode(s));
export async function apnsJwt(env, now = Date.now()) {
  if (jwtCache.jwt && jwtCache.kid === env.APNS_KEY_ID && now - jwtCache.at < 50 * 60e3) return jwtCache.jwt;
  const der = Uint8Array.from(atob(String(env.APNS_KEY_P8).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uText(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })), claims = b64uText(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + claims));
  jwtCache = { at: now, jwt: `${head}.${claims}.${b64u(sig)}`, kid: env.APNS_KEY_ID };
  return jwtCache.jwt;
}
export const apnsReady = env => !!(env.APNS_KEY_P8 && env.APNS_KEY_ID && env.APNS_TEAM_ID);
async function sendApns(env, dev, payload) {
  if (dev.platform === 'android') return sendFcm(env, dev, payload);   /* fcm.js */
  if (dev.platform !== 'ios') return { status: 0, error: 'unknown-platform' };
  if (!apnsReady(env)) return { status: 0, error: 'apns-not-configured' };
  const host = dev.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const r = await fetch(`https://${host}/3/device/${dev.device}`, {
    method: 'POST',
    headers: { authorization: 'bearer ' + await apnsJwt(env), 'apns-topic': BUNDLE_ID, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' },
    body: JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' }, ...payload.data }),
  });
  let reason = ''; if (r.status !== 200) { try { reason = (await r.json()).reason || ''; } catch {} }
  return { status: r.status, reason };
}

async function deliver(env, phone, rec, payload, send) {
  let sent = 0; const gone = [];
  for (const dev of rec.devices) {
    let r; try { r = await send(env, dev, typeof payload === 'function' ? payload(dev.lang || 'he') : payload); } catch (e) { r = { status: 0, error: String(e && e.message || e).slice(0, 120) }; }
    if (r.status === 200) sent++;
    else if (r.status === 410 || /BadDeviceToken|Unregistered/.test(r.reason || '')) gone.push(dev.device);
  }
  if (gone.length) rec.devices = rec.devices.filter(d => !gone.includes(d.device));
  return { sent, dropped: gone.length };
}

/* A guest answered. Daytime: one push. Quiet hours: held for the morning summary. */
export async function notifyAnswer(env, phone, x, { now = new Date(), send = sendApns } = {}) {
  if (!(await on(env))) return { sent: 0, off: true };
  const rec = await read(env, phone);
  if (!rec.devices.length || !rec.prefs.answer) return { sent: 0 };
  if (quiet(now)) {
    rec.held = [...rec.held, { t: x.token || '', s: x.status || '', at: now.toISOString() }].slice(-MAX_HELD);
    await write(env, phone, rec);
    return { sent: 0, held: true };
  }
  const r = await deliver(env, phone, rec, lang => buildPush('answer', x, lang), send);
  if (r.dropped) await write(env, phone, rec);
  return r;
}
/* 09:00: what came in overnight plus where the event stands. Clears the held list. */
export async function dailySummary(env, phone, x, { now = new Date(), send = sendApns } = {}) {
  if (!(await on(env))) return { sent: 0, off: true };
  const rec = await read(env, phone);
  const answered = rec.held.filter(h => !x.token || h.t === x.token).length;
  let r = { sent: 0 };
  if (rec.devices.length && rec.prefs.daily && !quiet(now)) r = await deliver(env, phone, rec, lang => buildPush('daily', { ...x, answered }, lang), send);
  rec.held = []; await write(env, phone, rec);
  return r;
}
export async function notifyFailed(env, phone, x, { now = new Date(), send = sendApns } = {}) {
  if (!(await on(env)) || quiet(now)) return { sent: 0 };
  const rec = await read(env, phone);
  if (!rec.devices.length || !rec.prefs.failed || !(Number(x.failed) > 0)) return { sent: 0 };
  const r = await deliver(env, phone, rec, lang => buildPush('failed', x, lang), send);
  if (r.dropped) await write(env, phone, rec);
  return r;
}

/* ── the two places the Worker calls in ── both return quietly whatever happens: an answer must never fail to be
   saved, and a cron must never stop, because of a notification. */
const HE_STATUS = { 'מגיע': 'confirmed', 'לא מגיע': 'declined', 'מתלבט': 'undecided' };
/* A guest's answer was written (WhatsApp reply or the RSVP page). `guest` = { token, name }, outcome is the sheet's
   Hebrew status. Not called for the client's own manual change on the board. */
export async function answerHook(env, d, guest, outcome, party, opts = {}) {
  try {
    if (!guest || !guest.token || !HE_STATUS[outcome] || !(await on(env))) return { sent: 0 };
    const rec = await d.tokenRecord(env, guest.token);
    const phone = String((rec && rec.phone) || '');
    if (!/^972\d{8,9}$/.test(phone)) return { sent: 0 };
    return await notifyAnswer(env, phone, { token: guest.token, guest: guest.name || '', seats: party, status: HE_STATUS[outcome] }, opts);
  } catch { return { sent: 0 }; }
}
/* Called from the ten-minute cron. Does its work once a day, in the first run of the 09:00 hour in Israel (so it
   is right in summer and in winter): one summary per client that has the app, for their nearest coming event. */
export async function morningRun(env, d, { now = new Date(), send } = {}) {
  try {
    if (!(await on(env))) return { ran: false };
    const il = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = t => (il.find(x => x.type === t) || {}).value;
    if (Number(part('hour')) !== 9) return { ran: false };
    const day = `${part('year')}-${part('month')}-${part('day')}`, mark = 'apppushday:' + day;
    if (await env.RATE.get(mark)) return { ran: false };
    await env.RATE.put(mark, '1', { expirationTtl: 2 * 86400 });
    const keys = ((await env.RATE.list({ prefix: 'apppush:', limit: 500 })).keys || []).map(k => k.name.slice('apppush:'.length));
    if (!keys.length) return { ran: true, sent: 0 };
    const raw = await d.readSnapshot(env, 'dashboard');
    let sent = 0;
    for (const phone of keys) {
      try {
        const evs = raw ? (d.eventsForPhone(raw, phone) || []).filter(e => e.token && String(e.event_date || '').slice(0, 10) >= day) : [];
        evs.sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
        const ev = evs[0];
        if (!ev) { const rec = await read(env, phone); if (rec.held.length) { rec.held = []; await write(env, phone, rec); } continue; }
        const snap = d.buildDashboard(ev.token, raw) || {}; const t = snap.totals || {};
        const r = await dailySummary(env, phone, { token: ev.token, event: ev.event_name || '', confirmed: t.confirmed_seats, pending: t.pending }, send ? { now, send } : { now });
        sent += r.sent || 0;
      } catch {}
    }
    return { ran: true, sent };
  } catch { return { ran: false }; }
}

import { ingest as evIngest, report as evReport, purge as evPurge } from './app-events.js';

/* ── /api/app/* ── POST, JSON. Every client route needs the client's session (the same one the personal area uses). */
export async function handleApp(request, env, origin, url, d) {
  const path = url.pathname.replace(/^\/api\/app\//, '');
  if (request.method !== 'POST') return d.deny(404, 'unknown-app-route', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }

  /* admin: can this Worker reach Apple's push service at all? (spec risk: APNs needs HTTP/2). Signs with a throwaway
     key, so Apple answers 403 InvalidProviderToken when the request arrives; anything else is printed as it came. */
  if (path === 'apns-probe') {
    if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const head = b64uText(JSON.stringify({ alg: 'ES256', kid: 'PROBE00000' })), claims = b64uText(JSON.stringify({ iss: 'PROBE00000', iat: Math.floor(Date.now() / 1000) }));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(head + '.' + claims));
    const out = {};
    for (const host of ['api.sandbox.push.apple.com', 'api.push.apple.com']) {
      try {
        const r = await fetch(`https://${host}/3/device/${'0'.repeat(64)}`, { method: 'POST', headers: { authorization: `bearer ${head}.${claims}.${b64u(sig)}`, 'apns-topic': BUNDLE_ID, 'apns-push-type': 'alert', 'content-type': 'application/json' }, body: '{"aps":{"alert":"probe"}}' });
        out[host] = { status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (e) { out[host] = { error: String(e && e.message || e).slice(0, 200) }; }
    }
    return d.okJson({ ok: true, out }, origin);
  }
  /* admin: the App Store review demo (review-demo.js). {admin_key, from: <token of an invented event in the current
     snapshot>} copies that event and its guests, re-keyed to REVIEW_TOKEN / REVIEW_PHONE, into KV review:rows; or
     {admin_key, rows:{events, guests}} stores given rows. Never writes the sheet. */
  if (path === 'review-seed') {
    if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
    if (!d.reviewOn || !d.reviewOn(env)) return d.deny(409, 'review-off', origin);
    let src = b.rows;
    if (!src && b.from) { const raw = await d.readSnapshot(env, 'dashboard'); src = { events: ((raw && raw.events && raw.events.values) || []).filter(r => String(r[1] || '').trim() === String(b.from)), guests: (raw && raw.guests && raw.guests.values) || [] }; }
    const rows = d.reviewRekey(env, src || {});
    if (!rows.events.length) return d.deny(404, 'no-event', origin);
    await env.RATE.put('review:rows', JSON.stringify(rows));
    await env.RATE.put('token:' + env.REVIEW_TOKEN, JSON.stringify({ phone: String(env.REVIEW_PHONE).replace(/\D/g, '').replace(/^0/, '972'), review_demo: true }));
    return d.okJson({ ok: true, events: rows.events.length, guests: rows.guests.length }, origin);
  }
  if (path === 'push-test') {   /* admin: one test notification to a phone's devices; works with the switch off */
    if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
    const phone = String(b.phone || ''); const rec = await read(env, phone);
    if (!rec.devices.length) return d.okJson({ ok: false, error: 'no-devices' }, origin);
    if (!apnsReady(env)) return d.okJson({ ok: false, error: 'apns-not-configured', devices: rec.devices.length }, origin);
    const results = [];
    for (const dev of rec.devices) { try { results.push(await sendApns(env, dev, buildPush('answer', { guest: 'בדיקה', seats: 2, status: 'confirmed', event: 'בדיקת התראה' }))); } catch (e) { results.push({ status: 0, error: String(e && e.message || e).slice(0, 160) }); } }
    return d.okJson({ ok: results.some(r => r.status === 200), results }, origin);
  }

  /* usage events (app-events.js): the report and the purge are for an admin */
  if (path === 'analytics' || path === 'events-purge') {
    if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
    if (path === 'events-purge') return b.phone ? d.okJson(await evPurge(env, String(b.phone)), origin) : d.deny(400, 'no-phone', origin);
    return d.okJson(await evReport(env, { days: b.days, phone: String(b.phone || '') }), origin);
  }

  const phone = await d.verifySession(env, String(b.session || ''));
  if (!phone) return d.deny(401, 'no-session', origin);
  if (path === 'events') return d.okJson(await evIngest(env, phone, b), origin);
  if (path === 'push-register') { const r = await register(env, phone, b); return r.ok ? d.okJson({ ...r, on: await on(env) }, origin) : d.deny(400, r.error, origin); }
  if (path === 'push-unregister') return d.okJson(await unregister(env, phone, b.device), origin);
  if (path === 'push-prefs') return d.okJson(b.prefs ? await setPrefs(env, phone, b.prefs) : { ok: true, prefs: (await read(env, phone)).prefs }, origin);
  if (path === 'delete-request') {
    /* Apple 5.1.1(v) / Google account deletion: the request starts in the app. A person carries it out within 7
       days (events, guest lists, answers), so it lands in the journal marked for review. */
    await env.RATE.put('appdelete:' + phone, new Date().toISOString(), { expirationTtl: 90 * 86400 }).catch(() => {});
    await d.logEvent(env, { area: 'אפליקציה', action: 'בקשת מחיקת חשבון ומידע מהאפליקציה (לבצע תוך 7 ימים)', ok: true, review: true, phone }).catch(() => {});
    await evPurge(env, phone).catch(() => {});   /* the client's usage events go at once (R24) */
    return d.okJson({ ok: true }, origin);
  }
  return d.deny(404, 'unknown-app-route', origin);
}
