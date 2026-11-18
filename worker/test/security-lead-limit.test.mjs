// node --test worker/test/security-lead-limit.test.mjs — 12/11 security audit, pass 2: the public lead form
// cannot be used to make the business number message a list of strangers. A new lead still reaches the
// sheet, Monday and Slack; only the automatic WhatsApp follow-up is withheld past the limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/* a clock the Worker's `new Date()` and Date.now() both follow: Thursday 12/11/2026, 12:00 in Israel */
const RealDate = Date; let NOW = RealDate.parse('2026-11-12T10:00:00Z');
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
globalThis.Date = FakeDate;
const { default: worker } = await import('../index.js');

function kv(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); },
  list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name })), list_complete: true }), getWithMetadata: async k => ({ value: m.has(k) ? m.get(k) : null, metadata: null }) }; }
let realFetch, sent = [], hooked = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (u, init = {}) => {
  const s = String(u);
  if (s === 'https://hook.test/leads') { hooked.push(JSON.parse(init.body)); return new Response('Accepted'); }
  if (/graph\.facebook\.com\/.*\/messages/.test(s)) { const b = JSON.parse(init.body || '{}'); sent.push({ to: b.to, template: b.template && b.template.name }); return new Response(JSON.stringify({ messages: [{ id: 'wamid.' + sent.length }] })); }
  return new Response('{}'); }; });
after(() => { globalThis.fetch = realFetch; globalThis.Date = RealDate; });
const ctx = { waitUntil: p => { if (p && p.catch) p.catch(() => {}); }, passThroughOnException: () => {} };
const env = (init = {}) => ({ ADMIN_KEY: 'k', APP_KEY: 'app', HOOK_LEADS: 'https://hook.test/leads', WA_TOKEN: 't', WA_PHONE_ID_CLIENT: 'NOA', RATE: kv(init) });
const stamp = () => { const nonce = crypto.randomBytes(8).toString('hex'), stamp_ts = String(NOW); return { app: 'ishur-web', nonce, stamp_ts, sig: crypto.createHash('sha256').update(`app|${nonce}|${stamp_ts}`).digest('hex') }; };
const lead = (e, phone, ip, extra = {}) => worker.fetch(new Request('https://go.ishur.io/api/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: 'https://ishur.io' },
  body: JSON.stringify({ ...stamp(), phone, name: 'דנה', occasion: 'חתונה', event_type: 'lead_submitted', ...extra }) }), e, ctx);
const rec = (e, p) => JSON.parse(e.RATE.m.get('lead:' + p) || 'null');

test('one IP: the first five new numbers are followed up, the rest are kept but not messaged', async () => {
  const e = env(); hooked = [];
  for (let i = 0; i < 8; i++) assert.equal((await lead(e, '05211100' + String(10 + i), '9.9.9.9')).status, 200, 'the form answers the same either way');
  assert.equal(hooked.length, 8, 'every lead still reaches the sheet');
  for (let i = 0; i < 5; i++) assert.ok(!rec(e, '97252111001' + i).nochase, 'lead ' + i + ' is followed up');
  for (let i = 5; i < 8; i++) assert.ok(rec(e, '9725211100' + String(10 + i)).nochase, 'lead ' + i + ' is held');
  /* the same person sending the form again (partial → full → checkout) is not a new number */
  const e2 = env();
  for (let i = 0; i < 7; i++) await lead(e2, '0521110099', '9.9.9.8');
  assert.ok(!rec(e2, '972521110099').nochase); assert.equal(rec(e2, '972521110099').seen, 7);
  /* another IP is not affected */
  await lead(e, '0521110077', '9.9.9.7'); assert.ok(!rec(e, '972521110077').nochase);
});

test('all IPs together: a daily ceiling on new numbers that get the automatic follow-up', async () => {
  const e = env();
  for (let i = 0; i < 84; i++) await lead(e, '05222' + String(10000 + i), '10.0.' + Math.floor(i / 4) + '.' + (i % 4));
  const held = [...e.RATE.m.keys()].filter(k => k.startsWith('lead:')).filter(k => JSON.parse(e.RATE.m.get(k)).nochase).length;
  assert.equal(held, 4, '80 followed up, 4 held');
});

test('the follow-up engine sends nothing to a held lead, and still follows up a normal one', async () => {
  const at = new RealDate(NOW - 45 * 60000).toISOString();
  const e = env({ 'lead:972521110001': JSON.stringify({ name: 'דנה', occasion: 'חתונה', at, lastAt: at, seen: 1, types: ['lead_submitted'] }),
    'lead:972521110002': JSON.stringify({ name: 'יוסי', occasion: 'חתונה', at, lastAt: at, seen: 1, types: ['lead_submitted'], nochase: 'rate' }) });
  sent = []; const waits = [];
  await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: NOW }, e, { waitUntil: p => waits.push(p) });
  await Promise.allSettled(waits);
  assert.deepEqual(sent.filter(s => /lo_siyem/.test(String(s.template))).map(s => s.to), ['972521110001'], 'only the normal lead got the template');
  assert.equal(e.RATE.m.has('lead:972521110002'), false, 'the held lead is settled, not rescanned every tick');
  assert.match(String(e.RATE.m.get('leadchase:972521110002')), /^nochase/);
});
