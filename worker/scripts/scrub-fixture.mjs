// Replaces guest names/phones and client event names in a fixture with stable
// fakes, so a fixture built from live data can sit in this public repo.
// usage: node worker/scripts/scrub-fixture.mjs <in.json> <out.json>
//
// 02/11 (calls-log fixture) — also scrubbed now:
//   · event tokens (36-hex) and every 8-char prefix of them, anywhere: a token
//     is the key to a client's dashboard (/api/status), not just an id
//   · `event` / `client` / `guest_name` string fields → fake labels
//   · `transcript`, `summary`, `detail` → placeholder (they quote people)
//   · `recording_name` (holds the phone) → ''
//   · local-format phones (05XXXXXXXX) inside any string
// Idempotent: running it on an already-scrubbed file changes nothing.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , inp, out] = process.argv;
const ours = new Set(['972559726673', '972553089799', '972559504499', '972555074446', '972555077733']);
const phones = new Map(), names = new Map(), events = new Map(), toks = new Map();
const fakePhone = p => ours.has(p) || /^9725000\d{5}$/.test(p) ? p : (phones.has(p) || phones.set(p, '9725000' + String(phones.size + 1).padStart(5, '0')), phones.get(p));
const fakeLocal = l => { const f = fakePhone('972' + l.slice(1)); return '0' + f.slice(3); };
const fakeName = n => /^(אורח|ליד) \d+$/.test(n) || !n ? n : (names.has(n) || names.set(n, 'אורח ' + (names.size + 1)), names.get(n));
const fakeEvent = e => !e || /^אירוע [0-9a-f]+$|^אירוע \d+$/.test(e) ? e : (events.has(e) || events.set(e, 'אירוע ' + (events.size + 1)), events.get(e));
const FAKE_TOK = /^0000[0-9a-f]{4}-0000-4000-8000-000000000000$/;
const fakeTok = t => FAKE_TOK.test(t) ? t : (toks.has(t) || toks.set(t, '0000' + (toks.size + 1).toString(16).padStart(4, '0') + '-0000-4000-8000-000000000000'), toks.get(t));
const SCRUB_TEXT = new Set(['transcript', 'summary', 'detail']);

const raw = readFileSync(inp, 'utf8');
/* pass 0: every real token in the file, so its 8-char prefix can be replaced wherever it appears */
for (const m of raw.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) fakeTok(m[0]);
const shortMap = new Map([...toks].filter(([r]) => !FAKE_TOK.test(r)).map(([r, f]) => [r.slice(0, 8), f.slice(0, 8)]));
const scrubStr = s => {
  let o = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, m => fakeTok(m));
  for (const [r, f] of shortMap) if (o.includes(r)) o = o.split(r).join(f);
  return o.replace(/9725\d{8}/g, m => fakePhone(m)).replace(/(?<!\d)05\d{8}(?!\d)/g, m => fakeLocal(m));
};
const walk = (v, ev) => {
  if (Array.isArray(v)) return v.map(x => walk(x, ev));
  if (v && typeof v === 'object') {
    const isEvent = typeof v.token === 'string' && /^[0-9a-f-]{36}$/.test(v.token) && 'short' in v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'name' && typeof x === 'string') o[k] = isEvent ? 'אירוע ' + fakeTok(v.token).slice(0, 8) : fakeName(x);
      else if (k === 'phone' && typeof x === 'string') o[k] = x ? fakePhone(x.replace(/\D/g, '')) : x;
      else if ((k === 'guest_name' || k === 'client') && typeof x === 'string') o[k] = fakeName(x);
      else if (k === 'event' && typeof x === 'string') o[k] = fakeEvent(x);
      else if (SCRUB_TEXT.has(k) && typeof x === 'string') o[k] = x && !/^\[הוסר/.test(x) ? '[הוסר מהקובץ הציבורי]' : x;
      else if (k === 'recording_name' && typeof x === 'string') o[k] = '';
      else o[k] = walk(x, ev || isEvent);
    }
    return o;
  }
  if (typeof v === 'string') return scrubStr(v);
  return v;
};
const j = walk(JSON.parse(raw));
writeFileSync(out, JSON.stringify(j));
console.log(`scrubbed: ${phones.size} phones, ${names.size} names, ${events.size} event labels, ${shortMap.size} tokens → ${out}`);
