/* ============================================================================
   ishur.io · parked-payments.js · a payment that arrived without the payer's phone
   (22/11/2026: a ₪50 Google Pay purchase sat unprocessed: Grow sends no phone
   for Google Pay, so no event was opened, no invoice, no monday update, and the
   alert went to the notifications center only)
   ----------------------------------------------------------------------------
   The payment is kept in ipnwait:<ref> exactly as Grow sent it. Once the phone
   is known (the record gets a `phone`), the next ten-minute run puts it through
   the same path every payment takes, as a real payment: event, invoice, monday,
   the buyer's message. Nothing here invents a phone: until one is set, the
   payment waits and Slack says so.
   ========================================================================== */
export const PARK_PREFIX = 'ipnwait:';
export const PARK_TTL = 30 * 86400;
const normPhone = p => { const d = String(p || '').replace(/\D/g, ''); return d.startsWith('972') ? d : d.startsWith('0') ? '972' + d.slice(1) : d; };

export async function parkPayment(env, ref, flat, now = Date.now()) {
  if (!env || !env.RATE || !ref) return false;
  try {
    if (await env.RATE.get(PARK_PREFIX + ref)) return true;   /* Grow repeats a notice: the first copy stays */
    await env.RATE.put(PARK_PREFIX + ref, JSON.stringify({ flat, at: new Date(now).toISOString() }), { expirationTtl: PARK_TTL });
    return true;
  } catch { return false; }
}

/* run every parked payment whose phone is now known. process(flat) is the worker's own processGrowPayment. */
export async function drainParked(env, process, { log = async () => {} } = {}) {
  const out = { waiting: 0, done: 0, failed: 0 };
  if (!env || !env.RATE) return out;
  const page = await env.RATE.list({ prefix: PARK_PREFIX, limit: 100 }).catch(() => null);
  for (const k of (page && page.keys) || []) {
    let rec = null; try { rec = JSON.parse(await env.RATE.get(k.name)); } catch {}
    const phone = rec && normPhone(rec.phone);
    if (!rec || !rec.flat || !/^9725\d{8}$/.test(phone || '')) { out.waiting++; continue; }
    const ref = k.name.slice(PARK_PREFIX.length);
    try {
      const res = await process({ ...rec.flat, payerPhone: phone });
      const text = res && res.text ? await res.text().catch(() => '') : '';
      if (res && res.status === 200 && !/^accepted-incomplete/.test(text)) {
        await env.RATE.delete(k.name).catch(() => {});
        out.done++; await log({ ok: true, ref, phone, text });
      } else { out.failed++; await log({ ok: false, ref, phone, text: text || String(res && res.status) }); }
    } catch (e) { out.failed++; await log({ ok: false, ref, phone, text: String(e && e.message).slice(0, 200) }); }
  }
  return out;
}
