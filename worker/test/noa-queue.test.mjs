// node --test worker/test/noa-queue.test.mjs
// R1 / R2 / R3 offline: monday and Retell are a fetch mock, KV is a Map.
// Proves the flag gate, the queue shape, the payload (why:'chase' + memory),
// the attempt bookkeeping and the write-back mutations — not the live APIs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scanMondayNotAnswered, drainNoaChase, noaChaseCallEnded, writeBackMonday, chaseOutcome, NQ, COL, ilDateAt } from '../noa.js';

function fakeKv() {
  const m = new Map();
  return { store: m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; } };
}
const item = (id, name, phone, owner = 'שלו', extra = {}) => ({ id: String(id), name, column_values: [
  { id: COL.status, text: 'לא ענה', index: 2, label: 'לא ענה' }, { id: COL.owner, text: owner, label: owner }, { id: COL.phone, text: phone },
  { id: COL.occasion, text: extra.occasion || 'חתונה' }, { id: COL.source, text: extra.source || 'פייסבוק' }, { id: COL.updates, text: '' }, { id: COL.callback, text: '' }] });

let realFetch; const calls = [];
function mockFetch(items) {
  return async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url.includes('monday.com')) {
      const q = String(body.query || '');
      if (q.includes('items_page(')) return { ok: true, status: 200, async json() { return { data: { boards: [{ items_page: { cursor: null, items } }] } }; } };
      if (q.includes('items_page_by_column_values')) return { ok: true, status: 200, async json() { return { data: { items_page_by_column_values: { items: [{ id: '777', name: 'x' }] } } }; } };
      if (q.includes('create_update')) return { ok: true, status: 200, async json() { return { data: { create_update: { id: 'u1' } } }; } };
      return { ok: true, status: 200, async json() { return { data: { change_multiple_column_values: { id: body.variables.i } } }; } };
    }
    if (url.includes('retellai.com')) return { ok: true, status: 201, async json() { return { call_id: 'call_test_1' }; }, clone() { return this; } };
    throw new Error('unexpected fetch ' + url);
  };
}
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

const SUN_11 = ilDateAt('2026-11-01', 11 * 60);   // Sunday 11:00 Israel, window open

test('scan: dry run lists what WOULD be queued and writes nothing; skips נועה / paid / blocked / test / no phone', async () => {
  calls.length = 0;
  const items = [
    item(1, 'דנה', '0501111111'), item(2, 'כבר אצל נועה', '0502222222', 'נועה'), item(3, 'שילם', '0503333333'),
    item(4, 'חסום', '0504444444'), item(5, 'בדיקה', '0500005001'), item(6, 'בלי טלפון', ''), item(7, 'קצר', '505297603'),
  ];
  globalThis.fetch = mockFetch(items);
  const env = { MONDAY_API_TOKEN: 't', RATE: fakeKv(), NOA_CHASE: 'off' };
  await env.RATE.put('nocall:972504444444', '1');
  const r = await scanMondayNotAnswered(env, { dry: true, deps: { now: SUN_11, leadRows: async () => [[0, 'שילם', '0503333333', 0, 'חתונה', 0, '', 'כן']] } });
  assert.equal(r.ok, true); assert.equal(r.dry, true); assert.equal(r.scanned, 7);
  assert.deepEqual(r.queued.map(q => q.phone), ['972501111111', '972505297603'], 'a 9-digit monday phone gets its 972');
  assert.deepEqual(r.skipped.map(s => s.why).sort(), ['already-noa', 'blocked', 'no-phone', 'paid', 'test-phone'].sort());
  const q = r.queued[0];
  assert.equal(q.item_id, '1'); assert.equal(q.name, 'דנה'); assert.equal(q.occasion, 'חתונה'); assert.equal(q.source, 'פייסבוק');
  assert.deepEqual(q.attempts, []); assert.equal(q.next_at, SUN_11.toISOString(), 'day 0 = the next open slot = now');
  assert.equal([...env.RATE.store.keys()].filter(k => k.startsWith(NQ)).length, 0, 'dry: no KV');
  assert.equal(calls.filter(c => String(c.body.query).includes('mutation')).length, 0, 'dry: no monday mutation');
});

test('scan: NOA_CHASE=off is read-only even without dry; =on writes nq: + טיפול=נועה + עדכונים', async () => {
  calls.length = 0;
  globalThis.fetch = mockFetch([item(1, 'דנה', '0501111111')]);
  const off = { MONDAY_API_TOKEN: 't', RATE: fakeKv(), NOA_CHASE: 'off' };
  const r0 = await scanMondayNotAnswered(off, { deps: { now: SUN_11 } });
  assert.equal(r0.dry, true); assert.equal(off.RATE.store.size, 0);
  assert.equal(calls.filter(c => String(c.body.query).includes('mutation')).length, 0);

  const on = { MONDAY_API_TOKEN: 't', RATE: fakeKv(), NOA_CHASE: 'on' };
  const r1 = await scanMondayNotAnswered(on, { deps: { now: SUN_11 } });
  assert.equal(r1.dry, false); assert.equal(r1.queued.length, 1);
  const saved = JSON.parse(on.RATE.store.get(NQ + '972501111111'));
  assert.equal(saved.item_id, '1'); assert.equal(saved.first_at, SUN_11.toISOString());
  const mut = calls.find(c => String(c.body.query).includes('change_multiple_column_values'));
  assert.ok(mut, 'monday mutation sent');
  const vals = JSON.parse(mut.body.variables.v);
  assert.deepEqual(vals[COL.owner], { label: 'נועה' });
  assert.equal(vals[COL.updates], 'נועה לקחה · 01/11');
  /* second scan: already queued → not re-queued, no second mutation */
  calls.length = 0;
  const r2 = await scanMondayNotAnswered(on, { deps: { now: SUN_11 } });
  assert.equal(r2.queued.length, 0); assert.equal(r2.skipped[0].why, 'queued');
  assert.equal(calls.filter(c => String(c.body.query).includes('mutation')).length, 0);
});

test('drain: flag gate, window gate, waiting vs due, payload carries why:chase + memory + item_id', async () => {
  calls.length = 0;
  globalThis.fetch = mockFetch([]);
  const env = { RATE: fakeKv(), NOA_CHASE: 'on', RETELL_KEY: 'k', NOA_AGENT: 'agent_x', NOA_FROM: '+972555077733' };
  assert.equal((await drainNoaChase({ ...env, NOA_CHASE: 'off' }, { deps: { now: SUN_11 } })).why, 'noa-chase-off');
  assert.equal((await drainNoaChase(env, { deps: { now: ilDateAt('2026-11-07', 11 * 60) } })).why, 'shabbat');
  assert.equal((await drainNoaChase(env, { deps: { now: ilDateAt('2026-11-01', 8 * 60) } })).why, 'hours');

  await env.RATE.put(NQ + '972501111111', JSON.stringify({ item_id: '1', name: 'דנה', phone: '972501111111', occasion: 'חתונה', source: 'פייסבוק', first_at: SUN_11.toISOString(), attempts: [], next_at: SUN_11.toISOString() }));
  await env.RATE.put(NQ + '972502222222', JSON.stringify({ item_id: '2', name: 'מחר', phone: '972502222222', first_at: SUN_11.toISOString(), attempts: [], next_at: ilDateAt('2026-11-02', 13 * 60).toISOString() }));
  await env.RATE.put(NQ + '972503333333', JSON.stringify({ item_id: '3', name: 'ענה בוואטסאפ', phone: '972503333333', first_at: SUN_11.toISOString(), attempts: [], next_at: SUN_11.toISOString() }));

  const dry = await drainNoaChase(env, { dry: true, deps: { now: SUN_11, memory: 'דברים שלמדתי:\n• לשאול מתי נוח', leadReplied: async p => p === '972503333333' } });
  assert.equal(dry.dialed, 1); assert.equal(dry.waiting, 1); assert.equal(dry.skipped, 1);
  assert.deepEqual(dry.phones, ['972501111111']);
  const p = dry.payload;
  assert.equal(p.to_number, '+972501111111'); assert.equal(p.from_number, '+972555077733'); assert.equal(p.override_agent_id, 'agent_x');
  assert.equal(p.metadata.kind, 'lead'); assert.equal(p.metadata.why, 'chase'); assert.equal(p.metadata.item_id, '1'); assert.equal(p.metadata.attempt, '1');
  assert.equal(p.retell_llm_dynamic_variables.why, 'chase');
  assert.equal(p.retell_llm_dynamic_variables.memory, 'דברים שלמדתי:\n• לשאול מתי נוח');
  assert.ok(p.retell_llm_dynamic_variables.opening_line.includes('נועה'));
  assert.equal(calls.filter(c => c.url.includes('retellai')).length, 0, 'dry: Retell untouched');
  assert.ok(env.RATE.store.has(NQ + '972503333333'), 'dry: the WhatsApp-replied entry is not deleted');

  const live = await drainNoaChase(env, { deps: { now: SUN_11, leadReplied: async p => p === '972503333333' } });
  assert.equal(live.dialed, 1);
  assert.equal(env.RATE.store.has(NQ + '972503333333'), false, 'live: answered on WhatsApp → out of the queue');
  const retell = calls.filter(c => c.url.includes('retellai'));
  assert.equal(retell.length, 1);
  assert.equal(retell[0].body.metadata.why, 'chase');
  const after1 = JSON.parse(env.RATE.store.get(NQ + '972501111111'));
  assert.equal(after1.attempts.length, 1); assert.equal(after1.attempts[0].call_id, 'call_test_1'); assert.equal(after1.attempts[0].reached, false);
  assert.equal(after1.next_at, ilDateAt('2026-11-02', 13 * 60).toISOString(), 'attempt 2 = +1 day, band 13–16');
  /* same tick again: today's attempt is spent → waiting, no second dial */
  const again = await drainNoaChase(env, { deps: { now: new Date(SUN_11.getTime() + 5 * 60000), leadReplied: async () => false } });
  assert.equal(again.dialed, 0); assert.equal(again.waiting, 2);
});

test('call ended: no answer → attempt recorded + next scheduled; reached → chase done; monday gets status/עדכונים/update with /rec/', async () => {
  calls.length = 0;
  globalThis.fetch = mockFetch([]);
  const env = { RATE: fakeKv(), NOA_CHASE: 'on', MONDAY_API_TOKEN: 't' };
  const first = SUN_11.toISOString();
  await env.RATE.put(NQ + '972501111111', JSON.stringify({ item_id: '1', name: 'דנה', phone: '972501111111', first_at: first, attempts: [{ at: first, call_id: 'c1', reached: false, outcome: '' }], next_at: null }));

  const noAns = await noaChaseCallEnded(env, { call_id: 'c1', to_number: '+972501111111', disconnection_reason: 'dial_no_answer', metadata: { kind: 'lead', why: 'chase', item_id: '1', attempt: '1' }, start_timestamp: 0, end_timestamp: 0 }, { now: new Date(SUN_11.getTime() + 60000) });
  assert.equal(noAns.verdict.reached, false); assert.equal(noAns.verdict.outcome, 'לא ענה'); assert.equal(noAns.done, false);
  assert.equal(noAns.next_at, ilDateAt('2026-11-02', 13 * 60).toISOString());
  let mut = calls.filter(c => String(c.body.query).includes('change_multiple_column_values')).pop();
  let vals = JSON.parse(mut.body.variables.v);
  assert.deepEqual(vals[COL.status], { index: 2 }, 'stays לא ענה');
  assert.ok(vals[COL.updates].startsWith('נועה · 01/11 · לא ענה'));
  let upd = calls.filter(c => String(c.body.query).includes('create_update')).pop();
  assert.ok(upd.body.variables.b.includes('https://go.ishur.io/rec/c1'));

  calls.length = 0;
  const reached = await noaChaseCallEnded(env, { call_id: 'c2', to_number: '+972501111111', disconnection_reason: 'user_hangup', transcript: 'Agent: היי\nUser: תתקשרו מחר בבוקר\n',
    call_analysis: { call_summary: 'ביקשה שיחה מחר בבוקר' }, metadata: { kind: 'lead', why: 'chase', item_id: '1', attempt: '2' }, start_timestamp: 0, end_timestamp: 40000 }, { now: ilDateAt('2026-11-02', 13 * 60) });
  assert.equal(reached.verdict.reached, true); assert.equal(reached.verdict.outcome, 'שיחה חוזרת'); assert.equal(reached.done, true); assert.equal(reached.next_at, null);
  const q = JSON.parse(env.RATE.store.get(NQ + '972501111111'));
  assert.equal(q.attempts.length, 2); assert.equal(q.done, true);
  mut = calls.filter(c => String(c.body.query).includes('change_multiple_column_values')).pop();
  vals = JSON.parse(mut.body.variables.v);
  assert.deepEqual(vals[COL.status], { index: 4 });
  assert.ok(vals[COL.updates].includes('שיחה חוזרת'));
  upd = calls.filter(c => String(c.body.query).includes('create_update')).pop();
  assert.ok(upd.body.variables.b.includes('/rec/c2') && upd.body.variables.b.includes('תתקשרו מחר'));

  /* flag off: nothing is written anywhere */
  calls.length = 0;
  const off = await noaChaseCallEnded({ ...env, NOA_CHASE: 'off' }, { call_id: 'c3', to_number: '+972501111111', disconnection_reason: 'dial_busy', metadata: { kind: 'lead', why: 'chase' } });
  assert.equal(off.monday.why, 'skipped'); assert.equal(calls.length, 0);
  assert.equal((await writeBackMonday({ ...env, NOA_CHASE: 'off' }, '972501111111', { outcome: 'סגר' })).why, 'noa-chase-off');
  assert.equal((await noaChaseCallEnded(env, { metadata: { kind: 'lead' } })).why, 'not-chase');
});

test('chaseOutcome: analysis enum wins, then the transcript, then the disconnection reason', () => {
  assert.deepEqual(chaseOutcome({ disconnection_reason: 'voicemail_reached' }), { outcome: 'לא ענה', reached: false });
  assert.equal(chaseOutcome({ transcript: 'User: כן\n', call_analysis: { custom_analysis_data: { outcome: 'סגר' } } }).outcome, 'סגר');
  assert.equal(chaseOutcome({ transcript: 'User: לא מעוניין תודה\n' }).outcome, 'לא רלוונטי');
  assert.equal(chaseOutcome({ transcript: 'User: הלו\n' }).outcome, '', 'reached but unclear → status untouched');
  assert.equal(chaseOutcome({ transcript: 'User: הלו\n' }).reached, true);
});
