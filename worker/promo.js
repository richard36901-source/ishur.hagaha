/* ============================================================================
   ishur.io · promo vouchers
   ----------------------------------------------------------------------------
   A promo is a cheaper price for a closed audience. Two rules make it safe:

     1. The discounted Grow link is NEVER in the repo. ishur.io is a public
        GitHub repo, so a link sitting in config.js is a link anyone can find
        and pay 49 with. It lives in KV and the Worker hands it out only after
        a code checks out.
     2. Every redemption burns a code and every campaign has a hard cap. A code
        that has been through checkout does not work for the next person, so a
        link forwarded out of the group buys nothing.

   Flow:
     /promo/check?code=X   read-only. The site asks before showing 49 instead
                           of 299, so nobody is ever shown a price we will not
                           charge them.
     /promo/go?code=X      places a hold and 302s to Grow. The hold expires on
                           its own, so an abandoned checkout gives the slot
                           back instead of eating it.
     grow IPN              the payment confirms the burn: hold -> used.

   How the cap is really enforced — this was got wrong once, so it is written
   down. The first version counted live holds with KV list(). KV list is
   eventually consistent: a hold written a second ago is not in the listing
   yet, so ten people opening the link at once all read "0 taken" and all got
   in. Verified against the deployed Worker, not theorised.

   So the cap is STRUCTURAL: a campaign mints exactly `cap` codes and each code
   works once. Ten seats means ten codes. There is no counter to race on and no
   listing to lag. The counters below exist to display "3 left" and to stop a
   campaign whose confirmed sales already reached the cap; they are never the
   only thing standing between a stranger and the discount.
   ========================================================================== */

/* no O/0/I/1/L — these get read aloud in a WhatsApp group and typed by hand */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HOLD_TTL   = 2 * 3600;          // a checkout nobody finished
const CLAIM_TTL  = 4 * 3600;          // phone -> code, read back by the IPN
const MAX_CAP    = 500;
const MAX_BATCH  = 200;

const kCampaign = c => 'promoc:' + c;
const kVoucher  = v => 'promov:' + v;
const kHold     = (c, v) => 'promoh:' + c + ':' + v;
const kCount    = c => 'promon:' + c;
const kClaim    = p => 'promoph:' + p;

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    if (i === 3) out += '-';
  }
  return out;
}

/* Codes are typed by people. "ishur-7k3m", "7K3M", stray spaces — all the same
   code. Normalising here means the group can paste it however they like. */
export function normCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 8) return '';
  return s.slice(0, 4) + '-' + s.slice(4);
}

async function getJson(env, key) {
  if (!env.RATE) return null;
  const raw = await env.RATE.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* Display only. KV list lags behind writes by up to a minute, so this number
   is a good-faith estimate of who is mid-checkout and must never gate a sale —
   see the note at the top of the file. */
async function holdCount(env, campaign) {
  if (!env.RATE) return 0;
  let total = 0, cursor;
  do {
    const page = await env.RATE.list({ prefix: 'promoh:' + campaign + ':', cursor });
    total += page.keys.length;
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return total;
}

async function usedCount(env, campaign) {
  if (!env.RATE) return 0;
  return parseInt(await env.RATE.get(kCount(campaign)) || '0', 10) || 0;
}

/* What a campaign looks like from outside: never the Grow link, and never the
   campaign's admin label either. `label` is how we file a campaign — "מבצע
   בעלי עסקים", "בדיקת קצה לקצה" — and a test name reached a customer's screen
   through it once. Not sending it at all is cheaper than remembering not to
   render it. Admin responses still carry it. */
function publicView(camp, left) {
  return {
    campaign: camp.campaign,
    price: camp.price,
    plan: camp.plan || 'basic',
    maxTier: camp.maxTier || null,
    greeting: camp.greeting || '',
    beta: !!camp.beta,
    left,
  };
}

/* ── the read-only check the site calls before it shows a discounted price ── */
export async function promoCheck(env, code) {
  const v = normCode(code);
  if (!v) return { ok: false, reason: 'bad-code' };
  if (!env.RATE) return { ok: false, reason: 'unavailable' };

  const voucher = await getJson(env, kVoucher(v));
  if (!voucher) return { ok: false, reason: 'bad-code' };
  if (voucher.st === 'used') return { ok: false, reason: 'used' };

  const camp = await getJson(env, kCampaign(voucher.c));
  if (!camp) return { ok: false, reason: 'bad-code' };
  if (!camp.active) return { ok: false, reason: 'closed' };
  if (!camp.link) return { ok: false, reason: 'closed' };

  /* The real gate is that this code has not been spent — checked above. This
     is the second line: once confirmed sales reach the cap the campaign is
     over, whatever codes are still floating around. A direct get, never a
     list, because get-after-put actually reflects the write. */
  const used = await usedCount(env, camp.campaign);
  if (used >= camp.cap) return { ok: false, reason: 'sold-out' };

  return { ok: true, ...publicView(camp, camp.cap - used) };
}

/* ── the buy button: hold a seat, then hand over the real link ───────────── */
export async function promoGo(env, code, phone) {
  const res = await promoCheck(env, code);
  if (!res.ok) return res;

  const v = normCode(code);
  const camp = await getJson(env, kCampaign(res.campaign));
  if (!camp || !camp.link) return { ok: false, reason: 'closed' };

  const p = String(phone || '').replace(/\D/g, '');
  const p9 = p.length >= 9 ? p.slice(-9) : '';
  /* The route refuses a phoneless request before we get here, so p9 is real.
     The first version accepted anonymous holds as the sentinel '1' — and the
     review proved that one stripped query param then handed the same code to
     unlimited callers, with the sentinel also disarming the check for
     everyone after (finding #6). No phone, no hold, no link. */
  if (!p9) return { ok: false, reason: 'phone-required' };
  const holder = await env.RATE.get(kHold(camp.campaign, v));
  if (holder && holder !== p9) {
    return { ok: false, reason: 'in-use' };
  }
  await env.RATE.put(kHold(camp.campaign, v), p9, { expirationTtl: HOLD_TTL });
  /* the IPN arrives knowing a phone and a sum, nothing else. This is the only
     thread back to which code paid, so it is worth writing even when the phone
     is a guess from the lead form. */
  if (p9) await env.RATE.put(kClaim(p9), v, { expirationTtl: CLAIM_TTL });
  return { ok: true, link: camp.link, campaign: camp.campaign, price: camp.price };
}

/* ── payment confirms it. Called from processGrowPayment, never fatal ────── */
export async function promoBurn(env, phone, explicitCode) {
  if (!env.RATE) return null;
  let v = normCode(explicitCode);
  if (!v) {
    const p = String(phone || '').replace(/\D/g, '').slice(-9);
    if (p.length < 9) return null;
    v = normCode(await env.RATE.get(kClaim(p)) || '');
  }
  if (!v) return null;

  const voucher = await getJson(env, kVoucher(v));
  if (!voucher) return null;
  if (voucher.st === 'used') return { campaign: voucher.c, already: true };

  const camp = await getJson(env, kCampaign(voucher.c));

  await env.RATE.put(kVoucher(v), JSON.stringify({
    ...voucher, st: 'used', ph: String(phone || ''), used_at: new Date().toISOString(),
  }));
  await env.RATE.delete(kHold(voucher.c, v));
  const n = await usedCount(env, voucher.c);
  await env.RATE.put(kCount(voucher.c), String(n + 1));

  /* a pilot buyer owes us feedback and a testimonial after their event.
     This is the flag the post-event stage looks for. */
  const p9 = String(phone || '').replace(/\D/g, '').slice(-9);
  if (p9.length === 9 && camp && camp.beta) {
    await env.RATE.put('pilot:' + p9, voucher.c, { expirationTtl: 400 * 86400 });
  }
  if (p9.length === 9) await env.RATE.delete(kClaim(p9));

  return {
    campaign: voucher.c,
    code: v,
    label: (camp && camp.label) || voucher.c,
    beta: !!(camp && camp.beta),
    /* the entitlement the promo bought, which is not what the payment amount
       says: a 50-shekel pilot seat is a 300-guest event, and the upload cap
       has to know that or it blocks the customer at row 51 */
    plan: (camp && camp.plan) || 'basic',
    maxTier: (camp && camp.maxTier) || null,
    left: camp ? camp.cap - (n + 1) : null,
  };
}

/* ── admin ───────────────────────────────────────────────────────────────── */
export async function promoAdmin(env, body) {
  if (!env.RATE) return { ok: false, error: 'no-kv' };
  const action = String(body.action || 'status');
  const campaign = String(body.campaign || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

  if (action === 'list') {
    const page = await env.RATE.list({ prefix: 'promoc:' });
    const out = [];
    for (const k of page.keys) {
      const c = await getJson(env, k.name);
      if (!c) continue;
      const used = await usedCount(env, c.campaign);
      const holds = await holdCount(env, c.campaign);
      out.push({
        campaign: c.campaign, label: c.label, price: c.price, plan: c.plan,
        maxTier: c.maxTier, cap: c.cap, used, holds, left: c.cap - used - holds,
        active: !!c.active, beta: !!c.beta, hasLink: !!c.link,
      });
    }
    return { ok: true, campaigns: out };
  }

  if (!campaign) return { ok: false, error: 'campaign-required' };

  if (action === 'create') {
    const cap = Math.min(MAX_CAP, Math.max(1, parseInt(body.cap, 10) || 10));
    const price = parseInt(body.price, 10);
    if (!(price > 0)) return { ok: false, error: 'price-required' };
    const link = String(body.link || '').trim();
    if (link && !/^https:\/\/[a-z0-9.-]*grow\.link\//i.test(link)) {
      return { ok: false, error: 'link-must-be-a-grow-link' };
    }
    const existing = await getJson(env, kCampaign(campaign));
    if (existing && !body.overwrite) return { ok: false, error: 'exists' };

    const camp = {
      campaign, cap, price,
      label: String(body.label || campaign),
      plan: String(body.plan || 'basic'),
      maxTier: parseInt(body.maxTier, 10) || null,
      greeting: String(body.greeting || ''),
      beta: !!body.beta,
      link,
      /* a campaign with no link cannot be sold, so it starts closed and the
         first thing that opens it is pasting the link Shalev created */
      active: !!link && body.active !== false,
      created: new Date().toISOString(),
    };
    await env.RATE.put(kCampaign(campaign), JSON.stringify(camp));
    if (!existing) await env.RATE.put(kCount(campaign), '0');

    /* codes ARE the cap. Ten seats means ten codes, because that is the only
       count that cannot be raced. Asking for a different number is allowed but
       has to be deliberate. */
    /* never more codes than seats — the code list is the cap.
       `|| cap` would turn an explicit codes:0 into a full batch, which is how
       an overwrite of a live campaign silently doubled its codes once. */
    const asked = body.codes === undefined || body.codes === null || body.codes === ''
      ? cap : Math.max(0, parseInt(body.codes, 10) || 0);
    const already = existing ? await codeCount(env, campaign) : 0;
    const n = Math.max(0, Math.min(MAX_BATCH, cap - already, asked));
    const codes = await mintCodes(env, campaign, n);
    return { ok: true, campaign: camp.campaign, cap, price, active: camp.active, codes };
  }

  const camp = await getJson(env, kCampaign(campaign));
  if (!camp) return { ok: false, error: 'not-found' };

  if (action === 'link') {
    const link = String(body.link || '').trim();
    if (!/^https:\/\/[a-z0-9.-]*grow\.link\//i.test(link)) {
      return { ok: false, error: 'link-must-be-a-grow-link' };
    }
    camp.link = link;
    if (body.active !== false) camp.active = true;
    await env.RATE.put(kCampaign(campaign), JSON.stringify(camp));
    return { ok: true, campaign, active: camp.active, hasLink: true };
  }

  if (action === 'close' || action === 'open') {
    camp.active = action === 'open';
    if (camp.active && !camp.link) return { ok: false, error: 'no-link-cannot-open' };
    await env.RATE.put(kCampaign(campaign), JSON.stringify(camp));
    return { ok: true, campaign, active: camp.active };
  }

  if (action === 'cap') {
    const cap = Math.min(MAX_CAP, Math.max(1, parseInt(body.cap, 10) || camp.cap));
    camp.cap = cap;
    await env.RATE.put(kCampaign(campaign), JSON.stringify(camp));
    return { ok: true, campaign, cap };
  }

  if (action === 'add') {
    const asked = Math.min(MAX_BATCH, Math.max(1, parseInt(body.codes, 10) || 1));
    const have = await codeCount(env, campaign);
    const room = camp.cap - have;
    if (room <= 0) {
      return { ok: false, error: 'cap-full', cap: camp.cap, codes_issued: have,
        hint: 'raise the cap first: {action:"cap", cap:N}' };
    }
    const n = Math.min(asked, room);
    const codes = await mintCodes(env, campaign, n);
    return { ok: true, campaign, codes, asked, minted: codes.length, cap: camp.cap };
  }

  if (action === 'codes') {
    const page = await env.RATE.list({ prefix: 'promov:' });
    const out = [];
    for (const k of page.keys) {
      const v = await getJson(env, k.name);
      if (!v || v.c !== campaign) continue;
      const code = k.name.slice('promov:'.length);
      const held = await env.RATE.get(kHold(campaign, code));
      out.push({ code, state: v.st === 'used' ? 'used' : (held ? 'held' : 'open'), phone: v.ph || '' });
    }
    out.sort((a, b) => a.code.localeCompare(b.code));
    return { ok: true, campaign, codes: out };
  }

  if (action === 'status') {
    const used = await usedCount(env, campaign);
    const holds = await holdCount(env, campaign);
    return {
      ok: true, campaign, label: camp.label, price: camp.price, plan: camp.plan,
      maxTier: camp.maxTier, cap: camp.cap, used, holds, left: camp.cap - used - holds,
      active: !!camp.active, beta: !!camp.beta, hasLink: !!camp.link,
    };
  }

  return { ok: false, error: 'unknown-action' };
}

/* Now that the cap IS the code count, minting is the thing that has to be
   bounded. Without this, `add` quietly raises the cap: fifteen more codes on a
   ten-seat campaign is a fifteen-seat campaign, and nothing anywhere would
   have said so. */
async function codeCount(env, campaign) {
  if (!env.RATE) return 0;
  let n = 0, cursor;
  do {
    const page = await env.RATE.list({ prefix: 'promov:', cursor });
    for (const k of page.keys) {
      const v = await getJson(env, k.name);
      if (v && v.c === campaign) n++;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return n;
}

async function mintCodes(env, campaign, n) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    let code = newCode();
    /* 31^8 of space, but a collision would silently reassign somebody's
       voucher to another campaign, so check anyway */
    for (let t = 0; t < 5 && await env.RATE.get(kVoucher(code)); t++) code = newCode();
    if (await env.RATE.get(kVoucher(code))) continue;
    await env.RATE.put(kVoucher(code), JSON.stringify({
      c: campaign, st: 'open', ts: new Date().toISOString(),
    }));
    codes.push(code);
  }
  return codes;
}
