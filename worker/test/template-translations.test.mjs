// node --test worker/test/template-translations.test.mjs — the guest templates in six languages
// (scripts/translate-templates.mjs, round 7 Part B). Checks the generated files against Meta's limits and their Hebrew source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { build } from '../scripts/translate-templates.mjs';
import { GUEST_LANGS } from '../guest-lang.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const T = JSON.parse(fs.readFileSync(path.join(DIR, 'i18n', 'lines.json'), 'utf8'));
const SRC = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))).filter(s => !T.skip.includes(s.payload.name));
const HEB = /[֐-׿]/;
const RSVP = ['מגיע/ה', 'לא מגיע/ה', 'עדיין לא ידוע'];
const vars = t => [...t.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
const comp = (p, type) => p.components.find(c => c.type === type);

test('every Hebrew line and button has all six translations', () => {
  const miss = [];
  for (const s of SRC) {
    for (const line of comp(s.payload, 'BODY').text.split('\n').filter(l => l.trim())) {
      const e = T.lines[line.replace(/\{\{\d+\}\}/g, '{{#}}')];
      for (const l of GUEST_LANGS) if (!e || !e[l]) miss.push(l + ': ' + line);
    }
    /* the three answer buttons come from guest-lang.js (guestButtons), every other button from the table */
    for (const b of (comp(s.payload, 'BUTTONS') || { buttons: [] }).buttons) for (const l of GUEST_LANGS) if (!(b.type === 'QUICK_REPLY' && RSVP.includes(b.text)) && !(T.buttons[b.text] || {})[l]) miss.push(l + ' button: ' + b.text);
  }
  assert.deepEqual(miss, []);
});

test('each translated line keeps exactly the placeholders of its Hebrew line', () => {
  for (const [he, e] of Object.entries(T.lines)) for (const l of GUEST_LANGS)
    assert.equal((e[l].match(/\{\{#\}\}/g) || []).length, (he.match(/\{\{#\}\}/g) || []).length, `${l}: ${e[l]}`);
});

for (const s of SRC) for (const lang of GUEST_LANGS) for (const mode of ['alone', 'pair']) {
  const t = build(s, lang, mode), p = t.payload, name = p.name;
  test(`${name}: within Meta's limits and true to ${s.payload.name}`, () => {
    const body = comp(p, 'BODY').text, src = comp(s.payload, 'BODY').text, n = new Set(vars(src)).size;
    assert.equal(name, s.payload.name + '_' + (mode === 'pair' ? 'he' : '') + lang);
    assert.equal(p.language, mode === 'pair' ? 'he' : (lang === 'pt' ? 'pt_BR' : lang));
    assert.equal(p.category, s.payload.category);
    assert.ok(body.length <= 1024, `body ${body.length}`);
    const want = mode === 'pair' ? 2 * n : n;
    assert.deepEqual([...new Set(vars(body))].sort((a, b) => a - b), Array.from({ length: want }, (_, i) => i + 1), 'variables 1..' + want);
    const ex = comp(p, 'BODY').example;
    if (ex) assert.equal(ex.body_text[0].length, want);
    if (mode === 'alone') assert.ok(!HEB.test(body), 'Hebrew left in: ' + body);
    else { assert.ok(body.startsWith(src + '\n\n'), 'pair starts with the Hebrew message'); assert.equal(t.pairParams, 'repeat'); }
    const f = comp(p, 'FOOTER'); if (f) assert.ok([...f.text].length <= 60, f.text);
    const sb = (comp(s.payload, 'BUTTONS') || { buttons: [] }).buttons, tb = (comp(p, 'BUTTONS') || { buttons: [] }).buttons;
    assert.equal(tb.length, sb.length);
    tb.forEach((b, i) => {
      assert.equal(b.type, sb[i].type); assert.equal(b.url, sb[i].url); assert.deepEqual(b.example, sb[i].example);
      assert.ok([...b.text].length <= 25, `button "${b.text}" is ${[...b.text].length}`);
      if (mode === 'alone') assert.ok(!HEB.test(b.text), b.text);
    });
  });
}

test('the files on disk are exactly what the generator builds (no hand edits, nothing stale)', () => {
  const OUT = path.join(DIR, 'i18n', 'out'), names = new Set();
  for (const s of SRC) for (const lang of GUEST_LANGS) for (const mode of ['alone', 'pair']) {
    const t = build(s, lang, mode); names.add(t.payload.name + '.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(OUT, t.payload.name + '.json'), 'utf8')), t, t.payload.name);
  }
  assert.deepEqual(fs.readdirSync(OUT).sort(), [...names].sort());
});
