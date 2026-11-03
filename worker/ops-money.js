/* ============================================================================
   ishur.io · ops-money.js · Phase 4c of the ops center (03/11/2026)
   ----------------------------------------------------------------------------
   The four screens כספים / פרסום / תבניות / פידבקים. ops.js routes them:
     GET  /api/ops/finance?range=   revenue mix, P&L + margin per month, costs, invoices,
                                    per-event economics, cash view, MoM growth, cumulative
     POST /api/ops/finance          {set_manual:{month, vendor, ils}} → costman:<YYYY-MM>
     POST /api/ops/invoice-resend   {token, confirm} — re-sends an EXISTING invoice link (typed confirm,
                                    client hours only, template invoicetmpl); without confirm = preview
     GET  /api/ops/ads?range=       campaigns → ad sets → ads: spend, leads, CPL, ROAS; traffic; Shalev read-only
     GET  /api/ops/templates        every template on the 3 WABAs + per-template performance + pending age
     POST /api/ops/template-variant {waba, name, new_name, confirm} — copies a template's components under a
                                    new name and submits it to Meta (the same Graph POST meta-admin uses)
     GET  /api/ops/feedback         feedback list, per-event roll-up, average trend
   Every GET is cached in KV (RATE) for 5–10 min; ?fresh=1 bypasses.
   §1 pure (unit-tested in test/ops-money.test.mjs) · §2 I/O
   ========================================================================== */
import { rangeOf, bucketOf, clientHoursOpen } from './crm.js';
import { HOSTESS_PRICE, DESIGN_PRICE } from './paylink.js';
import { makeStore } from './store.js';
import { computeTemplateStats, loadRows as tstatsLoadRows } from './template-stats.js';

export const USD_ILS = 3.7;                      /* same flat rate as index.js / admin.html */
export const SHALEV_CAMPAIGN = '120250670197650731';
export const WABAS = [
  { key: 'guests', waba: '1378764257421712', he: 'אורחים (שיר)' },
  { key: 'portfolio', waba: '2815615772154486', he: 'לקוחות · פורטפוליו' },
  { key: 'old', waba: '1060242146337688', he: 'לקוחות · 4499' },
];
export const MANUAL_VENDORS = ['cloudflare', 'monday', 'make', 'anthropic', 'telnyx', 'retell', 'other'];
const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
const ilDay = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
const num = v => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */

/* one Grow IPN pay row → revenue lines by kind. A package payment that also carries hostesses or
   design is split at list price (HOSTESS_PRICE / DESIGN_PRICE): that split is an ESTIMATE. */
export function classifyPay(row, { parsePaidDesc = () => null } = {}) {
  if (!row || row.kind !== 'pay') return null;
  const f = (row.data && row.data.ipn) || {};
  const sum = num(f.paymentSum || f.sum || f.amount || f.transactionSum);
  if (!sum) return null;
  const desc = String(f.paymentDesc || f.description || f.productName || '');
  const ref = String(f.asmachta || f.transactionId || f.transactionCode || row.id || '');
  const phone = String(f.payerPhone || f.phone || row.phone || '').replace(/\D/g, '').replace(/^0/, '972');
  const tokM = desc.match(/·\s*([0-9a-f]{8})\s*$/);
  const base = { day: ilDay(row.ts), ref, phone, name: String(f.fullName || f.payerName || f.name || ''), desc: desc.slice(0, 80), sum, tok8: tokM ? tokM[1] : String(row.token || '').slice(0, 8) };
  const pkg = parsePaidDesc(desc);
  const lines = [];
  if (pkg && /\d{2,4}\s*(?:מוזמנים|רשומות)/.test(desc) && !/תוספת|שדרוג|הרחב/.test(desc)) {
    let rest = sum;
    if (pkg.hostess) { const h = Math.min(rest, HOSTESS_PRICE[pkg.hostess] || HOSTESS_PRICE[2] || 0); if (h > 0) { lines.push({ kind: 'hostess', ils: h, estimated: true }); rest -= h; } }
    if (/עיצוב|design/i.test(desc)) { const d = Math.min(rest, DESIGN_PRICE); if (d > 0) { lines.push({ kind: 'design', ils: d, estimated: true }); rest -= d; } }
    lines.unshift({ kind: 'package', ils: r2(rest), estimated: lines.length > 0 });
  } else if (/דייל/.test(desc)) lines.push({ kind: 'hostess', ils: sum, estimated: false });
  else if (/עיצוב|design/i.test(desc)) lines.push({ kind: 'design', ils: sum, estimated: false });
  else lines.push({ kind: 'addon', ils: sum, estimated: false });
  return { ...base, lines };
}

/* sheet fallback: a paid event with no pay audit row (audit pay rows start 22/10) counts as a package */
export function revenueEntries(payRows, events = [], { parsePaidDesc } = {}) {
  const seen = new Set(), out = [];
  const byPhone = {};
  for (const r of payRows || []) {
    const c = classifyPay(r, { parsePaidDesc }); if (!c || seen.has(c.ref)) continue; seen.add(c.ref);
    out.push({ ...c, source: 'grow' }); if (c.phone) byPhone[c.phone.slice(-9)] = true;
  }
  for (const e of events) {
    if (!e.paid || e.cancelled || !e.paid_day || !e.sum) continue;
    if (e.phone && byPhone[String(e.phone).replace(/\D/g, '').slice(-9)]) continue;
    out.push({ day: e.paid_day, ref: 'sheet:' + e.tok8, phone: e.phone || '', name: e.name, desc: e.plan, sum: e.sum, tok8: e.tok8, lines: [{ kind: 'package', ils: e.sum, estimated: false }], source: 'sheet' });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

export const REV_KINDS = ['package', 'addon', 'hostess', 'design'];
export function revenueSeries(entries, { from, to, group }) {
  const m = {};
  for (let d = from; d <= to; d = new Date(Date.parse(d + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10)) { const k = bucketOf(d, group); m[k] = m[k] || { bucket: k, package: 0, addon: 0, hostess: 0, design: 0, total: 0, payments: 0 }; }
  for (const e of entries) {
    if (e.day < from || e.day > to) continue;
    const s = m[bucketOf(e.day, group)]; if (!s) continue;
    s.payments++;
    for (const l of e.lines) { s[l.kind] = r2(s[l.kind] + l.ils); s.total = r2(s.total + l.ils); }
  }
  return Object.values(m).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/* P&L for one month. variable = WhatsApp + calls + hostess pay; net also subtracts ads, fixed, manual vendors. */
export function pnlMonth({ month, revenue = 0, wa = 0, calls = 0, hostess = 0, ads = 0, fixed = 0, manual = 0 }) {
  const variable = r2(wa + calls + hostess);
  const gross = r2(revenue - variable);
  const costs = r2(variable + ads + fixed + manual);
  const net = r2(revenue - costs);
  return { month, revenue: r2(revenue), costs: { wa: r2(wa), calls: r2(calls), hostess: r2(hostess), ads: r2(ads), fixed: r2(fixed), manual: r2(manual), total: costs },
    gross, net, gross_margin_pct: revenue > 0 ? Math.round(1000 * gross / revenue) / 10 : null, margin_pct: revenue > 0 ? Math.round(1000 * net / revenue) / 10 : null };
}

/* months[] (sorted) → growth vs previous month + running totals */
export function growth(months) {
  let cr = 0, cn = 0, prev = null;
  return months.map(p => {
    cr = r2(cr + p.revenue); cn = r2(cn + p.net);
    const g = prev && prev.revenue > 0 ? Math.round(1000 * (p.revenue - prev.revenue) / prev.revenue) / 10 : null;
    prev = p;
    return { month: p.month, revenue: p.revenue, net: p.net, mom_pct: g, cum_revenue: cr, cum_net: cn };
  });
}

export function monthsBetween(from, to) { const out = []; let m = from.slice(0, 7); while (m <= to.slice(0, 7)) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; } return out; }

/* per event: revenue (sheet sum + matching add-on pay lines), messages, calls, hostess pay, margin.
   msgs = evcost (₪, all spend on the event) − calls from the audit: an estimate when evcost lags. */
export function eventEconomics(events, { entries = [], evcostIls = {}, callsIls = {}, hostessPay = {} } = {}) {
  const extra = {};
  for (const e of entries) if (e.source === 'grow' && e.tok8) for (const l of e.lines) if (l.kind !== 'package') extra[e.tok8] = r2((extra[e.tok8] || 0) + l.ils);
  return events.filter(e => e.paid && !e.cancelled).map(e => {
    const calls = r2(callsIls[e.tok8] || 0);
    const total = r2(evcostIls[e.tok8] || 0);
    const msgs = r2(Math.max(0, total - calls));
    const hostess = r2(hostessPay[e.tok8] || 0);
    const revenue = r2(e.sum + (extra[e.tok8] || 0));
    const margin = r2(revenue - msgs - calls - hostess);
    return { tok8: e.tok8, token: e.token, name: e.name, date: e.date, plan: e.plan, revenue, msgs_cost: msgs, calls_cost: calls, hostess_pay: hostess, margin, margin_pct: revenue > 0 ? Math.round(1000 * margin / revenue) / 10 : null };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function invoiceRows(events, invByToken = {}) {
  return events.filter(e => e.paid && !e.cancelled).map(e => {
    const inv = invByToken[e.token] || null;
    const url = (inv && (inv.url || inv.link)) || (/^https?:/.test(e.invoice || '') ? e.invoice : '');
    const number = (inv && (inv.number || inv.num)) || (!url && e.invoice ? e.invoice : '');
    return { token: e.token, tok8: e.tok8, name: e.name, phone: e.phone || '', sum: e.sum, paid_day: e.paid_day || '', status: url || number ? 'issued' : 'pending', number: String(number || ''), url, at: (inv && inv.at) || '' };
  }).sort((a, b) => String(b.paid_day).localeCompare(String(a.paid_day)));
}

/* ── ads ── */
export const leadsOfActions = (actions = []) => {
  let n = 0; for (const a of actions || []) if (a.action_type === 'offsite_conversion.fb_pixel_lead') n = Number(a.value) || 0;
  if (!n) for (const a of actions || []) if (a.action_type === 'lead') n = Number(a.value) || 0;
  return n;
};
/* insight rows (level=ad) + CRM leads (origin.campaign / origin.ad names) + revenue per phone → tree with ROAS.
   ROAS = revenue from leads attributed to the campaign that closed ÷ spend. Leads with no campaign land in
   `unattributed`. Blended ROAS (all revenue ÷ all spend) is reported separately. */
export function adsTree(rows, { leads = [], revenueByPhone = {}, shalev = SHALEV_CAMPAIGN } = {}) {
  const camps = {};
  for (const r of rows || []) {
    const c = camps[r.campaign_id] = camps[r.campaign_id] || { id: r.campaign_id, name: r.campaign_name || r.campaign_id, read_only: r.campaign_id === shalev, owner: r.campaign_id === shalev ? 'שלו' : '', spend: 0, impressions: 0, clicks: 0, leads: 0, adsets: {} };
    const s = c.adsets[r.adset_id] = c.adsets[r.adset_id] || { id: r.adset_id, name: r.adset_name || r.adset_id, spend: 0, impressions: 0, clicks: 0, leads: 0, ads: [] };
    const ad = { id: r.ad_id, name: r.ad_name || r.ad_id, spend: r2(r.spend), impressions: Number(r.impressions) || 0, clicks: Number(r.inline_link_clicks || r.clicks) || 0, leads: leadsOfActions(r.actions) };
    s.ads.push(ad);
    for (const o of [c, s]) { o.spend = r2(o.spend + ad.spend); o.impressions += ad.impressions; o.clicks += ad.clicks; o.leads += ad.leads; }
  }
  const byName = {}; for (const c of Object.values(camps)) byName[String(c.name).trim()] = c;
  const unattributed = { leads: 0, closed: 0, revenue: 0 };
  for (const c of Object.values(camps)) Object.assign(c, { crm_leads: 0, closed: 0, revenue: 0 });
  for (const l of leads) {
    const nm = String((l.origin && l.origin.campaign) || '').trim();
    const c = nm ? byName[nm] : null;
    const rev = r2(revenueByPhone[String(l.phone || '').slice(-9)] || 0);
    const won = l.status === 'closed' || rev > 0;
    const tgt = c || (l.source === 'meta_form' ? unattributed : null); if (!tgt) continue;
    if (c) c.crm_leads++; else tgt.leads++;
    if (won) { tgt.closed++; tgt.revenue = r2(tgt.revenue + rev); }
  }
  const fin = o => ({ ...o, cpl: o.leads ? r2(o.spend / o.leads) : null, ctr_pct: o.impressions ? Math.round(10000 * o.clicks / o.impressions) / 100 : null });
  const campaigns = Object.values(camps).map(c => ({ ...fin(c), roas: c.spend > 0 ? r2(c.revenue / c.spend) : null,
    adsets: Object.values(c.adsets).map(s => ({ ...fin(s), ads: s.ads.map(fin).sort((a, b) => b.spend - a.spend) })).sort((a, b) => b.spend - a.spend) })).sort((a, b) => b.spend - a.spend);
  const tot = campaigns.reduce((t, c) => ({ spend: r2(t.spend + c.spend), leads: t.leads + c.leads, revenue: r2(t.revenue + c.revenue), closed: t.closed + c.closed }), { spend: 0, leads: 0, revenue: 0, closed: 0 });
  return { campaigns, unattributed, totals: { ...tot, cpl: tot.leads ? r2(tot.spend / tot.leads) : null, roas_attributed: tot.spend > 0 ? r2(tot.revenue / tot.spend) : null } };
}

/* ── templates ── */
export function aggregateTemplates(lists, stats = [], { seen = {}, now = Date.now() } = {}) {
  const perf = {};
  for (const s of stats) { const p = perf[s.template] = perf[s.template] || { sends: 0, delivered: 0, read: 0, failed: 0, rejected: 0, replies72: 0, cost: 0 }; for (const k of Object.keys(p)) p[k] = r2(p[k] + (Number(s[k]) || 0)); }
  const out = [];
  for (const w of lists) for (const t of w.templates || []) {
    const p = perf[t.name] || { sends: 0, delivered: 0, read: 0, failed: 0, rejected: 0, replies72: 0, cost: 0 };
    const pending = /PENDING|IN_APPEAL/.test(String(t.status || ''));
    const first = seen[w.key + ':' + t.name];
    out.push({ waba: w.key, waba_id: w.waba, waba_he: w.he, id: String(t.id || ''), name: t.name, language: t.language || '', status: t.status || '', category: t.category || '',
      quality: (t.quality_score && t.quality_score.score) || '', rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : '',
      ...p, delivery_rate: p.sends - p.rejected > 0 ? Math.round(1000 * p.delivered / (p.sends - p.rejected)) / 10 : null, read_rate: p.delivered ? Math.round(1000 * p.read / p.delivered) / 10 : null,
      pending, pending_since: pending && first ? first : null, pending_age_days: pending && first ? Math.floor((now - Date.parse(first)) / 864e5) : null });
  }
  const ord = { REJECTED: 0, PAUSED: 1, DISABLED: 1, PENDING: 2, IN_APPEAL: 2, APPROVED: 3 };
  out.sort((a, b) => (ord[a.status] ?? 4) - (ord[b.status] ?? 4) || b.sends - a.sends || a.name.localeCompare(b.name));
  const by_status = {}; for (const t of out) by_status[t.status] = (by_status[t.status] || 0) + 1;
  return { templates: out, by_status, errors: lists.filter(w => w.error).map(w => ({ waba: w.key, error: w.error })) };
}
/* first time a template is seen in a pending state → its "pending since" (KV map, merged) */
export function updateSeen(seen, lists, nowIso) {
  const next = { ...seen };
  for (const w of lists) for (const t of w.templates || []) { const k = w.key + ':' + t.name; if (/PENDING|IN_APPEAL/.test(String(t.status || ''))) { if (!next[k]) next[k] = nowIso; } else delete next[k]; }
  return next;
}
/* the variant: same components, new name (lowercase a-z0-9_) */
export function variantPayload(tpl, newName) {
  if (!/^[a-z0-9_]{3,60}$/.test(String(newName || ''))) return { error: 'bad-name' };
  if (!tpl || !Array.isArray(tpl.components)) return { error: 'no-source' };
  const components = tpl.components.map(c => { const x = { ...c }; delete x.example_handle; return x; });
  return { payload: { name: newName, language: tpl.language || 'he', category: tpl.category || 'UTILITY', components } };
}

/* ── feedback ── */
export function feedbackRollup(list, { group = 'week' } = {}) {
  const ok = list.filter(f => f.nps || f.exp);
  const avg = xs => { const v = xs.filter(x => x != null && x !== '').map(Number).filter(Number.isFinite); return v.length ? Math.round(10 * v.reduce((a, b) => a + b, 0) / v.length) / 10 : null; };
  const ev = {};
  for (const f of list) { const e = ev[f.token] = ev[f.token] || { token: f.token, name: f.name || '', date: f.date || '', occasion: f.occasion || '', n: 0, nps: [], exp: [], notes: 0, review_clicks: 0 }; e.n++; e.nps.push(f.nps); e.exp.push(f.exp); if (f.note) e.notes++; if (f.clicked_review) e.review_clicks++; }
  const events = Object.values(ev).map(e => ({ ...e, avg_nps: avg(e.nps), avg_exp: avg(e.exp), nps: undefined, exp: undefined, review_url: 'https://ishur.io/feedback.html?t=' + e.token })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const tb = {};
  for (const f of ok) { if (!f.at) continue; const k = bucketOf(String(f.at).slice(0, 10), group); const t = tb[k] = tb[k] || { bucket: k, nps: [], exp: [] }; t.nps.push(f.nps); t.exp.push(f.exp); }
  const trend = Object.values(tb).map(t => ({ bucket: t.bucket, n: t.nps.length, avg_nps: avg(t.nps), avg_exp: avg(t.exp) })).sort((a, b) => a.bucket.localeCompare(b.bucket));
  const promoters = ok.filter(f => Number(f.nps) >= 9).length, detractors = ok.filter(f => Number(f.nps) && Number(f.nps) <= 6).length;
  return { events, trend, totals: { n: list.length, rated: ok.length, avg_nps: avg(ok.map(f => f.nps)), avg_exp: avg(ok.map(f => f.exp)), nps_score: ok.length ? Math.round(100 * (promoters - detractors) / ok.length) : null, notes: list.filter(f => f.note).length, left: list.filter(f => f.left).length } };
}

/* sheet event rows → the fields money needs */
export function eventsForMoney(raw, { isTestEventRow = () => false, planKeyOf = () => '' } = {}) {
  const out = [];
  for (const ev of (raw && raw.events && raw.events.values) || []) {
    const token = String(ev[1] || '').trim(); if (!token || isTestEventRow(ev)) continue;
    const m = String(ev[25] || '').match(/\d{4}-\d{2}-\d{2}/);
    out.push({ token, tok8: token.slice(0, 8), name: String(ev[34] || ev[2] || '').trim(), client: String(ev[2] || '').trim(), phone: String(ev[3] || '').replace(/\D/g, ''), date: String(ev[6] || '').trim().slice(0, 10),
      plan: String(ev[31] || '').trim() || planKeyOf(ev), paid: String(ev[7] || '').trim() === 'כן', cancelled: String(ev[27] || '').trim() === 'כן', paid_day: m ? m[0] : '', sum: num(ev[8]), invoice: String(ev[9] || '').trim() });
  }
  return out;
}

/* ══ §2 I/O ════════════════════════════════════════════════════════════════ */
async function cached(env, key, ttlMs, fresh, fn) {
  if (!fresh && env.RATE) { try { const hit = JSON.parse((await env.RATE.get(key)) || 'null'); if (hit && Date.now() - hit.at < ttlMs) return { ...hit.data, cached: true }; } catch {} }
  const data = await fn();
  if (env.RATE) await env.RATE.put(key, JSON.stringify({ at: Date.now(), data }), { expirationTtl: Math.ceil(ttlMs / 1000) + 60 }).catch(() => {});
  return { ...data, cached: false };
}
const jp = v => { try { return JSON.parse(v); } catch { return null; } };
const kvMap = async (d, env, p) => (d.kvPrefix ? d.kvPrefix(env, p).catch(() => ({})) : {});

async function storeAll(env, t) { try { return await makeStore(env).all(t); } catch { return []; } }

export async function buildFinance(env, d, { range = '90d', fresh = false, balances = null } = {}) {
  const today = d.ilDate(new Date());
  const r = rangeOf(range, today);
  return cached(env, `opsfin:${range}`, 5 * 60e3, fresh, async () => {
    const raw = await d.snapshotCached(env).catch(() => null);
    const events = eventsForMoney(raw, d);
    const aq = kind => d.auditQueryEx(env, { from: r.from.replace(/-/g, ''), to: today.replace(/-/g, ''), kind, limit: 20000, budget: 1500 }).catch(() => ({ items: [], truncated: true }));
    const [pay, calls, wacost, wastat, shircost, evcost, adspend, fixedcost, costman, invKv, asg, bal] = await Promise.all([aq('pay'), aq('call'),
      kvMap(d, env, 'wacost:'), kvMap(d, env, 'wastat:'), kvMap(d, env, 'shircost:'), kvMap(d, env, 'evcost:'), kvMap(d, env, 'adspend:'), kvMap(d, env, 'fixedcost:'), kvMap(d, env, 'costman:'), kvMap(d, env, 'invoice:'),
      storeAll(env, 'hostess_assignments'), balances ? balances().catch(() => null) : null]);
    const entries = revenueEntries(pay.items, events, { parsePaidDesc: d.parsePaidDesc || (() => null) });
    const series = revenueSeries(entries, r);
    /* costs per day → per month */
    const mo = {}; const M = m => (mo[m] = mo[m] || { wa: 0, calls: 0, hostess: 0, wa_estimated: false });
    const days = new Set([...Object.keys(wacost), ...Object.keys(wastat)]);
    for (const day of days) {
      if (wacost[day] != null) M(day.slice(0, 7)).wa += Number(wacost[day]) || 0;
      else { const st = jp(wastat[day]) || {}; const x = M(day.slice(0, 7)); x.wa += (Number(st.tmpl) || 0) * 0.0053 * USD_ILS; x.wa_estimated = true; }
    }
    for (const [day, v] of Object.entries(shircost)) M(day.slice(0, 7)).calls += (Number(v) || 0) / 100 * USD_ILS;
    const hostessPay = {}; let owed = 0, paidOut = 0;
    for (const a of asg) {
      const p = Number(a.pay) || 0; if (!p || a.status === 'proposed') continue;
      const t8 = String(a.event_token || '').slice(0, 8); hostessPay[t8] = (hostessPay[t8] || 0) + p;
      if (a.date) M(String(a.date).slice(0, 7)).hostess += p;
      if (a.status === 'paid') paidOut += p; else owed += p;
    }
    const revM = {}; for (const e of entries) for (const l of e.lines) revM[e.day.slice(0, 7)] = (revM[e.day.slice(0, 7)] || 0) + l.ils;
    const months = monthsBetween(r.from, today).map(m => {
      const fx = jp(fixedcost['fixedcost:' + m] ?? fixedcost[m]) || [];
      const man = jp(costman['costman:' + m] ?? costman[m]) || {};
      const c = mo[m] || { wa: 0, calls: 0, hostess: 0 };
      return { ...pnlMonth({ month: m, revenue: revM[m] || 0, wa: c.wa, calls: c.calls, hostess: c.hostess, ads: Number(adspend['adspend:' + m] ?? adspend[m]) || 0,
        fixed: fx.reduce((s, x) => s + (Number(x.ils) || 0), 0), manual: Object.values(man).reduce((s, v) => s + (Number(v) || 0), 0) }), fixed_items: fx, manual_items: man, wa_estimated: !!c.wa_estimated };
    });
    const callsIls = {}; for (const c of calls.items || []) { const t8 = String(c.token || '').slice(0, 8); if (t8) callsIls[t8] = (callsIls[t8] || 0) + (Number(c.cost) || 0); }
    const evcostIls = {}; for (const [k, v] of Object.entries(evcost)) evcostIls[k.replace(/^evcost:/, '')] = (Number(v) || 0) / 100;
    const invByToken = {}; for (const [k, v] of Object.entries(invKv)) invByToken[k.replace(/^invoice:/, '')] = jp(v);
    const meta = bal && bal.vendors ? Object.fromEntries(bal.vendors.map(v => [v.vendor, v])) : {};
    return { ok: true, at: new Date().toISOString(), range: r, usd_ils: USD_ILS,
      revenue: { series, kinds: REV_KINDS, total: r2(series.reduce((s, x) => s + x.total, 0)), payments: series.reduce((s, x) => s + x.payments, 0),
        by_kind: Object.fromEntries(REV_KINDS.map(k => [k, r2(series.reduce((s, x) => s + x[k], 0))])), entries: entries.filter(e => e.day >= r.from).slice(-300).reverse() },
      pnl: months, growth: growth(months),
      vendors: { meta_wa: meta.meta_wa ? { spend_mtd_usd: meta.meta_wa.amount, wabas: meta.meta_wa.extra.wabas || [] } : null,
        telnyx: meta.telnyx ? { balance_usd: meta.telnyx.amount } : null, meta_ads: meta.meta_ads ? { owed_ils: meta.meta_ads.extra.balance_owed, spent_ils: meta.meta_ads.extra.amount_spent } : null,
        calls_mtd_ils: r2((mo[today.slice(0, 7)] || {}).calls || 0), manual_vendors: MANUAL_VENDORS },
      adspend: Object.fromEntries(Object.entries(adspend).map(([k, v]) => [k.replace(/^adspend:/, ''), Number(v) || 0])),
      fixedcost: Object.fromEntries(Object.entries(fixedcost).map(([k, v]) => [k.replace(/^fixedcost:/, ''), jp(v) || []])),
      events: eventEconomics(events, { entries, evcostIls, callsIls, hostessPay }),
      invoices: invoiceRows(events, invByToken),
      cash: { hostess_owed: r2(owed), hostess_paid: r2(paidOut), meta_ads_owed: meta.meta_ads ? meta.meta_ads.extra.balance_owed : null, telnyx_balance_usd: meta.telnyx ? meta.telnyx.amount : null },
      estimates: ['revenue split of package payments that include hostesses/design (list price)', 'WhatsApp cost on days without wacost (tmpl × $0.0053)', 'calls ₪ = Retell USD × 3.7', 'per-event msgs = evcost − audited calls'],
      audit_truncated: !!(pay.truncated || calls.truncated), sources: { snapshot: !!raw, pay_rows: (pay.items || []).length, hostess_assignments: asg.length } };
  });
}

export async function setManualCost(env, b) {
  const m = String(b.month || ''), v = String(b.vendor || ''), ils = Number(b.ils);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return { status: 400, body: { ok: false, error: 'bad-month' } };
  if (!MANUAL_VENDORS.includes(v)) return { status: 400, body: { ok: false, error: 'unknown-vendor', vendors: MANUAL_VENDORS } };
  if (!Number.isFinite(ils) || ils < 0) return { status: 400, body: { ok: false, error: 'bad-amount' } };
  const cur = jp(await env.RATE.get('costman:' + m)) || {}; cur[v] = Math.round(ils * 100) / 100;
  await env.RATE.put('costman:' + m, JSON.stringify(cur));
  return { status: 200, body: { ok: true, month: m, manual: cur } };
}

/* re-send an invoice that ALREADY exists. Preview without confirm; confirm must equal the token's first 8. */
export async function invoiceResend(env, d, b, now = Date.now()) {
  const token = String(b.token || '').trim(); if (!/^[0-9a-f-]{36}$/.test(token)) return { status: 400, body: { ok: false, error: 'bad-token' } };
  const inv = jp(await env.RATE.get('invoice:' + token));
  const url = inv && (inv.url || inv.link);
  if (!url) return { status: 404, body: { ok: false, error: 'no-invoice' } };
  const raw = await d.snapshotCached(env).catch(() => null);
  const ev = eventsForMoney(raw, d).find(e => e.token === token);
  const phone = d.normPhone(String(b.phone || (ev && ev.phone) || ''));
  const tmpl = await env.RATE.get('invoicetmpl');
  const word = token.slice(0, 8);
  const preview = { token, name: ev ? ev.name : '', phone, url, number: inv.number || inv.num || '', template: tmpl || null, confirm_required: word };
  if (String(b.confirm || '') !== word) return { status: 200, body: { ok: true, preview, applied: false } };
  if (!tmpl) return { status: 409, body: { ok: false, error: 'no-invoice-template', preview } };
  if (!phone) return { status: 409, body: { ok: false, error: 'no-phone', preview } };
  if (!clientHoursOpen(now)) return { status: 409, body: { ok: false, error: 'outside-client-hours', he: 'אין הודעות ללקוחות בין 21:00 ל-09:00', preview } };
  if (!d.sendClient) return { status: 501, body: { ok: false, error: 'send-not-wired' } };
  const first = ((ev && ev.client) || '').split(' ')[0] || 'לקוח יקר';
  const sent = await d.sendClient(env, phone, tmpl, [first, url], { token });
  if (d.auditRecord) await d.auditRecord(env, { kind: 'admin', area: 'חשבוניות', action: 'חשבונית נשלחה שוב מהמרכז', ok: !!(sent && sent.ok), phone, token, detail: url }).catch(() => {});
  return { status: 200, body: { ok: !!(sent && sent.ok), applied: true, error: sent && !sent.ok ? sent.error : undefined, preview } };
}

export async function buildAds(env, d, { range = '30d', fresh = false } = {}) {
  const today = d.ilDate(new Date());
  const r = rangeOf(range, today);
  return cached(env, `opsads:${range}`, 10 * 60e3, fresh, async () => {
    const tr = encodeURIComponent(JSON.stringify({ since: r.from, until: r.to }));
    const fields = 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,inline_link_clicks,actions';
    const [ins, leads, clients, fin, traffic] = await Promise.all([
      d.metaAds ? d.metaAds(env, `/${d.META_AD_ACCOUNT}/insights?level=ad&time_range=${tr}&fields=${fields}&limit=500`, 'GET').catch(() => null) : null,
      storeAll(env, 'leads'), storeAll(env, 'clients'),
      buildFinance(env, d, { range, fresh: false }).catch(() => null),
      d.trafficReport ? d.trafficReport(env, Math.min(90, r.days)).catch(() => null) : null]);
    const rows = (ins && ins.ok && ins.data && ins.data.data) || [];
    const revenueByPhone = {};
    for (const e of (fin && fin.revenue && fin.revenue.entries) || []) if (e.phone) { const k = String(e.phone).slice(-9); revenueByPhone[k] = r2((revenueByPhone[k] || 0) + e.sum); }
    for (const c of clients) if (c.phone && c.paid_sum && !revenueByPhone[String(c.phone).slice(-9)]) revenueByPhone[String(c.phone).slice(-9)] = num(c.paid_sum);
    const inRange = l => { const day = l.created_at ? ilDay(Date.parse(l.created_at)) : ''; return day >= r.from && day <= r.to; };
    const tree = adsTree(rows, { leads: leads.filter(inRange), revenueByPhone });
    const revenue = fin && fin.revenue ? fin.revenue.total : null;
    return { ok: true, at: new Date().toISOString(), range: r, ...tree, shalev_campaign: SHALEV_CAMPAIGN,
      blended: { revenue, spend: tree.totals.spend, roas: revenue != null && tree.totals.spend > 0 ? r2(revenue / tree.totals.spend) : null },
      traffic: traffic ? { days: traffic.days || traffic.series || null, today: traffic.today || null, totals: traffic.totals || null } : null,
      meta_error: ins && !ins.ok ? JSON.stringify(ins.data || '').slice(0, 200) : (ins ? '' : 'no META_ADS_TOKEN') };
  });
}

function wabaToken(env, d, key) { return key === 'guests' || key === 'portfolio' ? env.WA_TOKEN_GUESTS : env.WA_TOKEN; }
async function listTemplates(env, d, w, fetchFn = fetch) {
  const tok = wabaToken(env, d, w.key); if (!tok) return { ...w, templates: [], error: 'no-token' };
  const out = []; let url = `https://graph.facebook.com/v21.0/${w.waba}/message_templates?fields=id,name,status,category,language,quality_score,rejected_reason&limit=200`;
  for (let i = 0; i < 5 && url; i++) {
    const res = await fetchFn(url, { headers: { Authorization: 'Bearer ' + tok } }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    if (!j || !j.data) return { ...w, templates: out, error: (j && j.error && j.error.message) || 'http ' + (res ? res.status : 'unreachable') };
    out.push(...j.data); url = j.paging && j.paging.next;
  }
  return { ...w, templates: out };
}
export async function buildTemplates(env, d, { fresh = false, days = 30 } = {}) {
  return cached(env, 'opstpl', 10 * 60e3, fresh, async () => {
    const lists = await Promise.all(WABAS.map(w => listTemplates(env, d, w)));
    let stats = [], partial = false;
    try { const lr = await tstatsLoadRows(env, days, { queryDay: (e, day) => d.auditQuery(e, { from: day, to: day, limit: 20000 }), budget: 3 }); stats = computeTemplateStats(lr.rows, { now: Date.now() }).rows; partial = lr.missing.length > 0; } catch { partial = true; }
    const seen0 = jp(await env.RATE.get('tplseen')) || {};
    const seen = updateSeen(seen0, lists, new Date().toISOString());
    await env.RATE.put('tplseen', JSON.stringify(seen)).catch(() => {});
    return { ok: true, at: new Date().toISOString(), days, stats_partial: partial, wabas: WABAS, ...aggregateTemplates(lists, stats, { seen }) };
  });
}
export async function templateVariant(env, d, b, fetchFn = fetch) {
  const w = WABAS.find(x => x.key === b.waba); if (!w) return { status: 400, body: { ok: false, error: 'unknown-waba', wabas: WABAS.map(x => x.key) } };
  const tok = wabaToken(env, d, w.key); if (!tok) return { status: 503, body: { ok: false, error: 'no-token' } };
  const name = String(b.name || ''), nn = String(b.new_name || '');
  const res = await fetchFn(`https://graph.facebook.com/v21.0/${w.waba}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,category,components`, { headers: { Authorization: 'Bearer ' + tok } }).catch(() => null);
  const j = res ? await res.json().catch(() => null) : null;
  const src = ((j && j.data) || []).find(t => t.name === name);
  const v = variantPayload(src, nn); if (v.error) return { status: 400, body: { ok: false, error: v.error } };
  if (String(b.confirm || '') !== nn) return { status: 200, body: { ok: true, applied: false, confirm_required: nn, preview: v.payload } };
  const pr = await fetchFn(`https://graph.facebook.com/v21.0/${w.waba}/message_templates`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(v.payload) }).catch(() => null);
  const pj = pr ? await pr.json().catch(() => ({})) : {};
  if (env.RATE) await env.RATE.delete('opstpl').catch(() => {});
  return { status: 200, body: { ok: !!(pr && pr.ok), applied: true, meta: pj } };
}

export async function buildFeedback(env, d, { fresh = false, group = 'week' } = {}) {
  return cached(env, 'opsfb:' + group, 5 * 60e3, fresh, async () => {
    const raw = await d.snapshotCached(env).catch(() => null);
    const evs = {}; for (const r of ((raw && raw.events && raw.events.values) || [])) { const t = String(r[1] || '').trim(); if (t) evs[t] = { name: String(r[34] || r[2] || '').trim(), client: String(r[2] || '').trim(), occasion: String(r[5] || '').trim(), date: String(r[6] || '').trim().slice(0, 10), plan: String(r[31] || '').trim() }; }
    const all = await kvMap(d, env, 'fb:');
    const list = [];
    for (const [k, s] of Object.entries(all)) {
      const v = jp(s); if (!v) continue;
      const [token, who] = k.replace(/^fb:/, '').split(':');
      list.push({ token, who: who === '2' ? 2 : 1, ...(evs[token] || {}), nps: v.nps || null, exp: v.exp || null, route: v.route || '', note: v.note || '', at: v.at || v.note_at || '', clicked_clip: v.clicked_clip || '', clicked_review: v.clicked_review || '', left: v.left || '' });
    }
    list.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return { ok: true, at: new Date().toISOString(), feedback: list, ...feedbackRollup(list, { group }) };
  });
}
