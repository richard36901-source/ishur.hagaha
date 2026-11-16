/* ============================================================================
   What else an inbound WhatsApp message carries, kept for the inbox so a
   conversation there looks like it does on the phone (16/11/2026, Richard:
   "שכפול של ווצאפ"). Pure: Meta's message object in, a few plain fields out,
   spread into the stored log record. Nothing here decides anything.
     wid      the message's own id (a reaction or a reply points at it)
     react    {emoji, to}   — a reaction to message `to` ('' emoji = removed)
     ctx      the id of the message this one replies to
     loc      {lat, lng, name, address}
     contacts [{name, phone}]
     caption  the text under a photo / video / file
     voice    true for a voice note (as opposed to an audio file)
   ============================================================================ */
const s = (v, n) => String(v == null ? '' : v).slice(0, n);
export function inboundExtras(msg) {
  const out = {};
  if (!msg || typeof msg !== 'object') return out;
  if (msg.id) out.wid = s(msg.id, 120);
  if (msg.context && msg.context.id) out.ctx = s(msg.context.id, 120);
  if (msg.type === 'reaction' && msg.reaction && msg.reaction.message_id) out.react = { emoji: s(msg.reaction.emoji, 16), to: s(msg.reaction.message_id, 120) };
  if (msg.type === 'location' && msg.location && Number.isFinite(Number(msg.location.latitude)) && Number.isFinite(Number(msg.location.longitude))) {
    out.loc = { lat: Number(msg.location.latitude), lng: Number(msg.location.longitude), name: s(msg.location.name, 80), address: s(msg.location.address, 160) };
  }
  if (msg.type === 'contacts' && Array.isArray(msg.contacts)) {
    out.contacts = msg.contacts.slice(0, 5).map(c => ({ name: s(c && c.name && (c.name.formatted_name || c.name.first_name), 60), phone: s(c && c.phones && c.phones[0] && (c.phones[0].wa_id || c.phones[0].phone), 24).replace(/[^\d+]/g, '') })).filter(c => c.name || c.phone);
    if (!out.contacts.length) delete out.contacts;
  }
  const m = msg[msg.type];
  if (m && typeof m === 'object' && m.caption) out.caption = s(m.caption, 600);
  if (msg.type === 'audio' && m && m.voice === true) out.voice = true;
  return out;
}
