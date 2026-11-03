/* Builds fixtures/ops/brain.json by running the REAL worker/brain.js (runBrain → buildBrain) locally, so the
   fixture has exactly the shape GET /api/ops/brain returns. Until /api/ops/brain is deployed it cannot be read
   live, so the inputs are:
     · LIVE (read-only GET, admin key): /api/ops/capacity?days=3 and /api/ops/balances → the capacity and
       balances checks see production numbers.
     · a local KV double seeded with a few realistic states (pacer tick stale, a template pending 26 h,
       a lead without a Monday item, a 131047 reply) so every screen state has a row.
   Nothing is written anywhere but fixtures/ops/brain.json; no message, Slack or Meta call leaves (fetch is
   stubbed after the two live reads). Event names are pseudonymized and phones masked (buildBrain masks too).
   Once the brain is deployed, scripts/build-ops-fixtures.mjs reads /api/ops/brain live instead.
   Run: OPS_ADMIN_KEY=… node scripts/build-brain-fixture.mjs [--base https://go.ishur.io] */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.OPS_ADMIN_KEY;
const ai = process.argv.indexOf('--base'), BASE = ai > 0 ? process.argv[ai + 1] : 'https://go.ishur.io';
if (!KEY) { console.error('set OPS_ADMIN_KEY'); process.exit(2); }
const live = async (p) => { const r = await fetch(BASE + '/api/ops/' + p, { headers: { 'X-Admin-Key': KEY } }); return r.json(); };
const [capacity, balances] = await Promise.all([live('capacity?days=3'), live('balances')]);

const { runBrain, buildBrain, runLogAppend, P } = await import(pathToFileURL(join(ROOT, 'worker/brain.js')));
const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  const s = String(u);
  if (/message_templates\?fields=name,status/.test(s) && s.includes('1378764257421712')) return new Response(JSON.stringify({ data: [{ name: 'ishur_wave1_f', status: 'PENDING', category: 'MARKETING', language: 'he' }, { name: 'ishur_toda_matana', status: 'APPROVED', language: 'he' }] }));
  if (/message_templates\?name=ishur_wave1_f/.test(s)) return new Response(JSON.stringify({ data: [{ name: 'ishur_wave1_f', status: 'PENDING', category: 'MARKETING', language: 'he', components: [{ type: 'BODY', text: 'שלום {{1}}, הוזמנתם ל{{2}}' }] }] }));
  return new Response(JSON.stringify({ data: [] }));
};
const m = new Map(); const now = Date.now(); const H = 3600e3;
const RATE = { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async (k) => { m.delete(k); }, list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }) };
m.set('pacer:last', JSON.stringify({ at: new Date(now - 38 * 60e3).toISOString() }));
m.set(P.tmpl, JSON.stringify({ base: true, t: { '1378764257421712/ishur_wave1_f/he': { status: 'PENDING', since: now - 26 * H } } }));
m.set('lead:972520000001', JSON.stringify({ name: 'ליד', at: new Date(now - 3 * H).toISOString() }));
const env = { RATE, WA_TOKEN_GUESTS: 'x', MONDAY_API_TOKEN: 'x' };
const ilDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const audit = [
  { ts: now - 25 * 60e3, at: new Date(now - 25 * 60e3).toISOString(), kind: 'wa_out', ok: false, phone: '972520000002', area: 'שיר', detail: '131047: Re-engagement message · תודה, רשמנו 2 מגיעים 🙂', data: { phone_id: '1409632775565601' } },
  { ts: now - 50 * 60e3, at: new Date(now - 50 * 60e3).toISOString(), kind: 'wa_in', area: 'שיר', phone: '972520000002', detail: 'מגיעים 2' },
];
const d = {
  ilDate: (dt) => ilDay(dt), guestPhoneIds: () => ['1107514695777584', '1409632775565601'], clientPhoneId: () => '1218978741299669', clientWaba: () => '', clientToken: () => '',
  sendingPaused: async () => false, sendWindowState: () => ({ open: true }), kvPrefix: async (e, p) => Object.fromEntries([...m.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v])),
  auditQueryEx: async () => ({ items: audit }), snapshotCached: async () => null, fetchSnapshot: async () => null,
  slackSend: async () => {}, slackPost: async () => {}, auditRecord: async () => {},
  mondayFindLead: async () => ({ found: false }), mondayUpsertLead: async () => ({ ok: true, id: '1800000001', created: true }),
  runEventDayBlasts: async () => ({}), giftBlast: async () => ({ ok: true }), waProbe: async () => ({ ok: true, mode: 'health' }), sendText: async () => ({ ok: true }),
};
const fns = { buildCapacity: async () => capacity, buildBalances: async () => balances };
await runBrain(env, d, { force: true, fns, sleep: async () => {} });
const idx = JSON.parse(m.get(P.runs));
await runLogAppend(env, { run_id: idx[0].run_id, lines: ['(סוכן) קראתי את הממצאים הפתוחים דרך /api/ops/brain', '(סוכן) הפייסר: pacer:last ישן — בודק את ריצות d_pacer בשעה האחרונה'] });
const out = await buildBrain(env);
globalThis.fetch = realFetch;

/* event names from the live capacity → pseudonyms (fixtures are public) */
const names = new Map();
const json = JSON.stringify(out).replace(/"(name|title_he|detail)":"([^"]*)"/g, (all, k, v) => {
  for (const day of capacity.days || []) for (const e of day.by_event || []) if (e.name && v.includes(e.name)) { if (!names.has(e.name)) names.set(e.name, 'אירוע ' + String.fromCharCode(0x5d0 + names.size)); v = v.split(e.name).join(names.get(e.name)); }
  return `"${k}":"${v}"`;
});
writeFileSync(join(ROOT, 'fixtures/ops/brain.json'), JSON.stringify({ fixture: true, fixture_from: 'local runBrain + live capacity/balances (' + BASE + ')', ...JSON.parse(json) }, null, 1) + '\n');
console.log('wrote fixtures/ops/brain.json · findings', out.findings.open.length, '· pending', out.pending.length, '· stream', out.stream.length, '· names', names.size);
