#!/usr/bin/env node
/* ============================================================================
   staging-seed.mjs · the invented demo sheet of the development environment
   (Richard 18/11/2026: "אנחנו צריכים סביבת פיתוח לפעם הבאה לדברים האלה")
   ----------------------------------------------------------------------------
   Staging has no Make scenario and no real sheet behind its client boards.
   This script writes an invented one into the staging KV (stg:snapshot) and
   the token records that go with it, through POST /api/staging-seed, which
   exists only on the staging worker and needs the staging admin key.

     node worker/scripts/staging-seed.mjs            seed
     node worker/scripts/staging-seed.mjs --print    print what would be sent

   Every name and number here is made up. Phones are 050-000-01xx / 055-000-0xxx;
   staging cannot send to any of them (staging-guard.js), and they are not
   anybody's data.

   Event rows follow the "אירועים" tab by column index, guest rows the "אורחים"
   tab — the same shapes the worker's tests use.
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.STAGING_BASE || 'https://go-staging.ishur.io';

const iso = d => d.toISOString().slice(0, 10);
const plus = n => iso(new Date(Date.now() + n * 864e5));

export const EVENTS = [
  { token: 'aaaaaaaa-0000-4000-8000-000000000001', client: 'נועה לוי', phone: '0500000101', venue: 'הגן הקסום', occasion: 'חתונה', date: plus(30), hosts: 'נועה ויונתן', time: '19:30', city: 'רמת גן', address: 'דרך הים 12', plan: 'פרמיום', tier: '100', w1: plus(5), w2: plus(15), guests: 36, seated: true },
  { token: 'bbbbbbbb-0000-4000-8000-000000000002', client: 'דניאל כהן', phone: '0500000102', venue: 'אולמי הדקל', occasion: 'בר מצווה', date: plus(12), hosts: 'איתי', time: '18:00', city: 'חיפה', address: 'שדרות הנשיא 40', plan: 'הכל כלול', tier: '200', w1: plus(-6), w2: plus(2), guests: 60, seated: false, sent: true },
  { token: 'cccccccc-0000-4000-8000-000000000003', client: 'מיכל אברהם', phone: '0500000103', venue: 'בית על הים', occasion: 'ברית', date: plus(-20), hosts: 'נועם', time: '11:00', city: 'אשדוד', address: 'הטיילת 3', plan: 'בסיס', tier: '100', w1: plus(-40), w2: '', guests: 18, seated: false, sent: true },
];
const FIRST = ['דנה', 'יוסי', 'מיכל', 'אבי', 'רותי', 'שגיא', 'ליאת', 'עומר', 'טל', 'הדס', 'איתן', 'שירה', 'גיל', 'מאיה', 'רון', 'נועם', 'יעל', 'אורי', 'תמר', 'עידו'];
const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'דהן', 'אברהם', 'פרידמן', 'אזולאי', 'חדד', 'גבאי', 'שפירא'];

export function build() {
  const events = [], guests = [], kv = {};
  let n = 0;
  for (const e of EVENTS) {
    const r = Array(50).fill('');
    r[1] = e.token; r[2] = e.client; r[3] = e.phone; r[4] = e.venue; r[5] = e.occasion; r[6] = e.date; r[7] = 'כן';
    r[31] = e.plan; r[32] = e.tier; r[34] = e.hosts; r[36] = e.time; r[37] = e.city; r[38] = e.address; r[39] = e.w1; r[40] = e.w2; r[43] = 'כן';
    events.push(r);
    kv['token:' + e.token] = { phone: '972' + e.phone.slice(1), name: e.client, clientId: 'C-' + e.phone.slice(1), ref: 'STAGING' };
    for (let i = 0; i < e.guests; i++) {
      n++;
      const g = Array(31).fill('');
      const mod = i % 6, rsvp = !e.sent ? '' : mod < 3 ? 'מגיע' : mod === 3 ? 'לא מגיע' : mod === 4 ? 'מתלבט' : '';
      g[2] = `G-${e.token.slice(0, 8)}-${i + 1}`; g[3] = `${FIRST[(i * 7 + n) % FIRST.length]} ${LAST[(i * 5 + n) % LAST.length]}`;
      g[4] = '0550000' + String(1000 + n).slice(1); g[5] = String(1 + (i % 4)); g[13] = rsvp === 'מגיע' ? String(1 + (i % 4)) : '';
      g[15] = rsvp; g[25] = rsvp ? new Date(Date.now() - (e.guests - i) * 3600e3).toISOString() : ''; g[28] = e.token; g[30] = e.seated && i % 3 === 0 ? String(1 + (i % 8)) : '';
      guests.push(g);
    }
  }
  const leads = [['', 'נועה לוי', '0500000101', 'noa.demo@example.com'], ['', 'דניאל כהן', '0500000102', '']];
  return { snapshot: { events: { values: events }, guests: { values: guests }, leads: { values: leads } }, kv };
}

function adminKey() {
  if (process.env.STAGING_ADMIN_KEY) return process.env.STAGING_ADMIN_KEY;
  const f = path.join(HERE, '..', '.staging.secrets');
  const line = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').find(l => /^ADMIN_KEY=/.test(l)) : '';
  if (!line) throw new Error('no staging ADMIN_KEY (worker/.staging.secrets or STAGING_ADMIN_KEY)');
  return line.slice('ADMIN_KEY='.length).trim();
}
export async function seed(extraKv = {}) {
  const b = build();
  const r = await fetch(BASE + '/api/staging-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: adminKey(), snapshot: b.snapshot, kv: { ...b.kv, ...extraKv }, del_prefixes: ['rl:acctpin', 'rl:bpin', 'rl:login', 'rl:acctotp', 'acctpinlock:'] }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export async function kv(set = {}, get = []) {
  const r = await fetch(BASE + '/api/staging-seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_key: adminKey(), kv: set, get }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export { adminKey };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print')) { const b = build(); console.log(JSON.stringify({ events: b.snapshot.events.values.length, guests: b.snapshot.guests.values.length, tokens: Object.keys(b.kv) }, null, 2)); }
  else { const r = await seed(); console.log(r.status, JSON.stringify(r.body)); if (r.status !== 200) process.exit(1); }
}
