/* 25/11/2026: Shir said "רשמתי אחד" and never called the tool. The answer is read from the words, strictly. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transcriptAnswer } from '../callqa.js';

const real = 'Agent: היי סייג, מדברת שיר מאישורי הגעה. ההזמנה שלכם לחתונה של תאיר ואביב עוד מחכה לתשובה — אתם מגיעים?\nUser: כן \nAgent: מעולה, כמה תהיו?\nUser: אחד \nAgent: רשמתי אחד. המשך יום נעים!\n';

test('the real callback (בנימין, 23/11): yes + one → מגיע 1', () => {
  assert.deepEqual(transcriptAnswer(real, 31), { rsvp: 'מגיע', party: 1 });
  assert.deepEqual(transcriptAnswer('Agent: היי, מדברת שיר — מגיעים לחתונה ב-1 בדצמבר?\nUser: כן שניים\nAgent: מעולה, רשמתי שניים.\n', 14), { rsvp: 'מגיע', party: 2 });
  assert.deepEqual(transcriptAnswer('Agent: היי, מדברת שיר מאישורי הגעה בשם תאיר\nUser: כן\nAgent: ואביב — מגיעים לחתונה ב-1 בדצמבר?\nAgent: מעולה, כמה תהיו?\nUser: אחד\nAgent: מעולה, רשמתי אחד.\n', 19), null, 'the "כן" came before the question: not an answer to it');
});

test('anything unclear is left for a person', () => {
  const t = (u1, u2, back) => `Agent: מגיעים לחתונה?\nUser: ${u1}\nAgent: כמה תהיו?\nUser: ${u2}\n${back ? 'Agent: רשמתי ' + back + '\n' : ''}`;
  assert.equal(transcriptAnswer(t('כן', 'שניים או שלושה'), 20), null, 'two numbers');
  assert.equal(transcriptAnswer(t('כן', 'עוד לא יודעים'), 20), null);
  assert.equal(transcriptAnswer(t('אולי', 'שניים'), 20), null);
  assert.equal(transcriptAnswer(t('כן', ''), 20), null, 'no count');
  assert.equal(transcriptAnswer(t('כן', 'שלושה', 'ארבעה'), 20), null, 'Shir read back a different number');
  assert.equal(transcriptAnswer(t('הלו', 'שניים'), 20), null, 'no yes');
  assert.equal(transcriptAnswer('User: כן אחד\nAgent: היי\n', 20), null, 'the question was never asked');
  assert.equal(transcriptAnswer('', 20), null);
});

test('a bare "לא": only after the question, in a call of 8 seconds or more', () => {
  const q = 'Agent: היי, מדברת שיר — מגיעים לחתונה?\nUser: לא\nAgent: הבנתי, תודה\n';
  assert.deepEqual(transcriptAnswer(q, 12), { rsvp: 'לא מגיע' });
  assert.equal(transcriptAnswer(q, 6), null);
  assert.equal(transcriptAnswer('Agent: היי, \nUser: לא \nAgent: מדברת שיר מאישורי הגעה בשם תאיר ואביב — \n', 5), null);
  assert.equal(transcriptAnswer('User: לא לא \nAgent: היי, מדברת שיר מאישורי הגעה בשם תאיר ואביב — מגיעים לחתונה \n', 6), null);
});

test('the net runs for callbacks too, before the end-of-call write, and marks the call as recorded', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = src.indexOf('const ta = transcriptAnswer(c0.transcript'), b = src.slice(at - 1200, at + 1600);
  assert.ok(at > 0 && at < src.indexOf("const toolRanHere = !!(action.call_id && env.RATE && await env.RATE.get('shirtool:' + action.call_id));"));
  assert.ok(b.includes("meta0.kind === 'inbound' || meta0.kind === 'callback'"));
  assert.ok(b.includes("env.RATE.put('shirtool:' + action.call_id, 'net'"));
  assert.ok(b.includes("guardCallParty(env, body, meta0.guest_id, ta.party"));
});

test('25/11 "לא עוד לא" is "not yet": never a refusal (the real call that the first version misread)', () => {
  const t = 'User: הלו\nAgent: היי, מדברת שיר מאישורי הגעה בשם מור ונועם — ראינו שעוד לא סגרתם לגבי החתונה ב-30 בנובמבר. כבר יודעים אם מגיעים?\nUser: לא עוד לא\nAgent: אין לחץ, אפשר לעדכן בוואטסאפ כשתדעו. יום טוב!\n';
  assert.equal(transcriptAnswer(t, 20), null);
  for (const u of ['לא עדיין', 'לא יודע', 'לא עכשיו', 'לא נוח לי', 'לא שמעתי', 'מי זה לא', 'לא אני בנסיעה'])
    assert.equal(transcriptAnswer('Agent: מגיעים לחתונה?\nUser: ' + u + '\n', 20), null, u);
  assert.deepEqual(transcriptAnswer('Agent: מגיעים לחתונה?\nUser: לא לא תודה\n', 20), { rsvp: 'לא מגיע' });
});
