import test from 'node:test'; import assert from 'node:assert/strict';
import { monthCut, isReportDay, monthIncome, reportText, reportHtml, periodicReport, REPORT_URL } from '../periodic-report.js';
const INC = { '2026-10-30': { revenue: 500, vat: 76.27, fees: 9, payments: 1 }, '2026-11-02': { revenue: 1180, vat: 180, fees: 20.5, payments: 2 }, '2026-11-15': { revenue: 590, vat: 90, fees: 10, payments: 1, fee_estimated: true }, '2026-11-16': { revenue: 236, vat: 36, fees: 4.5, payments: 1 }, '2026-11-20': { revenue: 999, vat: 152.39, fees: 0, payments: 1 } };
const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
test('every third day, in a rhythm that does not restart with the month', () => {
  const days = []; for (let i = 0; i < 12; i++) days.push(new Date(Date.UTC(2026, 10, 25 + i, 12)).toISOString().slice(0, 10));
  const due = days.filter(isReportDay); assert.equal(due.length, 4); for (let i = 1; i < due.length; i++) assert.equal((Date.parse(due[i]) - Date.parse(due[i - 1])) / 86400e3, 3); assert.equal(isReportDay('junk'), false);
});
test('month income: only this month, only up to today; the last three days separately', () => {
  const m = monthIncome(INC, '2026-11', '2026-11-16');
  assert.deepEqual([m.revenue, m.vat, m.fees, m.payments, m.after_vat, m.last3, m.fee_estimated], [2006, 306, 35, 4, 1700, 826, true]);
});
test('text: title, one fact per line, action footer and the link; the email body is escaped', () => {
  const t = reportText(monthIncome(INC, '2026-11', '2026-11-16'), '2026-11', '2026-11-16').split('\n');
  assert.match(t[0], /^📊 \*הדוח התקופתי · נובמבר 2026\* \(עד 16\/11\)$/); assert.equal(t[1], ''); assert.ok(t.includes('• הכנסות החודש: ₪2,006 · 4 תשלומים')); assert.ok(t.includes('• אחרי מע״מ: ₪1,700 (מע״מ לתשלום ₪306)'));
  assert.ok(t.includes('• עמלות סליקה: ₪35 (חלקן הערכה)')); assert.match(t[t.length - 2], /^מה לעשות: /); assert.equal(t[t.length - 1], REPORT_URL); assert.ok(!t.some(l => /חלקית/.test(l)));
  assert.ok(reportText(monthIncome(INC, '2026-11', '2026-11-16'), '2026-11', '2026-11-16', { truncated: true }).includes('נקרא חלקית'));
  const h = reportHtml('*כותרת* <script>\nhttps://ishur.io/next/report.html'); assert.ok(h.includes('<b>כותרת</b>')); assert.ok(h.includes('&lt;script&gt;')); assert.ok(h.includes('<a href="https://ishur.io/next/report.html">'));
});
test('sent once on a report day from 09:00, to Slack and by email; not on other days, not twice, not without income data', async () => {
  const env = { RATE: kv() }, slack = [], mails = []; const due = ['2026-11-25', '2026-11-26', '2026-11-27'].find(isReportDay), other = ['2026-11-25', '2026-11-26', '2026-11-27'].find(d => !isReportDay(d));
  const at = (d, hm) => Date.parse(`${d}T${hm}:00+02:00`);
  const run = (now, extra = {}) => periodicReport(env, { now, income: async () => ({ income: INC }), post: async (t, o) => slack.push([t, o]), mail: async m => { mails.push(m); return { ok: true }; }, to: 'owner@example.com', ...extra });
  assert.equal((await run(at(other, '10:00'))).why, 'not-due'); assert.equal((await run(at(due, '08:00'))).why, 'not-due');
  assert.equal((await run(at(due, '10:00'), { income: async () => null })).why, 'no-income-data'); assert.equal(env.RATE.m.size, 0, 'a failed read does not burn the day');
  assert.deepEqual(await run(at(due, '10:00')), { sent: true, slack: true, email: true, email_error: undefined });
  assert.equal((await run(at(due, '11:00'))).why, 'already-sent'); assert.equal(slack.length, 1); assert.equal(mails.length, 1);
  assert.equal(slack[0][1].important, true); assert.equal(mails[0].to, 'owner@example.com'); assert.ok(!/[*]/.test(mails[0].text)); assert.match(mails[0].subject, /^הדוח התקופתי · נובמבר 2026/);
});

test('a cut read of the payment log is flagged only when it touches this month, and the report names the day', () => {
  assert.equal(monthCut({ truncated: false }, '2026-11'), false);
  assert.equal(monthCut({ truncated: true, oldest: Date.parse('2026-10-20T10:00:00Z') }, '2026-11'), false, 'read back into October: November is whole');
  assert.match(monthCut({ truncated: true, oldest: Date.parse('2026-11-09T10:00:00Z') }, '2026-11'), /עוד לא נקרא עד תחילת החודש/);
  assert.match(monthCut({ truncated: true }, '2026-11'), /עוד לא נקרא/, 'unknown depth: say so');
  assert.match(monthCut({ truncated: false, gaps: ['2026-11-02', '2026-10-07'] }, '2026-11'), /של 02\/11 נקרא חלקית/); assert.equal(monthCut({ truncated: false, gaps: ['2026-10-07'] }, '2026-11'), false);
  assert.ok(reportText(monthIncome(INC, '2026-11', '2026-11-16'), '2026-11', '2026-11-16', { truncated: monthCut({ gaps: ['2026-11-02'] }, '2026-11') }).includes('• שים לב: יומן התשלומים של 02/11 נקרא חלקית'));
});
