/* ══ חיוג ממאנדיי עם הקלטה · dial.js (02/11, noa-chase R7) ═══════════════════
   GET /api/dial?item=<monday item id>&who=shalev|richard&k=<hmac>   (alias: /dial)

   One click in the leads board rings the REP first (שלו: SHALEV_PHONE, then
   SHALEV_PHONE_2 if the first does not pick up; ריצארד: RICHARD_PHONE). A
   tiny Retell "bridge" agent (DIAL_BRIDGE_AGENT, see setup-dial.mjs) answers
   that call, says one sentence — "מחברת אותך ל<שם>, השיחה מוקלטת לשיפור
   השירות" — and immediately transfer_call's to the lead (warm transfer). The
   lead sees our telephony number (NOA_FROM, 055-507-7733). No AI talks to
   the lead; the recording and transcript land like every other call
   (audit.keepCall on call_analyzed), tagged agent 'שלו' / 'ריצארד'.

   Guarded twice:
     · k must equal HMAC-SHA256(`${item}|${who}`, env.ADMIN_KEY), first 16 hex
       (dialLinkFor() makes it; the Monday link column holds the URL)
     · env.DIAL_ENABLED must be exactly 'on' — default off renders a Hebrew
       "not switched on yet" page and touches nothing

   Second-number fallback: the rep call's call_ended webhook must reach
   dialOnEnded(env, call) (other agent's hook); on dial_no_answer / dial_busy
   with a `next` number stored under dialtry:<call_id>, it places the same
   call to that number. Nothing here runs on a timer.
   ═══════════════════════════════════════════════════════════════════════════ */

import { normPhone, safeEqual } from './lib.js';
import { stream } from './evlog.js';
import { logRow, ilTime } from './sheetlogs.js';
import { mondayGql } from './monday.js';

const PHONE_COL = 'phone_mm7g3mjv';           /* monday.js FIXED['טלפון'] */
const WHO_HE = { shalev: 'שלו', richard: 'ריצארד' };
const BASE = 'https://go.ishur.io';

/* ── signature ──────────────────────────────────────────────────────────── */
export async function dialSig(env, item, who) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.ADMIN_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${item}|${who}`));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
/* The URL for the Monday link column. How to add it (once, by hand or via
   create_column): board 18432553641 → column "📞 התקשר" of type `link`;
   the pacer (noa.js, R1) writes { url: dialLinkFor(env, item, 'shalev'),
   text: '📞 שלו' } into it for every item it touches, with
   change_column_value(column_id, value: JSON.stringify({url, text})).
   A second column "📞 ריצארד" takes who='richard'. */
export async function dialLinkFor(env, item, who) {
  const w = who === 'richard' ? 'richard' : 'shalev';
  const k = await dialSig(env, String(item), w);
  return `${BASE}/api/dial?item=${encodeURIComponent(String(item))}&who=${w}&k=${k}`;
}

/* ── pages (result first, two lines, Hebrew) ────────────────────────────── */
function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ishur.io</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Heebo,system-ui,sans-serif;background:#FAF8F1;color:#1B2420}main{max-width:420px;padding:2rem 1.4rem;text-align:center}h1{font-size:1.3rem;margin:0 0 .5rem;color:#0F2E22}p{margin:.3rem 0;color:#4A554E;font-size:.95rem}small{color:#7A847C}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

/* ── the lead's phone from Monday ───────────────────────────────────────── */
async function leadFromMonday(env, item) {
  const d = await mondayGql(env, `query($i:[ID!]){ items(ids:$i){ id name column_values(ids:["${PHONE_COL}"]){ id text value } } }`, { i: [String(item)] });
  const it = d && d.items && d.items[0];
  if (!it) return null;
  const cv = (it.column_values || [])[0] || {};
  let raw = String(cv.text || '');
  if (!raw && cv.value) { try { raw = String((JSON.parse(cv.value) || {}).phone || ''); } catch {} }
  const phone = normPhone(raw);
  return { id: String(it.id), name: String(it.name || '').trim(), phone };
}

/* ── placing the rep call ───────────────────────────────────────────────── */
function repNumbers(env, who) {
  if (who === 'richard') return [env.RICHARD_PHONE].filter(Boolean);
  return [env.SHALEV_PHONE, env.SHALEV_PHONE_2].filter(Boolean);
}
function e164(p) { const n = normPhone(p); return n ? '+' + n : ''; }
async function placeRepCall(env, { who, item, lead, repNumber, next }) {
  const payload = {
    from_number: env.NOA_FROM || '+972555077733',
    to_number: e164(repNumber),
    override_agent_id: env.DIAL_BRIDGE_AGENT,
    metadata: { kind: 'dial', who, item: String(item), phone: lead.phone, lead_name: lead.name, agent: WHO_HE[who] },
    retell_llm_dynamic_variables: {
      rep_name: WHO_HE[who],
      lead_name: lead.name || 'הליד',
      lead_phone: e164(lead.phone),
      lead_phone_spoken: lead.phone.replace(/^972/, '0'),
    },
  };
  const r = await fetch('https://api.retellai.com/v2/create-phone-call', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  const ok = !!(r && (r.status === 200 || r.status === 201) && j.call_id);
  const cid = String(j.call_id || '');
  if (ok && next && env.RATE) await env.RATE.put('dialtry:' + cid, JSON.stringify({ who, item: String(item), lead, next }), { expirationTtl: 1800 }).catch(() => {});
  await logRow(env, 'calls', { agent: WHO_HE[who], dir: 'יוצאת (ממאנדיי)', phone: lead.phone, name: lead.name, kind: 'ליד — חיוג מוקלט', status: ok ? 'מצלצל לנציג ' + ilTime() : 'נכשל', id: cid }).catch(() => {});
  stream(env, { kind: 'call', area: WHO_HE[who], action: `📞 ${WHO_HE[who]} ← מאנדיי · ${lead.name || lead.phone.replace(/^972/, '0')} · ${ok ? 'מצלצל לנציג' : 'החיוג נכשל'}`, ok, phone: lead.phone,
    detail: ok ? `rep=${repNumber.replace(/^\+?972/, '0')}${next ? ' · גיבוי=' + String(next).replace(/^\+?972/, '0') : ''}` : String(j.message || j.error || (r && r.status) || 'no-response').slice(0, 300),
    data: { call_id: cid, agent: WHO_HE[who], who, item: String(item), lead_name: lead.name, kind: 'dial', rep_number: repNumber, next: next || '' } }).catch(() => {});
  return { ok, call_id: cid, status: r && r.status, body: j };
}

/* call_ended for a rep call that nobody picked up → the second number */
export async function dialOnEnded(env, call) {
  try {
    if (!env || !env.RATE || !call || !call.call_id) return null;
    const meta = call.metadata || {};
    if (meta.kind !== 'dial') return null;
    const raw = await env.RATE.get('dialtry:' + call.call_id);
    if (!raw) return null;
    await env.RATE.delete('dialtry:' + call.call_id).catch(() => {});
    if (!/dial_no_answer|dial_busy|dial_failed|voicemail/.test(String(call.disconnection_reason || ''))) return null;
    const t = JSON.parse(raw);
    if (!t.next) return null;
    return placeRepCall(env, { who: t.who, item: t.item, lead: t.lead, repNumber: t.next, next: '' });
  } catch { return null; }
}

/* ── GET /dial ──────────────────────────────────────────────────────────── */
export async function handleDial(request, env, url) {
  const item = String(url.searchParams.get('item') || '').trim();
  const who = String(url.searchParams.get('who') || '').trim();
  const k = String(url.searchParams.get('k') || '').trim();
  if (!/^\d{5,20}$/.test(item) || !WHO_HE[who] || !/^[0-9a-f]{16}$/.test(k)) return page('הקישור לא תקין', '<p>חסר פרט בקישור. לפתוח מחדש מלוח הלידים.</p>', 400);
  if (!env.ADMIN_KEY || !safeEqual(k, await dialSig(env, item, who))) return page('הקישור לא תקין', '<p>החתימה לא תואמת. לפתוח מחדש מלוח הלידים.</p>', 403);
  if (env.DIAL_ENABLED !== 'on') return page('החיוג המוקלט עדיין לא הופעל', '<p>בינתיים מחייגים רגיל מהטלפון.</p><p><small>כשיופעל: לחיצה כאן תצלצל אליך ואז לליד, והשיחה תוקלט.</small></p>', 503);
  if (!env.RETELL_KEY || !env.DIAL_BRIDGE_AGENT || !env.MONDAY_API_TOKEN) return page('החיוג לא מוגדר עד הסוף', '<p>חסר מפתח או סוכן גשר. ריצארד יודע.</p>', 503);
  const nums = repNumbers(env, who);
  if (!nums.length) return page('אין מספר לנציג', `<p>המספר של ${esc(WHO_HE[who])} לא מוגדר במערכת.</p>`, 503);

  let lead = null;
  try { lead = await leadFromMonday(env, item); } catch (e) { return page('מאנדיי לא ענה', `<p>לנסות שוב בעוד רגע.</p><p><small>${esc(String(e && e.message).slice(0, 120))}</small></p>`, 502); }
  if (!lead) return page('הליד לא נמצא', '<p>הפריט לא קיים בלוח.</p>', 404);
  if (!lead.phone || !/^9725\d{8}$/.test(lead.phone)) return page('אין מספר נייד תקין בליד', `<p>${esc(lead.name)}: ${esc(lead.phone || 'ריק')}</p>`, 422);
  if (env.RATE && ((await env.RATE.get('nocall:' + lead.phone).catch(() => null)) || (await env.RATE.get('block:' + lead.phone).catch(() => null)))) return page('הליד ביקש לא להתקשר', `<p>${esc(lead.name)} חסום לשיחות.</p>`, 423);

  const r = await placeRepCall(env, { who, item, lead, repNumber: nums[0], next: nums[1] || '' });
  if (!r.ok) return page('החיוג לא יצא', '<p>לנסות שוב, או לחייג רגיל.</p>', 502);
  return page('מצלצל אליך עכשיו…', `<p>תעני, ואז ${esc(lead.name || 'הליד')} מצלצל. השיחה מוקלטת.</p><p><small>${nums[1] ? 'לא ענית? מצלצל למספר השני.' : ''}</small></p>`);
}
