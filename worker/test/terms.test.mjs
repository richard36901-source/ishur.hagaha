/* 26/11 Richard (terminology): no answer yet reads "מתלבט/ת / מתלבטים", an unsure answer ('מתלבט' in the sheet) reads "אולי".
   Labels only: the stored values and the add-on scope they drive stay the same. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsvpHe } from '../team-log.js';
import { _parseAddonDesc } from '../index.js';
import { AUDIENCE_HE, audienceIncludes } from '../send-plan.js';
import { STATUS_HE as SUB_HE } from '../subevent.js';

test('rsvpHe: stored rsvp → the words people read; the stored value itself is untouched', () => {
  assert.equal(rsvpHe(''), 'מתלבט/ת');
  assert.equal(rsvpHe(undefined), 'מתלבט/ת');
  assert.equal(rsvpHe('מתלבט'), 'אולי');
  assert.equal(rsvpHe('מגיע'), 'מגיע');
  assert.equal(rsvpHe('לא מגיע'), 'לא מגיע');
  assert.equal(rsvpHe('משהו אחר'), 'משהו אחר');
});

test('extra-send add-on: the renamed label still parses to the unanswered scope, and payments made under the old label still do', () => {
  assert.equal(_parseAddonDesc('תוספת: שליחה נוספת למתלבטים · 40 מוזמנים · abcdef12').scope, 'unanswered');
  assert.equal(_parseAddonDesc('תוספת: שליחה נוספת ללא ענו · 40 מוזמנים · abcdef12').scope, 'unanswered');
  assert.equal(_parseAddonDesc('תוספת: שליחה נוספת לכולם · 200 מוזמנים · abcdef12').scope, 'all');
  assert.equal(_parseAddonDesc('תוספת: סבב שיחות AI למתלבטים · 40 מוזמנים · abcdef12').kind, 'calls');
});

test('audience words follow the new terms; who is in each audience does not change', () => {
  assert.deepEqual(AUDIENCE_HE, { all: 'כולם', unanswered: 'מתלבטים + אולי', noanswer: 'רק מתלבטים', undecided: 'אולי' });
  assert.deepEqual(['', 'מתלבט', 'מגיע'].filter(r => audienceIncludes('noanswer', r)), ['']);
  assert.deepEqual(['', 'מתלבט', 'מגיע'].filter(r => audienceIncludes('undecided', r)), ['מתלבט']);
  assert.equal(SUB_HE.none, 'מתלבטים');
  assert.equal(SUB_HE.undecided, 'אולי');
});
