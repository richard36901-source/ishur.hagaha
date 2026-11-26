import test from 'node:test';
import assert from 'node:assert/strict';
import { normRow, mergeRows, monthFixedItems, callTopups, applyToSeries, missingCharges, rowIls } from '../vendorexp.js';

const share = { make: 0.91, retell: 1, telnyx: 1, cloudflare: 1, monday: 1, anthropic: 1 };

test('normRow: Make of a client organisation is not ishur; Richard Main is', () => {
  assert.equal(normRow({ date: '2026-11-13', vendor: 'Make (Celonis)', amount: 15.06, currency: 'USD', ref: 'a', desc: 'Make Core plan (organization ID: 7008811)' }), null);
  assert.equal(normRow({ date: '2026-11-08', vendor: 'Make (Celonis)', amount: 51.2, currency: 'USD', ref: 'b', desc: 'Core 80000 (organization ID: 5881669)' }).vendor, 'make');
  assert.equal(normRow({ date: '2026-11-08', vendor: 'HighLevel', amount: 10, currency: 'USD', ref: 'c' }), null);
  assert.equal(normRow({ date: '2026-11-08', vendor: 'Telnyx', amount: null, ref: 'd' }), null);
});

test('mergeRows: the same receipt twice, and a Stripe Link copy of a Retell receipt, are one charge', () => {
  const by = {};
  mergeRows(by, [{ date: '2026-11-24', vendor: 'Retell AI', amount: 11, currency: 'USD', ref: '2648-4514', source: 'gmail' }]);
  const ch = mergeRows(by, [{ date: '2026-11-24', vendor: 'Retell AI', amount: 11, currency: 'USD', ref: '2648-4514', source: 'gmail' },
    { date: '2026-11-24', vendor: 'Retell AI', amount: 11, currency: 'USD', ref: 'cltxn_1Uf', source: 'spark' }]);
  assert.deepEqual(ch, {});
  assert.equal(by['2026-11'].length, 1);
});

test('monthFixedItems: a vendor with a real charge replaces its recurring row, on the charge day; others stay', () => {
  const rec = [{ name: 'Make', ils: 35, day: 10 }, { name: 'Monday', ils: 228, day: 10 }, { name: 'Retell', ils: 0, day: 10 }];
  const rows = [normRow({ date: '2026-11-08', vendor: 'Make', amount: 51.2, currency: 'USD', ref: 'x', desc: 'org 5881669' }), normRow({ date: '2026-11-23', vendor: 'Make', amount: 8.1, currency: 'USD', ref: 'y', desc: 'organization ID: 5881669' })];
  const out = monthFixedItems(rec, rows, share);
  assert.equal(out.filter((x) => /^Make$/.test(x.name)).length, 0);
  assert.ok(out.find((x) => x.name === 'Monday' && x.ils === 228));
  assert.ok(!out.find((x) => x.name === 'Retell'));
  const mk = out.filter((x) => x.actual);
  assert.deepEqual(mk.map((x) => x.day), [8, 23]);
  assert.equal(mk[0].ils, Math.round(51.2 * 3.7 * 0.91 * 100) / 100);
});

test('callTopups + applyToSeries: a month with top-ups is costed by them, usage kept aside; a month without keeps usage', () => {
  const vx = { '2026-11': [normRow({ date: '2026-11-24', vendor: 'Telnyx', amount: 50, currency: 'USD', ref: 't1' })], '2026-10': [] };
  assert.equal(callTopups(vx['2026-10'], share), null);
  const series = [{ date: '2026-11-24', shir_cost_usd_cents: 120 }, { date: '2026-11-20', shir_cost_usd_cents: 300 }, { date: '2026-10-05', shir_cost_usd_cents: 77 }];
  applyToSeries(series, vx, share);
  assert.equal(series[0].shir_cost_usd_cents, 5000);
  assert.equal(series[0].shir_usage_usd_cents, 120);
  assert.equal(series[1].shir_cost_usd_cents, 0);
  assert.equal(series[2].shir_cost_usd_cents, 77);
});

test('missingCharges: a recurring vendor 5+ days past its day with no charge is named; one with a charge is not', () => {
  const rec = [{ name: 'Monday', day: 10 }, { name: 'Make', day: 8 }, { name: 'SIM 4499', day: 10 }];
  const rows = [normRow({ date: '2026-11-08', vendor: 'Make', amount: 51.2, currency: 'USD', ref: 'x', desc: 'org 5881669' })];
  assert.deepEqual(missingCharges(rec, rows, '2026-11-16'), ['Monday']);
  assert.deepEqual(missingCharges(rec, rows, '2026-11-12'), []);
  assert.equal(rowIls(rows[0], { make: 1 }), Math.round(51.2 * 3.7 * 100) / 100);
});

test('ledgerRows: maps the HUB Ledger by its header; a Make bill without the ishur org is left out', async () => {
  const { ledgerRows } = await import('../vendorexp.js');
  const v = [['hash', 'vendor', 'invoice_number', 'doc_date', 'amount', 'currency', 'vat', 'period', 'doc_type', 'source', 'source_ref', 'file', 'url', 'morning', 'status', 'created', 'notes'],
    ['h1', 'Telnyx, LLC', 'T-1', '2026-11-24', '50.00', 'USD', '', '', 'receipt', '', '', '', '', '', '', '', ''],
    ['h2', 'Celonis Inc.', 'M-1', '2026-11-13', '15.06', 'USD', '', '', 'receipt', '', '', '', '', '', '', '', 'org 7008811'],
    ['h3', 'Celonis Inc.', 'M-2', '2026-11-23', '8.10', 'USD', '', '', 'receipt', '', '', '', '', '', '', '', 'organization ID: 5881669'],
    ['h4', 'HighLevel', 'G-1', '2026-11-02', '10', 'USD', '', '', 'receipt', '', '', '', '', '', '', '', '']];
  const r = ledgerRows(v).map((x) => [x.vendor, x.ref, x.amount]);
  assert.deepEqual(r, [['Telnyx, LLC', 'T-1', 50], ['Celonis Inc.', 'M-2', 8.1], ['HighLevel', 'G-1', 10]]);
});

test('ledgerRows: ECLTTLZP = ishur Make org; an unnumbered receipt of a numbered invoice and HUB-unsure rows are skipped', async () => {
  const { ledgerRows } = await import('../vendorexp.js');
  const H = ['hash', 'vendor', 'invoice_number', 'doc_date', 'amount', 'currency', 'vat', 'period', 'doc_type', 'source', 'source_ref', 'file', 'url', 'morning', 'status', 'created', 'notes'];
  const row = (h, v, ref, d, a, notes = '') => [h, v, ref, d, a, 'USD', '', '', 'invoice', '', '', '', '', '', '', '', notes];
  const r = ledgerRows([H, row('1', 'Celonis Inc. (Make.com)', 'ECLTTLZP-0048', '2026-11-24', '8.10'), row('2', 'Celonis Inc. (Make.com)', 'TEOQQBQV-0016', '2026-11-13', '15.06'),
    row('3', 'Retell AI', 'AGOLUBXB-0015', '2026-11-24', '11.00'), row('4', 'Retell AI', '', '2026-11-24', '11.00'), row('5', 'Telnyx LLC', 'b19', '2026-11-24', '20.00', 'המודל לא בטוח שזה מסמך חיוב')]);
  assert.deepEqual(r.map((x) => x.ref), ['ECLTTLZP-0048', 'AGOLUBXB-0015']);
  assert.equal(r[0].org, '5881669');
});

test('chargeLabel: short Hebrew labels', async () => {
  const { chargeLabel } = await import('../vendorexp.js');
  assert.equal(chargeLabel({ vendor: 'make', desc: 'Make - 1,000 extra credits (organization ID: 5881669)' }), 'Make · קרדיטים נוספים');
  assert.equal(chargeLabel({ vendor: 'make', desc: 'Nov 8–Dec 8 | Make Core plan (80000 credits / month)' }), 'Make · מנוי');
  assert.equal(chargeLabel({ vendor: 'cloudflare', desc: '2026/11-12' }), 'Cloudflare · חשבון חודשי');
});
