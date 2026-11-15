// node --test worker/test/guestlist-manual.test.mjs — 15/11: the list a client types into the upload page
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../../assets/guestlist.js', import.meta.url)), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const G = mod.exports;

test('typed list: what is ready, what needs a look, what repeats', () => {
  const c = G.manualCheck([
    { name: 'משפחת כהן', phone: '050-123 4567', count: 4 },
    { name: 'דנה לוי', phone: '+972 52 7654321', count: '2' },
    { name: '', phone: '0541112222', count: 1 },          // no name
    { name: 'יוסי', phone: '03-5551234', count: 1 },       // landline
    { name: 'כפול', phone: '0501234567', count: 3 },       // same number as row 1
    { name: 'סבתא', phone: '+43 660 1234567', count: 1 },  // abroad
    { name: '', phone: '', count: 1 },                     // blank row is ignored
  ]);
  assert.deepEqual(c.good, [
    { name: 'משפחת כהן', phone: '0501234567', count: 4 },
    { name: 'דנה לוי', phone: '0527654321', count: 2 },
    { name: 'סבתא', phone: '+436601234567', count: 1 },
  ]);
  assert.deepEqual(c.bad, [2, 3]);
  assert.deepEqual(c.dup, [4]);
  assert.equal(c.guests, 7);
});

test('typed list: an empty list and odd counts', () => {
  assert.deepEqual(G.manualCheck([]), { good: [], bad: [], dup: [], guests: 0 });
  const c = G.manualCheck([{ name: 'א', phone: '0501234567', count: 0 }, { name: 'ב', phone: '0501234568', count: 'abc' }, { name: 'ג', phone: '0501234569', count: 250 }]);
  assert.deepEqual(c.good.map(r => r.count), [1, 1, 1]);
});

test('paste: rows copied from a sheet (tabs), with a header line', () => {
  const rows = G.parsePaste('שם\tטלפון\tכמות\nמשפחת כהן\t050-1234567\t4\r\nדנה לוי\t0527654321\t2\n\n');
  assert.deepEqual(rows, [{ name: 'משפחת כהן', phone: '050-1234567', count: 4 }, { name: 'דנה לוי', phone: '0527654321', count: 2 }]);
});

test('paste: free lines from Notes or WhatsApp', () => {
  const rows = G.parsePaste('דנה לוי 052-7654321 2\n0541112222 - יוסי\nרק שם\nמשפחת לוי, 0503334444, 5');
  assert.deepEqual(rows, [
    { name: 'דנה לוי', phone: '052-7654321', count: 2 },
    { name: 'יוסי', phone: '0541112222', count: 1 },
    { name: 'רק שם', phone: '', count: 1 },
    { name: 'משפחת לוי', phone: '0503334444', count: 5 },
  ]);
  assert.equal(G.manualCheck(rows).bad.length, 1);
});

test('draft: survives a round trip, drops blank rows, rejects junk', () => {
  const raw = G.draftPack([{ name: 'א', phone: '050', count: 2 }, { name: '', phone: '', count: 1 }, { name: 'ב', phone: '', count: 1 }], 1700000000000);
  const d = G.draftUnpack(raw);
  assert.equal(d.at, 1700000000000);
  assert.deepEqual(d.rows, [{ name: 'א', phone: '050', count: 2 }, { name: 'ב', phone: '', count: 1 }]);
  assert.equal(G.draftUnpack('{bad'), null);
  assert.equal(G.draftUnpack('{"v":2,"rows":[]}'), null);
  assert.equal(G.draftUnpack(null), null);
});

test('typed list goes out on the same column contract as a file', () => {
  const c = G.manualCheck([{ name: 'כהן, משפחה', phone: '0501234567', count: 4 }]);
  const csv = G.toCsv(c.good);
  assert.ok(csv.includes('שם,טלפון,כמות מוזמנים'));
  assert.ok(csv.includes('"כהן, משפחה",0501234567,4'));
});
