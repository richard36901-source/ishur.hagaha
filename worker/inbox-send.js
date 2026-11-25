/* ============================================================================
   ishur.io · inbox-send.js · the composer in next/inbox.html (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   "add in the new inbox so I can use it to send messages and add files."

   Routes (all POST, admin key / Google session like every admin route):
     /api/inbox/state      {admin_key, phone}
        → {ok, phone, line:{channel, kind, phone_id, label}, window:{open, last_in_ts, closes_at},
           quiet:{quiet, rule, until}, who:{name, via}, limits}
     /api/inbox/templates  {admin_key, phone}
        → {ok, channel, templates:[{name, lang, category, body, params, header, button_param, supported}]}
     /api/inbox/media      multipart/form-data {phone, file[, admin_key]}  (key also as x-admin-key header)
        → {ok, media:{id, kind, mime, name, size, phone_id}}
     /api/inbox/send       {admin_key, phone, kind:'text'|'media'|'template', text?,
                            media?:{id, kind, mime, name, phone_id}, caption?,
                            template?:{name, lang, params[], header_media?:{id,kind}|header_url?, button_param?},
                            confirm_quiet?:true}
        → {ok:true, id, status:'sent', who, channel}
        | {ok:false, error:'window-closed', window}       free text / file after 24h → use a template
        | {ok:false, error:'needs-confirm', quiet}         quiet hours → resend with confirm_quiet:true
        | {ok:false, error:'<reason>'}

   Rules held here (server side, whatever the screen does):
   · the reply leaves from the line the person last wrote to (conv:<phone>.last_in_line,
     the guest's gph: pin, the x4499 marker for older rows) — never chosen by the request;
   · free text and files only inside 24h of their last message; templates any time;
   · quiet hours: clients/leads 21:00–09:00, guests 19:00–09:00 (Israel) → explicit confirm;
   · who sent it = the signed-in person (x-ishur-user, set only by authGate), never the body.
   Everything goes out through whatsapp.js post(), so the log line, ticks (wamid2log),
   conversation index, messages sheet and CRM timeline are written the usual way.
   ========================================================================== */
import { normPhone } from './lib.js';
import {
  sendText, sendTemplate, sendMedia, guestsReady, isGuestPhone, guestPinnedPhone, pickGuestPhone,
  clientOnPortfolio, clientPhoneId, clientWaba, clientToken, templateAllowedOn,
} from './whatsapp.js';
import { logEvent } from './evlog.js';
import { isStaging, isAllowedPhone } from './staging-guard.js';

export const GRAPH = 'https://graph.facebook.com/v21.0';
export const GUEST_WABA = '1378764257421712';
export const WINDOW_MS = 24 * 3600 * 1000;
export const TEXT_MAX = 4096;
export const CAPTION_MAX = 1024;

/* ── §1 media rules (Meta Cloud API "Supported media types", read 25/11/2026) ──
   image 5MB jpeg/png/webp · video 16MB mp4/3gpp (H.264+AAC) · audio 16MB aac/amr/mp3/m4a/ogg(opus)
   · document 100MB txt/xls/xlsx/doc/docx/ppt/pptx/pdf. Documents are capped lower here (WORKER_DOC_MAX):
   the Worker holds the whole file in memory (128MB) while it passes it to Meta. */
export const WORKER_DOC_MAX = 25 * 1024 * 1024;
const MB = 1024 * 1024;
export const MEDIA_RULES = {
  image: { max: 5 * MB, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
  video: { max: 16 * MB, mimes: ['video/mp4', 'video/3gpp'] },
  audio: { max: 16 * MB, mimes: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'] },
  document: { max: WORKER_DOC_MAX, meta_max: 100 * MB, mimes: [
    'text/plain', 'application/pdf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
};
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', '3gp': 'video/3gpp',
  aac: 'audio/aac', amr: 'audio/amr', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg',
  txt: 'text/plain', pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const MIME_ALIAS = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'audio/mp3': 'audio/mpeg', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/x-aac': 'audio/aac', 'audio/opus': 'audio/ogg', 'video/3gp': 'video/3gpp' };
/* what browsers commonly hand over that WhatsApp refuses — said in words, not a code */
const REFUSED_HE = {
  'audio/webm': 'הקלטה מהדפדפן (webm) לא נתמכת בוואטסאפ. שולחים mp3, m4a או ogg.',
  'video/quicktime': 'סרטון mov (אייפון) לא נתמך. צריך mp4.',
  'video/webm': 'סרטון webm לא נתמך. צריך mp4.',
  'image/heic': 'תמונת HEIC (אייפון) לא נתמכת. צריך jpg או png.',
  'image/gif': 'GIF לא נתמך כתמונה. שולחים כסרטון mp4.',
};

export function normMime(mime, name = '') {
  let m = String(mime || '').toLowerCase().split(';')[0].trim();
  m = MIME_ALIAS[m] || m;
  const ext = (String(name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || '';
  /* the extension decides when the browser gave nothing useful */
  if ((!m || m === 'application/octet-stream') && EXT_MIME[ext]) m = EXT_MIME[ext];
  return m;
}
export function kindOfMime(mime) {
  for (const [k, r] of Object.entries(MEDIA_RULES)) if (r.mimes.includes(mime)) return k;
  return '';
}
/* → {ok:true, kind, mime} | {ok:false, error, he} */
export function validateMedia({ mime, size, name } = {}) {
  const m = normMime(mime, name);
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'empty-file', he: 'הקובץ ריק.' };
  if (REFUSED_HE[m]) return { ok: false, error: 'type-not-allowed', mime: m, he: REFUSED_HE[m] };
  const kind = kindOfMime(m);
  if (!kind) return { ok: false, error: 'type-not-allowed', mime: m, he: 'סוג הקובץ לא נתמך בוואטסאפ. אפשר: תמונה jpg/png, סרטון mp4, שמע mp3/m4a/ogg, מסמך pdf/word/excel/powerpoint/txt.' };
  const r = MEDIA_RULES[kind];
  if (n > r.max) {
    const mb = Math.round(r.max / MB);
    return { ok: false, error: 'too-big', kind, mime: m, max: r.max, he: kind === 'document' ? `מסמך עד ${mb}MB מהאינבוקס.` : `${({ image: 'תמונה', video: 'סרטון', audio: 'קובץ שמע' })[kind]} עד ${mb}MB בוואטסאפ.` };
  }
  return { ok: true, kind, mime: m };
}

/* ── §2 the 24-hour window and quiet hours (pure; `now` injected) ───────────── */
export function windowState(lastInTs, now = Date.now()) {
  const t = Number(lastInTs) || 0;
  const open = !!t && now - t < WINDOW_MS && now >= t - 60000;
  return { open, last_in_ts: t || null, closes_at: t ? t + WINDOW_MS : null };
}
export function ilHour(now = Date.now()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
  return h === 24 ? 0 : h;
}
/* kind 'guests' → 19:00–09:00 · anything else (clients, leads) → 21:00–09:00 */
export function quietState(kind, now = Date.now()) {
  const rule = kind === 'guests' ? 'guests' : 'client';
  const from = rule === 'guests' ? 19 : 21;
  const h = ilHour(now);
  const quiet = h >= from || h < 9;
  return { quiet, rule, from: `${from}:00`, until: '09:00' };
}

/* ── §3 which line, who is sending ─────────────────────────────────────────── */
async function kvJson(env, k) { try { return env.RATE ? JSON.parse((await env.RATE.get(k)) || 'null') : null; } catch { return null; } }

/* → {channel:'client'|'guests', kind:'client'|'guests', phone_id, label} | {error} */
export async function resolveLine(env, phone, conv) {
  const c = conv || {};
  const chs = Array.isArray(c.ch) ? c.ch : [];
  const x4499 = env.RATE ? !!(await env.RATE.get('x4499:' + phone).catch(() => null)) : false;
  const pin = await guestPinnedPhone(env, phone).catch(() => '');
  let channel = c.last_in_line === 'guests' || c.last_in_line === 'client' ? c.last_in_line : '';
  if (!channel) {
    if (chs.length === 1) channel = chs[0] === 'guests' && !x4499 ? 'guests' : 'client';
    else if (x4499) channel = 'client';
    else channel = pin ? 'guests' : 'client';
  }
  const kind = c.last_in_kind === 'guests' || c.last_in_kind === 'client' ? c.last_in_kind : (x4499 || channel === 'guests' ? 'guests' : 'client');
  if (channel === 'guests') {
    if (!guestsReady(env)) return { error: 'guests-number-not-connected', channel, kind };
    let pid = c.last_in_pid && isGuestPhone(env, c.last_in_pid) ? String(c.last_in_pid) : (pin || '');
    if (!pid) pid = await pickGuestPhone(env, { template: false, to: phone }).catch(() => '');
    if (!pid) return { error: 'no-guest-number', channel, kind };
    return { channel, kind, phone_id: pid, label: 'מספר האורחים (שיר)' };
  }
  const pid = clientOnPortfolio(env) ? env.WA_PHONE_ID_CLIENT_NEW : clientPhoneId(env);
  if (!pid) return { error: 'wa-not-configured', channel, kind };
  return { channel, kind, phone_id: String(pid), label: 'נועה · 4499' };
}

/* d: { getUser(env, email), readSession(env, tok) } — the name of the person, never from the body */
export async function whoOf(env, request, body, d = {}) {
  const email = String(request.headers.get('x-ishur-user') || '').trim();
  if (email) {
    const u = d.getUser ? await d.getUser(env, email).catch(() => null) : null;
    return { name: String((u && u.name) || email.split('@')[0]).slice(0, 40), email, via: 'google' };
  }
  const key = String((body && body.admin_key) || request.headers.get('x-admin-key') || '');
  if (/^us\./.test(key) && d.readSession) {
    const u = await d.readSession(env, key).catch(() => null);
    if (u && u.email) return { name: String(u.name || u.email.split('@')[0]).slice(0, 40), email: u.email, via: 'google' };
  }
  if (/^sess\./.test(key)) return { name: 'מכשיר מנהל', email: '', via: 'admin-device' };
  return { name: 'מנהל', email: '', via: 'admin-key' };
}

const mask = p => String(p || '').replace(/(\d{3})\d+(\d{3})$/, '$1****$2');
function jres(d, origin, o, status = 200) {
  return status === 200 ? d.okJson(o, origin) : new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...d.cors(origin) } });
}

/* ── §4 approved templates for the line ───────────────────────────────────── */
function lineWaba(env, channel) {
  return channel === 'guests' ? { waba: GUEST_WABA, token: env.WA_TOKEN_GUESTS } : { waba: clientWaba(env), token: clientToken(env) };
}
export function shapeTemplate(t) {
  const comps = t.components || [];
  const bd = comps.find(c => c.type === 'BODY') || {};
  const hd = comps.find(c => c.type === 'HEADER');
  const bt = comps.find(c => c.type === 'BUTTONS');
  const body = String(bd.text || '');
  const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
  const params = nums.length ? Math.max(...nums) : 0;
  const named = String(t.parameter_format || '').toUpperCase() === 'NAMED' || /\{\{[a-z_][a-z0-9_]*\}\}/i.test(body);
  const header = hd ? { format: String(hd.format || 'TEXT'), text: String(hd.text || '') } : null;
  const headerVar = !!(header && header.format === 'TEXT' && /\{\{/.test(header.text));
  const urlBtnIdx = ((bt && bt.buttons) || []).findIndex(b => b.type === 'URL' && /\{\{1\}\}/.test(String(b.url || '')));
  return {
    name: String(t.name || ''), lang: String(t.language || 'he'), category: String(t.category || ''),
    body, params, header, buttons: ((bt && bt.buttons) || []).map(b => ({ type: b.type, text: b.text || '', url: b.url || '' })),
    button_param: urlBtnIdx >= 0 ? { index: urlBtnIdx } : null,
    supported: !named && !headerVar && !(header && header.format === 'LOCATION'),
  };
}
/* the footer/portfolio twins (<name>_f / <name>_n) are picked by sendTemplate itself — show the base name once */
export function pickTemplates(list, channel) {
  const approved = (list || []).filter(t => t && String(t.status || '').toUpperCase() === 'APPROVED' && String(t.category || '').toUpperCase() !== 'AUTHENTICATION');
  const names = new Set(approved.map(t => t.name));
  return approved
    .filter(t => !(/_(f|n)$/.test(t.name) && names.has(t.name.replace(/_(f|n)$/, ''))))
    .filter(t => templateAllowedOn(t.name, channel))
    .map(shapeTemplate)
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function loadTemplates(env, channel, d) {
  const { waba, token } = lineWaba(env, channel);
  if (!token) return { ok: false, error: 'wa-not-configured' };
  const ck = 'inboxtmpl:' + waba;
  const hit = await kvJson(env, ck);
  if (hit && Array.isArray(hit.list)) return { ok: true, list: hit.list };
  const f = d.fetch || fetch;
  const all = [];
  let url = `${GRAPH}/${waba}/message_templates?fields=name,status,category,language,components,parameter_format&limit=200`;
  for (let i = 0; i < 5 && url; i++) {
    const r = await f(url, { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    if (!j) { if (!all.length) return { ok: false, error: 'meta-unreachable' }; break; }
    all.push(...(j.data || []));
    url = (j.paging && j.paging.next) || '';
  }
  if (env.RATE) await env.RATE.put(ck, JSON.stringify({ list: all }), { expirationTtl: 600 }).catch(() => {});
  return { ok: true, list: all };
}

/* ── §5 the routes ────────────────────────────────────────────────────────── */
/* d: { okJson, deny, cors, adminKeyOk, getUser, readSession, fetch?, now?(), send?:{text,template,media} } */
export async function handleInboxCompose(request, env, origin, path, d) {
  const now = d.now ? d.now() : Date.now();
  if (path === '/api/inbox/media') return handleUpload(request, env, origin, d);
  let b = {};
  try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!b || typeof b !== 'object') return d.deny(400, 'bad-json', origin);
  if (!(await d.adminKeyOk(env, b.admin_key || request.headers.get('x-admin-key')))) return d.deny(403, 'bad-admin-key', origin);
  const phone = normPhone(b.phone || '');
  if (!phone) return d.deny(400, 'bad-phone', origin);
  const conv = await kvJson(env, 'conv:' + phone);
  const line = await resolveLine(env, phone, conv);

  if (path === '/api/inbox/state') {
    const who = await whoOf(env, request, b, d);
    return jres(d, origin, {
      ok: true, phone, line, window: windowState(conv && conv.last_in_ts, now), quiet: quietState(line.kind, now), who,
      limits: { text: TEXT_MAX, caption: CAPTION_MAX, media: Object.fromEntries(Object.entries(MEDIA_RULES).map(([k, r]) => [k, { max: r.max, mimes: r.mimes }])) },
    });
  }
  if (path === '/api/inbox/templates') {
    if (line.error) return jres(d, origin, { ok: false, error: line.error });
    const t = await loadTemplates(env, line.channel, d);
    if (!t.ok) return jres(d, origin, { ok: false, error: t.error });
    return jres(d, origin, { ok: true, channel: line.channel, templates: pickTemplates(t.list, line.channel) });
  }
  if (path === '/api/inbox/send') return handleSend(request, env, origin, d, { b, phone, conv, line, now });
  return d.deny(404, 'unknown-route', origin);
}

async function handleSend(request, env, origin, d, { b, phone, conv, line, now }) {
  if (line.error) return jres(d, origin, { ok: false, error: line.error });
  const kind = String(b.kind || 'text');
  if (!['text', 'media', 'template'].includes(kind)) return d.deny(400, 'bad-kind', origin);
  /* validate what goes out before any rule, so a bad request never needs a confirm */
  const text = String(b.text || '').trim();
  let media = null, tpl = null;
  if (kind === 'text') {
    if (!text) return d.deny(400, 'empty-text', origin);
    if (text.length > TEXT_MAX) return d.deny(400, 'text-too-long', origin);
  } else if (kind === 'media') {
    media = b.media && typeof b.media === 'object' ? b.media : null;
    if (!media || !/^\d{5,40}$/.test(String(media.id || ''))) return d.deny(400, 'bad-media', origin);
    if (!MEDIA_RULES[media.kind]) return d.deny(400, 'bad-media-kind', origin);
    if (media.phone_id && String(media.phone_id) !== String(line.phone_id)) return jres(d, origin, { ok: false, error: 'media-line-mismatch' });
    if (String(b.caption || '').length > CAPTION_MAX) return d.deny(400, 'caption-too-long', origin);
  } else {
    tpl = b.template && typeof b.template === 'object' ? b.template : null;
    if (!tpl || !/^[a-z0-9_]{1,512}$/.test(String(tpl.name || ''))) return d.deny(400, 'bad-template', origin);
    if (!templateAllowedOn(tpl.name, line.channel)) return jres(d, origin, { ok: false, error: 'wrong-channel' });
    if (tpl.params && !Array.isArray(tpl.params)) return d.deny(400, 'bad-params', origin);
  }
  const win = windowState(conv && conv.last_in_ts, now);
  if (kind !== 'template' && !win.open) return jres(d, origin, { ok: false, error: 'window-closed', window: win });
  const quiet = quietState(line.kind, now);
  if (quiet.quiet && b.confirm_quiet !== true) return jres(d, origin, { ok: false, error: 'needs-confirm', quiet });

  const who = await whoOf(env, request, b, d);
  const ctx = { who: who.name, ...(line.channel === 'guests' ? { phone_id: line.phone_id } : {}) };
  const S = d.send || { text: sendText, template: sendTemplate, media: sendMedia };
  let res;
  if (kind === 'text') res = await S.text(env, phone, text, line.channel, ctx);
  else if (kind === 'media') {
    res = await S.media(env, phone, media.kind, { id: media.id, caption: String(b.caption || '').trim(), filename: String(media.name || '') }, line.channel,
      { ...ctx, media_mime: String(media.mime || ''), media_name: String(media.name || '').slice(0, 120) });
  } else {
    const comps = [];
    const hm = tpl.header_media && typeof tpl.header_media === 'object' ? tpl.header_media : null;
    const hu = String(tpl.header_url || '');
    const hk = String((hm && hm.kind) || tpl.header_kind || 'image').toLowerCase();
    if ((hm && /^\d{5,40}$/.test(String(hm.id || ''))) || /^https:\/\//.test(hu)) {
      if (!/^(image|video|document)$/.test(hk)) return d.deny(400, 'bad-header', origin);
      comps.push({ type: 'header', parameters: [{ type: hk, [hk]: hm ? { id: String(hm.id) } : { link: hu } }] });
    }
    if (tpl.button_param && tpl.button_param.text) {
      comps.push({ type: 'button', sub_type: 'url', index: String(Number(tpl.button_param.index) || 0), parameters: [{ type: 'text', text: String(tpl.button_param.text).slice(0, 200) }] });
    }
    res = await S.template(env, phone, tpl.name, (tpl.params || []).map(String), '', String(tpl.lang || 'he'), line.channel, { ...ctx, ...(comps.length ? { components: comps } : {}) });
  }
  res = res || { ok: false, error: 'send-failed' };
  /* the line's own window is what Meta checks — our index is per person, not per line */
  if (!res.ok && /131047/.test(String(res.error || ''))) {
    await logEvent(env, { area: 'אינבוקס', action: 'הודעה ידנית לא יצאה — חלון 24 שעות סגור', ok: false, phone, detail: `${who.name} · ${kind}` }).catch(() => {});
    return jres(d, origin, { ok: false, error: 'window-closed', window: { ...win, open: false }, meta: String(res.error).slice(0, 200) });
  }
  /* a person writing in the inbox is a person taking the conversation (same as /api/wa-send) */
  if (res.ok && kind !== 'template' && line.channel === 'client' && env.RATE) {
    await env.RATE.put('human:' + phone, JSON.stringify({ at: new Date(now).toISOString(), via: 'inbox', who: who.name }), { expirationTtl: 7 * 86400 }).catch(() => {});
  }
  await logEvent(env, {
    area: 'אינבוקס', ok: !!res.ok, phone,
    action: (res.ok ? 'הודעה ידנית נשלחה' : 'הודעה ידנית נכשלה') + ` · ${({ text: 'טקסט', media: 'קובץ', template: 'תבנית' })[kind]}`,
    detail: `${who.name}${who.email ? ' (' + who.email + ')' : ''} · ${line.channel === 'guests' ? 'מספר האורחים' : '4499'}${quiet.quiet ? ' · בשעות שקט, אושר' : ''}${kind === 'template' ? ' · ' + tpl.name : ''}${res.ok ? '' : ' · ' + String(res.error || '').slice(0, 120)}`,
  }).catch(() => {});
  if (!res.ok) return jres(d, origin, { ok: false, error: String(res.error || 'send-failed').slice(0, 200), held: !!res.held });
  return jres(d, origin, { ok: true, id: res.id || '', status: 'sent', who: who.name, channel: line.channel, quiet_confirmed: quiet.quiet });
}

/* multipart upload → Meta media id on the line that will send it */
async function handleUpload(request, env, origin, d) {
  const ct = String(request.headers.get('Content-Type') || '');
  if (!ct.includes('multipart/form-data')) return d.deny(400, 'multipart-only', origin);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > WORKER_DOC_MAX + 512 * 1024) return jres(d, origin, { ok: false, error: 'too-big', he: `עד ${Math.round(WORKER_DOC_MAX / MB)}MB מהאינבוקס.` });
  let form;
  try { form = await request.formData(); } catch { return d.deny(400, 'bad-form', origin); }
  const key = request.headers.get('x-admin-key') || String(form.get('admin_key') || '');
  if (!(await d.adminKeyOk(env, key))) return d.deny(403, 'bad-admin-key', origin);
  const phone = normPhone(String(form.get('phone') || ''));
  if (!phone) return d.deny(400, 'bad-phone', origin);
  const file = form.get('file');
  if (!file || typeof file === 'string') return d.deny(400, 'no-file', origin);
  const v = validateMedia({ mime: file.type, size: file.size, name: file.name });
  if (!v.ok) return jres(d, origin, { ok: false, ...v });
  /* the upload is an outbound call post() does not see: same staging lock */
  if (isStaging(env) && !isAllowedPhone(env, phone)) return jres(d, origin, { ok: false, error: 'staging-blocked' });
  const conv = await kvJson(env, 'conv:' + phone);
  const line = await resolveLine(env, phone, conv);
  if (line.error) return jres(d, origin, { ok: false, error: line.error });
  const token = line.channel === 'guests' ? env.WA_TOKEN_GUESTS : clientToken(env);
  if (!token) return jres(d, origin, { ok: false, error: 'wa-not-configured' });
  const name = String(file.name || '').replace(/[\\/<>]/g, '').slice(0, 120) || ('file.' + (Object.keys(EXT_MIME).find(e => EXT_MIME[e] === v.mime) || 'bin'));
  const up = new FormData();
  up.append('messaging_product', 'whatsapp');
  up.append('type', v.mime);
  /* a re-typed view of the same bytes, not a second copy (the isolate has 128MB) */
  up.append('file', file.slice(0, file.size, v.mime), name);
  const f = d.fetch || fetch;
  const r = await f(`${GRAPH}/${line.phone_id}/media`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: up }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r || !r.ok || !j.id) {
    const e = (j && j.error) || {};
    await logEvent(env, { area: 'אינבוקס', action: 'העלאת קובץ למטא נכשלה', ok: false, phone, detail: `${v.kind} · ${e.code || (r ? r.status : 'unreachable')} ${String(e.message || '').slice(0, 120)}` }).catch(() => {});
    return jres(d, origin, { ok: false, error: 'upload-failed', meta: `${e.code || (r ? r.status : 'unreachable')}` });
  }
  return jres(d, origin, { ok: true, media: { id: String(j.id), kind: v.kind, mime: v.mime, name, size: file.size, phone_id: line.phone_id, channel: line.channel } });
}

export const _mask = mask;
