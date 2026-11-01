// Replaces guest names/phones and client event names in a fixture with stable
// fakes, so a fixture built from live data can sit in this public repo.
// usage: node worker/scripts/scrub-fixture.mjs <in.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
const [, , inp, out] = process.argv;
const ours = new Set(['972559726673', '972553089799', '972559504499']);
const phones = new Map(), names = new Map();
const fakePhone = p => ours.has(p) ? p : (phones.has(p) || phones.set(p, '9725000' + String(phones.size + 1).padStart(5, '0')), phones.get(p));
const fakeName = n => (names.has(n) || names.set(n, 'אורח ' + (names.size + 1)), names.get(n));
const walk = (v, ev) => {
  if (Array.isArray(v)) return v.map(x => walk(x, ev));
  if (v && typeof v === 'object') {
    const isEvent = typeof v.token === 'string' && /^[0-9a-f-]{36}$/.test(v.token) && 'short' in v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'name' && typeof x === 'string') o[k] = isEvent ? 'אירוע ' + v.short : fakeName(x);
      else if (k === 'phone' && typeof x === 'string') o[k] = fakePhone(x.replace(/\D/g, ''));
      else o[k] = walk(x, ev || isEvent);
    }
    return o;
  }
  if (typeof v === 'string') return v.replace(/9725\d{8}/g, m => fakePhone(m));
  return v;
};
const j = walk(JSON.parse(readFileSync(inp, 'utf8')));
writeFileSync(out, JSON.stringify(j));
console.log(`scrubbed: ${phones.size} phones, ${names.size} names → ${out}`);
