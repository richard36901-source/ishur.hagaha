#!/usr/bin/env node
/* ============================================================================
   build-automations-fixture.mjs — run the REAL handleAutomations() in Node
   against a fake env, and write automations.fixture.json for the page.
   ----------------------------------------------------------------------------
   · env.RATE is an in-memory KV whose put()/delete() THROW — so this run also
     proves the handler is read-only (any write = crash = non-zero exit).
   · The snapshot, KV contents and audit rows below are INVENTED. The output is
     stamped fixture:true and the page shows a "נתוני דמה" banner.
   Usage: node worker/scripts/build-automations-fixture.mjs [out.json]
   ========================================================================== */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAutomations } from '../automations.js';
import { ilDate } from '../shir.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2] ? resolve(process.argv[2]) : resolve(ROOT, 'automations.fixture.json');
const today = ilDate();
const day = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const ymd = today.replace(/-/g, '');
const T1 = '11111111-aaaa-4bbb-8ccc-000000000001', T2 = '22222222-aaaa-4bbb-8ccc-000000000002', T3 = '33333333-aaaa-4bbb-8ccc-000000000003';

const now = Date.now();
const store = new Map(Object.entries({
  'invitetmpl': 'hazmana_ishur',
  'pacer:pending': today,
  'pacer:last': JSON.stringify({ at: new Date(now - 4 * 60e3).toISOString(), date: today, sends: { ran: true, truncated: true }, calls: { dialed: 3, queued: 12 }, callbacks: { dialed: 0 }, leads: 0, doctor: { ok: true, fixed: 0 } }),
  'engine:lastrun': JSON.stringify({ at: new Date(now - 3 * 3600e3).toISOString(), date: today, items: 9 }),
  'wacap:1409632775565601': new Date(now - 2 * 3600e3).toISOString(),
  ['gsend:1409632775565601:' + today]: '250', ['gsend:FAKE_GUEST_ID_1:' + today]: '61',
  ['hold:' + T3]: new Date(now - 86400e3).toISOString(),
  ['wave:' + T1 + ':1']: day(-5),
  ['edblast:' + T1]: JSON.stringify({ at: day(1), time: '19:30', what: 'החתונה', template: 'ishur_yom_haerua', no_table: true }),
  ['callround:' + T2]: JSON.stringify({ at: day(2), guest_ids: ['g1', 'g2', 'g3'], note: 'סבב שני' }),
}));
const rows = [];
const rec = (msAgo, kind, extra) => { const ts = now - msAgo; const k = `stream:${ymd}:${ts}:${Math.random().toString(36).slice(2, 6)}`; store.set(k, JSON.stringify({ ts, at: new Date(ts).toISOString(), kind, ok: true, ...extra })); rows.push(k); };
for (const [i, job] of ['runPacer', 'runEventDayBlasts', 'drainCallRounds', 'drainPartyNudges', 'drainLeadPings', 'pullMetaFormLeads', 'checkCustomTemplates', 'drainNoaQueue', 'drainAdminCalls', 'adsHealthWatch'].entries())
  rec(4 * 60e3 + i * 1000, 'cron', { data: { job, ms: 300 + i * 40, ok: true } });
for (let i = 0; i < 40; i++) rec(30 * 60e3 + i * 5000, 'wa_out', { ok: i % 10 !== 9, data: { template: i < 30 ? 'ishur_yom_lifnei' : 'hazmana_ishur', phone_id: i % 2 ? '1409632775565601' : 'FAKE_GUEST_ID_1', wamid: 'wamid.F' + i } });
for (let i = 0; i < 6; i++) rec(20 * 60e3 + i * 1000, 'wa_status', { ok: false, detail: '131048 Spam rate limit hit', data: { wamid: 'wamid.F' + i, status: 'failed' } });

const RATE = {
  async get(k) { return store.has(k) ? store.get(k) : null; },
  async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true }; },
  async put(k) { throw new Error('READ-ONLY VIOLATION: put ' + k); },
  async delete(k) { throw new Error('READ-ONLY VIOLATION: delete ' + k); },
};
const env = { RATE, ADMIN_KEY: 'fixture-key', WA_PHONE_ID_GUESTS: 'FAKE_GUEST_ID_1', WA_TOKEN_GUESTS: 'x', WA_PHONE_IDS_GUESTS: '1409632775565601', WA_PHONE_ID_CLIENT: '1218978741299669', HOOK_STATUS: 'fake' };

/* events row: [0]id [1]token [2]name [3]phone [5]occasion [6]date [7]paid [27]cancelled [31]plan [34]display [39..41]waves [43]fileUp */
const evRow = (token, name, date, plan, w1, w2) => { const r = Array(45).fill(''); r[1] = token; r[2] = name; r[3] = '0500000000'; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; r[31] = plan; r[34] = name; r[39] = w1; r[40] = w2; r[43] = 'כן'; return r; };
const gRow = (token, i, rsvp, table) => { const r = Array(31).fill(''); r[2] = 'g' + i; r[3] = 'אורח ' + i; r[4] = '0500000' + String(100 + i); r[15] = rsvp; r[28] = token; r[30] = table || ''; return r; };
const snapshot = {
  events: { values: [evRow(T1, 'דמה · חתונה מחר', day(1), 'הכל כלול', day(-5), day(-2)), evRow(T2, 'דמה · בר מצווה', day(5), 'פרמיום', day(-1), day(2)), evRow(T3, 'דמה · מוחזק', day(3), 'בסיס', day(0), '')] },
  guests: { values: [
    ...Array.from({ length: 30 }, (_, i) => gRow(T1, i, i < 20 ? 'מגיע' : i < 25 ? 'לא מגיע' : '', i < 12 ? String(1 + (i % 6)) : '')),
    ...Array.from({ length: 18 }, (_, i) => gRow(T2, 100 + i, i < 6 ? 'מגיע' : i < 8 ? 'מתלבט' : '')),
    ...Array.from({ length: 8 }, (_, i) => gRow(T3, 200 + i, '')),
  ] },
};
const deps = { fetchSnapshot: async () => snapshot };

const req = new Request('https://fixture.local/api/automations', { method: 'POST', body: JSON.stringify({ admin_key: 'fixture-key' }) });
const res = await handleAutomations(req, env, 'https://ishur.io', deps);
const body = await res.json();
if (res.status !== 200 || !body.ok) { console.error('handler failed', res.status, body); process.exit(1); }
const bad = await handleAutomations(new Request('https://x/', { method: 'POST', body: JSON.stringify({ admin_key: 'nope' }) }), env, '', deps);
if (bad.status !== 403) { console.error('expected 403 for a wrong key, got', bad.status); process.exit(1); }
body.fixture = true;
body.fixture_note = 'נתוני דמה — נוצר מקומית ע"י worker/scripts/build-automations-fixture.mjs. הרשומה (registry) אמיתית; המצב החי והאירועים מומצאים.';
writeFileSync(out, JSON.stringify(body, null, 1));
console.log(`fixture OK → ${out} · ${body.registry.nodes.length} nodes · ${body.registry.edges.length} edges · ${body.timeline.items.length} timeline items · ${body.timeline.events.length} events · audit rows ${body.live.global.audit_rows_scanned} · 403 on bad key ✓ · no KV writes ✓`);
