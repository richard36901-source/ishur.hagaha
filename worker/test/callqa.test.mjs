// node --test worker/test/callqa.test.mjs
// R11 / P11: the 28 Shir calls of 01/11 (fixture) through the reviewer —
// the 16 gaps of qa-shir-2026-11-01.md are found, the 12 non-gaps are not.
// Offline: no model (opts.model=false) and a fetch that fails loudly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reviewCall, rulesVerdict, applyReview, callFromRetell, modelReview, HANGUP_LABEL, userTokens, substantive, answerTokens } from '../callqa.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/shir-calls-2026-11-01.json', import.meta.url), 'utf8'));
const toCall = r => ({ agent: r.data.agent, transcript: r.detail, outcome: r.data.outcome, answer: r.data.answer, duration_s: r.data.duration_s, guest_name: r.data.guest_name, event: r.data.event_name, call_id: r.data.call_id, guest_id: r.data.guest_id, phone: r.phone, tries: 0, max_tries: 1 });

/* qa-shir-2026-11-01.md, row by row: [guest, duration, should-be] — ⚠️ = gap */
const GAPS = [
  ['בטי', 22, 'מתלבט'], ['יוסי וליאת', 18, 'מתלבט'],
  ['טל', 7, HANGUP_LABEL], ['גל ואושרת', 8, HANGUP_LABEL], ['אייל והילה', 7, HANGUP_LABEL], ['מאי', 6, HANGUP_LABEL],
  ['מוראל', 3, HANGUP_LABEL], ['אופיר ומורן', 6, HANGUP_LABEL], ['אילן', 5, HANGUP_LABEL], ['עינב', 6, HANGUP_LABEL],
  ['לילוש ודני', 6, HANGUP_LABEL], ['נועה ואביעד', 5, HANGUP_LABEL], ['רון ודנה', 6, HANGUP_LABEL], ['עמית', 3, HANGUP_LABEL],
  ['רותי', 5, HANGUP_LABEL], ['יפעת', 9, HANGUP_LABEL],
];
const NON_GAPS = [
  ['שירן ומיכאל', 21], ['אוריה וליזה', 22], ['שלום ואדרה', 12], ['אן ובר', 20], ['נועה', 9], ['אלמוג וגל', 16],
  ['ישראל', 10], ['סימה ודוד', 33], ['תמי ואבי', 26], ['משה ונעמי', 18], ['רון יעקב', 5], ['סימה ודוד', 11],
];
const find = (name, dur) => {
  const r = FIX.rows.find(x => x.data.guest_name === name && x.data.duration_s === dur);
  assert.ok(r, `fixture row ${name} ${dur}s`);
  return toCall(r);
};

let realFetch;
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('network call in an offline test'); }; });
after(() => { globalThis.fetch = realFetch; });

test('fixture: 38 Shir rows fetched 02/11, 28 with a transcript', () => {
  assert.equal(FIX.rows.length, 38);
  assert.ok(FIX.rows.every(r => r.data.agent === 'שיר'));
  assert.equal(GAPS.length + NON_GAPS.length, 28);
  for (const [n, d] of [...GAPS, ...NON_GAPS]) find(n, d);
});

test('the 16 gaps are detected as mismatches with the right suggestion (rules only, no model)', async () => {
  const seen = [];
  for (const [name, dur, want] of GAPS) {
    const rv = await reviewCall({}, find(name, dur), { model: false });
    seen.push(`${name} ${dur}s → ${rv.verdict}/${rv.suggested}`);
    assert.equal(rv.verdict, 'mismatch', `${name} ${dur}s: ${JSON.stringify(rv)}`);
    assert.equal(rv.suggested, want, `${name} ${dur}s`);
    assert.equal(rv.auto_fix, true, `${name}: the three unambiguous rules auto-fix`);
    if (want === HANGUP_LABEL) assert.equal(rv.retry, true, `${name}: hangup → another try`);
    assert.notEqual(rv.recorded, want);
  }
  assert.equal(seen.length, 16);
});

test('the 12 non-gaps are left alone (ok or review, never mismatch, never auto_fix)', async () => {
  for (const [name, dur] of NON_GAPS) {
    const rv = await reviewCall({}, find(name, dur), { model: false });
    assert.notEqual(rv.verdict, 'mismatch', `${name} ${dur}s: ${JSON.stringify(rv)}`);
    assert.equal(rv.auto_fix, false, `${name} ${dur}s`);
  }
  /* the specific judgements the QA doc makes */
  const yes = await reviewCall({}, find('משה ונעמי', 18), { model: false });
  assert.equal(yes.verdict, 'ok'); assert.equal(yes.suggested, 'מגיע'); assert.equal(yes.count_unclear, true, 'מגיע (לבדוק כמות)');
  const sima = await reviewCall({}, find('סימה ודוד', 33), { model: false });
  assert.equal(sima.verdict, 'review'); assert.equal(sima.suggested, 'מגיע'); assert.equal(sima.count_unclear, true, '"אחד או שתיים" is not a number');
  const noa = await reviewCall({}, find('נועה', 9), { model: false });
  assert.equal(noa.verdict, 'review', '9s but the guest said a sentence — not a hangup');
  const nine = await reviewCall({}, find('שירן ומיכאל', 21), { model: false });
  assert.equal(nine.verdict, 'ok', '"על לא" is a לא with an STT shard; recorded לא מגיע stands');
  const bye = await reviewCall({}, find('אוריה וליזה', 22), { model: false });
  assert.equal(bye.verdict, 'ok', '"לא לא תודה יום טוב" = לא; recorded לא מגיע stands');
  const walla = await reviewCall({}, find('רון יעקב', 5), { model: false });
  assert.equal(walla.verdict, 'review', '"וואלה הלאה" is not הלו and not an answer');
});

test('rules: word boundaries — הלאה / וואלה / חלה never read as לא', () => {
  assert.deepEqual(substantive(userTokens('User: וואלה הלאה\n')), ['וואלה', 'הלאה'], 'words beyond הלו — not a hangup, not an answer');
  assert.deepEqual(answerTokens(userTokens('User: הלו לא לא תודה יום טוב\n')), ['לא', 'לא'], 'closings stripped, לא kept');
  assert.deepEqual(answerTokens(userTokens('User: על לא\n')), ['לא'], 'a 2-letter STT shard is noise');
  assert.deepEqual(substantive(userTokens('User: כן מי זה חלה הלאה כן\n')), ['כן', 'הלאה', 'כן']);
  assert.equal(rulesVerdict({ transcript: 'Agent: היי\nUser: לא\n', outcome: '__keep__', answer: 'שיחה ללא תוצאה ברורה', duration_s: 15 }).suggested, 'לא מגיע');
  assert.equal(rulesVerdict({ transcript: 'Agent: היי\nUser: לא, לא נגיע\n', outcome: '', duration_s: 15 }).suggested, '', '"לא נגיע" = לא plus a verb, not "לא and nothing else"');
  assert.equal(rulesVerdict({ transcript: 'Agent: היי\nUser: לא בטוח עדיין\n', outcome: 'לא מגיע', duration_s: 15 }).suggested, 'מתלבט', 'undecided wins over לא');
  assert.equal(rulesVerdict({ transcript: 'Agent: היי\nUser: כן שניים\n', outcome: '', duration_s: 15 }).count_unclear, false);
  const already = rulesVerdict({ transcript: 'Agent: היי\nUser: הלו\n', outcome: '__keep__', answer: 'לא ענה', duration_s: 4 });
  assert.equal(already.verdict, 'ok', 'a hangup already recorded as לא ענה is not a gap');
  assert.equal(rulesVerdict({ transcript: '', outcome: '', answer: '', duration_s: 10 }).verdict, 'review', '10s silent call: over the 9s line, for a human');
});

test('model pass: Workers AI mock is used, its JSON is parsed and capped; Anthropic preferred when a key exists', async () => {
  const calls = [];
  const env = { AI: { async run(model, args) { calls.push(model); return { response: 'text before {"hebrew_issues":["חזרה על הפתיח"],"lessons":["א","ב","ג","ד"],"memory_updates":["לשאול מתי נוח","x","y"]} after' }; } } };
  const rv = await reviewCall(env, find('סימה ודוד', 33));
  assert.deepEqual(calls, ['@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
  assert.equal(rv.lessons.length, 3);
  assert.equal(rv.memory_updates.length, 2);
  assert.ok(rv.hebrew_issues.includes('חזרה על הפתיח'));
  assert.equal(rv.verdict, 'review', 'the model never changes the rules verdict');

  const seen = [];
  const fetchMock = async (url, init) => { seen.push({ url, model: JSON.parse(init.body).model, key: init.headers['x-api-key'] }); return { ok: true, async json() { return { content: [{ type: 'text', text: '{"hebrew_issues":[],"lessons":["לקח"],"memory_updates":[]}' }] }; } }; };
  const m = await modelReview({ ANTHROPIC_API_KEY: 'k', AI: env.AI }, find('סימה ודוד', 33), { fetch: fetchMock });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].model, 'claude-opus-5-5');
  assert.equal(m.model, 'claude-opus-5-5');
  assert.deepEqual(m.lessons, ['לקח']);

  const hung = await reviewCall(env, find('טל', 7));
  assert.equal(calls.length, 1, 'a hangup is not sent to the model');
  const broken = await reviewCall({ AI: { async run() { return { response: 'not json' }; } } }, find('סימה ודוד', 33));
  assert.deepEqual(broken.lessons, [], 'garbage from the model = nothing, no throw');
});

test('applyReview: auto-fix goes through the call_result path only with NOA_CHASE=on; mismatches post one quiet Slack line', async () => {
  const kv = new Map();
  const env = { NOA_CHASE: 'on', RATE: { async get(k) { return kv.get(k) || null; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } }, SLACK_ALERT_HOOK: '' };
  const writes = [];
  const call = find('בטי', 22);
  const rv = await reviewCall(env, call, { model: false });
  const out = await applyReview(env, call, rv, { writeCallResult: async (gid, result) => { writes.push({ gid, result }); return true; } });
  assert.equal(out.applied, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].gid, call.guest_id);
  assert.equal(writes[0].result.rsvp, 'מתלבט');
  assert.equal(writes[0].result.tries, 1, 'the dial consumed the attempt');
  const streamed = [...kv.entries()].filter(([k]) => k.startsWith('stream:')).map(([, v]) => JSON.parse(v));
  assert.ok(streamed.some(s => s.kind === 'call' && s.area === 'בקרה' && s.action === 'תוקן אוטומטית מהתמליל'), 'journal line');

  /* hangup → לא ענה with a retry */
  const hcall = find('טל', 7);
  const hw = [];
  await applyReview(env, hcall, await reviewCall(env, hcall, { model: false }), { writeCallResult: async (gid, result) => { hw.push(result); return true; } });
  assert.equal(hw[0].answer.startsWith('לא ענה'), true);
  assert.equal(hw[0].rsvp, '__keep__');

  /* flag off: nothing is written, the gap is journaled for a human */
  const off = { ...env, NOA_CHASE: 'off' };
  const w2 = [];
  const o2 = await applyReview(off, call, rv, { writeCallResult: async () => { w2.push(1); return true; } });
  assert.equal(o2.applied, false);
  assert.equal(w2.length, 0);

  /* memory updates pass through the guard */
  const o3 = await applyReview(env, call, { ...rv, verdict: 'ok', auto_fix: false, memory_updates: ['לשאול מתי נוח לחזור', 'להציע הנחה'] }, {});
  assert.deepEqual(o3.memory.added, ['לשאול מתי נוח לחזור']);
  assert.equal(o3.memory.rejected[0].why, 'banned:הנחה');
  assert.ok(kv.get('shir-memory').includes('לשאול מתי נוח לחזור'));
});

test('callFromRetell maps the webhook body to the reviewer shape', () => {
  const c = callFromRetell({ call_id: 'c1', transcript: 'User: הלו\n', start_timestamp: 1000, end_timestamp: 6000, to_number: '+972500000001',
    metadata: { kind: 'guest', guest_id: 'G-1', token: 't', tries: '1', max_tries: '3' }, retell_llm_dynamic_variables: { guest_name: 'דנה', event_name: 'אורי' } },
  { result: { rsvp: '__keep__', answer: 'שיחה ללא תוצאה ברורה' } });
  assert.equal(c.agent, 'שיר'); assert.equal(c.duration_s, 5); assert.equal(c.guest_name, 'דנה'); assert.equal(c.event, 'אורי'); assert.equal(c.tries, 1); assert.equal(c.phone, '972500000001');
  assert.equal(callFromRetell({ metadata: { kind: 'lead' } }).agent, 'נועה');
});
