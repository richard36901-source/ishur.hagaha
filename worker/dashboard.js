/* ============================================================================
   ishur.io · dashboard snapshot builder
   ----------------------------------------------------------------------------
   The Status scenario in Make returns the two sheets raw. This module turns
   them into exactly what dashboard.html renders. Pure function, node-testable.

   Column contract (0-based):
     אירועים · 1 מזהה אירוע · 2 שם לקוח · 4 מיקום · 5 סוג · 6 תאריך ·
               31 חבילה · 32 כמות הזמנות · 34 שם אירוע · 36 שעה · 37 עיר ·
               39-41 שליחה 1-3 · 44 תמונת הזמנה
     אורחים  · 3 שם · 4 טלפון · 5 כמה הוזמנו · 13 כמות מגיעים ·
               15 מגיע? (מגיע/לא מגיע/מתלבט) · 21 סטטוס שיחה · 28 מזהה אירוע
   ========================================================================== */

function guestStatus(rsvp, callFlag) {
  if (rsvp === 'מגיע') return 'confirmed';
  if (rsvp === 'לא מגיע') return 'declined';
  if (callFlag) return 'awaiting_call';
  return 'pending'; // includes מתלבט and everyone not yet answered
}

/* Everyone across all events whose row says a call is needed, joined with the
   event details the caller reads from the script. Column 29 (AD) counts tries. */
export function buildCallQueue(raw, maxTries = 3) {
  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  const events = {};
  for (const r of evRows) {
    const t = String(r[1] || '').trim();
    if (t) events[t] = r;
  }
  const queue = [];
  for (const r of gRows) {
    const g = i => String(r[i] ?? '').trim();
    if (g(21) !== 'נדרשת שיחה') continue;
    if (!g(2) || !g(4)) continue; // a row without a guest id or phone is noise
    const tries = Number(g(29)) || 0;
    const token = g(28);
    const ev = events[token] || [];
    const e = i => String(ev[i] ?? '').trim();
    queue.push({
      guest_id: g(2),
      name: g(3),
      phone: g(4),
      party: g(5),
      rsvp: g(15),
      last_answer: g(22),
      tries,
      capped: tries >= maxTries,
      token,
      client_name: e(2),
      occasion: e(5),
      event_name: e(34) || e(2),
      event_date: e(6),
      reception_time: e(36),
      venue_name: e(4),
      venue_city: e(37),
    });
  }
  /* soonest event first, fewest tries first inside it */
  queue.sort((a, b) => (a.event_date || '9') < (b.event_date || '9') ? -1 :
    (a.event_date || '9') > (b.event_date || '9') ? 1 : a.tries - b.tries);
  return { ok: true, max_tries: maxTries, queue };
}

/* One call outcome → the exact cell values Make writes. The page sends the
   button pressed plus the current try count; the meaning lives here. */
export function callOutcome(outcome, tries, maxTries = 3) {
  const t = Number(tries) || 0;
  switch (outcome) {
    case 'מגיע':     return { rsvp: 'מגיע',     call_status: '',            answer: 'ענה',  tries: t };
    case 'לא מגיע':  return { rsvp: 'לא מגיע',  call_status: '',            answer: 'ענה',  tries: t };
    case 'מתלבט':    return { rsvp: 'מתלבט',    call_status: 'נדרשת שיחה', answer: 'ענה - מתלבט', tries: t };
    case 'לחייג שוב': return { rsvp: '',        call_status: 'נדרשת שיחה', answer: 'לחייג שוב',   tries: t };
    case 'לא להתקשר': return { rsvp: '',        call_status: '',            answer: 'ביקש לא להתקשר יותר', tries: t };
    case 'לא ענה': {
      const n = t + 1;
      return n >= maxTries
        ? { rsvp: '', call_status: '', answer: 'לא ענה - מוצו הנסיונות', tries: n }
        : { rsvp: '', call_status: 'נדרשת שיחה', answer: 'לא ענה', tries: n };
    }
    default: return null;
  }
}

/* The owner's business view: the funnel from leads to money, per-event RSVP
   progress, and totals. Reads the same snapshot plus the לידים sheet.
   לידים columns: 1 שם · 2 טלפון · 4 סוג · 6 שלב נטישה · 7 שולם? · 11 מקור · 14 זמן */
export function buildBizStats(raw) {
  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  const leadRows = (raw.leads && raw.leads.values) || [];

  const t = s => String(s ?? '').trim();
  const leads = leadRows.filter(r => t(r[2]));
  const leadsPaid = leads.filter(r => t(r[7]) === 'כן').length;

  const events = evRows.filter(r => t(r[1]));
  let revenue = 0;
  const perEvent = [];
  const guestsByToken = {};
  for (const r of gRows) {
    const tok = t(r[28]);
    if (!tok) continue;
    (guestsByToken[tok] = guestsByToken[tok] || []).push(r);
  }
  for (const ev of events) {
    const tok = t(ev[1]);
    const paid = t(ev[7]) === 'כן';
    const isCancelled = t(ev[27]) === 'כן';
    const sum = Number(String(ev[8] || '').replace(/[^\d.]/g, '')) || 0;
    /* revenue and paid_events use the SAME definition: paid and not cancelled */
    if (paid && !isCancelled) revenue += sum;
    const gl = guestsByToken[tok] || [];
    let confirmed = 0, declined = 0, seats = 0, needCall = 0;
    for (const g of gl) {
      const rsvp = t(g[15]);
      if (rsvp === 'מגיע') { confirmed++; seats += Number(t(g[13])) || Number(t(g[5])) || 0; }
      else if (rsvp === 'לא מגיע') declined++;
      if (t(g[21]) === 'נדרשת שיחה') needCall++;
    }
    perEvent.push({
      token: tok, client: t(ev[2]), name: t(ev[34]) || t(ev[2]),
      occasion: t(ev[5]), date: t(ev[6]), paid, sum,
      plan: t(ev[31]), tier: t(ev[32]),
      file_uploaded: t(ev[43]) === 'כן',
      guests: gl.length, confirmed, declined,
      pending: Math.max(0, gl.length - confirmed - declined),
      seats, need_call: needCall,
      cancelled: isCancelled,
    });
  }
  perEvent.sort((a, b) => (a.date || '9') < (b.date || '9') ? -1 : 1);

  const paidEvents = perEvent.filter(e => e.paid && !e.cancelled);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    funnel: {
      leads: leads.length,
      leads_paid: leadsPaid,
      events: events.length,
      paid_events: paidEvents.length,
      conversion: leads.length ? Math.round(100 * leadsPaid / leads.length) : 0,
    },
    money: { revenue_ils: revenue },
    guests: {
      total: Object.values(guestsByToken).reduce((n, a) => n + a.length, 0),
      awaiting_call: perEvent.reduce((n, e) => n + e.need_call, 0),
    },
    events: perEvent,
  };
}

export function buildDashboard(token, raw) {
  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  const ev = evRows.find(r => String(r[1] || '').trim() === token);
  if (!ev) return null;
  const c = i => String(ev[i] ?? '').trim();

  const guests = gRows
    .filter(r => String(r[28] || '').trim() === token)
    .map(r => {
      const g = i => String(r[i] ?? '').trim();
      const status = guestStatus(g(15), g(21));
      return {
        name: g(3),
        phone: g(4),
        status,
        seats: Number(g(13)) || Number(g(5)) || 0,
      };
    });

  const totals = { invitations: guests.length, confirmed: 0, confirmed_seats: 0, declined: 0, pending: 0, awaiting_call: 0 };
  for (const g of guests) {
    if (g.status === 'confirmed') { totals.confirmed++; totals.confirmed_seats += g.seats; }
    else totals[g.status]++;
  }

  /* the daily sender is not live yet, so nothing is honestly "sent" — every
     date shows as scheduled until the sender stamps real send history */
  const sends = [];
  if (c(39)) sends.push({ key: 'invite', label: 'ההזמנה ואישור ההגעה', date: c(39), status: 'scheduled' });
  if (c(40)) sends.push({ key: 'reminder', label: 'תזכורת למי שלא ענה', date: c(40), status: 'scheduled', editable: true });
  if (c(41)) sends.push({ key: 'extra', label: 'תזכורת נוספת', date: c(41), status: 'scheduled', editable: true });
  if (c(6)) sends.push({ key: 'event_day', label: 'תזכורת עם הכתובת', date: c(6), status: 'scheduled', auto: true });

  return {
    ok: true,
    event: {
      name1: c(34) || c(2), name2: '',
      occasion: c(5), occasion_label: c(5),
      event_date: c(6), reception_time: c(36),
      venue_name: c(4), venue_city: c(37),
      plan: c(31), guests_tier: c(32),
      image_url: c(44),
    },
    totals,
    sends,
    guests,
  };
}
