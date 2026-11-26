/* ============================================================================
   ishur.io · vendorexp.js · the REAL vendor charges, on the day they were charged
   ----------------------------------------------------------------------------
   Richard 26/11: "אין מצב שהכל זה רק 300 … תציג לי אותם ביום שהם חויבו … בסכום …
   ואם נרכש אקסטרה אז גם זה … תעשה משהו שלא תלוי בך שעוקב אחרי זה".

   KV vexp:<YYYY-MM> = [{ref, day, vendor, amount, currency, desc, org?, source}]
     one row per receipt, keyed by the receipt number (a second copy of the same receipt is a no-op).
   KV cfg:vexp_share  = {make: 0.91, ...}   the part of a shared vendor that is ishur's (default below)
   KV cfg:vexp_ingest = "<key>"             the key Make's receipt scan sends in x-ingest-key

   How a month is costed (one rule everywhere — the money page, the finance view, the daily table):
     · a recurring row (fixedcosts) is REPLACED by that vendor's real charges in any month that has one;
       a month with no charge yet keeps the recurring row as the estimate (marked approx).
     · call vendors (Retell, Telnyx) are top-ups: in a month with any top-up, the calls cost is the top-ups
       on their days (Richard 26/11: "Actual charges"), and the per-call usage is kept only as information.
     · Make: only the "Richard Main" organisation (5881669) is ishur's; client organisations are not.
   ========================================================================== */
export const ISHUR_MAKE_ORG = '5881669';
export const VENDORS = [
  { key: 'make', name: 'Make', re: /\bmake\b|celonis/i },
  { key: 'retell', name: 'Retell', re: /retell/i, calls: true },
  { key: 'telnyx', name: 'Telnyx', re: /telnyx/i, calls: true },
  { key: 'cloudflare', name: 'Cloudflare', re: /cloudflare/i },
  { key: 'monday', name: 'Monday', re: /monday/i },
  { key: 'anthropic', name: 'Anthropic', re: /anthropic|claude/i },
];
/* 26/11: Make by ishur's share of the org's credits (≈180k of ≈197k, measured 25/11); the rest whole */
export const DEFAULT_SHARE = { make: 0.91, retell: 1, telnyx: 1, cloudflare: 1, monday: 1, anthropic: 1 };
const RATES = { USD: 3.7, ILS: 1, EUR: 4, GBP: 4.7 };   /* USD = the flat rate the money page uses everywhere */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const jp = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function vendorKey(name) { const v = VENDORS.find((x) => x.re.test(String(name || ''))); return v ? v.key : ''; }
export const isCallVendor = (k) => !!(VENDORS.find((v) => v.key === k) || {}).calls;

/* a receipt → a stored row, or null (not a vendor we cost, a client's Make org, no amount) */
export function normRow(x) {
  const key = vendorKey(x.vendor);
  const amount = Number(x.amount);
  const day = String(x.date || x.day || '').slice(0, 10);
  if (!key || !(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const org = String(x.org || (String(x.desc || '').match(/organi[sz]ation ID:?\s*(\d{6,})|\borg\s+(\d{6,})/i) || []).slice(1).find(Boolean) || '');
  if (key === 'make' && org && org !== ISHUR_MAKE_ORG) return null;
  const currency = String(x.currency || 'USD').toUpperCase();
  return { ref: String(x.ref || `${key}:${day}:${amount}`).slice(0, 80), day, vendor: key, amount: r2(amount), currency: RATES[currency] ? currency : 'USD',
    desc: String(x.desc || '').slice(0, 140), org: org || undefined, source: String(x.source || 'mail').slice(0, 20) };
}
export const rowIls = (r, share = DEFAULT_SHARE) => r2(r.amount * (RATES[r.currency] || RATES.USD) * (share[r.vendor] ?? 1));

/* merge rows into the months they belong to; returns {month: rows[]} of only the months that changed */
export function mergeRows(byMonth, rows) {
  const changed = {};
  for (const x of rows) {
    const r = normRow(x); if (!r) continue;
    const m = r.day.slice(0, 7), list = byMonth[m] || (byMonth[m] = []);
    /* the same charge seen twice: same receipt number, or the same vendor, day and amount from a second mailbox */
    if (list.some((y) => y.ref === r.ref || (y.vendor === r.vendor && y.day === r.day && y.amount === r.amount && (y.source !== r.source || /^cltxn_/.test(r.ref) || /^cltxn_/.test(y.ref))))) continue;
    list.push(r); list.sort((a, b) => a.day.localeCompare(b.day)); changed[m] = list;
  }
  return changed;
}

/* the month's non-call costs as the money page lists them: [{name, ils, day, actual?, approx?}] */
export function monthFixedItems(recurring, rows, share = DEFAULT_SHARE) {
  const real = (rows || []).filter((r) => !isCallVendor(r.vendor));
  const charged = new Set(real.map((r) => r.vendor));
  const out = [];
  for (const x of recurring || []) {
    const k = vendorKey(x.name);
    if (k && charged.has(k)) continue;               /* the real charges stand in for it */
    if (k && isCallVendor(k)) continue;               /* calls are costed from the top-ups / usage, never as a fixed row */
    out.push({ ...x });
  }
  for (const r of real) {
    const ils = rowIls(r, share); if (!(ils > 0)) continue;
    out.push({ name: (VENDORS.find((v) => v.key === r.vendor) || {}).name + (r.desc ? ' · ' + r.desc.slice(0, 40) : ''), ils, day: Number(r.day.slice(8, 10)), actual: true, ref: r.ref });
  }
  return out;
}
/* the month's call top-ups per day in USD cents (the unit the series uses), or null when the month has none */
export function callTopups(rows, share = DEFAULT_SHARE) {
  const calls = (rows || []).filter((r) => isCallVendor(r.vendor));
  if (!calls.length) return null;
  const by = {};
  for (const r of calls) by[r.day] = r2((by[r.day] || 0) + rowIls(r, share) / RATES.USD * 100);
  return by;
}

export async function loadShare(env) { return { ...DEFAULT_SHARE, ...(jp(env.RATE ? await env.RATE.get('cfg:vexp_share').catch(() => null) : null) || {}) }; }
export async function loadVexp(env, months) {
  const out = {};
  if (!env.RATE) return out;
  await Promise.all((months || []).map(async (m) => { out[m] = jp(await env.RATE.get('vexp:' + m).catch(() => null)) || []; }));
  return out;
}
export async function saveRows(env, rows) {
  const months = [...new Set((rows || []).map((x) => String(x.date || x.day || '').slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))];
  const cur = await loadVexp(env, months);
  const changed = mergeRows(cur, rows);
  for (const [m, list] of Object.entries(changed)) await env.RATE.put('vexp:' + m, JSON.stringify(list));
  if (Object.keys(changed).length) { await env.RATE.delete('incdays').catch(() => {}); await env.RATE.delete('opsfin:90d').catch(() => {}); }
  return { ok: true, months: Object.keys(changed), added: Object.values(changed).reduce((n, l) => n + l.length, 0) };
}

/* the money page's months: recurring rows with the real charges in their place */
export function applyToFixedMap(fixedMap, vexp, share) {
  const out = { ...fixedMap };
  for (const m of new Set([...Object.keys(fixedMap || {}), ...Object.keys(vexp || {})])) out[m] = monthFixedItems(fixedMap[m] || [], vexp[m] || [], share);
  return out;
}
/* series rows {date, shir_cost_usd_cents}: a month with top-ups is costed by them (usage kept as shir_usage_usd_cents) */
export function applyToSeries(series, vexp, share) {
  const top = {};
  for (const [m, rows] of Object.entries(vexp || {})) { const t = callTopups(rows, share); if (t) top[m] = t; }
  const byDate = new Map(series.map((s) => [s.date, s]));
  for (const s of series) if (top[s.date.slice(0, 7)]) { s.shir_usage_usd_cents = s.shir_cost_usd_cents; s.shir_cost_usd_cents = top[s.date.slice(0, 7)][s.date] || 0; }
  const added = [];
  for (const days of Object.values(top)) for (const [d, c] of Object.entries(days)) if (!byDate.has(d)) added.push(d), byDate.set(d, null), series.push({ date: d, shir_cost_usd_cents: c, shir_usage_usd_cents: 0, _added: true });
  return added;
}

/* POST /api/vendor-expense {admin_key, action:'list'|'add'|'remove'|'share', rows?, ref?, month?, share?} */
export async function vendorExpenseAction(env, b) {
  if (b.action === 'add') return saveRows(env, Array.isArray(b.rows) ? b.rows.slice(0, 500) : []);
  if (b.action === 'share' && b.share && typeof b.share === 'object') {
    const cur = await loadShare(env);
    for (const [k, v] of Object.entries(b.share)) if (DEFAULT_SHARE[k] != null && Number(v) >= 0 && Number(v) <= 1) cur[k] = Number(v);
    await env.RATE.put('cfg:vexp_share', JSON.stringify(cur)); await env.RATE.delete('incdays').catch(() => {});
    return { ok: true, share: cur };
  }
  if (b.action === 'remove' && /^\d{4}-\d{2}$/.test(String(b.month || '')) && b.ref) {
    const list = (await loadVexp(env, [b.month]))[b.month].filter((r) => r.ref !== String(b.ref));
    await env.RATE.put('vexp:' + b.month, JSON.stringify(list)); await env.RATE.delete('incdays').catch(() => {});
    return { ok: true, month: b.month, rows: list.length };
  }
  const m = /^\d{4}-\d{2}$/.test(String(b.month || '')) ? b.month : new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 7);
  const share = await loadShare(env);
  const rows = (await loadVexp(env, [m]))[m];
  return { ok: true, month: m, share, rows: rows.map((r) => ({ ...r, ils: rowIls(r, share) })), total_ils: r2(rows.reduce((t, r) => t + rowIls(r, share), 0)) };
}

/* Make's receipt scan → POST /api/vendor-expense/ingest with x-ingest-key. Rows it can't cost are answered, not stored. */
export async function vendorExpenseIngest(env, request, body) {
  const want = env.RATE ? await env.RATE.get('cfg:vexp_ingest').catch(() => null) : null;
  if (!want || request.headers.get('x-ingest-key') !== want) return { status: 403, body: { ok: false, error: 'bad-key' } };
  /* the HUB's Ledger sheet as it is (header row first): vendor, invoice_number, doc_date, amount, currency, notes … */
  if (Array.isArray(body.ledger)) {
    const rows = ledgerRows(body.ledger);
    let out;
    if (body.dry) {   /* what a real run would add, without writing */
      const months = [...new Set(rows.map((x) => String(x.date).slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m)))];
      const cur = await loadVexp(env, months), before = new Set(Object.values(cur).flat().map((r) => r.ref));
      mergeRows(cur, rows);
      out = { ok: true, dry: true, would_add: Object.values(cur).flat().filter((r) => !before.has(r.ref)).map((r) => [r.day, r.vendor, r.amount, r.currency, r.ref]) };
    } else out = await saveRows(env, rows);
    const sample = body.ledger.slice(0, 1).concat(body.ledger.slice(-25));
    if (env.RATE) await env.RATE.put('vexp:lastingest', JSON.stringify({ at: new Date().toISOString(), rows: body.ledger.length, costed: rows.length, ...out, sample }), { expirationTtl: 30 * 86400 }).catch(() => {});
    return { status: 200, body: { ...out, rows: body.ledger.length, costed: rows.length } };
  }
  const rows = Array.isArray(body.rows) ? body.rows : [body];
  return { status: 200, body: await saveRows(env, rows.slice(0, 50)) };
}
/* Ledger values → receipt rows (only vendors we cost survive normRow; a Make row needs the ishur org in its text) */
export function ledgerRows(values) {
  const head = (values[0] || []).map((h) => String(h || '').trim().toLowerCase());
  const col = (names) => names.map((n) => head.indexOf(n)).find((i) => i >= 0);
  const c = { vendor: col(['vendor', 'ספק']), ref: col(['invoice_number', 'מספר מסמך', 'invoice']), date: col(['doc_date', 'תאריך', 'date']), amount: col(['amount', 'סכום']),
    currency: col(['currency', 'מטבע']), notes: col(['notes', 'הערות']), period: col(['period', 'תקופה']), hash: col(['hash']), type: col(['doc_type', 'סוג']) };
  const out = [], numbered = new Set();
  const rows = values.slice(1).map((r) => { const g = (k) => (c[k] == null ? '' : String(r[c[k]] ?? '').trim()); return { g, key: [vendorKey(g('vendor')), g('date').slice(0, 10), Number(String(g('amount')).replace(/[^\d.]/g, ''))].join('|') }; });
  for (const { g, key } of rows) if (g('ref')) numbered.add(key);
  for (const { g, key } of rows) {
    if (/credit|זיכוי/i.test(g('type'))) continue;
    if (/לא בטוח/.test(g('notes'))) continue;                       /* the HUB itself wasn't sure it is a charge */
    if (!g('ref') && numbered.has(key)) continue;                     /* the receipt of an invoice already in the sheet */
    const vendor = g('vendor'), text = [vendor, g('notes'), g('period'), g('ref')].join(' ');
    /* Make: only the "Richard Main" organisation is ishur's — its invoices are numbered ECLTTLZP-…; client orgs have their own prefixes */
    const mine = /5881669|richard main/i.test(text) || /^ECLTTLZP-/i.test(g('ref'));
    if (/\bmake\b|celonis/i.test(vendor) && !mine) continue;
    out.push({ date: g('date').slice(0, 10), vendor, amount: Number(String(g('amount')).replace(/[^\d.]/g, '')), currency: g('currency') || 'USD',
      ref: g('ref') || g('hash'), desc: (g('notes') || g('period')).slice(0, 140), org: mine && /\bmake\b|celonis/i.test(vendor) ? ISHUR_MAKE_ORG : undefined, source: 'ledger' });
  }
  return out;
}

/* the daily check (cron): a recurring vendor whose charge day passed by 5+ days with no charge this month → one Slack line a month */
export function missingCharges(recurring, rows, today) {
  const day = Number(today.slice(8, 10)), have = new Set((rows || []).map((r) => r.vendor));
  return (recurring || []).filter((x) => { const k = vendorKey(x.name); return k && !isCallVendor(k) && !have.has(k) && day >= (x.day || 10) + 5; }).map((x) => x.name);
}
