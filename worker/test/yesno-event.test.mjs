/* 19/11 Richard (אריאל ודיקלה): an event can be yes/no only — two buttons, no "how many", "מגיע" = one place. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const s = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('a yes/no event never arms the "how many" nudge and answers with the short thanks', () => {
  assert.equal((s.match(/yesNoOnly \? GUEST_REPLY\.yesOnly : GUEST_REPLY\.askParty/g) || []).length, 1);
  assert.equal((s.match(/yesNoOnly2 \? GUEST_REPLY\.yesOnly : GUEST_REPLY\.askParty/g) || []).length, 1);
  assert.match(s, /if \(saved && env\.RATE && !yesNoOnly\) await armPartyNudge/);
  assert.match(s, /if \(saved && env\.RATE && !yesNoOnly2\) await armPartyNudge/);
  assert.match(s, /yesOnly: 'נרשם, תודה! נתראה באירוע 🎉'/);
});
test('the two-button twin is used only when the event is flagged AND the twin was activated', () => {
  assert.match(s, /await env\.RATE\.get\('yesno:' \+ token\)\.catch\(\(\) => null\) \? await env\.RATE\.get\('tmplyn:' \+ chosenTmpl\)/);
  assert.match(s, /sendTemplate\(env, phone, ynTwin \|\| \(abv \? abv\.template : chosenTmpl\)/);
});
test('the twin has exactly the two answers and can only be activated when approved', () => {
  assert.match(s, /buttons: \[\{ type: 'QUICK_REPLY', text: 'מגיע\/ה' \}, \{ type: 'QUICK_REPLY', text: 'לא מגיע\/ה' \}\] \} : c\)/);
  assert.match(s, /if \(row\.twin_status === 'APPROVED'\) \{ await env\.RATE\.put\('tmplyn:' \+ base, twin\)/);
});
