// node --test worker/test/guest-lang.test.mjs — guest buttons in the language the client chose (round 7 Part B,
// .sdlc/client-app/round7-partB-spec.md). Richard 22/11: "same text we got now for the buttons just translated".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../guest-lang.js';
import { parseInboundReply } from '../whatsapp.js';

const HE = ['מגיע/ה', 'לא מגיע/ה', 'עדיין לא ידוע'];
const tap = text => parseInboundReply({ type: 'button', button: { text, payload: text } });
const CHOICES = [{ mode: 'he' }, ...G.GUEST_LANGS.flatMap(lang => [{ mode: 'alone', lang }, { mode: 'pair', lang }])];

test('the six guest languages, as Richard decided (no Yiddish, no Amharic)', () => {
  assert.deepEqual([...G.GUEST_LANGS].sort(), ['ar', 'en', 'es', 'fr', 'pt', 'ru']);
});

test('Hebrew only is exactly today: the same three buttons, the same footer, template language he', () => {
  assert.deepEqual(G.guestButtons({ mode: 'he' }), HE);
  assert.deepEqual(G.guestButtons(undefined), HE);
  assert.equal(G.guestFooter({ mode: 'he' }), 'נשלח ע"י ishur.io · הגיע בטעות? השיבו "טעות"');
  assert.equal(G.templateLang({ mode: 'he' }), 'he');
});

test('an unknown or unsupported language falls back to Hebrew', () => {
  for (const c of [{ mode: 'alone', lang: 'yi' }, { mode: 'pair', lang: 'am' }, { mode: 'alone' }, { mode: 'x', lang: 'en' }]) {
    assert.deepEqual(G.guestButtons(c), HE, JSON.stringify(c));
    assert.equal(G.templateLang(c), 'he');
  }
});

for (const c of CHOICES) {
  const name = c.mode + (c.lang ? ' ' + c.lang : '');
  test(`${name}: three buttons within Meta's 25 characters, footer within 60, no two buttons alike`, () => {
    const b = G.guestButtons(c);
    assert.equal(b.length, 3);
    for (const t of b) assert.ok([...t].length <= 25 && t.trim() === t && t, `"${t}" is ${[...t].length} characters`);
    assert.equal(new Set(b.map(t => t.toLowerCase())).size, 3);
    const f = G.guestFooter(c);
    assert.ok([...f].length <= 60, `footer "${f}" is ${[...f].length}`);
  });
  test(`${name}: a tap on each button is read exactly like the Hebrew button`, () => {
    const b = G.guestButtons(c);
    b.forEach((t, i) => assert.deepEqual(tap(t), tap(HE[i]), `"${t}"`));
    for (const t of b) assert.ok(tap(t), `"${t}" understood`);
  });
}

test('alone: the template is labelled with that language (Portuguese as pt_BR); pair: Hebrew', () => {
  assert.equal(G.templateLang({ mode: 'alone', lang: 'en' }), 'en');
  assert.equal(G.templateLang({ mode: 'alone', lang: 'pt' }), 'pt_BR');
  assert.equal(G.templateLang({ mode: 'pair', lang: 'ru' }), 'he');
});

test('pair buttons carry the Hebrew first, so a Hebrew reader sees today\'s words', () => {
  for (const lang of G.GUEST_LANGS) G.guestButtons({ mode: 'pair', lang }).forEach((t, i) => assert.ok(t.startsWith(HE[i]), t));
});

test('"wrong number" in each language is read like "טעות"; case and spaces do not matter', () => {
  const he = parseInboundReply({ type: 'text', text: { body: 'טעות' } });
  assert.equal(he.kind, 'mistake');
  for (const w of ['mistake', ' Mistake ', 'Wrong number', 'ошибка', 'خطأ', 'erreur', 'error', 'erro'])
    assert.deepEqual(parseInboundReply({ type: 'text', text: { body: w } }), he, w);
});

test('the footer tells the guest the word to send, and that word is understood', () => {
  for (const c of CHOICES) {
    const f = G.guestFooter(c), words = [...f.matchAll(/"([^"\s]+)"/g)].map(m => m[1]);   /* quoted single words; ע"י is not one */
    assert.ok(words.length >= 1, f);
    for (const w of words) assert.equal(parseInboundReply({ type: 'text', text: { body: w } }).kind, 'mistake', `${w} in ${f}`);
  }
});

test('only whole replies are swapped: a sentence that contains a button word is left alone', () => {
  assert.equal(G.toHebrewReply('Coming with my wife and 2 kids'), 'Coming with my wife and 2 kids');
  assert.equal(G.toHebrewReply('there is no mistake here'), 'there is no mistake here');
  assert.equal(G.toHebrewReply('מגיע/ה'), 'מגיע/ה');
});
