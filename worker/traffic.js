/* ============================================================================
   ishur.io · first-party traffic + funnel counter
   ----------------------------------------------------------------------------
   Richard (07/09): "כמה אנשים בלייב, כמה נכנסו היום, כמה מאז ומעולם, כמה
   חוזרים" — and he wants the same numbers written to the sheet and usable for
   decisions, by him and by me, without opening four different tools.

   Why our own counter and not GA4 or PostHog:
     · both are blocked for 10-25% of visitors, and PostHog says so itself on
       its own dashboard. A number that silently loses a quarter of the truth
       is not a number you steer a budget by.
     · "how many are on the site right now" needs a live store, and neither
       gives us one we can read from the Worker.
     · the sheet and the admin board must read the SAME counter, or the two
       will disagree and Richard will trust neither.
   PostHog stays for what it is genuinely better at: heatmaps, replays and
   per-user funnels. This file answers "how many", it does not replace it.

   Storage: plain KV, four shapes.
     t:live            {vid: epochSec}  pruned to LIVE_S, capped LIVE_MAX
     t:d:<YYYY-MM-DD>  the day's counters
     t:v:<vid>         a visitor we have seen before (365d) — new vs returning
     t:all             totals since the first ever hit

   Honest limit: the daily counter is a read-modify-write, so two hits landing
   in the same handful of milliseconds can lose one increment. At the traffic
   this business has (tens per hour, not thousands) that is noise, and the
   alternative — a Durable Object per day — is a lot of machinery for it. If
   the site ever does thousands an hour, this is the thing to replace first.
   ========================================================================== */

const LIVE_S = 300;      // "on the site now" = seen in the last 5 minutes
const LIVE_MAX = 300;    // hard cap so one bot cannot inflate the live map
const DAY_TTL = 400 * 86400;
const VID_TTL = 365 * 86400;

/* Israel's calendar day, so "today" on the board means today in Israel. */
function ilDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}

function emptyDay() {
  return {
    views: 0,           // page views
    visitors: 0,        // distinct visitors
    fresh: 0,           // first time ever on the site
    returning: 0,       // seen before today or earlier
    pages: {},          // path → views
    src: {},            // utm_source (or 'direct') → visitors
    pay: 0,             // reached a payment page
    purchase: 0,        // paid (written by the payment path, not the browser)
    seen: {},           // vid → 1, so a second view is not a second visitor
  };
}

async function readJson(env, key, fallback) {
  if (!env.RATE) return fallback;
  try {
    const raw = await env.RATE.get(key);
    if (!raw) return fallback;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : fallback;
  } catch { return fallback; }
}

/* ── the hot path ──────────────────────────────────────────────────────────
   One beacon per page view. Everything here is best-effort: a counter that
   throws must never break a page, so every failure is swallowed.           */
export async function recordHit(env, { vid, path, src, kind }) {
  if (!env.RATE || !vid) return { ok: false, why: 'no-kv-or-vid' };
  const day = ilDay();
  const nowS = Math.floor(Date.now() / 1000);
  const p = String(path || '/').slice(0, 80);
  const s = String(src || '').toLowerCase().slice(0, 40) || 'direct';

  /* live presence */
  const live = await readJson(env, 't:live', {});
  live[vid] = nowS;
  for (const k of Object.keys(live)) if (nowS - live[k] > LIVE_S) delete live[k];
  const keys = Object.keys(live);
  if (keys.length > LIVE_MAX) {
    keys.sort((a, b) => live[a] - live[b]);
    for (const k of keys.slice(0, keys.length - LIVE_MAX)) delete live[k];
  }
  await env.RATE.put('t:live', JSON.stringify(live), { expirationTtl: LIVE_S * 4 }).catch(() => {});

  /* returning or brand new — the visitor key is the only honest source */
  const seenBefore = await env.RATE.get('t:v:' + vid).catch(() => null);
  if (!seenBefore) {
    await env.RATE.put('t:v:' + vid, day, { expirationTtl: VID_TTL }).catch(() => {});
  }

  /* the day */
  const d = Object.assign(emptyDay(), await readJson(env, 't:d:' + day, null) || {});
  if (kind === 'pay') d.pay++;
  else {
    d.views++;
    d.pages[p] = (d.pages[p] || 0) + 1;
    if (!d.seen[vid]) {
      d.seen[vid] = 1;
      d.visitors++;
      if (seenBefore) d.returning++; else d.fresh++;
      d.src[s] = (d.src[s] || 0) + 1;
    }
  }
  await env.RATE.put('t:d:' + day, JSON.stringify(d), { expirationTtl: DAY_TTL }).catch(() => {});

  /* all time */
  const all = await readJson(env, 't:all', { views: 0, visitors: 0, since: day });
  if (kind !== 'pay') {
    all.views++;
    if (!seenBefore) all.visitors++;
    if (!all.since) all.since = day;
    await env.RATE.put('t:all', JSON.stringify(all)).catch(() => {});
  }
  return { ok: true };
}

/* Purchases are counted by the Worker at the moment the money lands, never by
   the browser: thanks.html can be closed, blocked, or reloaded twice, and the
   funnel's last step is the one that must be exactly right. */
export async function recordPurchase(env) {
  if (!env.RATE) return;
  const day = ilDay();
  const d = Object.assign(emptyDay(), await readJson(env, 't:d:' + day, null) || {});
  d.purchase++;
  await env.RATE.put('t:d:' + day, JSON.stringify(d), { expirationTtl: DAY_TTL }).catch(() => {});
}

/* ── the board ─────────────────────────────────────────────────────────────
   Everything the admin page needs in one call: live, a row per day, the
   totals, and the funnel with its two conversion rates already computed —
   the percentage is the number Richard actually decides on, so it should not
   be re-derived differently in two places.                                  */
export async function trafficReport(env, days = 14) {
  const n = Math.min(Math.max(Number(days) || 14, 1), 90);
  const nowS = Math.floor(Date.now() / 1000);
  const live = await readJson(env, 't:live', {});
  const liveNow = Object.values(live).filter(t => nowS - t <= LIVE_S).length;

  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = ilDay(new Date(Date.now() - i * 86400e3));
    const d = await readJson(env, 't:d:' + day, null);
    rows.push({
      date: day,
      views: d ? d.views || 0 : 0,
      visitors: d ? d.visitors || 0 : 0,
      fresh: d ? d.fresh || 0 : 0,
      returning: d ? d.returning || 0 : 0,
      pay: d ? d.pay || 0 : 0,
      purchase: d ? d.purchase || 0 : 0,
      pages: d ? d.pages || {} : {},
      src: d ? d.src || {} : {},
    });
  }

  const sum = rows.reduce((a, r) => ({
    views: a.views + r.views, visitors: a.visitors + r.visitors,
    fresh: a.fresh + r.fresh, returning: a.returning + r.returning,
    pay: a.pay + r.pay, purchase: a.purchase + r.purchase,
  }), { views: 0, visitors: 0, fresh: 0, returning: 0, pay: 0, purchase: 0 });

  const pages = {}, src = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.pages)) pages[k] = (pages[k] || 0) + v;
    for (const [k, v] of Object.entries(r.src)) src[k] = (src[k] || 0) + v;
  }

  const all = await readJson(env, 't:all', { views: 0, visitors: 0, since: '' });
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  return {
    ok: true,
    live_now: liveNow,
    today: rows[rows.length - 1] || null,
    days: rows,
    window: sum,
    all_time: all,
    funnel: {
      visitors: sum.visitors,
      pay: sum.pay,
      purchase: sum.purchase,
      visit_to_pay: pct(sum.pay, sum.visitors),
      pay_to_purchase: pct(sum.purchase, sum.pay),
      visit_to_purchase: pct(sum.purchase, sum.visitors),
    },
    top_pages: Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 12),
    top_src: Object.entries(src).sort((a, b) => b[1] - a[1]).slice(0, 12),
    generated_at: new Date().toISOString(),
  };
}
