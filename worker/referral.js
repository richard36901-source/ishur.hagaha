/* ============================================================================
   ishur.io · referral.js · "הזמן חבר" (Richard 12/11/2026)
   ----------------------------------------------------------------------------
   Pure rules, no I/O. index.js gives them hands (KV, Slack, routes).

   A client picks per event: 'discount' (friends pay 80% of the PACKAGE) or
   'commission' (the client earns 20% of the friend's PACKAGE as credit, never
   cash, redeemable against our packages). The code is the first 8 chars of
   the event token — the same code the old share links already carried.

   Money flow (Richard, second rule 12/11): a friend's payment creates a
   record in status 'pending'. Credit is posted to the referrer's ledger ONLY
   when the friend's invoice exists (verified_by:'invoice') or Richard presses
   "אשר הפניה" (verified_by:'manual'). verifyRecord is idempotent.

   Reviews earn credit too (Google ₪20, video ₪30) — that part lives in
   account.js (handleReviewClaim, immediate and idempotent). The raffle stays off.

   KV (index.js): ref:<code> · refpend:<phone> (30d) · refrec:<code>:<ipnRef>
   · reffriend:<token> · credit:<phone> (account.js shape). refcred:<code> (tier) unchanged.
   ========================================================================== */

export const CODE_RE = /^[0-9a-f]{8}$/;
export const MODES = ['discount', 'commission'];
export const PCT = 20;
export const REVIEW_CREDIT = { review_google: 20, review_video: 30 };   /* mirrors account.js CREDIT_ILS */
export const SITE = 'https://ishur.io';

export const codeOf = token => String(token || '').slice(0, 8).toLowerCase();
export const isCode = c => CODE_RE.test(String(c || ''));
export const refLink = code => `${SITE}/?ref=${codeOf(code)}`;
/* 80% of the package, whole shekels (₪95 → ₪76, ₪449 → ₪359) */
export const discountPrice = p => Math.round(Number(p) * (100 - PCT) / 100);
export const creditOf = pkgSum => Math.round(Number(pkgSum) * PCT / 100);
export const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';

/* ── the client's choice ──────────────────────────────────────────────── */
export function newRef({ token, phone, name = '', mode, at = new Date().toISOString() }) {
  if (!MODES.includes(mode)) return { ok: false, error: 'bad-mode' };
  if (!/^[0-9a-f-]{20,40}$/i.test(String(token || ''))) return { ok: false, error: 'bad-token' };
  return { ok: true, ref: { code: codeOf(token), token: String(token).toLowerCase(), phone: String(phone || ''), name: String(name || '').slice(0, 80), mode, at, locked: false } };
}
/* changeable until the first referral record exists */
export function setMode(ref, mode, at = new Date().toISOString()) {
  if (!MODES.includes(mode)) return { ok: false, error: 'bad-mode' };
  if (ref.mode === mode) return { ok: true, ref, changed: false };
  if (ref.locked) return { ok: false, error: 'locked' };
  return { ok: true, ref: { ...ref, mode, mode_at: at }, changed: true };
}
/* what the public site may know about a code: mode + first name, nothing else */
export function publicRef(ref) {
  if (!ref) return { ok: false };
  return { ok: true, mode: ref.mode, name_first: firstName(ref.name) };
}

/* ── attribution at the IPN ───────────────────────────────────────────── */
/* "ref:<code>" anywhere in Grow's custom fields (cField3 by design, but any) */
export function codeFromFields(flat) {
  const all = ['cField3', 'cfield3', 'customField3', 'cField1', 'cField2', 'note'].map(k => String((flat || {})[k] || '')).join(' ');
  const m = all.match(/\bref:([0-9a-f]{8})\b/i);
  return m ? m[1].toLowerCase() : '';
}
/* order: custom field → the site's pre-redirect claim (refpend) → the lead row.
   lookup(code) → ref or null. Self-referral and "my own event" are ignored. */
export function attribute({ flat, pendCode = '', leadCode = '', payerPhone = '', friendToken = '', lookup }) {
  const cands = [[codeFromFields(flat), 'cField3'], [pendCode, 'pending'], [leadCode, 'lead']];
  for (const [code, via] of cands) {
    if (!isCode(code)) continue;
    const ref = lookup(code);
    if (!ref) continue;
    if (ref.phone && payerPhone && String(ref.phone).slice(-9) === String(payerPhone).slice(-9)) return { code, via, ref, ignored: 'self' };
    if (friendToken && codeOf(friendToken) === code) return { code, via, ref, ignored: 'own-event' };
    return { code, via, ref };
  }
  return null;
}

/* the PACKAGE line only (20% never touches hostesses / design / add-ons) */
export function packageSum({ purchase = null, parsed = null, sum = 0, pkgPrices = {} }) {
  const total = Number(String(sum).replace(/[^\d.]/g, '')) || 0;
  if (purchase && Array.isArray(purchase.lines)) {
    const l = purchase.lines.find(x => x.key === 'pkg');
    if (l) return { sum_package: Number(l.price) || 0, note: 'quote' };
    const bl = purchase.lines.find(x => x.key === 'bundle');
    /* a bundle is package + hostesses at one price: the package part is the list price of that plan */
    if (bl && purchase.plan && pkgPrices[purchase.records] && pkgPrices[purchase.records][purchase.plan] != null) return { sum_package: pkgPrices[purchase.records][purchase.plan], note: 'bundle' };
  }
  if (parsed && parsed.tier && parsed.plan && pkgPrices[parsed.tier] && pkgPrices[parsed.tier][parsed.plan] != null) {
    const list = pkgPrices[parsed.tier][parsed.plan];
    /* an 80% page pays less than list: the package line is what was paid, capped at list */
    return { sum_package: Math.min(list, total || list), note: parsed.hostess ? 'desc-hostess' : 'desc' };
  }
  return { sum_package: total, note: 'unstructured' };
}

export function newRecord({ code, ref, friend, sum_total, sum_package, note = '', ipnRef, via = '', at = new Date().toISOString() }) {
  const path = ref.mode;
  const pkg = Number(sum_package) || 0;
  return {
    id: `${code}:${ipnRef}`, code, referrer_phone: ref.phone, referrer_name: ref.name, referrer_token: ref.token,
    friend_phone: String(friend.phone || ''), friend_name: String(friend.name || '').slice(0, 80), friend_token: String(friend.token || ''),
    sum_total: Number(String(sum_total).replace(/[^\d.]/g, '')) || 0, sum_package: pkg, note, via, path,
    discount_given: path === 'discount' ? Math.round(pkg * PCT / (100 - PCT)) : 0,   /* paid 80 → the friend saved 20 */
    credit: path === 'commission' ? creditOf(pkg) : 0,
    at, status: 'pending', verified_by: '', verified_at: '', redeemed: false, redeemed_at: '',
  };
}
/* idempotent: the credit comes back once, on the first verification only */
export function verifyRecord(rec, { by = 'manual', at = new Date().toISOString() } = {}) {
  if (!rec || rec.status === 'verified') return { rec, credit: 0, changed: false };
  return { rec: { ...rec, status: 'verified', verified_by: by, verified_at: at }, credit: rec.credit || 0, changed: true };
}
export function redeemRecord(rec, { on = true, at = new Date().toISOString() } = {}) {
  if (!rec || rec.status !== 'verified') return { rec, changed: false };
  if (!!rec.redeemed === !!on) return { rec, changed: false };
  return { rec: { ...rec, redeemed: !!on, redeemed_at: on ? at : '' }, changed: true };
}

/* ── the credit ledger, one per client phone ─────────────────────────────
   Owned by account.js (personal area): credit:<phone> = {entries:[{kind, ils, at, token}], redeemed:[{ils, at, note}]}.
   The referral program appends here; balance = Σentries − Σredeemed (account.js ledgerBalance). */
export const emptyLedger = () => ({ entries: [], redeemed: [] });
const sumIls = a => (Array.isArray(a) ? a : []).reduce((n, e) => n + (Number(e && e.ils) || 0), 0);
export const ledgerBalance = L => Math.max(0, sumIls(L && L.entries) - sumIls(L && L.redeemed));
export function ledgerAdd(ledger, { kind, amount, ref = '', token = '', at = new Date().toISOString(), note = '' }) {
  const L = { entries: Array.isArray(ledger && ledger.entries) ? ledger.entries : [], redeemed: Array.isArray(ledger && ledger.redeemed) ? ledger.redeemed : [] };
  const key = `${kind}:${token}:${ref}`;
  if (L.entries.some(e => `${e.kind}:${e.token || ''}:${e.ref || ''}` === key)) return { ledger: L, added: false };
  const ils = Math.max(0, Math.round(Number(amount) || 0));
  if (!ils) return { ledger: L, added: false };
  return { ledger: { ...L, entries: [...L.entries, { kind, ils, ref, token, at, note }] }, added: true };
}
/* redeem = the whole open balance against a package (no partials for now) */
export function ledgerRedeem(ledger, { at = new Date().toISOString(), note = '' } = {}) {
  const L = { entries: Array.isArray(ledger && ledger.entries) ? ledger.entries : [], redeemed: Array.isArray(ledger && ledger.redeemed) ? ledger.redeemed : [] };
  const bal = ledgerBalance(L);
  if (!bal) return { ledger: L, redeemed: 0 };
  return { ledger: { ...L, redeemed: [...L.redeemed, { ils: bal, at, note }] }, redeemed: bal };
}

/* ── what people read ─────────────────────────────────────────────────── */
export function slackLine(rec) {
  const local = String(rec.friend_phone || '').replace(/^972/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  const how = rec.path === 'discount' ? `הנחה ₪${rec.discount_given}` : `זיכוי ₪${rec.credit} (ממתין לחשבונית)`;
  return `🎉 *הפניה שילמה* · ${rec.friend_name || local} ${rec.friend_name ? local : ''} · ₪${rec.sum_total} · דרך ${firstName(rec.referrer_name) || rec.code} · ${how}`.replace(/\s+·/g, ' ·');
}
/* the dashboard card's numbers: verified records count, pending ones are only counted */
export function refSummary(ref, recs = [], ledger = null) {
  const ver = recs.filter(r => r.status === 'verified'), pend = recs.filter(r => r.status === 'pending');
  const L = ledger || emptyLedger();
  return {
    mode: ref ? ref.mode : '', code: ref ? ref.code : '', link: ref ? refLink(ref.code) : '', locked: !!(ref && ref.locked) || recs.length > 0,
    friends: ver.length, pending: pend.length,
    saved: ver.reduce((s, r) => s + (r.discount_given || 0), 0),
    earned: (L.entries || []).filter(e => e.kind === 'referral').reduce((s, e) => s + (Number(e.ils) || 0), 0),
    balance: ledgerBalance(L),
  };
}
export function cardCopy(sum) {
  return sum.mode === 'discount' ? `חברים חסכו ₪${sum.saved}` : `הרווחתם ₪${sum.earned}`;
}
/* ops home: one line when credit waits */
export function pendingLine(ledgers = []) {
  const open = ledgers.map(l => ledgerBalance(l)).filter(b => b > 0);
  if (!open.length) return '';
  return `זיכויים ממתינים: ₪${open.reduce((s, b) => s + b, 0)} ל-${open.length} לקוחות`;
}
