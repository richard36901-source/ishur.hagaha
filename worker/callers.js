/* ============================================================================
   The call centre, infrastructure only (16/11/2026, Richard: "תכין תשתית",
   dialling stays off). Who the agents are, when each one is on shift, and
   which WhatsApp conversation belongs to whom.
     · an agent is identified by her own phone (the number the recorded dial
       rings) and by her Google account (what she signs in with)
     · a shift is opened and closed by the agent herself, or by an admin for her;
       one that was never closed is cut at 12 hours so it cannot run for days
     · a conversation gets an owner; unowned ones are visible to everybody
   KV: caller:<phone>            = {name, email, active, at}
       callshift:<phone>         = {in}                       (the open shift)
       callshiftlog:<YYYY-MM>:<phone>:<inTs> = '1' + metadata {in, out, by}
       convown:<phone of the customer> = {owner (agent phone), name, at, by}
   §1 pure (unit-tested in test/callers.test.mjs) · §2 I/O
   ============================================================================ */
export const MAX_SHIFT_MS = 12 * 3600e3;
const pj = v => { try { return JSON.parse(v); } catch { return null; } };
export const ilMonth = (ts = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts)).slice(0, 7);
/* a closed shift: never negative, never longer than the cap */
export function closeShift(inTs, outTs) { const a = Number(inTs) || 0, b = Math.max(a, Math.min(Number(outTs) || a, a + MAX_SHIFT_MS)); return { in: a, out: b, ms: b - a, capped: (Number(outTs) || 0) - a > MAX_SHIFT_MS }; }
export const hoursOf = ms => Math.round((Number(ms) || 0) / 36e3) / 100;
export function monthSummary(callers, shifts, open, now = Date.now()) {
  return callers.map(c => {
    const mine = shifts.filter(s => s.phone === c.phone); const on = open[c.phone] ? Number(open[c.phone].in) || 0 : 0;
    const live = on ? Math.min(now - on, MAX_SHIFT_MS) : 0;
    return { ...c, shifts: mine.length + (on ? 1 : 0), hours: hoursOf(mine.reduce((n, s) => n + s.ms, 0) + live), on_shift: !!on, since: on || null, stale: !!on && now - on > MAX_SHIFT_MS };
  });
}
export const normEmail = v => { const e = String(v || '').trim().toLowerCase(); return /^[^@\s]{1,64}@[^@\s]{1,255}\.[a-z]{2,}$/.test(e) ? e : ''; };

/* ── §2 I/O ─────────────────────────────────────────────────────────────── */
async function listCallers(env, kvPrefix) { const kv = await kvPrefix(env, 'caller:'); return Object.entries(kv).map(([phone, v]) => ({ phone, ...(pj(v) || {}) })).filter(c => c.name).sort((a, b) => a.name.localeCompare(b.name, 'he')); }
async function clock(env, phone, on, by, now) {
  const k = 'callshift:' + phone, cur = pj(await env.RATE.get(k).catch(() => null) || 'null');
  if (on) { if (cur && now - cur.in < MAX_SHIFT_MS) return { in: cur.in, already: true }; if (cur) await logShift(env, phone, cur.in, cur.in + MAX_SHIFT_MS, 'auto'); await env.RATE.put(k, JSON.stringify({ in: now, by })); return { in: now }; }
  if (!cur) return { none: true };
  const s = closeShift(cur.in, now); await logShift(env, phone, s.in, s.out, by); await env.RATE.delete(k); return { closed: s };
}
async function logShift(env, phone, inTs, outTs, by) { await env.RATE.put(`callshiftlog:${ilMonth(inTs)}:${phone}:${inTs}`, '1', { expirationTtl: 3 * 365 * 86400, metadata: { in: inTs, out: outTs, by: String(by || '').slice(0, 60) } }); }
export async function handleCallers(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  const now = Date.now(), who = normEmail(request.headers.get('x-ishur-user') || ''), fresh = { caller: {}, open: {}, own: {}, shift: [] };
  const P = v => { const p = d.normPhone(v || ''); return /^9725\d{8}$/.test(p) ? p : ''; };
  if (b.add) { const phone = P(b.add.phone), name = String(b.add.name || '').replace(/[<>]/g, '').trim().slice(0, 40); if (!phone || name.length < 2) return d.okJson({ ok: false, error: 'bad-input' }, origin);
    const prev = pj(await env.RATE.get('caller:' + phone) || 'null'); const rec = { name, email: normEmail(b.add.email), active: b.add.active !== false, at: (prev && prev.at) || new Date().toISOString() };
    await env.RATE.put('caller:' + phone, JSON.stringify(rec)); fresh.caller[phone] = rec; }
  if (b.remove) { const phone = P(b.remove.phone); if (phone) { await env.RATE.delete('caller:' + phone); fresh.caller[phone] = null; } }
  let callers = await listCallers(env, d.kvPrefix);
  for (const [ph, v] of Object.entries(fresh.caller)) { callers = callers.filter(c => c.phone !== ph); if (v) callers.push({ phone: ph, ...v }); }
  callers.sort((a, b2) => a.name.localeCompare(b2.name, 'he'));
  const me = who ? callers.find(c => c.email && c.email === who) || null : null;
  if (b.clock) { const phone = b.clock.phone ? P(b.clock.phone) : (me && me.phone) || ''; if (!phone || !callers.some(c => c.phone === phone)) return d.okJson({ ok: false, error: 'not-a-caller' }, origin);
    const r = await clock(env, phone, !!b.clock.on, who || 'admin', now); fresh.open[phone] = b.clock.on ? { in: r.in } : null; if (r.closed) fresh.shift.push({ phone, in: r.closed.in, out: r.closed.out, ms: r.closed.ms }); }
  if (b.own) { const cust = String(b.own.phone || '').replace(/\D/g, ''); if (/^\d{9,15}$/.test(cust)) { const owner = b.own.owner === 'me' ? (me && me.phone) || '' : b.own.owner ? P(b.own.owner) : '';
    if (owner && callers.some(c => c.phone === owner)) { const rec = { owner, name: callers.find(c => c.phone === owner).name, at: new Date().toISOString(), by: who || 'admin' }; await env.RATE.put('convown:' + cust, JSON.stringify(rec), { expirationTtl: 400 * 86400 }); fresh.own[cust] = rec; }
    else if (!b.own.owner) { await env.RATE.delete('convown:' + cust); fresh.own[cust] = null; } } }
  const month = /^\d{4}-\d{2}$/.test(String(b.month || '')) ? b.month : ilMonth(now);
  const open = {}; await Promise.all(callers.map(async c => { const v = fresh.open[c.phone] !== undefined ? fresh.open[c.phone] : pj(await env.RATE.get('callshift:' + c.phone).catch(() => null) || 'null'); if (v) open[c.phone] = v; }));
  const shifts = []; const page = await env.RATE.list({ prefix: 'callshiftlog:' + month + ':', limit: 1000 }).catch(() => null);
  for (const k of (page && page.keys) || []) { const p = k.name.split(':'), m = k.metadata || {}; const s = closeShift(m.in, m.out); shifts.push({ phone: p[2], in: s.in, out: s.out, ms: s.ms }); }
  for (const s of fresh.shift) if (ilMonth(s.in) === month && !shifts.some(x => x.phone === s.phone && x.in === s.in)) shifts.push(s);
  const ownKv = await d.kvPrefix(env, 'convown:').catch(() => ({})); const owners = {}; for (const [cust, v] of Object.entries(ownKv)) { const x = pj(v); if (x) owners[cust] = { owner: x.owner, name: x.name }; }
  for (const [cust, v] of Object.entries(fresh.own)) { if (v) owners[cust] = { owner: v.owner, name: v.name }; else delete owners[cust]; }
  const counts = {}; for (const o of Object.values(owners)) counts[o.owner] = (counts[o.owner] || 0) + 1;
  return d.okJson({ ok: true, month, me: me ? { phone: me.phone, name: me.name } : null, callers: monthSummary(callers, shifts, open, now).map(c => ({ ...c, conversations: counts[c.phone] || 0 })),
    shifts: shifts.sort((a, b2) => b2.in - a.in).slice(0, 300), owners }, origin);
}
