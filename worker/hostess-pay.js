/* ============================================================================
   Hostess pay clock (16/11/2026, Richard): every hostess has a pay rule, per
   HOUR or per EVENT. A shift = one hostess on one event. Hours come from her
   attendance reports (first "הגעה", last "עזיבה") and can be corrected by hand.
   The month adds up per hostess; a shift is marked paid, and the receipt she
   gave is kept per hostess and month.
   KV: hostpay:<phone>            = {mode:'hour'|'event', rate}
       hostshift:<tok8>:<phone>   = {date, name, city, in?, out?, mode?, rate?, paid?:{at, by}}
       hostrcpt:<phone>:<YYYY-MM> = file bytes + metadata {type, name, at}
       hostday:<tok8>:<phone>:<date> = the event-day message went out
   §1 pure (unit-tested in test/hostess-pay.test.mjs) · §2 I/O
   ============================================================================ */
const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export const normHm = v => { const m = HM.exec(String(v || '').trim()); return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : ''; };
/* hours between arrival and leaving; an event that ends after midnight wraps to the next day */
export function hoursBetween(inHm, outHm) {
  const a = HM.exec(String(inHm || '')), b = HM.exec(String(outHm || '')); if (!a || !b) return 0;
  let min = (Number(b[1]) * 60 + Number(b[2])) - (Number(a[1]) * 60 + Number(a[2])); if (min < 0) min += 1440;
  return Math.round(min / 60 * 100) / 100;
}
export const normPay = p => { const mode = p && p.mode === 'hour' ? 'hour' : 'event'; const rate = Math.max(0, Math.min(100000, Math.round(Number(p && p.rate) * 100) / 100 || 0)); return { mode, rate }; };
export function shiftAmount({ mode, rate, hours }) {
  const r = Number(rate) || 0; if (!r) return 0;
  return mode === 'hour' ? Math.round((Number(hours) || 0) * r * 100) / 100 : r;
}
/* first arrival and last leaving of one hostess on one day, from her attendance reports */
export function clockFromLog(log, phone, day) {
  const mine = (log || []).filter(x => x.phone === phone && x.day === day).sort((x, y) => x.ts - y.ts);
  const arr = mine.find(x => x.kind === 'arrive'), lv = [...mine].reverse().find(x => x.kind === 'leave');
  return { in: arr ? normHm(arr.time) : '', out: lv ? normHm(lv.time) : '' };
}
/* stored = {id: record}; pay = {phone: {mode, rate}}; names = {phone: name} */
export function buildShifts({ stored = {}, pay = {}, names = {}, log = [], month = '' }) {
  const out = [];
  for (const [id, s] of Object.entries(stored)) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date || '')) || (month && !s.date.startsWith(month))) continue;
    const [tok8, phone] = id.split(':'); const auto = clockFromLog(log, phone, s.date), def = normPay(pay[phone]);
    const tin = normHm(s.in) || auto.in, tout = normHm(s.out) || auto.out;
    const mode = s.mode === 'hour' || s.mode === 'event' ? s.mode : def.mode, rate = s.rate != null && s.rate !== '' ? normPay({ rate: s.rate }).rate : def.rate;
    const hours = hoursBetween(tin, tout);
    out.push({ id, tok8, phone, name: names[phone] || '', date: s.date, event: String(s.name || ''), city: String(s.city || ''), in: tin, out: tout, in_manual: !!normHm(s.in), out_manual: !!normHm(s.out),
      hours, mode, rate, amount: shiftAmount({ mode, rate, hours }), missing: mode === 'hour' && !hours ? 'hours' : !rate ? 'rate' : '', paid: s.paid && s.paid.at ? { at: s.paid.at, by: String(s.paid.by || '') } : null });
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.name.localeCompare(y.name, 'he')));
}
export function monthTotals(shifts) {
  const by = {};
  for (const s of shifts) { const t = by[s.phone] = by[s.phone] || { phone: s.phone, name: s.name, shifts: 0, hours: 0, total: 0, paid: 0, due: 0 }; t.shifts++; t.hours = Math.round((t.hours + s.hours) * 100) / 100; t.total = Math.round((t.total + s.amount) * 100) / 100; if (s.paid) t.paid = Math.round((t.paid + s.amount) * 100) / 100; else t.due = Math.round((t.due + s.amount) * 100) / 100; }
  return Object.values(by).sort((x, y) => x.name.localeCompare(y.name, 'he'));
}
export const dayText = (name, s, arrival) => `היי ${String(name || '').split(' ')[0]}, היום האירוע של ${s.name || 'הלקוח'}${s.city ? ' ב' + s.city : ''}${arrival ? '. הגעה עד ' + arrival : ''}. בהגעה, בחופה ובעזיבה מדווחים בקישור:`;

/* ── §2 I/O ─────────────────────────────────────────────────────────────── */
const pj = v => { try { return JSON.parse(v); } catch { return null; } };
const ID_RE = /^[0-9a-f]{8}:9725\d{8}$/, REF_RE = /^9725\d{8}:\d{4}-\d{2}$/;
async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.ADMIN_KEY || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('hostrcpt:' + text)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
/* called by the assignment route: a shift exists exactly while the hostess is assigned (a paid shift is kept) */
export async function syncShift(env, { tok8, phone, on, date, name, city }) {
  const k = `hostshift:${tok8}:${phone}`; const cur = pj(await env.RATE.get(k).catch(() => null) || 'null');
  const id = `${tok8}:${phone}`;
  if (on) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return; await env.RATE.put(k, JSON.stringify({ ...(cur || {}), date, name: String(name || '').slice(0, 80), city: String(city || '').slice(0, 40) }), { expirationTtl: 3 * 365 * 86400 }); await indexShift(env, id, true); }
  else if (cur && !cur.paid) { await env.RATE.delete(k); await indexShift(env, id, false); }
}
/* KV list() lags its own writes, so the shifts are found through one index key and read one by one */
async function indexShift(env, id, on) {
  const cur = new Set(pj(await env.RATE.get('hostshiftidx').catch(() => null) || 'null') || []);
  if (on) cur.add(id); else cur.delete(id);
  await env.RATE.put('hostshiftidx', JSON.stringify([...cur].slice(-3000)));
}
async function readLog(env, days) {
  const log = [];
  for (const day of days) { const page = await env.RATE.list({ prefix: 'stafflog:' + day + ':', limit: 1000 }).catch(() => null); for (const k of (page && page.keys) || []) { const p = k.name.split(':'), m = k.metadata || {}; log.push({ day: p[1], ts: Number(p[2]), phone: p[3], kind: m.k || 'note', time: m.t || '' }); } }
  return log;
}
export async function payData(env, { month, kvPrefix, fresh = {} }) {
  const [ids, staffKv] = await Promise.all([env.RATE.get('hostshiftidx').then(v => pj(v || 'null') || []).catch(() => []), kvPrefix(env, 'staff:')]);
  const stored = {}; await Promise.all(ids.filter(id => ID_RE.test(id)).map(async id => { const x = pj(await env.RATE.get('hostshift:' + id).catch(() => null) || 'null'); if (x) stored[id] = x; }));
  const payKv = {}; await Promise.all(Object.keys(staffKv).map(async ph => { const v = await env.RATE.get('hostpay:' + ph).catch(() => null); if (v) payKv[ph] = v; }));
  for (const [id, v] of Object.entries(fresh.shift || {})) { if (v) stored[id] = v; else delete stored[id]; }   /* KV list() lags its own writes */
  const pay = {}; for (const [ph, v] of Object.entries(payKv)) pay[ph] = normPay(pj(v)); Object.assign(pay, fresh.pay || {});
  const names = {}; for (const [ph, v] of Object.entries(staffKv)) names[ph] = (pj(v) || {}).name || '';
  const days = [...new Set(Object.values(stored).map(s => s.date).filter(d => d && (!month || d.startsWith(month))))].slice(0, 62);
  const shifts = buildShifts({ stored, pay, names, log: await readLog(env, days), month });
  const receipts = {};
  for (const ph of Object.keys(names)) { const ref = ph + ':' + month; const meta = fresh.receipt && fresh.receipt[ref] !== undefined ? fresh.receipt[ref] : ((await env.RATE.getWithMetadata('hostrcpt:' + ref, { type: 'stream' }).catch(() => null)) || {}).metadata; if (meta) receipts[ph] = { name: meta.name || '', at: meta.at || '', url: `/api/hostess-receipt?ref=${encodeURIComponent(ref)}&sig=${await sign(env, ref)}` }; }
  return { ok: true, month, shifts, totals: monthTotals(shifts), pay: Object.fromEntries(Object.keys(names).map(ph => [ph, pay[ph] || normPay(null)])), receipts };
}
export async function handleHostessPay(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  const month = /^\d{4}-\d{2}$/.test(String(b.month || '')) ? b.month : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()).slice(0, 7);
  const fresh = { shift: {}, pay: {} };
  if (b.set_rate && /^9725\d{8}$/.test(String(b.set_rate.phone || ''))) { const p = normPay(b.set_rate); await env.RATE.put('hostpay:' + b.set_rate.phone, JSON.stringify(p)); fresh.pay[b.set_rate.phone] = p; }
  if (b.set_shift && ID_RE.test(String(b.set_shift.id || ''))) {
    const k = 'hostshift:' + b.set_shift.id, cur = pj(await env.RATE.get(k) || 'null');
    if (cur) { const n = { ...cur }; for (const f of ['in', 'out']) if (f in b.set_shift) { const v = normHm(b.set_shift[f]); if (v) n[f] = v; else delete n[f]; }
      if ('mode' in b.set_shift) { if (b.set_shift.mode === 'hour' || b.set_shift.mode === 'event') n.mode = b.set_shift.mode; else delete n.mode; }
      if ('rate' in b.set_shift) { if (b.set_shift.rate === '' || b.set_shift.rate == null) delete n.rate; else n.rate = normPay({ rate: b.set_shift.rate }).rate; }
      await env.RATE.put(k, JSON.stringify(n), { expirationTtl: 3 * 365 * 86400 }); fresh.shift[b.set_shift.id] = n; }
  }
  if (b.mark_paid && Array.isArray(b.mark_paid.ids)) for (const id of b.mark_paid.ids.slice(0, 60)) { if (!ID_RE.test(String(id))) continue;
    const k = 'hostshift:' + id, cur = pj(await env.RATE.get(k) || 'null'); if (!cur) continue;
    const n = { ...cur }; if (b.mark_paid.on) n.paid = { at: new Date().toISOString(), by: String(b.who || '').slice(0, 40) }; else delete n.paid;
    await env.RATE.put(k, JSON.stringify(n), { expirationTtl: 3 * 365 * 86400 }); fresh.shift[id] = n; }
  return d.okJson(await payData(env, { month, kvPrefix: d.kvPrefix, fresh }), origin);
}
/* the receipt the hostess gave: one file per hostess and month (image or PDF, up to 5 MB) */
export async function handleReceiptUpload(request, env, origin, d) {
  let form; try { form = await request.formData(); } catch { return d.deny(400, 'bad-form', origin); }
  if (!(await d.adminKeyOk(env, String(form.get('admin_key') || '')))) return d.deny(403, 'bad-admin-key', origin);
  const ref = String(form.get('ref') || ''), file = form.get('file');
  if (!REF_RE.test(ref) || !file || typeof file.arrayBuffer !== 'function') return d.okJson({ ok: false, error: 'bad-input' }, origin);
  const type = String(file.type || ''); if (!/^(image\/(jpeg|png|webp|heic)|application\/pdf)$/.test(type)) return d.okJson({ ok: false, error: 'bad-type' }, origin);
  const buf = await file.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 5 * 1024 * 1024) return d.okJson({ ok: false, error: 'too-big' }, origin);
  const meta = { type, name: String(file.name || '').replace(/[^\w.֐-׿ -]/g, '').slice(0, 60), at: new Date().toISOString() };
  await env.RATE.put('hostrcpt:' + ref, buf, { expirationTtl: 7 * 365 * 86400, metadata: meta });
  return d.okJson({ ok: true, receipt: { name: meta.name, at: meta.at, url: `/api/hostess-receipt?ref=${encodeURIComponent(ref)}&sig=${await sign(env, ref)}` } }, origin);
}
export async function handleReceiptGet(env, url) {
  const ref = url.searchParams.get('ref') || '', sig = url.searchParams.get('sig') || '';
  if (!REF_RE.test(ref) || sig !== await sign(env, ref)) return new Response('forbidden', { status: 403 });
  const hit = await env.RATE.getWithMetadata('hostrcpt:' + ref, { type: 'arrayBuffer' }).catch(() => null);
  if (!hit || !hit.value) return new Response('not found', { status: 404 });
  return new Response(hit.value, { headers: { 'Content-Type': (hit.metadata && hit.metadata.type) || 'application/octet-stream', 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
}
/* cron, from 09:00 on the event day: each assigned hostess gets today's event and her report link, once */
export async function hostessDayMessages(env, { now = Date.now(), kvPrefix, send, slack, arrivalOf } = {}) {
  const out = { sent: 0, failed: 0 }; if (!env.RATE || !kvPrefix || !send) return out;
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(now))) % 24; if (hour < 9 || hour >= 21) return out;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(now));
  const ids = pj(await env.RATE.get('hostshiftidx').catch(() => null) || 'null') || [];
  for (const id of ids) {
    if (!ID_RE.test(id)) continue; const s = pj(await env.RATE.get('hostshift:' + id).catch(() => null) || 'null'); if (!s || s.date !== today) continue; const [tok8, phone] = id.split(':'); const mk = `hostday:${tok8}:${phone}:${today}`;
    if (await env.RATE.get(mk).catch(() => '1')) continue;
    const st = pj(await env.RATE.get('staff:' + phone).catch(() => null) || 'null'); if (!st || !st.sid) continue;
    await env.RATE.put(mk, new Date(now).toISOString(), { expirationTtl: 14 * 86400 });
    let reception = ''; try { const bk = await kvPrefix(env, 'hostessbook:' + tok8); const first = Object.values(bk)[0]; reception = (pj(first || 'null') || {}).reception || ''; } catch {}
    const r = await send(phone, st, dayText(st.name, s, arrivalOf ? arrivalOf(reception) : '')).catch(e => ({ ok: false, error: String(e && e.message || e) }));
    if (r && r.ok) out.sent++; else { out.failed++; if (slack) await slack(`📌 *דיילות: הודעת יום האירוע לא נשלחה*\n\n• ${st.name}\n• ${s.name || ''}\n\nמה לעשות: לשלוח לה ידנית את קישור הדיווח\n${(r && r.wa) || ''}`, { important: true, oneoff: true, urgent: true }).catch(() => {}); }
  }
  return out;
}
