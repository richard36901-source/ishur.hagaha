import test from 'node:test'; import assert from 'node:assert/strict';
import { inboundExtras } from '../wa-extras.js';
test('inbound extras: id, reply context, reaction, location, contacts, caption, voice; junk in → nothing out', () => {
  assert.deepEqual(inboundExtras({ id: 'wamid.A', type: 'text', text: { body: 'x' } }), { wid: 'wamid.A' });
  assert.deepEqual(inboundExtras({ id: 'wamid.B', type: 'text', context: { id: 'wamid.A' } }), { wid: 'wamid.B', ctx: 'wamid.A' });
  assert.deepEqual(inboundExtras({ id: 'wamid.C', type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.A' } }), { wid: 'wamid.C', react: { emoji: '👍', to: 'wamid.A' } });
  assert.deepEqual(inboundExtras({ id: 'wamid.C2', type: 'reaction', reaction: { message_id: 'wamid.A' } }).react, { emoji: '', to: 'wamid.A' });
  assert.deepEqual(inboundExtras({ id: 'w', type: 'location', location: { latitude: 31.8, longitude: 34.65, name: 'אולם', address: 'רחוב 1' } }).loc, { lat: 31.8, lng: 34.65, name: 'אולם', address: 'רחוב 1' });
  assert.equal(inboundExtras({ id: 'w', type: 'location', location: { latitude: 'x' } }).loc, undefined);
  assert.deepEqual(inboundExtras({ id: 'w', type: 'contacts', contacts: [{ name: { formatted_name: 'דנה' }, phones: [{ phone: '+972 50-000-0001' }] }, {}] }).contacts, [{ name: 'דנה', phone: '+972500000001' }]);
  assert.deepEqual(inboundExtras({ id: 'w', type: 'image', image: { id: 'm1', caption: 'ההזמנה' } }), { wid: 'w', caption: 'ההזמנה' });
  assert.equal(inboundExtras({ id: 'w', type: 'audio', audio: { id: 'm2', voice: true } }).voice, true); assert.equal(inboundExtras({ id: 'w', type: 'audio', audio: { id: 'm2' } }).voice, undefined);
  assert.deepEqual(inboundExtras(null), {}); assert.deepEqual(inboundExtras({ type: 'reaction' }), {});
  assert.ok(inboundExtras({ id: 'x'.repeat(500), type: 'text' }).wid.length <= 120);
});
