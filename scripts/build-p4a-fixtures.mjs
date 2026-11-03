/* Phase 4a fixtures (synthetic, deterministic, fake 97250000xxxx phones): runs the REAL pure builders
   from worker/ops-inbox.js over made-up audit rows / inbox logs, so the fixture shape is the API shape.
   Writes fixtures/ops/{messages,inbox,thread,control}.json. Usage: node scripts/build-p4a-fixtures.mjs */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupMessages, pageMessages, inboxView, threadView, directory, STATUS_HE, TYPE_HE } from '../worker/ops-inbox.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ops');
const AS_OF = Date.parse('2026-11-03T10:00:00Z');
const TOKS = ['a1b2c3d4-0000-0000-0000-000000000000', 'e5f6a7b8-0000-0000-0000-000000000000'];
const ev = (tok, name, client, phone, date) => { const r = Array(50).fill(''); r[1] = tok; r[2] = client; r[3] = phone; r[5] = 'חתונה'; r[6] = date; r[7] = 'כן'; r[34] = name; r[43] = 'כן'; return r; };
const gr = (tok, i) => { const r = Array(31).fill(''); r[28] = tok; r[3] = 'אורח ' + i; r[4] = '9725000001' + String(i).padStart(2, '0'); r[15] = i % 3 ? '' : 'מגיע'; return r; };
const raw = { events: { values: [ev(TOKS[0], 'אירוע א', 'לקוח א', '972500000201', '2026-11-10'), ev(TOKS[1], 'אירוע ב', 'לקוח ב', '972500000202', '2026-11-20')] },
  guests: { values: [...Array.from({ length: 14 }, (_, i) => gr(TOKS[0], i + 1)), ...Array.from({ length: 6 }, (_, i) => gr(TOKS[1], i + 20))] } };
const dir = directory(raw);
const numbers = { A: { label: 'שיר #1', role: 'guests' }, B: { label: 'שיר #2', role: 'guests' }, N: { label: 'נועה', role: 'client' } };
const out = [], st = [], inn = [];
let n = 0;
const T = (min) => AS_OF - min * 60e3;
const send = (min, phone, pid, tmpl, text, { token = '', ok = true, error = '', statuses = ['sent', 'delivered'], fail = '' } = {}) => {
  const ts = T(min), wamid = ok ? 'wamid.FAKE' + (++n) : '';
  out.push({ kind: 'wa_out', ts, at: new Date(ts).toISOString(), id: 'o' + n, ok, phone, token, area: pid === 'N' ? 'נועה' : 'שיר', detail: (ok ? '' : error + ' · ') + text, data: { phone_id: pid, wamid, template: tmpl, error } });
  if (ok) statuses.forEach((s, i) => st.push({ kind: 'wa_status', ts: ts + (i + 1) * 30e3, at: new Date(ts + (i + 1) * 30e3).toISOString(), id: 's' + n + i, ok: s !== 'failed', detail: s === 'failed' ? fail : '', data: { wamid, status: s } }));
};
const reply = (min, phone, pid, text) => { const ts = T(min); inn.push({ kind: 'wa_in', ts, at: new Date(ts).toISOString(), id: 'i' + ts, phone, area: pid === 'N' ? 'נועה' : 'שיר', detail: text }); };
for (let i = 1; i <= 14; i++) send(400 - i * 7, '9725000001' + String(i).padStart(2, '0'), i % 2 ? 'A' : 'B', 'hazmana_ishur', `שלום אורח ${i}, הוזמנת לאירוע א ביום שלישי 10/11 בשעה 19:30. נשמח לדעת אם תגיעו`, { token: TOKS[0], statuses: i % 4 === 0 ? ['sent', 'delivered', 'read'] : i === 5 ? ['sent', 'failed'] : ['sent', 'delivered'], fail: '131026 Message undeliverable' });
send(300, '972500000120', 'B', 'hazmana_ishur', 'שלום אורח 20, הוזמנת לאירוע ב', { token: TOKS[1], ok: false, error: '(#131049) This message was not delivered to maintain healthy ecosystem engagement' });
send(250, '972500000121', 'A', 'ishur_tizkoret', 'תזכורת: מחר האירוע. מגיעים?', { token: TOKS[1], statuses: ['sent', 'delivered', 'read'] });
reply(330, '972500000104', 'B', 'מגיעים 2');
reply(240, '972500000121', 'A', 'כן, נגיע');
send(120, '972500000301', 'N', '', 'היי, תודה שפנית! איזה אירוע מתכננים?', { statuses: ['sent', 'delivered', 'read'] });
reply(110, '972500000301', 'N', 'חתונה בדצמבר, 250 אורחים');
send(60, '972500000201', 'N', 'ishur_doch', 'דוח לאירוע א: 9 אישרו, 3 סירבו, 2 ממתינים', { statuses: ['sent', 'delivered'] });
reply(20, '972500000302', 'N', 'שלום, כמה עולה?');
const g = groupMessages(out, st, inn, { numbers, clientIds: ['N'], dir });
const write = (name, o) => writeFileSync(join(OUT, name + '.json'), JSON.stringify({ ok: true, fixture: true, as_of: new Date(AS_OF).toISOString(), ...o }, null, 1) + '\n');
write('messages', { day: '2026-11-03', tab: 'all', ...pageMessages(g, { limit: 100 }), inbound: g.inbound, statuses: STATUS_HE, types: TYPE_HE, truncated: false });
/* inbox: one conversation per phone that appears above */
const logs = {};
for (const r of out) (logs[r.phone] = logs[r.phone] || []).push({ ts: r.ts, dir: 'out', type: r.data.template ? 'template' : 'text', tmpl: r.data.template, text: r.detail.replace(/^[^·]*· /, r.ok ? '' : ''), id: r.data.wamid, ok: r.ok, status: r.ok ? 'delivered' : 'failed', error: r.data.error, ch: r.data.phone_id === 'N' ? 'client' : 'guests' });
for (const r of inn) (logs[r.phone] = logs[r.phone] || []).push({ ts: r.ts, dir: 'in', type: 'text', text: r.detail, ch: r.area === 'נועה' ? 'client' : 'guests' });
logs['972500000302'].push({ ts: T(19), dir: 'in', type: 'image', text: '', ch: 'client', media: { id: '1234567890', kind: 'image', mime: 'image/jpeg', name: 'הזמנה.jpg' } });
const convs = Object.entries(logs).map(([phone, ms]) => { ms.sort((a, b) => a.ts - b.ts); const last = ms[ms.length - 1]; const lastIn = ms.filter((m) => m.dir === 'in').pop();
  return { phone, msgs: ms.length, last_ts: last.ts, last_dir: last.dir, last_text: last.text || last.type, first_ts: ms[0].ts, last_in_ts: lastIn ? lastIn.ts : 0, ch: [...new Set(ms.map((m) => m.ch))] }; });
const items = inboxView(convs, { leads: new Set(['972500000301', '972500000302']), humans: new Set(['972500000301']), dir, now: AS_OF });
write('inbox', { channel: '', items, total: items.length, counts: { all: items.length, client: items.filter((c) => c.ch.includes('client')).length, guests: items.filter((c) => c.ch.includes('guests')).length, unread: items.filter((c) => c.unread).length } });
const threads = {};
for (const c of items) threads[c.phone] = threadView({ phone: c.phone, messages: logs[c.phone], human: c.phone === '972500000301', ai_off: c.phone === '972500000301', ai_off_perm: false }, { now: AS_OF, dir, lead: c.role === 'lead' });
write('thread', { by_phone: threads });
const events = Object.values(dir.events).map((e, i) => ({ token: e.token, tok8: e.tok8, name: e.name, client: e.client, date: e.date, occasion: e.occasion, hold: i === 1, cancel: false, guests: i ? 6 : 14, pending: i ? 4 : 9 }));
write('control', { at: new Date(AS_OF).toISOString(), today: '2026-11-03', paused: false, brain_active: false, pacer: { last_tick_at: new Date(AS_OF - 4 * 60e3).toISOString() }, events, event_flags: ['extrasend', 'hold', 'cancel', 'postponeok'] });
console.log('messages', g.items.length, 'inbound', g.inbound.length, 'inbox', items.length);
