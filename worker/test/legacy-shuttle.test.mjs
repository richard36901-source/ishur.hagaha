import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyShuttleSettings, shirFollowupVars } from '../event-settings.js';

const BUS = { id: 'bus', label: 'הסעה מבאר שבע', q: 'במידה ותהיה הסעה…', yes: 'כן', no: 'לא' };
test('the older bus question becomes Shir\'s shuttle question when the event has no new settings (Shalev 26/11)', () => {
  const v = shirFollowupVars(legacyShuttleSettings(null, BUS));
  assert.equal(v.ask_shuttle, 'כן'); assert.equal(v.shuttle_details, 'מבאר שבע'); assert.match(v.followup_questions, /הסעה/);
});
test('new settings win; no question → nothing asked', () => {
  const s = { questions: { food: { on: true } } };
  assert.equal(legacyShuttleSettings(s, BUS), s);
  assert.equal(shirFollowupVars(legacyShuttleSettings(null, null)).ask_shuttle, '');
  assert.equal(shirFollowupVars(legacyShuttleSettings(null, { id: 'other', q: 'x' })).ask_shuttle, '');
});
