import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPay, revenueEntries, revenueSeries, pnlMonth, growth, monthsBetween, eventEconomics, invoiceRows, adsTree, aggregateTemplates, updateSeen, variantPayload, feedbackRollup } from '../ops-money.js';

const parsePaidDesc = (d) => { const m = d.match(/(\d{2,4})\s*(?:מוזמנים|רשומות)/); if (!m) return null; const hx = d.match(/(\d)\s*דיילות/); return { tier: +m[1], hostess: hx ? +hx[1] : /דייל/.test(d) ? 1 : 0 }; };
const pay = (desc, sum, extra = {}) => ({ kind: 'pay', ts: Date.parse('2026-10-25T10:00:00Z'), id: 'p' + desc.length + sum, data: { ipn: { paymentDesc: desc, paymentSum: String(sum), asmachta: extra.ref || 'r' + sum, payerPhone: extra.phone || '0501234567' } } });

test('classifyPay: plain package, add-on, hostess-only, package+hostess split', () => {
  assert.deepEqual(classifyPay(pay('200 רשומות פרמיום', 279), { parsePaidDesc }).lines, [{ kind: 'package', ils: 279, estimated: false }]);
  assert.equal(classifyPay(pay('תוספת 50 מוזמנים · ab12cd34', 35), { parsePaidDesc }).lines[0].kind, 'addon');
  assert.equal(classifyPay(pay('תוספת 50 מוזמנים · ab12cd34', 35), { parsePaidDesc }).tok8, 'ab12cd34');
  assert.equal(classifyPay(pay('נסיעות דיילות', 250), { parsePaidDesc }).lines[0].kind, 'hostess');
  const s = classifyPay(pay('300 רשומות פרמיום + 2 דיילות', 2369), { parsePaidDesc }).lines;
  assert.deepEqual(s.map(l => l.kind), ['package', 'hostess']);
  assert.equal(s[0].ils + s[1].ils, 2369);
  assert.equal(s[1].ils, 1990); assert.ok(s[0].estimated && s[1].estimated);
  assert.equal(classifyPay({ kind: 'call' }), null);
});

test('revenueEntries: pay rows win, sheet events fill gaps, dedupe by ref and phone', () => {
  const rows = [pay('200 רשומות בסיס', 199, { ref: 'A', phone: '0501111111' }), pay('200 רשומות בסיס', 199, { ref: 'A', phone: '0501111111' })];
  const events = [{ paid: true, paid_day: '2026-10-25', sum: 199, tok8: 'aaaa1111', phone: '972501111111', name: 'x' }, { paid: true, paid_day: '2026-10-20', sum: 95, tok8: 'bbbb2222', phone: '972502222222', name: 'y' }, { paid: true, cancelled: true, paid_day: '2026-10-20', sum: 50, tok8: 'c' }];
  const e = revenueEntries(rows, events, { parsePaidDesc });
  assert.equal(e.length, 2);
  assert.deepEqual(e.map(x => x.source), ['sheet', 'grow']);
  const s = revenueSeries(e, { from: '2026-10-19', to: '2026-10-26', group: 'day' });
  assert.equal(s.length, 8);
  assert.equal(s.reduce((a, x) => a + x.total, 0), 294);
  assert.equal(s.find(x => x.bucket === '2026-10-25').package, 199);
});

test('pnlMonth: gross = revenue − variable; net subtracts ads, fixed, manual; margins', () => {
  const p = pnlMonth({ month: '2026-10', revenue: 10000, wa: 300, calls: 200, hostess: 1500, ads: 2000, fixed: 500, manual: 100 });
  assert.equal(p.gross, 8000); assert.equal(p.net, 5400); assert.equal(p.costs.total, 4600);
  assert.equal(p.gross_margin_pct, 80); assert.equal(p.margin_pct, 54);
  assert.equal(pnlMonth({ month: 'x', revenue: 0, ads: 100 }).margin_pct, null);
  assert.equal(pnlMonth({ month: 'x', revenue: 0, ads: 100 }).net, -100);
});

test('growth: MoM % and cumulative totals', () => {
  const g = growth([{ month: '2026-09', revenue: 1000, net: 200 }, { month: '2026-10', revenue: 1500, net: 300 }, { month: '2026-11', revenue: 750, net: -50 }]);
  assert.deepEqual(g.map(x => x.mom_pct), [null, 50, -50]);
  assert.deepEqual(g.map(x => x.cum_revenue), [1000, 2500, 3250]);
  assert.equal(g[2].cum_net, 450);
  assert.deepEqual(monthsBetween('2026-11-20', '2027-02-01'), ['2026-11', '2026-12', '2027-01', '2027-02']);
});

test('eventEconomics: revenue + add-ons, msgs = evcost − calls, margin', () => {
  const events = [{ token: 't1', tok8: 'aaaa1111', name: 'A', date: '2026-11-10', paid: true, sum: 449 }, { token: 't2', tok8: 'bbbb2222', paid: false, sum: 0 }];
  const entries = [{ source: 'grow', tok8: 'aaaa1111', lines: [{ kind: 'addon', ils: 35 }] }];
  const [r] = eventEconomics(events, { entries, evcostIls: { aaaa1111: 60 }, callsIls: { aaaa1111: 20 }, hostessPay: { aaaa1111: 300 } });
  assert.equal(r.revenue, 484); assert.equal(r.msgs_cost, 40); assert.equal(r.calls_cost, 20); assert.equal(r.hostess_pay, 300);
  assert.equal(r.margin, 124); assert.equal(r.margin_pct, 25.6);
  assert.equal(eventEconomics(events, {}).length, 1);
  const inv = invoiceRows([{ token: 'T', tok8: 'T', paid: true, sum: 1 }, { token: 'U', tok8: 'U', paid: true, sum: 2, invoice: '40012' }], { T: { url: 'https://x', number: '1' } });
  assert.deepEqual(inv.map(i => i.status), ['issued', 'issued']);
  assert.equal(invoiceRows([{ token: 'V', paid: true, sum: 1 }]).at(0).status, 'pending');
});

test('adsTree: rollup, CPL, ROAS from closed leads, Shalev read-only, unattributed', () => {
  const rows = [
    { campaign_id: 'C1', campaign_name: 'Main', adset_id: 'S1', adset_name: 's', ad_id: 'A1', ad_name: 'a1', spend: '300', impressions: '1000', clicks: '50', actions: [{ action_type: 'lead', value: '3' }] },
    { campaign_id: 'C1', campaign_name: 'Main', adset_id: 'S1', adset_name: 's', ad_id: 'A2', ad_name: 'a2', spend: '100', impressions: '1000', clicks: '10', actions: [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '1' }, { action_type: 'lead', value: '9' }] },
    { campaign_id: '120250670197650731', campaign_name: 'Shalev', adset_id: 'S2', ad_id: 'A3', spend: '200', impressions: '0', clicks: '0', actions: [] },
  ];
  const leads = [{ phone: '972501111111', origin: { campaign: 'Main' }, status: 'closed' }, { phone: '972502222222', origin: { campaign: 'Main' }, status: 'new' }, { phone: '972503333333', source: 'meta_form', status: 'closed' }];
  const t = adsTree(rows, { leads, revenueByPhone: { 501111111: 800, 503333333: 100 } });
  const main = t.campaigns.find(c => c.id === 'C1');
  assert.equal(main.spend, 400); assert.equal(main.leads, 4); assert.equal(main.cpl, 100);
  assert.equal(main.revenue, 800); assert.equal(main.closed, 1); assert.equal(main.roas, 2); assert.equal(main.crm_leads, 2);
  assert.equal(main.adsets[0].ads[0].id, 'A1');
  const sh = t.campaigns.find(c => c.id === '120250670197650731');
  assert.ok(sh.read_only); assert.equal(sh.owner, 'שלו'); assert.equal(sh.roas, 0); assert.equal(sh.cpl, null);
  assert.deepEqual(t.unattributed, { leads: 1, closed: 1, revenue: 100 });
  assert.equal(t.totals.spend, 600); assert.equal(t.totals.roas_attributed, 1.33);
});

test('templates: aggregation across WABAs, perf join, pending age, variant payload', () => {
  const lists = [{ key: 'guests', waba: 'G', he: 'g', templates: [{ name: 'hazmana', status: 'APPROVED', category: 'UTILITY', quality_score: { score: 'GREEN' } }, { name: 'new_one', status: 'PENDING' }] },
    { key: 'old', waba: 'O', he: 'o', templates: [{ name: 'hazmana', status: 'REJECTED', rejected_reason: 'TAG_CONTENT_MISMATCH' }] }, { key: 'portfolio', waba: 'P', templates: [], error: 'no-token' }];
  const stats = [{ template: 'hazmana', sends: 100, rejected: 0, delivered: 90, read: 45, failed: 5, replies72: 30, cost: 2 }, { template: 'hazmana', sends: 10, delivered: 10, read: 5 }];
  const seen = updateSeen({ 'guests:hazmana': 'old' }, lists, '2026-10-30T00:00:00Z');
  assert.deepEqual(seen, { 'guests:new_one': '2026-10-30T00:00:00Z' });
  const a = aggregateTemplates(lists, stats, { seen, now: Date.parse('2026-11-03T00:00:00Z') });
  assert.equal(a.templates.length, 3);
  assert.equal(a.templates[0].status, 'REJECTED');
  const h = a.templates.find(t => t.waba === 'guests' && t.name === 'hazmana');
  assert.equal(h.sends, 110); assert.equal(h.delivered, 100); assert.equal(h.read_rate, 50); assert.equal(h.quality, 'GREEN'); assert.equal(h.delivery_rate, 90.9);
  assert.equal(a.templates.find(t => t.name === 'new_one').pending_age_days, 4);
  assert.deepEqual(a.by_status, { REJECTED: 1, PENDING: 1, APPROVED: 1 });
  assert.deepEqual(a.errors, [{ waba: 'portfolio', error: 'no-token' }]);
  assert.equal(variantPayload({ components: [] }, 'Bad Name').error, 'bad-name');
  assert.equal(variantPayload(null, 'ok_name').error, 'no-source');
  assert.deepEqual(variantPayload({ language: 'he', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] }, 'hazmana_v3').payload, { name: 'hazmana_v3', language: 'he', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] });
});

test('feedbackRollup: per event, trend, NPS score', () => {
  const list = [{ token: 'a', name: 'A', nps: 10, exp: 9, at: '2026-10-26T10:00:00Z' }, { token: 'a', nps: 6, exp: 8, at: '2026-10-27T10:00:00Z', note: 'x' }, { token: 'b', nps: 9, exp: 10, at: '2026-11-02T10:00:00Z' }, { token: 'c', left: '1' }];
  const r = feedbackRollup(list, { group: 'week' });
  assert.equal(r.totals.n, 4); assert.equal(r.totals.rated, 3); assert.equal(r.totals.avg_nps, 8.3); assert.equal(r.totals.nps_score, 33);
  const a = r.events.find(e => e.token === 'a'); assert.equal(a.n, 2); assert.equal(a.avg_nps, 8); assert.equal(a.notes, 1); assert.ok(a.review_url.endsWith('?t=a'));
  assert.deepEqual(r.trend.map(t => [t.bucket, t.n]), [['2026-10-25', 2], ['2026-11-01', 1]]);
});
