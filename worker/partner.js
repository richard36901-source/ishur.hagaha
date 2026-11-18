/* ============================================================================
   ishur.io · partner.js · שגרירים (Richard 12/11/2026)
   ----------------------------------------------------------------------------
   A partner is someone WITHOUT an event who shares our link. Richard creates
   them; each gets a private board (partner.html?p=<pid>) and TWO fixed links:
     · discount   — friends get 20% off the package
     · commission — the partner earns 20% of the friend's package
   The mode lives in the code itself (ref:<code>.mode, locked), so a link that
   was published as "20% off" can never be turned into a commission link.
   The partner types first + last name once; it is saved and cannot be changed.

   KV: partner:<pid> = {pid, label, name, codes:{discount, commission}, at, name_at}
       ref:<code>    = {code, token:'', phone:'', name, mode, locked:true, partner:<pid>}
       refhits:<code> = {n, days:{YYYY-MM-DD:n}}   (index.js counts, one per visitor per day)
   Earnings are read from the records (refrec:<code>:*), never from a phone ledger.
   ========================================================================== */
export const PID_RE = /^[0-9a-f]{24}$/;
export const SITE = 'https://ishur.io';
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const linkOf = code => `${SITE}/?ref=${code}`;
export const boardOf = pid => `${SITE}/partner.html?p=${pid}`;

export const KINDS = ['person', 'venue'];
export function newPartner({ label = '', phone = '', kind = 'person', at = new Date().toISOString(), rnd = hex } = {}) {
  let a = rnd(4), b = rnd(4);
  while (b === a) b = rnd(4);
  return { pid: rnd(12), label: String(label || '').trim().slice(0, 60), name: '', phone: String(phone || ''), kind: KINDS.includes(kind) ? kind : 'person', codes: { discount: a, commission: b }, at };
}
export function refsOf(p) {
  const name = p.name || p.label || '';
  return ['discount', 'commission'].map(mode => ({ code: p.codes[mode], token: '', phone: '', name, mode, at: p.at, locked: true, partner: p.pid }));
}
/* first + last name, once */
export function setName(p, first, last, at = new Date().toISOString()) {
  if (p.name) return { ok: false, error: 'name-locked' };
  const clean = s => String(s || '').replace(/[<>"'`\\‎‏]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const f = clean(first), l = clean(last);
  if (f.length < 2 || l.length < 2) return { ok: false, error: 'bad-name' };
  return { ok: true, partner: { ...p, name: `${f} ${l}`, name_at: at } };
}
/* one link's numbers */
export function linkStats(mode, code, recs = [], hits = null) {
  const ver = recs.filter(r => r.status === 'verified'), pend = recs.filter(r => r.status === 'pending');
  return { mode, code, link: linkOf(code), visits: (hits && Number(hits.n)) || 0, closed: recs.length, verified: ver.length, pending: pend.length,
    saved: recs.reduce((s, r) => s + (r.discount_given || 0), 0),
    earned: ver.reduce((s, r) => s + (r.credit || 0), 0), earned_pending: pend.reduce((s, r) => s + (r.credit || 0), 0),
    paid_total: recs.reduce((s, r) => s + (r.sum_total || 0), 0) };
}
export function hitAdd(h, day) {
  const o = h && typeof h === 'object' ? h : { n: 0, days: {} };
  const days = { ...(o.days || {}) }; days[day] = (days[day] || 0) + 1;
  const keep = Object.keys(days).sort().slice(-60);
  return { n: (Number(o.n) || 0) + 1, days: Object.fromEntries(keep.map(k => [k, days[k]])) };
}

const kvJson = async (env, k) => { try { return JSON.parse(await env.RATE.get(k) || 'null'); } catch { return null; } };
/* who exactly came through: full for the admin, first name only for the partner's own board */
export function friendRows(recs, mode, full) {
  return recs.map(r => ({ mode, at: r.at, status: r.status, name: full ? (r.friend_name || '') : String(r.friend_name || '').trim().split(/\s+/)[0] || 'חבר', ...(full ? { phone: r.friend_phone || '', token: r.friend_token || '', id: r.id } : {}),
    paid: r.sum_total || 0, saved: r.discount_given || 0, credit: r.credit || 0 }));
}
export async function partnerView(env, p, d, full = false) {
  const links = [], friends = [];
  for (const mode of ['discount', 'commission']) {
    const code = p.codes[mode]; const recs = await d.refRecordsOf(env, code);
    links.push(linkStats(mode, code, recs, await kvJson(env, 'refhits:' + code)));
    friends.push(...friendRows(recs, mode, full));
  }
  friends.sort((a, c) => String(c.at).localeCompare(String(a.at)));
  return { pid: p.pid, label: p.label, name: p.name, kind: p.kind || 'person', ...(full ? { phone: p.phone || '' } : {}), at: p.at, board: boardOf(p.pid), links, friends };
}

export async function handlePartner(request, env, origin, url, d) {
  const path = url.pathname.replace(/^\/api\/partner\//, '');
  if (request.method !== 'POST') return d.deny(404, 'unknown-partner-route', origin);
  if (!env.RATE) return d.deny(503, 'kv-not-bound', origin);
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (path === 'create' || path === 'list' || path === 'update') {
    if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
    if (path === 'update') {
      const pid0 = String(b.p || '').toLowerCase(); const cur = PID_RE.test(pid0) ? await kvJson(env, 'partner:' + pid0) : null;
      if (!cur) return d.deny(404, 'unknown-partner', origin);
      const ph = d.normPhone ? d.normPhone(b.phone || '') : '';
      const next = { ...cur, ...(b.phone !== undefined ? { phone: /^972\d{8,9}$/.test(ph) ? ph : '' } : {}), ...(KINDS.includes(b.kind) ? { kind: b.kind } : {}), ...(typeof b.label === 'string' && b.label.trim().length > 1 ? { label: b.label.trim().slice(0, 60) } : {}) };
      await env.RATE.put('partner:' + pid0, JSON.stringify(next), { expirationTtl: d.REF_TTL });
      return d.okJson({ ok: true, partner: await partnerView(env, next, d, true) }, origin);
    }
    if (path === 'create') {
      const ph = d.normPhone ? d.normPhone(b.phone || '') : '';
      const p = newPartner({ label: b.label, phone: /^972\d{8,9}$/.test(ph) ? ph : '', kind: b.kind });
      if (!p.label) return d.deny(400, 'label-required', origin);
      for (const r of refsOf(p)) { if (await env.RATE.get('ref:' + r.code)) return d.deny(409, 'code-collision', origin); }
      await env.RATE.put('partner:' + p.pid, JSON.stringify(p), { expirationTtl: d.REF_TTL });
      for (const r of refsOf(p)) await env.RATE.put('ref:' + r.code, JSON.stringify(r), { expirationTtl: d.REF_TTL });
      await d.logEvent(env, { area: 'הפניות', action: `שגריר חדש: ${p.label}`, ok: true, detail: `${p.codes.discount} (הנחה) · ${p.codes.commission} (עמלה)` }).catch(() => {});
      return d.okJson({ ok: true, partner: await partnerView(env, p, d, true) }, origin);
    }
    const out = [];
    for (const k of (await env.RATE.list({ prefix: 'partner:', limit: 500 }).catch(() => ({ keys: [] }))).keys || []) {
      const p = await kvJson(env, k.name); if (p && p.codes) out.push(await partnerView(env, p, d, true));
    }
    out.sort((a, c) => String(a.at).localeCompare(String(c.at)));
    return d.okJson({ ok: true, partners: out }, origin);
  }

  const pid = String(b.p || '').toLowerCase();
  if (!PID_RE.test(pid)) return d.deny(403, 'bad-partner', origin);
  if (await d.overBudget(env, 'rl:partner:' + ip, 240, 3600)) return d.deny(429, 'rate-limited', origin);
  const p = await kvJson(env, 'partner:' + pid);
  if (!p || !p.codes) return d.deny(403, 'bad-partner', origin);

  if (path === 'me') return d.okJson({ ok: true, partner: await partnerView(env, p, d) }, origin);
  if (path === 'name') {
    const r = setName(p, b.first, b.last);
    if (!r.ok) return d.okJson({ ok: false, error: r.error }, origin);
    await env.RATE.put('partner:' + pid, JSON.stringify(r.partner), { expirationTtl: d.REF_TTL });
    for (const ref of refsOf(r.partner)) await env.RATE.put('ref:' + ref.code, JSON.stringify(ref), { expirationTtl: d.REF_TTL });
    await d.logEvent(env, { area: 'הפניות', action: `שגריר הזין שם: ${r.partner.name}`, ok: true, detail: p.label }).catch(() => {});
    return d.okJson({ ok: true, partner: await partnerView(env, r.partner, d) }, origin);
  }
  return d.deny(404, 'unknown-partner-route', origin);
}
