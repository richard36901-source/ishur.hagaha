/* 18/11 Richard: a blank line above the table line and after the navigation line; nothing else changes */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spacedBody } from '../index.js';

const DB = 'היי {{1}}, תזכורת קטנה: מחר חוגגים את {{2}}! 🎉\n📅 בתאריך {{3}} בשעה {{4}}\n📍 הכתובת: {{5}}\n🪑 השולחן שלכם: שולחן מספר {{6}}.\n🧭 לניווט לחצו על הכפתור למטה.\n🎁 מי שירצה לתת מתנה לבעלי השמחה, אפשר בביט או בפייבוקס בכפתור למטה.\nשמרו את ההודעה עם הפרטים, ונתראה שם. מחכים לראותכם!';
test('table + navigation: one blank line above the table and one after the navigation line', () => {
  const out = spacedBody(DB).split('\n');
  assert.equal(out[3], ''); assert.match(out[4], /השולחן שלכם/); assert.match(out[5], /לניווט לחצו/); assert.equal(out[6], ''); assert.match(out[7], /מתנה/);
  assert.equal(out.length, DB.split('\n').length + 2);
});
test('the words and the variables are untouched, in the same order', () => {
  assert.equal(spacedBody(DB).replace(/\n+/g, '\n'), DB);
  assert.deepEqual(spacedBody(DB).match(/\{\{\d\}\}/g), DB.match(/\{\{\d\}\}/g));
});
test('never two blank lines in a row (Meta refuses them); running it twice changes nothing more', () => {
  const once = spacedBody(DB); assert.ok(!/\n\n\n/.test(once)); assert.equal(spacedBody(once), once);
});
test('no table and no navigation line → unchanged', () => {
  const t = 'שלום {{1}}! מחכים לראותכם היום ב{{2}} 🎉\n⏰ שעה: {{3}}\n📍 הכתובת: {{4}}\nמאחלים ערב מושלם, נתראה!';
  assert.equal(spacedBody(t), t);
});
test('navigation as the last line gets no trailing blank line', () => {
  const t = 'שלום {{1}}\nלניווט לחצו על הכפתור למטה.'; assert.equal(spacedBody(t), t);
});
