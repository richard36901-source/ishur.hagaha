/* 24/11/2026 Shalev: the team can freeze an event's sends or cancel its send dates from the client card. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const at = src.indexOf("if (flag === 'clearsends') {"), block = src.slice(at, at + 2600);

test('cancelling the send dates clears only rounds that have not gone out, and sends nothing', () => {
  assert.ok(at > 0);
  assert.match(src, /const EVENT_FLAGS = \[[^\]]*'clearsends'/);
  assert.ok(block.includes("[[1, 'AN', 39], [2, 'AO', 40], [3, 'AP', 41]]"));
  assert.ok(block.includes('if (await env.RATE.get(`wave:${token}:${n}`)) { kept.push'));
  assert.ok(block.includes("values: [['']]"));
  assert.ok(!/sendText|sendClient|sendTemplate|ishur_bitul|אירועים!AB/.test(block), 'it is not the cancel flag: no message, the event is not marked cancelled');
});

test('the client is not nudged to "finish the settings" after the team removed the dates on purpose', () => {
  assert.ok(block.includes("env.RATE.put('sendsoff:' + token"));
  const s055 = src.indexOf('stage 0.55'), nudge = src.indexOf("'ishur_tzikoret_kovetz'", s055), guard = src.indexOf("env.RATE.get('sendsoff:' + token)", s055);
  assert.ok(guard > s055 && guard < nudge);
});

test('both client screens offer freeze and cancel-dates; freeze does not mark the client inactive', () => {
  for (const f of ['../../clients.html', '../../next/clients.html']) {
    const h = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(h.includes('data-act="freeze"') && h.includes('data-act="clear-sends"'), f);
    const a = h.indexOf("act === 'freeze'"), e = h.indexOf("act === 'clear-sends'");
    assert.ok(a > 0 && e > a);
    assert.ok(!h.slice(a, e).includes('client-active'), f);
    assert.ok(h.slice(e, e + 1200).includes("flag: 'clearsends', on: true"), f);
  }
});

test('24/11 the board offers the extra send only to guests who have not answered, priced by their number', () => {
  const h = fs.readFileSync(new URL('../../dashboard.html', import.meta.url), 'utf8');
  const a = h.indexOf('function askScope()'), body = h.slice(a, a + 2600);
  assert.ok(a > 0);
  assert.ok(!body.includes('data-scope="all"'), 'no "to everybody" choice');
  assert.ok(body.includes('data-scope="unanswered"') && body.includes("un.n + ' מוזמנים · ₪' + un.price"));
  assert.ok(body.includes('if (!un || !un.n)'));
  assert.ok(h.includes("priceOf(k, (k === 'extra_send' || k === 'extrasend') ? 'unanswered' : 'all')"));
});
