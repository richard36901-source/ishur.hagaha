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

   Attempt semantics for the automated caller: EVERY completed dial consumes
   one of the 3 attempts — except voicemail, which hangs up silently and is
   deliberately free. This is what stops an undecided guest from being dialed
   every day forever. The human calls page keeps its own softer semantics.

   Pure logic lives in exported functions so node can test it without Retell.
   ========================================================================== */

import { callOutcome } from './dashboard.js';

/* ── the calling window, in Israel time ──
   Sun-Thu 10:00-20:30 · Fri 09:30-13:00 · Sat: nothing. */
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

/* Today's date in Israel, YYYY-MM-DD — day buckets follow the local calendar,
   not UTC, so a late-night run cannot double-dial the same Israeli day. */
export function ilDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}

/* Is this guest worth dialing today? Past events are dead — they would
   otherwise sort FIRST (soonest-date ordering) and eat the daily cap. */
export function shouldDial(guest, todayIso) {
  if (guest.capped) return false;
  if (guest.event_date && guest.event_date < todayIso) return false;
  return true;
}

/* Hebrew spoken date for the prompt: "15 באוקטובר" */
const HE_MONTHS = ['בינואר', 'בפברואר', 'במרץ', 'באפריל', 'במאי', 'ביוני',
  'ביולי', 'באוגוסט', 'בספטמבר', 'באוקטובר', 'בנובמבר', 'בדצמבר'];
export function spokenDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return String(iso || '');
  return `${Number(m[3])} ${HE_MONTHS[Number(m[2]) - 1] || ''}`.trim();
}

/* One queue entry → the create-phone-call payload Retell expects.
   Dynamic variables must all be strings. */
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
      guest_name: String(guest.name || ''),
      host_name: String(guest.client_name || ''),
      occasion: String(guest.occasion || 'אירוע'),
      event_name: String(guest.event_name || ''),
      event_date_spoken: spokenDate(guest.event_date),
      reception_time: String(guest.reception_time || ''),
      venue_name: String(guest.venue_name || ''),
      venue_city: String(guest.venue_city || ''),
      party_size_invited: String(guest.party || ''),
      rsvp_deadline: spokenDate(guest.event_date),
    },
  };
}

/* Retell webhook body → what to write. Returns null for noise.
   Only `call_analyzed` is honored as the end-of-call event — Retell also
   fires call_ended for the same call, and honoring both double-counts. */
export function retellToCallResult(body) {
  /* mid-call custom function: {name, args, call} */
  if (body && body.name === 'record_rsvp_outcome') {
    const meta = (body.call && body.call.metadata) || {};
    const args = body.args || {};
    const base = Number(meta.tries) || 0;
    const result = callOutcome(String(args.outcome || ''), base);
    if (!result || !meta.guest_id) return null;
    /* an automated dial always consumes an attempt (callOutcome only
       increments for לא ענה, which is not a tool outcome) */
    result.tries = base + 1;
    if (result.call_status === 'נדרשת שיחה' && result.tries >= 3) result.call_status = '';
    return {
      kind: 'tool',
      call_id: String((body.call && body.call.call_id) || ''),
      guest_id: String(meta.guest_id),
      result,
      party_size: args.party_size,
      reply: result.rsvp === 'מגיע' ? 'נרשם: מגיעים' : 'נרשם',
    };
  }
  /* end of call — call_analyzed only */
  if (body && body.event === 'call_analyzed' && body.call) {
    const call = body.call;
    const meta = call.metadata || {};
    if (!meta.guest_id) return null;
    const base = Number(meta.tries) || 0;
    const callId = String(call.call_id || '');
    const reason = String(call.disconnection_reason || '');
    if (reason === 'voicemail_reached') {
      /* hung up on voicemail — deliberately NOT counted as a try */
      return { kind: 'skip', call_id: callId, guest_id: String(meta.guest_id), cost_cents: costOf(call) };
    }
    if (reason === 'dial_no_answer' || reason === 'dial_busy' || reason === 'dial_failed') {
      const result = callOutcome('לא ענה', base);
      return { kind: 'end', call_id: callId, guest_id: String(meta.guest_id), result, cost_cents: costOf(call) };
    }
    /* the call was answered. If the tool already recorded an outcome the
       handler will downgrade this to cost-only; otherwise the dial still
       consumed an attempt — write it, or the guest loops forever. */
    const tries = base + 1;
    return {
      kind: 'end-no-outcome', call_id: callId, guest_id: String(meta.guest_id),
      result: {
        rsvp: '', call_status: tries >= 3 ? '' : 'נדרשת שיחה',
        answer: 'שיחה ללא תוצאה ברורה', tries,
      },
      cost_cents: costOf(call),
    };
  }
  return null;
}

function costOf(call) {
  const c = call && call.call_cost;
  const cents = c && typeof c.combined_cost === 'number' ? c.combined_cost : 0;
  /* a single RSVP call is minutes, not hours — clamp garbage */
  return Math.max(0, Math.min(cents, 100000));
}

/* HMAC check for X-Retell-Signature (hex HMAC-SHA256 of the raw body,
   keyed with the API key). Re-verified against a real webhook on demo day. */
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
