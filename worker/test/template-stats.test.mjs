/* node --test worker/test/template-stats.test.mjs
   Fixture: test/fixtures/stats-rows.json (synthetic phones, hand-computed
   expectations below — every number is derived in the comment next to it). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  wilson, compactRecord, computeTemplateStats, attributeSends, recommend, msgTypeOf, baseName,
  classifyReply, handleTemplateStats, loadRows, RULE,
} from '../template-stats.js';

const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/stats-rows.json', import.meta.url), 'utf8'));

test('wilson: known values', () => {
  assert.deepEqual(wilson(0, 0), { p: 0, lo: 0, hi: 0 });
  const w = wilson(50, 100);
  assert.equal(w.p, 0.5);
  assert.ok(Math.abs(w.lo - 0.4038) < 0.0005, 'lo ' + w.lo);
  assert.ok(Math.abs(w.hi - 0.5962) < 0.0005, 'hi ' + w.hi);
  const z = wilson(0, 20);              // a zero rate still has a real upper bound
  assert.equal(z.lo, 0);
  assert.ok(z.hi > 0.15 && z.hi < 0.17, 'hi ' + z.hi);
});

test('msgTypeOf / baseName', () => {
  assert.equal(msgTypeOf('hazmana_ishur_v2', '2'), 'reminder');
  assert.equal(msgTypeOf('hazmana_ishur_v2', ''), 'invite');
  assert.equal(msgTypeOf('hazmana_ishur_img_u', '1'), 'invite');
  assert.equal(msgTypeOf('ishur_c_505cd735_1', '1'), 'invite');
  assert.equal(msgTypeOf('ishur_yom_lifnei_f', 'daybefore'), 'daybefore');
  assert.equal(msgTypeOf('ishur_toda_orach_v2', ''), 'thanks');
  assert.equal(msgTypeOf('ishur_lo_siyem_2', ''), 'client');
  assert.equal(baseName('hazmana_ishur_v2_ab3'), 'hazmana_ishur_v2');
  assert.equal(baseName('ishur_yom_lifnei_f'), 'ishur_yom_lifnei');
});

test('classifyReply uses the production parser', () => {
  assert.equal(classifyReply('מגיע').kind, 'rsvp');
  assert.equal(classifyReply('טעות').kind, 'mistake');
  assert.equal(classifyReply('הסר').kind, 'optout');
  assert.equal(classifyReply('3').kind, 'party');
  assert.equal(classifyReply('').kind, 'empty');
});

test('compactRecord: real audit shapes (synthetic phone)', () => {
  const out = compactRecord({ kind: 'wa_out', ts: 1, area: 'שיר', ok: true, phone: '972500000001', token: '505cd735-0000-4000-8000-000000000002', data: { phone_id: '1107514695777584', wamid: 'wamid.X', template: 'hazmana_ishur_v2', error: '' } });
  assert.deepEqual(out, { k: 'o', ts: 1, p: '972500000001', ch: 'g', t: 'hazmana_ishur_v2', w: 'wamid.X', ok: true, pid: '1107514695777584', tok: '505cd735', e: '' });
  const st = compactRecord({ kind: 'wa_status', ts: 2, detail: '130472 User\'s number is part of an experiment', cost: 0, data: { wamid: 'wamid.X', status: 'failed', wave: 1, pricing: null } });
  assert.equal(st.c, '130472'); assert.equal(st.wv, '1'); assert.equal(st.st, 'failed');
  const inn = compactRecord({ kind: 'wa_in', ts: 3, area: 'נועה', phone: '0500000001', detail: 'מגיע' });
  assert.deepEqual(inn, { k: 'i', ts: 3, p: '972500000001', ch: 'c', x: 'מגיע' });
  assert.equal(compactRecord({ kind: 'wa_out', data: { template: '' } }), null, 'free text is not a template');
  assert.equal(compactRecord({ kind: 'cron' }), null);
});

test('computeTemplateStats: the fixture, number by number', () => {
  const s = computeTemplateStats(FX.rows, { now: FX.now });
  const img = s.rows.find(r => r.template === 'hazmana_ishur_img_u' && r.type === 'invite');
  const v2 = s.rows.find(r => r.template === 'hazmana_ishur_v2' && r.type === 'reminder');
  assert.ok(img && v2, 'both rows exist');
  /* img_u: s1..s7 + s8(P9) = 8 sends; s7 rejected by Meta at send time */
  assert.equal(img.sends, 8); assert.equal(img.accepted, 7); assert.equal(img.rejected, 1);
  /* delivered: P1 P2 P5 P6 P9; read: P1; failed: P3 (131048 cap) P4 (131026) */
  assert.equal(img.delivered, 5); assert.equal(img.read, 1); assert.equal(img.failed, 2);
  assert.deepEqual(img.failed_codes, { '131048': 1, '131026': 1 });
  assert.equal(img.failed_cap, 1);
  /* delivery rate excludes the cap failure: 5 / (7 − 1) */
  assert.equal(img.delivery_rate, Math.round(5 / 6 * 10000) / 10000);
  /* 72h-mature delivered: P1 P2 P5 P9 (P6 is 10h old). Replies credited:
     P1 (1h), P2 "טעות" (2h). P5 answered after 80h → not credited. P9 answered
     on the OTHER number (Noa) → not credited. → 2/4 */
  assert.equal(img.reply_n, 4); assert.equal(img.reply_k, 2); assert.equal(img.reply_rate, 0.5);
  /* 24h: mature24 = every accepted send older than 24h = P1 P2 P3 P4 P5 P9 = 6; replied ≤24h: P1 P2 */
  assert.equal(img.mature24, 6); assert.equal(img.replies24, 2);
  /* button-equivalent answers: P1 "מגיע", P6 "2" (party size → coming) */
  assert.equal(img.clicks, 2); assert.equal(img.rsvp['מגיע'], 2);
  assert.equal(img.mistake, 1); assert.equal(img.optout, 0);
  assert.equal(img.optout_rate, 0.2);      // 1 / 5 delivered
  assert.equal(img.cost, 0.6);             // 5 × 0.12 on delivered rows
  /* v2 as reminder (wave 2): P1's "לא מגיע" belongs to THIS send (last touch),
     not to P1's invitation 20h earlier; P8 "הסר" 20h after */
  assert.equal(v2.sends, 2); assert.equal(v2.delivered, 2);
  assert.equal(v2.reply_k, 2); assert.equal(v2.reply_n, 2); assert.equal(v2.replies24, 2);
  assert.equal(v2.rsvp['לא מגיע'], 1); assert.equal(v2.optout, 1);
  /* both have far fewer than MIN_N mature sends */
  assert.equal(img.rec, 'מעט נתונים'); assert.equal(v2.rec, 'מעט נתונים');
  assert.equal(s.totals.sends, 10); assert.equal(s.totals.delivered, 7);
});

test('attributeSends: one record per send, same answer as the aggregate', () => {
  const xs = attributeSends(FX.rows, { now: FX.now });
  assert.equal(xs.length, 10);
  const p1inv = xs.find(x => x.o.w === 'w1');
  assert.equal(p1inv.rsvp, 'מגיע'); assert.equal(p1inv.replied24, true);
  const p1rem = xs.find(x => x.o.w === 'w8');
  assert.equal(p1rem.rsvp, 'לא מגיע'); assert.equal(p1rem.type, 'reminder');
});

/* a synthetic stats row for recommend() */
const row = (o) => ({ goal: 'reply', reply_n: 300, reply_k: 90, reply_rate: 0.3, reply_lo: 0.25, reply_hi: 0.35, delivered: 300, delivery_rate: 0.95, optout_rate: 0.005, template: 't', ...o });

test('recommend: every branch of the rule', () => {
  assert.equal(recommend(row({ reply_n: RULE.MIN_N - 1 })).rec, 'מעט נתונים');
  assert.equal(recommend(row({ optout_rate: 0.021 })).rec, 'החלף');
  assert.equal(recommend(row({ delivery_rate: 0.84 })).rec, 'החלף');
  const a = row({ template: 'a', reply_rate: 0.3, reply_lo: 0.25, reply_hi: 0.35 });
  const b = row({ template: 'b', reply_rate: 0.5, reply_lo: 0.44, reply_hi: 0.56 });
  const ra = recommend(a, [a, b]);
  assert.equal(ra.rec, 'החלף'); assert.match(ra.why, /^b /);
  assert.equal(recommend(b, [a, b]).rec, 'שמור');
  /* overlapping intervals → not significantly worse → keep */
  const c = row({ template: 'c', reply_rate: 0.33, reply_lo: 0.28, reply_hi: 0.38 });
  assert.equal(recommend(a, [a, c]).rec, 'שמור');
  /* information messages are not judged on replies */
  const info = row({ goal: 'info', reply_rate: 0.01, reply_lo: 0, reply_hi: 0.03 });
  assert.equal(recommend(info, [info, b]).rec, 'שמור');
});

/* ── the route + the per-day cache ─────────────────────────────────────────── */
function fakeKv() {
  const m = new Map();
  return { m, get: async k => (m.has(k) ? m.get(k).v : null), put: async (k, v, o) => { m.set(k, { v, o }); } };
}
const deps0 = (kv, recsByDay, extra = {}) => ({
  isAdmin: (env, k) => k === 'good',
  okJson: (o) => new Response(JSON.stringify(o), { status: 200 }),
  deny: (s, r) => new Response(JSON.stringify({ ok: false, error: r }), { status: s }),
  queryDay: async (env, day) => { extra.calls = (extra.calls || 0) + 1; return recsByDay[day] || []; },
  kvGet: kv.get, kvPut: kv.put, now: () => Date.UTC(2026, 10, 1, 12), budget: 2, ...extra,
});
const req = (b) => new Request('https://x/api/template-stats', { method: 'POST', body: JSON.stringify(b) });

test('handleTemplateStats: bad key → 403', async () => {
  const kv = fakeKv();
  const r = await handleTemplateStats(req({ admin_key: 'bad' }), {}, '', deps0(kv, {}));
  assert.equal(r.status, 403);
});

test('handleTemplateStats: budget, partial answer, closed days cached, today never cached', async () => {
  const kv = fakeKv();
  const recs = {
    '20261101': [{ kind: 'wa_out', ts: Date.UTC(2026, 10, 1, 8), area: 'שיר', ok: true, phone: '972500000001', data: { wamid: 'w1', template: 'hazmana_ishur_v2' } }],
    '20261031': [{ kind: 'wa_out', ts: Date.UTC(2026, 9, 31, 8), area: 'שיר', ok: true, phone: '972500000002', data: { wamid: 'w2', template: 'hazmana_ishur_v2' } }],
    '20261030': [{ kind: 'wa_out', ts: Date.UTC(2026, 9, 30, 8), area: 'שיר', ok: true, phone: '972500000003', data: { wamid: 'w3', template: 'hazmana_ishur_v2' } }],
  };
  const extra = {};
  const d = deps0(kv, recs, extra);
  const r1 = await (await handleTemplateStats(req({ admin_key: 'good', days: 3 }), {}, '', d)).json();
  assert.equal(r1.ok, true);
  assert.equal(r1.partial, true);
  assert.deepEqual(r1.missing_days, ['20261030']);
  assert.equal(r1.totals.sends, 2);
  assert.ok(kv.m.has('tstats:rows:20261031'), 'closed day cached');
  assert.ok(!kv.m.has('tstats:rows:20261101'), 'today is never cached');
  const r2 = await (await handleTemplateStats(req({ admin_key: 'good', days: 3 }), {}, '', d)).json();
  assert.equal(r2.partial, false);
  assert.equal(r2.totals.sends, 3);
  /* call 1 read 2 days, call 2 read today + the missing day = 4 queries total */
  assert.equal(extra.calls, 4);
});

test('loadRows: days are capped by the caller (60 max in the route)', async () => {
  const kv = fakeKv();
  const extra = {};
  const r = await handleTemplateStats(req({ admin_key: 'good', days: 999 }), {}, '', deps0(kv, {}, extra));
  const j = await r.json();
  assert.equal(j.days, 60);
  assert.equal(j.missing_days.length, 58);   // budget 2 of 60
  const lr = await loadRows({}, 1, deps0(kv, {}));
  assert.deepEqual(lr.missing, []);
});
