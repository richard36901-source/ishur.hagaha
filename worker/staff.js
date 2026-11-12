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
  return `${what} ✓ ${p.time || hm}${evName ? ' · ' + evName : ''}${p.kind === 'note' ? '\nאפשר לכתוב: הגעתי / חופה / עזבתי (ואפשר להוסיף שעה).' : ''}`;
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

export async function handleStaff(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  if (b.act === 'add') {
    const phone = d.normPhone(b.phone || ''), name = String(b.name || '').trim().slice(0, 40);
    if (!/^9725\d{8}$/.test(phone) || name.length < 2) return d.okJson({ ok: false, error: 'bad-input' }, origin);
    await env.RATE.put('staff:' + phone, JSON.stringify({ name, role: 'hostess', at: new Date().toISOString() }));
  } else if (b.act === 'remove') {
    const phone = d.normPhone(b.phone || ''); if (phone) await env.RATE.delete('staff:' + phone);
  }
  const staff = [];
  for (const k of (await env.RATE.list({ prefix: 'staff:', limit: 200 })).keys || []) { const s = await kvJson(env, k.name); if (s) staff.push({ phone: k.name.slice(6), ...s }); }
  const log = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const page = await env.RATE.list({ prefix: 'stafflog:', cursor, limit: 1000 }).catch(() => null); if (!page) break;
    for (const k of page.keys) { const p = k.name.split(':'); const m = k.metadata || {}; log.push({ day: p[1], ts: Number(p[2]), phone: p[3], name: m.n || '', kind: m.k || 'note', kind_he: KIND_HE[m.k] || '', time: m.t || '', received: m.at || '', text: m.x || '', token: m.tok || '', event: m.ev || '' }); }
    if (page.list_complete) break; cursor = page.cursor;
  }
  log.sort((a, c) => c.ts - a.ts);
  return d.okJson({ ok: true, staff, log: log.slice(0, 500) }, origin);
}
