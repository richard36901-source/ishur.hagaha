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

/* ══ 22/11 sending in the event's language (sendTemplate hook) and the board's choice ══ */
import { sendTemplate, _resetBudgetMemory } from '../whatsapp.js';
import { beforeEach, afterEach } from 'node:test';
function kv(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, get: async (k, t) => { if (!m.has(k)) return null; const v = m.get(k); return t === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
    list: async ({ prefix = '', limit = 1000 } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }), getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) };
}
const TOKEN = 'cccccccc-0000-4000-8000-000000000001';
let posts = [], fail = {}, realFetch;
beforeEach(() => {
  _resetBudgetMemory(); posts = []; fail = {}; realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (/\/messages$/.test(u) && init.method === 'POST') {
      const b = JSON.parse(init.body); posts.push(b);
      const f = fail[b.template && b.template.name]; if (f) return json({ error: { code: f, message: 'fake' } }, 400);
      return json({ messages: [{ id: 'wamid.' + posts.length }] });
    }
    return json({});
  };
});
afterEach(() => { globalThis.fetch = realFetch; });
const envWith = (store = {}, extra = {}) => ({ RATE: kv(store), WA_PHONE_ID_GUESTS: 'A', WA_TOKEN_GUESTS: 't', WA_TOKEN: 'tc', WA_PHONE_ID: 'C', ...extra });
const ON = { GUEST_LANG: 'on' };
const send = (env, name = 'ishur_yom_plain_t', params = ['דנה', 'החתונה', '19:30', 'אולם', '12']) => sendTemplate(env, '0501234567', name, params, '', 'he', 'guests', { token: TOKEN, wave: 'eventday' });
const sentAs = () => posts.map(p => p.template.name + '/' + p.template.language.code);
const paramsOfPost = p => ((p.template.components || []).find(c => c.type === 'body') || { parameters: [] }).parameters.map(x => x.text);

test('switch off (production today): Hebrew goes out exactly as before, even when the event chose a language', async () => {
  const r = await send(envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}' }));
  assert.equal(r.ok, true); assert.deepEqual(sentAs(), ['ishur_yom_plain_t/he']);
});
test('switch on, no choice for the event: Hebrew', async () => {
  await send(envWith({}, ON)); assert.deepEqual(sentAs(), ['ishur_yom_plain_t/he']);
});
test('switch on, English alone: the English copy, same values, one send', async () => {
  await send(envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}' }, ON));
  assert.deepEqual(sentAs(), ['ishur_yom_plain_t_en/en']);
  assert.deepEqual(paramsOfPost(posts[0]), ['דנה', 'החתונה', '19:30', 'אולם', '12']);
});
test('switch on, Portuguese alone: labelled pt_BR', async () => {
  await send(envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"pt"}' }, ON)); assert.deepEqual(sentAs(), ['ishur_yom_plain_t_pt/pt_BR']);
});
test('switch on, Hebrew + Russian: the pair copy (labelled he) gets every value twice', async () => {
  await send(envWith({ ['guestlang:' + TOKEN]: '{"mode":"pair","lang":"ru"}' }, ON));
  assert.deepEqual(sentAs(), ['ishur_yom_plain_t_heru/he']);
  assert.equal(paramsOfPost(posts[0]).length, 10);
});
test('a template with no translation (the client\'s own invitation, say) goes out in Hebrew', async () => {
  /* a client's own wording is submitted under its own name (custom_…), never one of ours */
  await send(envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}' }, ON), 'custom_dana_wedding_1', []);
  assert.deepEqual(sentAs(), ['custom_dana_wedding_1/he']);
});
test('Meta does not know the copy (132001): the Hebrew goes out at once, and the copy is not tried again for 6 hours', async () => {
  fail['ishur_yom_plain_t_en'] = 132001;
  const env = envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}' }, ON);
  const r = await send(env);
  assert.equal(r.ok, true); assert.deepEqual(sentAs(), ['ishur_yom_plain_t_en/en', 'ishur_yom_plain_t/he']);
  assert.ok(env.RATE.m.has('tmplmiss:ishur_yom_plain_t_en'));
  posts = []; await send(env);
  assert.deepEqual(sentAs(), ['ishur_yom_plain_t/he'], 'second guest: straight to Hebrew');
});
test('any other failure (the guest\'s number) is reported as it is, never sent twice', async () => {
  fail['ishur_yom_plain_t_en'] = 131026;
  const r = await send(envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}' }, ON));
  assert.equal(r.ok, false); assert.deepEqual(sentAs(), ['ishur_yom_plain_t_en/en']);
});
test('messages to clients are never touched', async () => {
  await sendTemplate(envWith({ ['guestlang:' + TOKEN]: '{"mode":"alone","lang":"en"}' }, ON), '0501234567', 'ishur_yom_plain_t', ['a', 'b', 'c', 'd', 'e'], '', 'he', 'client', { token: TOKEN });
  assert.ok(posts.every(p => p.template.name.indexOf('_en') < 0));
});
test('TRANSLATED is exactly the set of templates the generator translated', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), { fileURLToPath } = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'i18n', 'out');
  const bases = new Set(fs.readdirSync(dir).filter(f => /_en\.json$/.test(f)).map(f => f.replace(/_en\.json$/, '')));
  assert.deepEqual([...G.TRANSLATED].sort(), [...bases].sort());
});

test('the board\'s choice: saved, read back, Hebrew removes it, refused once the invitations went out', async () => {
  const env = envWith();
  assert.deepEqual((await G.guestLangApi(env, TOKEN, null)).choice, { mode: 'he' });
  assert.equal((await G.guestLangApi(env, TOKEN, { mode: 'pair', lang: 'ar' })).ok, true);
  assert.deepEqual((await G.guestLangApi(env, TOKEN, null)).choice, { mode: 'pair', lang: 'ar' });
  assert.equal((await G.guestLangApi(env, TOKEN, { mode: 'alone', lang: 'yi' })).error, 'bad-choice', 'Yiddish is not a guest language');
  assert.equal((await G.guestLangApi(env, TOKEN, { mode: 'he' })).ok, true);
  assert.equal(env.RATE.m.has('guestlang:' + TOKEN), false);
  env.RATE.m.set('wave:' + TOKEN + ':1', '1');
  const r = await G.guestLangApi(env, TOKEN, { mode: 'alone', lang: 'en' });
  assert.equal(r.error, 'already-sent'); assert.equal(r.locked, true);
});

test('fixed Hebrew words in a message are translated; names and places are not', () => {
  assert.equal(G.translateValue('חתונה', 'en'), 'wedding');
  assert.equal(G.translateValue('החתונה של דנה ויואב', 'en'), 'the wedding of דנה ויואב');
  assert.equal(G.translateValue('הבר מצווה של איתי', 'fr'), 'bar-mitsva de איתי');
  assert.equal(G.translateValue('מגיעים, 3 אורחים', 'es'), 'vamos, 3 invitados');
  assert.equal(G.translateValue('לא מגיעים', 'ru'), 'не придём');
  assert.equal(G.translateValue('פרטים בהמשך', 'pt'), 'detalhes em breve');
  for (const keep of ['דנה', 'אולמי הגן, רמת גן', '19:30', '03.12.2026', 'החתונה שלנו בגן', 'חתונה בגן']) assert.equal(G.translateValue(keep, 'en'), keep, keep);
  assert.equal(G.translateValue('חתונה', 'yi'), 'חתונה', 'not a guest language');
});
test('alone: the values are translated; pair: the Hebrew half keeps Hebrew values, the second half gets translated ones', () => {
  const p = ['דנה', 'החתונה של נועה ויונתן', '19:30'];
  assert.deepEqual(G.variantFor('ishur_shulchan', { mode: 'alone', lang: 'en' }, p).params, ['דנה', 'the wedding of נועה ויונתן', '19:30']);
  assert.deepEqual(G.variantFor('ishur_shulchan', { mode: 'pair', lang: 'en' }, p).params, [...p, 'דנה', 'the wedding of נועה ויונתן', '19:30']);
});
