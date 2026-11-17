import test from 'node:test'; import assert from 'node:assert/strict';
import { STYLES, STYLE_KEYS, OWN_TEMPLATE, normStyle, tmplName, templatePayload, pickStyled, styledTemplate, refreshStatus, submitAll } from '../invite-styles.js';
const kv = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; };
test('four styles; the general one has no template of its own; each of the others carries the same six parameters once each', () => {
  assert.deepEqual(STYLE_KEYS, ['happy', 'serious', 'respectful', 'playful']); assert.equal(OWN_TEMPLATE('happy'), false); assert.equal(normStyle('nope'), '');
  for (const s of ['serious', 'respectful', 'playful']) { const b = STYLES[s].body; for (let i = 1; i <= 6; i++) assert.equal(b.split('{{' + i + '}}').length, 2, s + ' param ' + i); assert.ok(!/^\{\{/.test(b) && !/\}\}$/.test(b), 'Meta refuses a body that starts or ends with a parameter'); assert.ok(b.length < 1024); }
});
test('payload: name per style and form, header only with a sample, buttons and footer as on the general template', () => {
  assert.equal(tmplName('serious', 'text'), 'hazmana_ishur_serious'); assert.equal(tmplName('playful', 'img'), 'hazmana_ishur_playful_img'); assert.equal(tmplName('respectful', 'vid'), 'hazmana_ishur_respectful_vid');
  const t = templatePayload('serious', 'text'); assert.deepEqual(t.components.map(c => c.type), ['BODY', 'FOOTER', 'BUTTONS']); assert.equal(t.language, 'he'); assert.equal(t.components[2].buttons.length, 3); assert.equal(t.components[0].example.body_text[0].length, 6);
  assert.equal(templatePayload('serious', 'img'), null, 'no sample, no submission'); assert.equal(templatePayload('happy', 'text'), null);
  const v = templatePayload('playful', 'vid', 'H1'); assert.deepEqual([v.components[0].type, v.components[0].format, v.components[0].example.header_handle[0]], ['HEADER', 'VIDEO', 'H1']);
});
test('the sender gets the styled template only when it is approved; anything else falls back to the general one', async () => {
  assert.equal(pickStyled('serious', 'img', 'BASE', { hazmana_ishur_serious_img: true }), 'hazmana_ishur_serious_img'); assert.equal(pickStyled('serious', 'img', 'BASE', {}), 'BASE'); assert.equal(pickStyled('happy', 'text', 'BASE', { x: 1 }), 'BASE'); assert.equal(pickStyled('', 'text', 'BASE', null), 'BASE');
  const env = { RATE: kv({ 'invstyle:T1': 'serious', 'invstyle:T2': 'playful', 'invstyle:T3': 'junk', 'stmplok:hazmana_ishur_serious': '1' }) };
  assert.equal(await styledTemplate(env, 'T1', 'text', 'BASE'), 'hazmana_ishur_serious'); assert.equal(await styledTemplate(env, 'T1', 'img', 'BASE_IMG'), 'BASE_IMG', 'that form is not approved yet');
  assert.equal(await styledTemplate(env, 'T2', 'text', 'BASE'), 'BASE'); assert.equal(await styledTemplate(env, 'T3', 'text', 'BASE'), 'BASE'); assert.equal(await styledTemplate(env, 'none', 'text', 'BASE'), 'BASE');
  assert.equal(await styledTemplate({ RATE: { get: async () => { throw new Error('kv down'); } } }, 'T1', 'text', 'BASE'), 'BASE', 'a storage error never blocks a send');
});
test('status marks only approved templates as usable and un-marks one that Meta paused; submit sends only the missing ones', async () => {
  const env = { WA_TOKEN_GUESTS: 't', RATE: kv({ 'stmplok:hazmana_ishur_playful': '1' }) }; const posted = [];
  const fetchFn = async (url, init) => { if (init && init.method === 'POST') { const b = JSON.parse(init.body); posted.push(b.name); return new Response(JSON.stringify(b.name.endsWith('_vid') ? { error: { message: 'bad sample' } } : { id: 'x', status: 'PENDING' })); }
    return new Response(JSON.stringify({ data: [{ name: 'hazmana_ishur_serious', status: 'APPROVED', category: 'UTILITY' }, { name: 'hazmana_ishur_playful', status: 'PAUSED' }, { name: 'hazmana_ishur_respectful', status: 'PENDING' }] })); };
  const s = await refreshStatus(env, fetchFn); assert.equal(s.templates.length, 9); assert.equal(env.RATE.m.get('stmplok:hazmana_ishur_serious'), '1'); assert.ok(!env.RATE.m.has('stmplok:hazmana_ishur_playful'));
  assert.equal(s.templates.find(t => t.name === 'hazmana_ishur_serious_img').status, 'MISSING');
  const r = await submitAll(env, { fetchFn, headerHandle: async k => (k === 'img' ? 'HIMG' : 'HVID') });
  assert.equal(posted.length, 6, 'three exist already, six are new'); assert.ok(!posted.includes('hazmana_ishur_serious')); assert.equal(r.results.filter(x => x.submitted).length, 3); assert.equal(r.results.filter(x => x.error).length, 3); assert.equal(r.results.filter(x => x.skipped).length, 3);
});
