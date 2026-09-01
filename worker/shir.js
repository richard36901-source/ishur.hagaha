/* ============================================================================
   ishur.io · שיר — the calling agent's plumbing
   ----------------------------------------------------------------------------
   Three halves, all dormant until the RETELL_KEY / SHIR_FROM secrets exist:

   dispatch  — reads the same "נדרשת שיחה" queue the calls page uses, keeps
               the legal calling window and the 3-tries-on-separate-days rule,
               and asks Retell to place the calls.
   inbound   — somebody rings the number back. Retell asks us who they are
               BEFORE the agent speaks (inboundLookup / inboundVariables), so
               the opening sentence arrives already knowing their name.
   webhook   — Retell talks back here: the mid-call tool (record_rsvp_outcome)
               and the end-of-call report. Both funnel into the SAME
               call_result contract the calls page already writes through.

   Direction changes one rule and only one: an outbound dial spends one of the
   guest's three attempts, an inbound call does not. They rang us.

   Attempt semantics for the automated caller: EVERY completed dial consumes
   one of the 3 attempts — except voicemail, which hangs up silently and is
   deliberately free. This is what stops an undecided guest from being dialed
   every day forever. The human calls page keeps its own softer semantics.

   Pure logic lives in exported functions so node can test it without Retell.
   ========================================================================== */

import { callOutcome, planKeyOf, planMaxCallTries } from './dashboard.js';
import { findGuestByPhone } from './whatsapp.js';

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

/* How long until the calling window opens, in ms. 0 when it is already open,
   -1 when the wait is longer than an hour (not worth holding a cron for).
   The daily engine fires at 09:35 Israel time and the window opens at 10:00,
   so without this the dialler asked "is it open?", heard no, and gave up
   twenty five minutes early, every day. */
/* When it is acceptable to contact a person at all — messages included, not
   just calls. Sending starts an hour before the phones do, because a message
   waits politely and a phone call does not.
   Sun-Thu 09:00-20:30 · Fri 09:00-13:00 · Sat: nothing. */
export function sendWindowState(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const day = get('weekday');
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  if (day === 'Sat') return { open: false, why: 'shabbat' };
  if (day === 'Fri') {
    return mins >= 9 * 60 && mins <= 13 * 60
      ? { open: true } : { open: false, why: 'friday-window' };
  }
  return mins >= 9 * 60 && mins <= 20 * 60 + 30
    ? { open: true } : { open: false, why: 'hours' };
}

/* Jewish holidays and their eves, when nobody wants a call about an RSVP.
   Hard-coded rather than computed: a wrong Hebrew-calendar conversion that
   nobody notices is worse than a list somebody has to extend once a year.
   Eve of a holiday counts from the afternoon, which is why the eves are here
   as full days — losing half a day of dialling is cheaper than calling a
   family mid-kiddush. Extend before Rosh Hashana 5788. */
const NO_CONTACT_DAYS = new Set([
  /* 5787 · autumn 2026 */
  '2026-09-11', '2026-09-12', '2026-09-13',   // ערב ראש השנה + יומיים
  '2026-09-20', '2026-09-21',                 // ערב יום כיפור + יום כיפור
  '2026-09-25', '2026-09-26',                 // ערב סוכות + סוכות א
  '2026-10-02', '2026-10-03',                 // הושענא רבה + שמחת תורה
  /* 5787 · spring 2027 */
  '2027-04-21', '2027-04-22',                 // ערב פסח + פסח א
  '2027-04-27', '2027-04-28',                 // שביעי של פסח
  '2027-05-11', '2027-05-12',                 // ערב יום הזיכרון + יום הזיכרון
  '2027-06-10', '2027-06-11',                 // ערב שבועות + שבועות
]);

export function isNoContactDay(iso) {
  return NO_CONTACT_DAYS.has(String(iso || '').slice(0, 10));
}

export function msUntilCallWindow(now = new Date()) {
  if (callWindowState(now).open) return 0;
  for (let m = 1; m <= 60; m++) {
    if (callWindowState(new Date(now.getTime() + m * 60000)).open) return m * 60000;
  }
  return -1;
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

/* Israeli phone in the one shape the sheets, the KV keys and Retell metadata
   all agree on: digits only, 972-prefixed. index.js and whatsapp.js each keep
   a private copy of this; the third lives here so the pure inbound functions
   below can be exercised by node with no siblings loaded. */
export function normIl(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) return d;
  if (d.startsWith('0')) return '972' + d.slice(1);
  return d;
}

/* One אירועים row → the facts a script is allowed to say out loud.
   Column contract lives in dashboard.js; this is the only place that decodes
   it for the caller, so a column that moves breaks in one spot. */
export function eventFacts(ev) {
  const e = i => String((ev && ev[i]) || '').trim();
  return {
    token: e(1),
    client_name: e(2),
    client_phone: e(3),
    venue_name: e(4),
    occasion: e(5) || 'אירוע',
    event_date: e(6),
    paid: e(7) === 'כן',
    cancelled: e(27) === 'כן',
    event_name: e(34) || e(2),
    reception_time: e(36),
    venue_city: e(37),
    extra_phone: e(46),
    plan: planKeyOf(ev),
  };
}

/* Who is on the other end of an inbound call? Three sheets, in the order that
   matters: a guest first (that is what the number is FOR), then the client
   who is paying us, then somebody who once asked about the service.
   Pure — index.js hands it a snapshot, node hands it a fixture. */
export function inboundLookup(raw, phone, todayIso) {
  const p = normIl(phone);
  const miss = { caller_kind: 'unknown', phone: p, name: '', event: null };
  if (!raw || !p) return miss;

  const facts = [];
  for (const ev of (raw.events && raw.events.values) || []) {
    const f = eventFacts(ev);
    if (f.token) facts.push(f);
  }
  const byToken = {};
  for (const f of facts) if (!byToken[f.token]) byToken[f.token] = f;

  /* 1 · a guest. findGuestByPhone already prefers the nearest upcoming event,
     which is the same rule the WhatsApp replies use — one definition of
     "which of this person's events did they mean", not two. */
  const g = findGuestByPhone(raw, p, todayIso);
  if (g && g.guest_id) {
    const f = byToken[g.token];
    if (f && !f.cancelled) {
      return {
        caller_kind: 'guest', phone: p, name: g.name || '',
        guest_id: g.guest_id, token: g.token,
        tries: Number(g.tries) || 0,
        /* the plan caps calls for this event exactly as it does outbound;
           בסיס buys no calls at all, so an answered inbound still may not
           spawn a callback */
        max_tries: planMaxCallTries(f.plan),
        rsvp: g.rsvp || '', party: Number(g.party) || 0,
        event: f,
      };
    }
  }

  /* 2 · the host. Column AU (46) is the second allowed phone per event, the
     "two people, one dashboard" case — a groom ringing from his own number
     must not be a stranger. */
  let host = null;
  for (const f of facts) {
    if (f.cancelled) continue;
    if (normIl(f.client_phone) !== p && normIl(f.extra_phone) !== p) continue;
    if (!host) { host = f; continue; }
    const a = f.event_date >= todayIso, b = host.event_date >= todayIso;
    if (a && !b) host = f;
    else if (a === b && (a ? f.event_date < host.event_date : f.event_date > host.event_date)) host = f;
  }
  if (host) {
    return {
      caller_kind: 'client', phone: p, name: host.client_name,
      token: host.token, event: host,
    };
  }

  /* 3 · a lead who never paid. לידים: 1 שם · 2 טלפון */
  for (const r of (raw.leads && raw.leads.values) || []) {
    if (normIl(r && r[2]) !== p) continue;
    return { caller_kind: 'lead', phone: p, name: String((r && r[1]) || '').trim(), event: null };
  }
  return miss;
}

/* The first sentence, composed here rather than by the model.
   Retell speaks begin_message verbatim, so an opening built from data cannot
   hallucinate, cannot stall, and cannot arrive with a hole in it where a
   dynamic variable used to be — which is exactly what the outbound script did
   on an inbound call, since none of its variables were ever populated. */
export function openingLine(hit, opts = {}) {
  const h = hit || {};
  const ev = h.event || {};
  const first = String(h.name || '').trim().split(/\s+/)[0] || '';
  const hello = first ? `היי ${first}` : 'שלום';
  const who = 'מדברת שיר מאישורי הגעה';

  /* a call WE placed back to somebody who rang us and did not get through */
  if (opts.callback) {
    return `${hello}, ${who}. ראיתי שהתקשרתם אלינו ולא הספקנו לדבר, אז חזרתי אליכם. איך אפשר לעזור?`;
  }
  if (h.caller_kind === 'guest') {
    const at = ev.occasion ? `ל${ev.occasion}${ev.client_name ? ' של ' + ev.client_name : ''}` : '';
    if (h.rsvp === 'מגיע') {
      return `${hello}, ${who}. רשומים אצלי כמגיעים ${at}. איך אפשר לעזור?`;
    }
    if (h.rsvp === 'לא מגיע') {
      return `${hello}, ${who}. רשום אצלי שלא מגיעים ${at}. איך אפשר לעזור?`;
    }
    return `${hello}, ${who}. ההזמנה שלכם ${at} עוד מחכה לתשובה — אתם מגיעים?`;
  }
  if (h.caller_kind === 'client') {
    return `${hello}, ${who}. איך אפשר לעזור?`;
  }
  return 'שלום, הגעתם לאישורי הגעה, מדברת שיר. איך אפשר לעזור?';
}

/* Everything the inbound script may say, as strings. Every key is always
   present: a variable Retell cannot resolve is spoken as literal braces. */
export function inboundVariables(hit, opts = {}) {
  const h = hit || {};
  const ev = h.event || {};
  return {
    opening_line: openingLine(h, opts),
    caller_kind: String(h.caller_kind || 'unknown'),
    caller_name: String(h.name || ''),
    known: h.caller_kind && h.caller_kind !== 'unknown' ? 'כן' : 'לא',
    is_callback: opts.callback ? 'כן' : 'לא',
    guest_name: h.caller_kind === 'guest' ? String(h.name || '') : '',
    current_rsvp: String(h.rsvp || ''),
    party_size_invited: String(h.party || ''),
    host_name: String(ev.client_name || ''),
    occasion: String(ev.occasion || 'אירוע'),
    event_name: String(ev.event_name || ''),
    event_date_spoken: spokenDate(ev.event_date || ''),
    reception_time: String(ev.reception_time || ''),
    venue_name: String(ev.venue_name || ''),
    venue_city: String(ev.venue_city || ''),
  };
}

/* What rides on the call so the end-of-call webhook can write the sheet.
   A guest we placed gets the same guest_id/tries contract an outbound dial
   carries, which is the whole reason an inbound call can update the sheet. */
export function inboundMetadata(hit, opts = {}) {
  const h = hit || {};
  const m = {
    kind: opts.callback ? 'callback' : 'inbound',
    caller_kind: String(h.caller_kind || 'unknown'),
    from: String(h.phone || ''),
  };
  if (h.caller_kind === 'guest' && h.guest_id) {
    m.guest_id = String(h.guest_id);
    m.token = String(h.token || '');
    m.tries = String(h.tries || 0);
    m.max_tries = String(h.max_tries || 3);
  }
  return m;
}

/* One queue entry → the create-phone-call payload Retell expects.
   Dynamic variables must all be strings.

   Three shapes ride through here, chosen by `kind`:
     guest     — the RSVP chase. Unchanged; this is the only shape in use.
     callback  — we are ringing back somebody who rang us. Speaks the inbound
                 script, so it carries the inbound variables and needs
                 opts.override_agent_id to point at the inbound agent.
     lead      — the sales call. Wired, deliberately never dialled: see
                 runShirLeadDial in index.js for what is still missing. */
export function buildCallPayload(guest, fromNumber, opts = {}) {
  const kind = String(guest.kind || 'guest');
  const payload = {
    from_number: fromNumber,
    to_number: '+' + guest.phone,
    metadata: {
      guest_id: guest.guest_id,
      token: guest.token,
      tries: String(guest.tries || 0),
      max_tries: String(guest.max_tries || 3),
      /* One number can be a guest at somebody's wedding AND a lead of ours, so
         what a call WAS belongs to the call, not to the number. Every call
         carries it: 'guest' (RSVP), 'lead' (sales), 'inbound' (they rang us),
         'callback' (we rang them back after a missed inbound). */
      kind,
    },
    retell_llm_dynamic_variables:
      kind === 'lead' ? leadVariables(guest)
        : kind === 'callback' ? inboundVariables(guest.hit || guest, { callback: true })
          : {
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
  /* one number, several scripts: the agent is chosen per call, not per number */
  if (opts.override_agent_id) payload.override_agent_id = String(opts.override_agent_id);
  return payload;
}

/* The sales script's variables — a lead has no event, no host and no seat
   count, so feeding it the guest set would hand the model empty braces to
   read out loud. Nothing calls this yet on a live number; see requirement 5.
   לידים columns: 1 שם · 2 טלפון · 4 סוג · 6 שלב נטישה · 7 שולם? · 11 מקור */
/* The first sentence of the sales call, composed from data exactly like the
   inbound opener — Retell speaks it verbatim, so it can neither stall nor
   read out an empty variable. Noa, never Shir: this call crosses the
   guest/client line and the persona must cross with it. */
export function leadOpeningLine(lead) {
  const l = lead || {};
  const first = String(l.name || '').trim().split(/\s+/)[0] || '';
  const hello = first ? `היי ${first}` : 'שלום';
  const occ = l.occasion && l.occasion !== 'אירוע' ? `ל${l.occasion}` : 'לאירוע שלכם';
  return `${hello}, מדברת נועה מאישורי הגעה. ראיתם אותנו באתר והתחלתם הזמנה ${occ}, ונעצרתם רגע לפני הסוף. רציתי לשאול אם משהו לא היה ברור, ואם אפשר לעזור.`;
}

export function leadVariables(lead) {
  const l = lead || {};
  return {
    opening_line: leadOpeningLine(l),
    lead_name: String(l.name || ''),
    lead_first_name: String(l.name || '').trim().split(/\s+/)[0] || '',
    occasion: String(l.occasion || 'אירוע'),
    event_date_spoken: spokenDate(l.event_date || ''),
    /* how far they got before they stopped — the only real hook a sales call
       has: "ראיתי שהתחלתם והפסקתם לפני התשלום" */
    abandoned_stage: String(l.stage || ''),
    guest_count: String(l.guest_count || ''),
    source: String(l.source || ''),
  };
}

/* ── נועה · the inbound side of HER number ──────────────────────────────────
   Same lookup as Shir's line, different persona and different priorities:
   clients get service, leads get honest sales help, and a guest who somehow
   rang the sales line is gently pointed back to WhatsApp — Noa never does
   guest-speak. That is the separation rule, spoken. */
export function noaOpeningLine(hit) {
  const h = hit || {};
  const first = String(h.name || '').trim().split(/\s+/)[0] || '';
  const hello = first ? `היי ${first}` : 'שלום';
  if (h.caller_kind === 'client') {
    return `${hello}, מדברת נועה מאישורי הגעה. איך אפשר לעזור?`;
  }
  if (h.caller_kind === 'lead') {
    return `${hello}, הגעתם לאישורי הגעה, מדברת נועה. איך אפשר לעזור?`;
  }
  return 'שלום, הגעתם לאישורי הגעה, מדברת נועה. איך אפשר לעזור?';
}

export function noaInboundVariables(hit) {
  const h = hit || {};
  const ev = h.event || {};
  return {
    opening_line: noaOpeningLine(h),
    caller_kind: String(h.caller_kind || 'unknown'),
    caller_name: String(h.name || ''),
    known: h.caller_kind && h.caller_kind !== 'unknown' ? 'כן' : 'לא',
    occasion: String(ev.occasion || 'אירוע'),
    event_name: String(ev.event_name || ''),
    event_date_spoken: spokenDate(ev.event_date || ''),
  };
}

/* One lead row → the shape buildCallPayload wants. Pure, so the sales pipe
   can be proven end to end without a sales agent existing. */
export function leadFromRow(row) {
  const r = i => String((row && row[i]) || '').trim();
  return {
    kind: 'lead',
    phone: normIl(r(2)),
    name: r(1),
    occasion: r(4) || 'אירוע',
    stage: r(6),
    paid: r(7) === 'כן',
    source: r(11),
    guest_id: '', token: '', tries: 0, max_tries: 1,
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
    /* the plan decides how many rounds this guest is entitled to; the cap
       rides in the call metadata so the webhook honours it too */
    const cap = Number(meta.max_tries) || 3;
    const result = callOutcome(String(args.outcome || ''), base, cap);
    if (!result) return null;
    /* An inbound call from a number we could not place has no sheet row to
       write. Answer the tool anyway: returning null left Shir listening to
       silence mid-sentence, which is how a real caller decides we hung up. */
    if (!meta.guest_id) {
      return {
        kind: 'tool-noop',
        call_id: String((body.call && body.call.call_id) || ''),
        call_kind: String(meta.kind || ''),
        reply: 'נרשם',
      };
    }
    /* An automated dial consumes an attempt (callOutcome only increments for
       לא ענה, which is not a tool outcome). A call THEY placed does not — we
       did not spend one of their three tries by picking up the phone. */
    result.tries = isInbound(meta) ? base : base + 1;
    if (result.call_status === 'נדרשת שיחה' && result.tries >= cap) result.call_status = '';
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
    /* No guest_id means no row to write — an inbound call from a stranger, or
       a call placed before the metadata contract existed. It is still a real
       call that cost real money and may owe somebody a ring back, so it is
       reported rather than dropped. Returning null here is what kept every
       inbound call out of the ledger entirely. */
    if (!meta.guest_id) {
      return {
        kind: 'end-untracked',
        call_id: String(call.call_id || ''),
        call_kind: String(meta.kind || (isInboundCall(call) ? 'inbound' : 'guest')),
        from_number: String(call.from_number || ''),
        reason: String(call.disconnection_reason || ''),
        cost_cents: costOf(call),
      };
    }
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
       consumed an attempt — write it, or the guest loops forever. An inbound
       call is exempt for the same reason as above: they rang us. */
    const tries = isInbound(meta) ? base : base + 1;
    return {
      kind: 'end-no-outcome', call_id: callId, guest_id: String(meta.guest_id),
      result: {
        rsvp: '', call_status: tries >= (Number(meta.max_tries) || 3) ? '' : 'נדרשת שיחה',
        answer: 'שיחה ללא תוצאה ברורה', tries,
      },
      cost_cents: costOf(call),
    };
  }
  return null;
}

/* 'inbound' (they rang us) and 'callback' (we rang back a missed inbound)
   both mean the guest reached out; neither may burn one of their three tries. */
function isInbound(meta) {
  const k = String((meta && meta.kind) || '');
  return k === 'inbound' || k === 'callback';
}

function isInboundCall(call) {
  return String((call && (call.direction || call.call_type)) || '').includes('inbound');
}

/* Did an inbound call get properly answered, or does this number deserve a
   ring back? Pure, so the rule is readable and testable in one place.

   Two ways to miss a caller: Retell never got them to an agent at all
   (concurrency, an error, a failed dial), or they hung up during the ring —
   which shows up as a very short call with no recorded outcome. A call that
   reached the tool recorded an answer, so by definition it was not missed. */
export const INBOUND_MISS_MS = 12000;

export function inboundCallVerdict(body, opts = {}) {
  if (!body || body.event !== 'call_analyzed' || !body.call) return null;
  const call = body.call;
  const meta = call.metadata || {};
  const kind = String(meta.kind || '');
  const inbound = kind === 'inbound' || kind === 'callback' || (!kind && isInboundCall(call));
  if (!inbound) return null;

  /* Whose number belongs in the callback queue: the OTHER party's.
     On a call they placed that is from_number; on a ring-back WE placed it is
     to_number, and reading from_number there would queue our own line and set
     Shir dialling herself in a loop. */
  const weDialled = kind === 'callback' || kind === 'lead';
  const phone = normIl(meta.from || (weDialled ? call.to_number : call.from_number) || '');
  if (!phone) return null;
  const reason = String(call.disconnection_reason || '');
  const ms = call.start_timestamp && call.end_timestamp
    ? Math.max(0, call.end_timestamp - call.start_timestamp) : 0;

  let missed = false, why = '';
  if (/^error|concurrency|dial_failed|dial_busy|dial_no_answer/.test(reason)) {
    missed = true; why = reason;
  } else if (!opts.outcomeRecorded && ms < INBOUND_MISS_MS) {
    missed = true; why = 'short-' + Math.round(ms / 1000) + 's';
  }
  return {
    phone, kind: kind || 'inbound', missed, why, reason, duration_ms: ms,
    caller_kind: String(meta.caller_kind || ''),
    guest_id: String(meta.guest_id || ''),
    token: String(meta.token || ''),
  };
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
