/* ============================================================================
   ishur.io · שיר — the calling agent's plumbing
   ----------------------------------------------------------------------------
   Two halves, both dormant until the RETELL_KEY / SHIR_FROM secrets exist:

   dispatch  — reads the same "נדרשת שיחה" queue the calls page uses, keeps
               the legal calling window and the 3-tries-on-separate-days rule,
               and asks Retell to place the calls.
   webhook   — Retell talks back here: the mid-call tool (record_rsvp_outcome)
               and the end-of-call report. Both funnel into the SAME
               call_result contract the calls page already writes through.

   Pure logic lives in exported functions so node can test it without Retell.
   ========================================================================== */

import { callOutcome } from './dashboard.js';

/* ── the calling window, in Israel time ──
   Sun-Thu 10:00-20:30 · Fri 09:30-13:00 · Sat and חג candidates: nothing.
   (Holidays are handled by Richard simply not scheduling sends around them;
   the sender already skips Saturdays the same way.) */
export function callWindowState(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const day = get('weekday');                    // Sun … Sat
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  if (day === 'Sat') return { open: false, why: 'shabbat' };
  if (day === 'Fri') {
    return mins >= 9 * 60 + 30 && mins <= 13 * 60
      ? { open: true } : { open: false, why: 'friday-window' };
  }
  return mins >= 10 * 60 && mins <= 20 * 60 + 30
    ? { open: true } : { open: false, why: 'hours' };
}

/* Hebrew spoken date for the prompt: "15 באוקטובר" */
const HE_MONTHS = ['בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני',
  'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר'];
export function spokenDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return String(iso || '');
  return `${Number(m[3])} ${HE_MONTHS[Number(m[2]) - 1] || ''}`.trim();
}

/* One queue entry → the create-phone-call payload Retell expects */
export function buildCallPayload(guest, fromNumber) {
  return {
    from_number: fromNumber,
    to_number: '+' + guest.phone,
    metadata: {
      guest_id: guest.guest_id,
      token: guest.token,
      tries: String(guest.tries || 0),
    },
    retell_llm_dynamic_variables: {
      guest_name: guest.name || '',
      host_name: guest.client_name || '',
      occasion: guest.occasion || 'אירוע',
      event_name: guest.event_name || '',
      event_date_spoken: spokenDate(guest.event_date),
      reception_time: guest.reception_time || '',
      venue_name: guest.venue_name || '',
      venue_city: guest.venue_city || '',
      party_size_invited: guest.party || '',
      rsvp_deadline: spokenDate(guest.event_date),
    },
  };
}

/* Retell webhook body → the call_result payload for the events scenario.
   Returns null when nothing should be written (voicemail, mid-call noise). */
export function retellToCallResult(body) {
  /* mid-call custom function: {name, args, call} */
  if (body && body.name === 'record_rsvp_outcome') {
    const meta = (body.call && body.call.metadata) || {};
    const args = body.args || {};
    const result = callOutcome(String(args.outcome || ''), meta.tries);
    if (!result || !meta.guest_id) return null;
    return {
      kind: 'tool', guest_id: String(meta.guest_id),
      result, party_size: args.party_size,
      reply: result.rsvp === 'מגיע' ? 'נרשם: מגיעים' : 'נרשם',
    };
  }
  /* end of call: {event: 'call_ended'|'call_analyzed', call:{...}} */
  if (body && (body.event === 'call_ended' || body.event === 'call_analyzed') && body.call) {
    const call = body.call;
    const meta = call.metadata || {};
    if (!meta.guest_id) return null;
    const reason = String(call.disconnection_reason || '');
    if (reason === 'voicemail_reached') {
      /* hung up on voicemail — deliberately NOT counted as a try */
      return { kind: 'skip', guest_id: String(meta.guest_id), cost_cents: costOf(call) };
    }
    if (reason === 'dial_no_answer' || reason === 'dial_busy' || reason === 'dial_failed') {
      const result = callOutcome('לא ענה', meta.tries);
      return { kind: 'end', guest_id: String(meta.guest_id), result, cost_cents: costOf(call) };
    }
    /* answered call: the tool should have recorded the outcome mid-call.
       Nothing extra to write, but the cost is still worth keeping. */
    return { kind: 'cost-only', guest_id: String(meta.guest_id), cost_cents: costOf(call) };
  }
  return null;
}

function costOf(call) {
  const c = call && call.call_cost;
  return c && typeof c.combined_cost === 'number' ? c.combined_cost : 0;
}

/* HMAC check for X-Retell-Signature (hex HMAC-SHA256 of the raw body,
   keyed with the API key). Verified for real on demo day — until then the
   route is gated on the secret existing at all. */
export async function verifyRetellSignature(rawBody, signature, apiKey) {
  if (!signature || !apiKey) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  const given = String(signature).replace(/^v=|^sha256=/, '').toLowerCase();
  if (hex.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
