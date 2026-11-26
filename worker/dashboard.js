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

/* The purchased plan decides what the machine may do for an event:
   בסיס — messages only, no calls · פרמיום — one call attempt per guest ·
   הכל כלול — three attempts on separate days. Column 31 holds the Hebrew
   plan name; an unknown/empty value falls back to פרמיום (the site default). */
import { rowStateHe } from './send-plan.js';   /* 25/11 track-board */

export function planKeyOf(ev) {
  const s = String((ev && ev[31]) || '').trim().toLowerCase();
  if (/הכל|premium|all/.test(s)) return 'premium';
  if (/בסיס|basic|base/.test(s)) return 'basic';
  return 'pro';
}

export function planMaxCallTries(planKey) {
  return planKey === 'premium' ? 3 : planKey === 'pro' ? 1 : 0;
}

function guestStatus(rsvp, callFlag) {
  if (rsvp === 'מגיע') return 'confirmed';
  if (rsvp === 'לא מגיע') return 'declined';
  if (rsvp === 'מתלבט') return 'undecided';   // Richard 27/09: "those who are not sure, mark not sure"
  if (callFlag) return 'awaiting_call';
  return 'pending';
}

/* Everyone across all events whose row says a call is needed, joined with the
   event details the caller reads from the script. Column 29 (AD) counts tries. */
function queued2(guests) { return guests.filter(g => g.status === 'awaiting_call').length; }
/* 04/11: a paid calls add-on (callsaddon:<token>) buys one round on any plan,
   בסיס included. `addons` is the Set of event tokens that hold one. */
export function buildCallQueue(raw, maxTries = 3, addons = null) {
  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  const events = {};
  for (const r of evRows) {
    const t = String(r[1] || '').trim();
    if (t) events[t] = r;
  }
  const queue = [];
  for (let ri = 0; ri < gRows.length; ri++) {
    const r = gRows[ri];
    const g = i => String(r[i] ?? '').trim();
    if (g(21) !== 'נדרשת שיחה') continue;
    if (!g(2) || !g(4)) continue; // a row without a guest id or phone is noise
    if (!/^9725\d{8}$/.test(g(4).replace(/\D/g, ''))) continue; // abroad: never dialed (Richard 21/10)
    const tries = Number(g(29)) || 0;
    const token = g(28);
    /* no event row means no plan and no date: never dial into the unknown */
    const ev = events[token];
    if (!ev) continue;
    const e = i => String(ev[i] ?? '').trim();
    if (e(27) === 'כן') continue;            // cancelled event — never call
    const plan = planKeyOf(ev);
    /* 12/11 Richard: the add-on is ONE MORE round on top of the plan's own (בסיס 0+1, פרמיום 1+1, הכל כלול 3+1) */
    const hasAddon = !!(addons && addons.has(token));
    const planCap = planMaxCallTries(plan) + (hasAddon ? 1 : 0);   /* Richard 12/11: הכל כלול gets a 4th round only when the add-on was bought */
    const cap = Math.min(maxTries + (hasAddon ? 1 : 0), planCap);
    if (!planCap) continue;                  // בסיס without a calls add-on — calls are not included
    queue.push({
      row: ri + 2,   /* 24→25/11: the sheet row, so a stale call flag can be cleared */
      guest_id: g(2),
      name: g(3),
      phone: g(4),
      party: g(5),
      rsvp: g(15),
      last_answer: g(22),
      tries,
      max_tries: cap,
      capped: tries >= cap,
      plan,
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
    /* Richard 21/10: a silent call must not erase an earlier "מתלבט" */
    case 'לחייג שוב': return { rsvp: '__keep__', call_status: 'נדרשת שיחה', answer: 'לחייג שוב',   tries: t };
    case 'לא להתקשר': return { rsvp: '__keep__', call_status: '',            answer: 'ביקש לא להתקשר יותר', tries: t };
    case 'לא ענה': {
      const n = t + 1;
      return n >= maxTries
        ? { rsvp: '__keep__', call_status: '', answer: 'לא ענה - מוצו הנסיונות', tries: n }
        : { rsvp: '__keep__', call_status: 'נדרשת שיחה', answer: 'לא ענה', tries: n };
    }
    default: return null;
  }
}

/* Test/demo events never count toward business numbers: name/notes say
   "בדיקה", the token starts with TEST-, or the client phone is one of ours. */
const TEST_EVENT_PHONES = ['0500005201', '0500000000', '0578888888'];
export function isTestEventRow(r) {
  const t = s => String(s ?? '').trim();
  if (/בדיקה/.test(t(r[2])) || /בדיקה/.test(t(r[34]))) return true;
  if (/^TEST-/i.test(t(r[1]))) return true;
  let ph = t(r[3]).replace(/\D/g, '');
  if (ph.startsWith('972')) ph = '0' + ph.slice(3);
  return TEST_EVENT_PHONES.includes(ph);
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

  const events = evRows.filter(r => t(r[1]) && !isTestEventRow(r));
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
    let confirmed = 0, declined = 0, undecided = 0, seats = 0, needCall = 0;
    for (const g of gl) {
      const rsvp = t(g[15]);
      if (rsvp === 'מגיע') { confirmed++; seats += Number(t(g[13])) || Number(t(g[5])) || 0; }
      else if (rsvp === 'לא מגיע') declined++;
      else if (rsvp === 'מתלבט') undecided++;
      if (t(g[21]) === 'נדרשת שיחה') needCall++;
    }
    perEvent.push({
      token: tok, client: t(ev[2]), name: t(ev[34]) || t(ev[2]),
      occasion: t(ev[5]), date: t(ev[6]), paid, sum,
      paid_at: (t(ev[25]).match(/\d{4}-\d{2}-\d{2}/) || [''])[0],
      /* 18/11 Richard: the clients screen lists by the moment the deal closed, so two sales on one day keep their order */
      paid_ts: (t(ev[25]).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/) || [''])[0],
      phone: t(ev[3]),
      plan: t(ev[31]), tier: t(ev[32]),
      invoice: t(ev[9]),
      file_uploaded: t(ev[43]) === 'כן',
      guests: gl.length, confirmed, declined, undecided,
      pending: Math.max(0, gl.length - confirmed - declined - undecided),
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
      conversion: (leads.length + paidEvents.length) ? Math.round(100 * paidEvents.length / (leads.length + paidEvents.length)) : 0,
    },
    money: { revenue_ils: revenue },
    guests: {
      total: Object.values(guestsByToken).reduce((n, a) => n + a.length, 0),
      awaiting_call: perEvent.reduce((n, e) => n + e.need_call, 0),
    },
    events: perEvent,
  };
}

/* `sent` marks which waves already went out (from KV wave:<token>:<n>) so the
   client sees "יצא" instead of a date they could pointlessly try to change. */
export function buildDashboard(token, raw, refCount = 0, sent = {}) {
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
        id: g(2),
        name: g(3),
        phone: g(4),
        status,
        seats: Number(g(13)) || Number(g(5)) || 0,
        table: g(30),
        /* came in through the public RSVP link (Richard 17/09): counted and
           seatable, but no messages or calls until the client unlocks them */
        self: /נרשם מהקישור/.test(g(24)),
        /* the phone round, for the send board's results line */
        tries: Number(g(29)) || 0,
        call_ans: g(22),
        at: g(25).slice(0, 10),
        at_ts: g(25).slice(0, 19),   /* 18/11: full time of the last change, so the newest confirmations sort to the top of the board */
      };
    });

  const totals = { invitations: guests.length, confirmed: 0, confirmed_seats: 0, declined: 0, undecided: 0, pending: 0, awaiting_call: 0 };
  for (const g of guests) {
    if (g.status === 'confirmed') { totals.confirmed++; totals.confirmed_seats += g.seats; }
    else totals[g.status]++;
  }

  /* the daily sender is not live yet, so nothing is honestly "sent" — every
     date shows as scheduled until the sender stamps real send history */
  /* loyalty tier: how many paid events this client has run with us */
  const myPhone = c(3);
  let paidEvents = 0;
  for (const r of evRows) {
    const t = i => String(r[i] ?? '').trim();
    if (t(3) === myPhone && t(7) === 'כן' && t(27) !== 'כן') paidEvents++;
  }
  /* the tier climbs with paid events AND verified referrals (a friend who
     actually purchased through this client's link) */
  const refs = Number(refCount) || 0;
  const score = paidEvents + refs;
  const tier =
    score >= 5 ? { key: 'vip', name: 'VIP' } :
    score >= 3 ? { key: 'gold', name: 'זהב' } :
    score >= 2 ? { key: 'silver', name: 'כסף' } :
    { key: 'bronze', name: 'ארד' };

  const sends = [];
  /* a send is editable while it has not gone out and its date is still ahead */
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  /* 12/11: a wave is "sent" when it went out to (nearly) everybody it was for — the KV flag alone is not
     enough, the engine clears it to retry a single undelivered guest. count = wsent: keys per wave. */
  const cnt = n => Number((sent.count || {})[n]) || 0;
  const eligible = n => Math.max(1, guests.filter(g => !g.self && (n === 1 ? true : g.status !== 'declined')).length);
  const state = (n, date) => {
    const d = date ? date.slice(0, 10) : '';
    if (sent[n]) return 'sent';
    /* 26/11 Richard (שוהם, Sunday's extra send read "בתהליך"): a round whose day has not come is scheduled, whatever marks exist
       (guests kept out of it in advance carry a send mark) — "בתהליך" only on its day, "בוצע" when done */
    if (d && d > todayIso) return 'scheduled';
    if (cnt(n) > 0) return (cnt(n) >= 0.9 * eligible(n) || (n > 1 && d && d < todayIso)) ? 'sent' : 'running';
    return d && d < todayIso ? 'passed' : 'scheduled';
  };
  if (c(39)) sends.push({ key: 'invite', label: 'ההזמנה ואישור ההגעה', date: c(39), status: state(1, c(39)), editable: state(1, c(39)) === 'scheduled', sent_n: cnt(1) });
  if (c(40)) sends.push({ key: 'reminder', label: 'תזכורת למי שלא ענה', date: c(40), status: state(2, c(40)), editable: state(2, c(40)) === 'scheduled', sent_n: cnt(2) });
  /* 04/11: a granted/paid extra send shows even before a date was picked */
  if (c(41) && (sent.extraPaid || sent[3])) sends.push({ key: 'extra', label: 'תזכורת נוספת', date: c(41), status: state(3, c(41)), editable: state(3, c(41)) === 'scheduled', sent_n: cnt(3) });
  else if (sent.extraPaid || sent[3]) sends.push({ key: 'extra', label: 'תזכורת נוספת', date: '', status: sent[3] ? 'sent' : 'scheduled', editable: !sent[3] });
  /* Shir's phone round (Richard 12/10: "they should know when there is also
     a call"). It starts the morning after the last planned send, for whoever
     still has not answered; בסיס has no calls. */
  /* 04/11: a paid calls add-on on בסיס shows the round too */
  /* 24/11: an extra call round (callround:<token>) puts its guests back in the queue with tries = 0. Without this the
     plan's own rounds lost those guests the morning the extra round opened (שילת: rounds 2 and 3 fell from 178 / 129
     dialled to 95 / 46 and went back to "בתהליך"). A guest of an opened extra round keeps, for the plan's rounds, the
     tries they had before it (job.prev), or all of the plan's tries when that was not recorded; what happens to them
     now belongs to the extra round's own row. */
  const xr = sent.callRound && sent.callRound.done ? sent.callRound : null;
  const xrIds = new Set((xr && xr.ids) || []);
  const planCap = planMaxCallTries(planKeyOf(ev)) || 0;
  const planTries = g => !xrIds.has(g.id) ? g.tries : (xr.prev && xr.prev[g.id] != null ? Number(xr.prev[g.id]) || 0 : planCap);
  /* 24/11 (שוהם: ten guests "not dialled" in round 1 were ten who pressed "טעות"): a wrong number is never called, so it
     does not wait for any round */
  const wrongSet = sent.wrong instanceof Set ? sent.wrong : new Set();
  const isWrong = g => wrongSet.size > 0 && wrongSet.has(String(g.phone || '').replace(/\D/g, '').replace(/^0/, '972'));
  const planWaits = g => g.status === 'awaiting_call' && !xrIds.has(g.id) && !isWrong(g);
  if (!sent.noCalls && (planMaxCallTries(planKeyOf(ev)) > 0 || sent.callsAddon)) {
    const last = [c(39), c(40), sent.extraPaid || sent[3] ? c(41) : '']
      .map(d => d.slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
    if (last) {
      const d = new Date(last + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      /* 18/11 Richard: a round that falls on Friday (the send was on Thursday) starts on Sunday; never on Shabbat */
      if (d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 2); else if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
      let start = (sent.callDate && /^\d{4}-\d{2}-\d{2}$/.test(sent.callDate)) ? sent.callDate : d.toISOString().slice(0, 10);   /* 12/11: admin-set day wins */
      /* 23/11: the rounds really opened on esc:<token>. A day set by hand AFTER that (שילת: opened 19/11, the day moved to
         23/11 for a later round) must not push the first round's date forward. */
      const escDay = String(sent.escDate || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(escDay) && escDay < start) start = escDay;
      /* 25/11 track-board: on a plan without calls the add-on round IS this row — a day the team / client set wins */
      if (!planCap && /^\d{4}-\d{2}-\d{2}$/.test(String(sent.callsAddonStart || ''))) start = sent.callsAddonStart;
      /* 04/11: a guest who used up every try is not waiting any more - the
         round is over even though the sheet still flags them */
      const cap = planMaxCallTries(planKeyOf(ev)) || (sent.callsAddon ? 1 : 0);
      const queued = guests.filter(g => planWaits(g) && g.tries < cap).length;
      /* a phone round happened only if somebody was dialed or answered BY PHONE
         ('ענה' / 'ענה - מתלבט' / 'לא ענה'); 'ענה בוואטסאפ' is a message answer */
      const byPhone = g => /^ענה($| - )/.test(g.call_ans) || g.call_ans === 'לא ענה' || /מוצו/.test(g.call_ans);
      const called = guests.filter(g => planTries(g) > 0 || byPhone(g) || (sent.dialed && sent.dialed.has(g.id))).length;
      /* once the event day has passed the round is over whatever is still flagged */
      const over = /^\d{4}-\d{2}-\d{2}$/.test(c(6)) && c(6).slice(0, 10) < todayIso;
      const status = start > todayIso ? 'scheduled' : over ? (called ? 'sent' : 'passed') : queued ? 'running' : called ? 'sent' : 'scheduled';
      /* 23/11 Shalev: a plan with several call rounds (הכל כלול: three) shows a row per round, not one row.
         Round 2 is the calling day after round 1, round 3 the one after (never Friday or Shabbat). A guest is
         dialled once a day, so the number of tries a guest has IS the round that reached them:
         done = nobody still waits for this round · running = some were dialled or it is its day · else scheduled. */
      const ownRounds = planMaxCallTries(planKeyOf(ev)) || 0;
      /* 24/11 Richard (שוהם: round 1 of yesterday still read "בתהליך · עוד לא חויגו 10" while round 2 was running):
         on a plan with several rounds, round 1 waits only for guests who were never dialled, and a round whose day
         has passed and that did dial is done - whoever it did not reach belongs to the next round. */
      const queued1 = ownRounds > 1 ? guests.filter(g => planWaits(g) && g.tries < 1).length : queued;
      const status1 = (ownRounds > 1 && !over && start <= todayIso) ? ((start < todayIso && called) ? 'sent' : queued1 ? 'running' : called ? 'sent' : 'scheduled')
        : (!over && start < todayIso && called && status === 'running') ? 'sent' : status;   /* 25/11: a single-round plan follows the same rule */
      sends.push({ key: 'calls', label: 'שיחה טלפונית למי שלא ענה' + (ownRounds > 1 ? ' · סבב 1' : ''), date: start, status: status1, auto: true, queued: queued1 });
      let prev = start;
      for (let k = 2; k <= ownRounds; k++) {
        const nd = new Date(prev + 'T12:00:00Z'); nd.setUTCDate(nd.getUTCDate() + 1);
        if (nd.getUTCDay() === 5) nd.setUTCDate(nd.getUTCDate() + 2); else if (nd.getUTCDay() === 6) nd.setUTCDate(nd.getUTCDate() + 1);
        const dk = nd.toISOString().slice(0, 10); prev = dk;
        const reached = guests.filter(g => planTries(g) >= k).length;
        const waitingK = guests.filter(g => planWaits(g) && g.tries < k).length;
        let stK = dk > todayIso && !reached ? 'scheduled' : over ? (reached ? 'sent' : 'passed') : waitingK ? (reached || dk <= todayIso ? 'running' : 'scheduled') : (reached || status === 'sent') ? 'sent' : 'scheduled';
        if (!over && dk < todayIso && reached) stK = 'sent';   /* 24/11: yesterday's round is done. 25/11 Richard ("שלושה ימים של תהליך?"): the last round too - a round is its day, whoever is still owed a call is simply called */
        /* a round that already dialled cannot carry a day that has not come yet (the first round's day was moved by hand
           after it started: שילת 23/11, rounds 2 and 3 were shown as done on 24/11 and 25/11) */
        const shownDay = reached && dk > todayIso ? todayIso : dk;
        sends.push({ key: 'calls_r' + k, label: 'שיחה טלפונית למי שלא ענה · סבב ' + k, date: shownDay, status: stK, auto: true, queued: waitingK, round: k, dialed_n: reached });
      }
    }
  }
  /* 25/11 Richard (אלעד: a calls round added from the client card ran, and the board showed nothing): on a plan that
     has call rounds of its own, the add-on is one more round and gets a row. Its guests are the ones the plan's rounds
     did not close: tries above the plan's limit = this round already rang them. */
  if (!sent.noCalls && sent.callsAddon && (sent.callsAddonAt || sent.callsAddonPick) && planCap > 0 && !sent.callRound) {
    const at = String(sent.callsAddonAt || '').slice(0, 10);
    const waitA = guests.filter(g => planWaits(g) && g.tries <= planCap).length;
    const rang = guests.filter(g => g.tries > planCap);
    const ans = rang.filter(g => /^ענה($| - )/.test(g.call_ans) && (g.status === 'confirmed' || g.status === 'declined' || g.status === 'undecided'));
    const stA = at > todayIso ? 'scheduled' : (waitA && at === todayIso) ? 'running' : (rang.length || at < todayIso) ? 'sent' : 'running';
    sends.push({ key: 'calls2', label: 'סבב שיחות נוסף (למי שלא ענה ולמתלבטים)', date: at, status: at ? stA : 'scheduled', auto: true, queued: stA === 'sent' ? 0 : waitA, addon: true, ...(at ? {} : { pick: true }),
      stats: { dialed: rang.length, answered: ans.length, confirmed: ans.filter(g => g.status === 'confirmed').length, declined: ans.filter(g => g.status === 'declined').length,
        undecided: ans.filter(g => g.status === 'undecided').length, no_answer: rang.length - ans.length, waiting: stA === 'sent' ? 0 : waitA, later: 0, later_confirmed: 0, later_declined: 0, later_undecided: 0 } });
  }
  /* Richard 21/10: an extra round booked by hand shows as its own row.
     04/11: on ANY plan - whatever we add, paid or free, the client sees it */
  /* 04/11: a round armed by hand on the same day as the regular round IS
     that round - one row, never two */
  const sameDay = sent.callRound && sends.some(r => r.key === 'calls' && r.date === String(sent.callRound.at).slice(0, 10));
  if (sent.callRound && sent.callRound.at && !sameDay) {
    const cr = sent.callRound;
    const st = cr.done ? ((queued2(guests) && !(String(cr.at).slice(0, 10) < todayIso)) ? 'running' : 'sent') : (cr.at <= todayIso ? 'running' : 'scheduled');   /* 25/11: an extra round of a past day is done */
    sends.push({ key: 'calls2', label: 'סבב שיחות נוסף (למי שלא ענה ולמתלבטים)', date: cr.at, status: st, auto: true, queued: cr.n });
  }
  /* the event-day message: 'sent' once the engine stamped it (s5t markers),
     'passed' when the day is behind us without one, otherwise scheduled */
  if (c(6)) sends.push({ key: 'event_day', label: 'תזכורת עם הכתובת', date: c(6), status: sent.eventDay ? 'sent' : (c(6).slice(0, 10) < todayIso ? 'passed' : 'scheduled'), auto: true });
  /* the day after: a thank-you to everyone who came (פרמיום and up, Richard 21/10) */
  if (/^\d{4}-\d{2}-\d{2}$/.test(c(6).slice(0, 10)) && planKeyOf(ev) !== 'basic') {
    const d = new Date(c(6).slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    const dayAfter = (sent.todaDate && /^\d{4}-\d{2}-\d{2}$/.test(sent.todaDate)) ? sent.todaDate : d.toISOString().slice(0, 10);   /* 12/11: admin-set day wins */
    sends.push({ key: 'day_after', label: 'הודעת תודה לאורחים', date: dayAfter, status: sent.dayAfter ? 'sent' : (dayAfter < todayIso ? 'passed' : 'scheduled'), auto: true });
  }

  /* Each round owns only the answers it brought in (Richard 12/10): a call
     answer belongs to the calls, a WhatsApp answer to the last message round
     that went out on or before the day it came in. "Waiting for a call" is only
     whoever Shir has not dialed yet; dialed and silent is "did not answer". */
  const dialed = sent.dialed || new Set();
  const viaCall = g => /^ענה($| - )/.test(g.call_ans) || g.call_ans === 'לא ענה' || /מוצו/.test(g.call_ans);
  const answered = g => g.status === 'confirmed' || g.status === 'declined' || g.status === 'undecided';
  const waveDates = sends.filter(x => x.key !== 'calls' && !/^calls_r\d$/.test(x.key) && x.key !== 'event_day' && x.key !== 'day_after').map(x => ({ key: x.key, d: String(x.date).slice(0, 10) }))
    .sort((x, y) => x.d < y.d ? -1 : 1);
  const tally = () => ({ answered: 0, confirmed: 0, declined: 0, undecided: 0 });
  const per = {};
  for (const x of sends) per[x.key] = tally();
  per.calls = Object.assign(tally(), { dialed: 0, no_answer: 0, waiting: 0, later: 0, later_confirmed: 0, later_declined: 0, later_undecided: 0 });
  /* 23/11 Richard: on a plan with several call rounds every round shows its own result, like the message rounds.
     Shir adds one try per call she places, so a guest's tries = the round of their last call: they were dialled in
     rounds 1..tries, did not answer in the earlier ones, and whatever happened last belongs to round `tries`. */
  const ROUNDS = sends.some(x => x.key === 'calls_r2') ? (planMaxCallTries(planKeyOf(ev)) || 0) : 0;
  const perR = {};
  const perX = Object.assign(tally(), { dialed: 0, no_answer: 0, waiting: 0, later: 0, later_confirmed: 0, later_declined: 0, later_undecided: 0 });
  for (let k = 1; k <= ROUNDS; k++) perR[k] = Object.assign(tally(), { dialed: 0, no_answer: 0, waiting: 0, later: 0, later_confirmed: 0, later_declined: 0, later_undecided: 0 });
  for (const g of guests) {
    if (g.self) continue;
    const isCall = viaCall(g) || dialed.has(g.id) || g.tries > 0;
    if (xrIds.has(g.id)) {
      /* the extra round's own row */
      const t2 = perX;
      const phoneNow = viaCall(g) && /^ענה/.test(g.call_ans) && answered(g);
      if (phoneNow) { t2.dialed++; t2.answered++; t2[g.status]++; }
      else if (g.tries > 0) { t2.dialed++; if (answered(g)) { t2.later++; t2['later_' + g.status]++; } else t2.no_answer++; }
      else if (!answered(g)) t2.waiting++;
      /* in the plan's rounds they were dialled and did not answer: that is why they are in the extra round */
      if (ROUNDS) for (let k = 1; k <= Math.min(ROUNDS, planTries(g)); k++) { perR[k].dialed++; perR[k].no_answer++; }
    } else if (ROUNDS) {
      const last = isCall ? Math.min(ROUNDS, Math.max(1, g.tries || 0)) : 0;
      const byPhoneNow = viaCall(g) && /^ענה/.test(g.call_ans) && answered(g);
      for (let k = 1; k <= ROUNDS; k++) {
        const t = perR[k];
        if (k <= last) {
          t.dialed++;
          if (k < last) t.no_answer++;
          else if (byPhoneNow) { t.answered++; t[g.status]++; }
          else if (answered(g)) { t.later++; t['later_' + g.status]++; }
          else t.no_answer++;
        } else if (!answered(g) && g.status === 'awaiting_call' && !isWrong(g)) t.waiting++;
      }
    }
    if (per.calls && isCall) per.calls.dialed++;
    if (!answered(g)) {
      /* Richard 21/10: dialed and still silent is "לא ענו" whatever the
         status column says (after 3 tries the sheet flips it back to pending) */
      if (isCall) per.calls.no_answer++;
      else if (g.status === 'awaiting_call' && !isWrong(g)) per.calls.waiting++;
      continue;
    }
    /* 08/11 (Richard): dialed, then answered some other way (WhatsApp / undecided) — shown on the calls row
       too, so dialed = answered by phone + answered later + no answer. The answer itself still
       belongs to the round that brought it in (below). */
    if (per.calls && isCall && !(viaCall(g) && /^ענה/.test(g.call_ans))) { per.calls.later++; per.calls['later_' + g.status]++; }
    let key;
    if (viaCall(g) && /^ענה/.test(g.call_ans)) key = 'calls';
    else {
      key = waveDates.length ? waveDates[0].key : null;
      for (const w of waveDates) if (g.at && w.d <= g.at) key = w.key;
    }
    const t = key && per[key];
    if (!t) continue;
    t.answered++; t[g.status]++;
  }
  for (const x of sends) { if (per[x.key] && x.key !== 'event_day' && x.key !== 'day_after' && !/^calls_r\d$/.test(x.key)) if (!x.addon) x.stats = per[x.key]; }
  if (xr) for (const x of sends) if (x.key === 'calls2') x.stats = perX;
  if (ROUNDS) for (const x of sends) { const k = x.key === 'calls' ? 1 : (/^calls_r(\d)$/.exec(x.key) || [])[1]; if (k && perR[k]) { if (x.key === 'calls') x.stats_all = x.stats; x.stats = perR[k]; } }
  /* 24/11: a finished round does not say "עוד לא חויגו": whoever it did not dial moved on to the next round, and the
     row says so (moved) */
  for (const x of sends) if ((x.key === 'calls' || /^calls_r\d$/.test(x.key)) && x.status === 'sent' && x.stats) { x.stats = { ...x.stats, moved: x.stats.waiting || 0, waiting: 0 }; x.queued = 0; }

  /* 25/11 track-board: every row says exactly where it stands; a round the client has to date carries pick */
  if (sent.extraPick) for (const x of sends) if (x.key === 'extra' && !x.date && x.status !== 'sent') x.pick = true;
  if (sent.callsAddonPick && !planCap) for (const x of sends) if (x.key === 'calls' && x.status !== 'sent') { x.pick = true; x.date = ''; x.status = 'scheduled'; }
  const waveN = { invite: 1, reminder: 2, extra: 3 };
  for (const x of sends) {
    const n = waveN[x.key];
    if (n && sent.sentAt && sent.sentAt[n]) x.sent_at = sent.sentAt[n];
    if (n && sent.delivered && sent.delivered[n] != null) x.delivered_n = sent.delivered[n];
    x.state_he = rowStateHe(x, { today: todayIso, stopped: !!sent.clientStop });
  }
  return {
    ok: true,
    stop: sent.clientStop || null,
    pick_date: sends.filter(x => x.pick).map(x => x.key),
    event: {
      name1: c(34) || c(2), name2: '',
      occasion: c(5), occasion_label: c(5),
      event_date: c(6), reception_time: c(36),
      venue_name: c(4), venue_city: c(37),
      plan: c(31), guests_tier: c(32),
      cancelled: c(27) === 'כן',
      image_url: c(44),
      paid_sum: Number(String(c(8)).replace(/[^\d.]/g, '')) || 0,
    },
    totals,
    sends,
    guests,
    tier: { ...tier, events: paidEvents, referrals: refs },
    referral_code: token.slice(0, 8),
  };
}
