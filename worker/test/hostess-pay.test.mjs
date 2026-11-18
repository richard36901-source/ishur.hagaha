import test from 'node:test'; import assert from 'node:assert/strict';
import { normHm, hoursBetween, normPay, shiftAmount, clockFromLog, buildShifts, monthTotals, syncShift, handleHostessPay, handleReceiptUpload, handleReceiptGet, hostessDayMessages, dayText } from '../hostess-pay.js';

const A = '972500000001', B = '972500000002';
function kv(init = {}) { const m = new Map(Object.entries(init)), meta = new Map(); return { m, meta,
  get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v, o) => { m.set(k, v); if (o && o.metadata) meta.set(k, o.metadata); }, delete: async k => { m.delete(k); meta.delete(k); },
  getWithMetadata: async k => (m.has(k) ? { value: m.get(k), metadata: meta.get(k) || null } : { value: null, metadata: null }),
  list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name, metadata: meta.get(name) })), list_complete: true }) }; }
const prefixOf = store => async (env, p) => Object.fromEntries([...store.m].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v]));
const d = store => ({ deny: (s, e) => new Response(JSON.stringify({ ok: false, error: e }), { status: s }), okJson: o => new Response(JSON.stringify(o)), isAdmin: (env, k) => k === 'k', adminKeyOk: async (env, k) => k === 'k', kvPrefix: prefixOf(store) });
const post = (store, body) => handleHostessPay(new Request('https://x/api/hostess-pay', { method: 'POST', body: JSON.stringify({ admin_key: 'k', ...body }) }), { RATE: store, ADMIN_KEY: 'k' }, '', d(store)).then(r => r.json());

test('hours: plain, past midnight, missing; times are normalised', () => {
  assert.equal(hoursBetween('18:20', '23:50'), 5.5); assert.equal(hoursBetween('19:00', '01:30'), 6.5); assert.equal(hoursBetween('', '23:00'), 0);
  assert.equal(normHm('7:05'), '07:05'); assert.equal(normHm('25:00'), ''); assert.equal(normHm('soon'), '');
});
test('pay: per hour multiplies the hours, per event is a flat amount, no rate means nothing to pay', () => {
  assert.equal(shiftAmount({ mode: 'hour', rate: 60, hours: 5.5 }), 330); assert.equal(shiftAmount({ mode: 'event', rate: 450, hours: 9 }), 450); assert.equal(shiftAmount({ mode: 'hour', rate: 0, hours: 5 }), 0);
  assert.deepEqual(normPay({ mode: 'hour', rate: '62.5' }), { mode: 'hour', rate: 62.5 }); assert.deepEqual(normPay(null), { mode: 'event', rate: 0 }); assert.deepEqual(normPay({ mode: 'x', rate: -4 }), { mode: 'event', rate: 0 });
});
test('the clock takes the first arrival and the last leaving of that hostess on that day', () => {
  const log = [{ phone: A, day: '2027-01-06', ts: 3, kind: 'leave', time: '23:40' }, { phone: A, day: '2027-01-06', ts: 1, kind: 'arrive', time: '18:15' }, { phone: A, day: '2027-01-06', ts: 2, kind: 'chuppah', time: '20:00' }, { phone: A, day: '2027-01-06', ts: 4, kind: 'leave', time: '23:55' }, { phone: B, day: '2027-01-06', ts: 1, kind: 'arrive', time: '17:00' }];
  assert.deepEqual(clockFromLog(log, A, '2027-01-06'), { in: '18:15', out: '23:55' }); assert.deepEqual(clockFromLog(log, A, '2027-01-07'), { in: '', out: '' });
});
test('shifts: defaults from the hostess, a hand correction wins over the reports, the month adds up paid and due', () => {
  const stored = { ['aaaaaaaa:' + A]: { date: '2027-01-06', name: 'אירוע א' }, ['bbbbbbbb:' + A]: { date: '2027-01-20', name: 'אירוע ב', out: '00:15', paid: { at: 'T', by: 'ריצארד' } }, ['aaaaaaaa:' + B]: { date: '2027-01-06', name: 'אירוע א', mode: 'event', rate: 500 }, ['cccccccc:' + A]: { date: '2027-02-02', name: 'חודש אחר' } };
  const log = [{ phone: A, day: '2027-01-06', ts: 1, kind: 'arrive', time: '18:00' }, { phone: A, day: '2027-01-06', ts: 2, kind: 'leave', time: '23:00' }, { phone: A, day: '2027-01-20', ts: 1, kind: 'arrive', time: '18:15' }, { phone: A, day: '2027-01-20', ts: 2, kind: 'leave', time: '23:00' }];
  const sh = buildShifts({ stored, pay: { [A]: { mode: 'hour', rate: 60 }, [B]: { mode: 'hour', rate: 70 } }, names: { [A]: 'דנה', [B]: 'מיכל' }, log, month: '2027-01' });
  assert.equal(sh.length, 3);
  const a1 = sh.find(s => s.id === 'aaaaaaaa:' + A), a2 = sh.find(s => s.id === 'bbbbbbbb:' + A), b1 = sh.find(s => s.id === 'aaaaaaaa:' + B);
  assert.deepEqual([a1.in, a1.out, a1.hours, a1.amount, a1.paid], ['18:00', '23:00', 5, 300, null]);
  assert.deepEqual([a2.out, a2.out_manual, a2.hours, a2.amount, !!a2.paid], ['00:15', true, 6, 360, true]);
  assert.deepEqual([b1.mode, b1.amount, b1.missing], ['event', 500, '']);
  const t = monthTotals(sh); assert.deepEqual(t.find(x => x.phone === A), { phone: A, name: 'דנה', shifts: 2, hours: 11, total: 660, paid: 360, due: 300 });
  assert.equal(buildShifts({ stored: { ['aaaaaaaa:' + A]: { date: '2027-01-06' } }, pay: { [A]: { mode: 'hour', rate: 60 } }, names: {}, log: [] })[0].missing, 'hours');
  assert.equal(buildShifts({ stored: { ['aaaaaaaa:' + A]: { date: '2027-01-06' } }, names: {}, log: [] })[0].missing, 'rate');
});
test('route: a shift exists while assigned, rate and correction and paid are saved and show at once, a paid shift survives unassigning', async () => {
  const store = kv({ ['staff:' + A]: JSON.stringify({ name: 'דנה', sid: 'a'.repeat(24) }) }), env = { RATE: store };
  await syncShift(env, { tok8: 'aaaaaaaa', phone: A, on: true, date: '2027-01-06', name: 'אירוע א', city: 'אשדוד' });
  assert.equal((await post(store, { month: '2027-01' })).shifts.length, 1);
  assert.equal((await handleHostessPay(new Request('https://x', { method: 'POST', body: JSON.stringify({ admin_key: 'no' }) }), env, '', d(store))).status, 403);
  let r = await post(store, { month: '2027-01', set_rate: { phone: A, mode: 'hour', rate: 60 } }); assert.deepEqual(r.pay[A], { mode: 'hour', rate: 60 }); assert.equal(r.shifts[0].missing, 'hours');
  r = await post(store, { month: '2027-01', set_shift: { id: 'aaaaaaaa:' + A, in: '18:00', out: '23:30' } }); assert.deepEqual([r.shifts[0].hours, r.shifts[0].amount, r.totals[0].due], [5.5, 330, 330]);
  r = await post(store, { month: '2027-01', set_shift: { id: 'aaaaaaaa:' + A, mode: 'event', rate: 400 } }); assert.equal(r.shifts[0].amount, 400);
  r = await post(store, { month: '2027-01', mark_paid: { ids: ['aaaaaaaa:' + A, 'junk'], on: true }, who: 'ריצארד' }); assert.equal(r.shifts[0].paid.by, 'ריצארד'); assert.deepEqual([r.totals[0].paid, r.totals[0].due], [400, 0]);
  await syncShift(env, { tok8: 'aaaaaaaa', phone: A, on: false }); assert.equal((await post(store, { month: '2027-01' })).shifts.length, 1, 'paid shift is kept');
  r = await post(store, { month: '2027-01', mark_paid: { ids: ['aaaaaaaa:' + A], on: false } }); assert.equal(r.shifts[0].paid, null);
  await syncShift(env, { tok8: 'aaaaaaaa', phone: A, on: false }); assert.equal((await post(store, { month: '2027-01' })).shifts.length, 0);
});
test('receipt: stored per hostess and month, opens only with its signed link, wrong type or oversize refused', async () => {
  const store = kv({ ['staff:' + A]: JSON.stringify({ name: 'דנה' }) }), env = { RATE: store, ADMIN_KEY: 'k' };
  const up = async (fields, file) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); if (file) f.append('file', file); return (await handleReceiptUpload(new Request('https://x/api/hostess-receipt', { method: 'POST', body: f }), env, '', d(store))); };
  assert.equal((await up({ admin_key: 'no', ref: A + ':2027-01' }, new File(['x'], 'r.pdf', { type: 'application/pdf' }))).status, 403);
  assert.equal((await (await up({ admin_key: 'k', ref: A + ':2027-01' }, new File(['x'], 'r.exe', { type: 'application/x-msdownload' }))).json()).error, 'bad-type');
  assert.equal((await (await up({ admin_key: 'k', ref: 'bad' }, new File(['x'], 'r.pdf', { type: 'application/pdf' }))).json()).error, 'bad-input');
  const ok = await (await up({ admin_key: 'k', ref: A + ':2027-01' }, new File(['%PDF-1'], 'קבלה ינואר.pdf', { type: 'application/pdf' }))).json();
  assert.equal(ok.ok, true); assert.match(ok.receipt.url, /^\/api\/hostess-receipt\?ref=972500000001%3A2027-01&sig=[0-9a-f]{32}$/);
  const u = new URL('https://x' + ok.receipt.url); const got = await handleReceiptGet(env, u); assert.equal(got.status, 200); assert.equal(got.headers.get('Content-Type'), 'application/pdf'); assert.equal(await got.text(), '%PDF-1');
  u.searchParams.set('sig', '0'.repeat(32)); assert.equal((await handleReceiptGet(env, u)).status, 403);
  assert.ok((await post(store, { month: '2027-01' })).receipts[A].url); assert.equal((await post(store, { month: '2027-02' })).receipts[A], undefined);
});
test('event day: each assigned hostess gets one message from 09:00, a failed send goes to Slack with a manual link', async () => {
  const store = kv({ ['staff:' + A]: JSON.stringify({ name: 'דנה לוי', sid: 'a'.repeat(24) }), ['staff:' + B]: JSON.stringify({ name: 'מיכל', sid: 'b'.repeat(24) }),
    hostshiftidx: JSON.stringify(['aaaaaaaa:' + A, 'aaaaaaaa:' + B, 'bbbbbbbb:' + A]), ['hostshift:aaaaaaaa:' + A]: JSON.stringify({ date: '2027-01-06', name: 'אירוע א', city: 'אשדוד' }), ['hostshift:aaaaaaaa:' + B]: JSON.stringify({ date: '2027-01-06', name: 'אירוע א' }), ['hostshift:bbbbbbbb:' + A]: JSON.stringify({ date: '2027-01-09', name: 'אחר' }),
    'hostessbook:aaaaaaaa-0000-4000-8000-000000000001': JSON.stringify({ reception: '19:00' }) });
  const env = { RATE: store }, sent = [], slack = []; const at = hm => Date.parse(`2027-01-06T${hm}:00+02:00`);
  const send = async (phone, st, text) => { sent.push([phone, text]); return phone === B ? { ok: false, wa: 'https://wa.me/x' } : { ok: true }; };
  const run = now => hostessDayMessages(env, { now, kvPrefix: prefixOf(store), send, slack: async t => slack.push(t), arrivalOf: r => (r === '19:00' ? '18:20' : '') });
  assert.deepEqual(await run(at('08:10')), { sent: 0, failed: 0 });
  assert.deepEqual(await run(at('09:05')), { sent: 1, failed: 1 }); assert.deepEqual(await run(at('10:05')), { sent: 0, failed: 0 });
  assert.match(sent.find(x => x[0] === A)[1], /היי דנה, היום האירוע של אירוע א באשדוד\. הגעה עד 18:20\./); assert.equal(slack.length, 1); assert.match(slack[0], /מיכל[\s\S]*https:\/\/wa\.me\/x/);
  assert.match(dayText('רות', { name: '' }, ''), /^היי רות, היום האירוע של הלקוח\. בהגעה/);
});
