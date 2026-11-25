/* ============================================================================
   ishur.io · future-log.js · "מה עומד לקרות" + live calls (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   POST /api/future-log   (admin)
     {days?=14, token?}          → { ok, at, today, sends:[SEND…], calls:[CALLEV…], notes }
       SEND   = { day, token, tok8, event, type, type_he, count, exact, held, dropped, template }
       CALLEV = { token, tok8, event, date, plan, queued, capped, next_at, next_he, blocked_he, round_day, round_n }
     {action:'live'}             → { ok, at, in_progress:[LIVE…], recent:[CALL…50] }
       LIVE   = { call_id, status, started_at, seconds, phone, guest_id, token, tok8, event, guest }
       CALL   = calls-log.js rowFromAudit (outcome, duration_s, transcript, recording_name, has_recording, call_id …)

   Where the numbers come from (no new rules — the engine's own mirrors):
     sends  · ops.js projectionInputs + projectItems: the capacity planner's projection of every wave /
              day-before / table / event-day / thanks from the same KV flags the engine reads (wave:, hold:,
              holdtill:, seat:, toda:, daybefore:, edblast:). Across events the counts are an UPPER BOUND
              (the projection does not read per-guest marks); with `token` each guest's marks are read
              (wsent/s5d/s5t/s3t/ed:, optout/block, wrong:) and the count is exact (`exact: true`).
            · the template: the wave template the sender would pick now (custom approved wording → style →
              hazmana_ishur), the event-day families from eventday.js familyCandidates.
     calls  · dashboard.js buildCallQueue (Shir's queue) + the dispatcher's own stops (hold:, callstop:,
              nocalls:) and shir.js callWindowState for the next moment the dialer can ring.
            · planned round: the morning after the last wave for an event with calls in its plan (board-event rule).
     live   · Retell list-calls (status ongoing/registered) + the audit log (kind 'call', last 3 days, 50 newest).
   The dry engine (runDailyEngine dry) is NOT called: its dry paths write KV and it covers one day.
   Read-only: KV get/list only.
   ========================================================================== */
import { projectionInputs, projectItems } from './ops.js';
import { TYPE_HE } from './ops-plan.js';
import { familyCandidates } from './eventday.js';
import { rowFromAudit } from './calls-log.js';

const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const ilDayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const ilHm = ms => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
export const norm = p => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '972' + d.slice(1); return d; };

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */

/* the per-guest marker the sender of each type checks (index.js /api/skip, eventday.js edMarkKey) */
export function markKeys(type, token, phone) {
  const p = norm(phone);
  switch (type) {
    case 'w1': case 'w2': case 'w3': return [`wsent:${token}:${type.slice(1)}:${p}`, `wdead:${token}:${type.slice(1)}:${p}`];
    case 'daybefore': return [`s5d:${token}:${p}`];
    case 'table': return [`s5t:${token}:${p}`, `ed:${token}:${p}`];
    case 'eventday': return [`s5e:${token}:${p}`, `ed:${token}:${p}`];
    case 'thanks': return [`s3t:${token}:${p}`];
    default: return [];
  }
}
/* the key "cancel the next send" writes (value 'skip', as /api/skip does) */
export function skipKey(type, token, phone) {
  const p = norm(phone);
  if (/^w[123]$/.test(type)) return `wsent:${token}:${type.slice(1)}:${p}`;
  return { daybefore: `s5d:${token}:${p}`, table: `ed:${token}:${p}`, eventday: `ed:${token}:${p}`, thanks: `s3t:${token}:${p}` }[type] || '';
}
/* which template the type goes out with; `invite` = the wave template the sender would use now */
export function templateOf(type, { invite = 'hazmana_ishur', table = false, gift = false, nav = true } = {}) {
  if (/^w[123]$/.test(type)) return invite;
  if (type === 'daybefore') return familyCandidates({ day: 'd1', nav, hasTable: table, giftOn: gift })[0];
  if (type === 'table') return familyCandidates({ day: 'day', nav, hasTable: true, giftOn: gift })[0] + ' / ishur_shulchan';
  if (type === 'eventday') return familyCandidates({ day: 'day', nav, hasTable: false, giftOn: gift })[0];
  if (type === 'thanks') return 'ishur_toda_orach';
  return '';
}
/* the next moment the dialer may ring: the first open call-window minute (10-minute ticks) that is not a
   no-contact day, and not today when the guest was already tried today (shirtry:<id>:<day>) */
export function nextCallAt({ now = Date.now(), triedToday = false, callWindowState, isNoContactDay = () => false, horizonDays = 9 } = {}) {
  const today = ilDayOf(now);
  for (let t = Math.ceil(now / 600e3) * 600e3, end = now + horizonDays * 864e5; t < end; t += 600e3) {
    const d = ilDayOf(t);
    if (triedToday && d === today) continue;
    if (isNoContactDay(d)) continue;
    if (callWindowState(new Date(t)).open) return t;
  }
  return null;
}
export function whenHe(ms, now = Date.now()) {
  if (ms == null) return '';
  const d = ilDayOf(ms), t = ilDayOf(now);
  const day = d === t ? 'היום' : d === addDays(t, 1) ? 'מחר' : d.slice(8, 10) + '/' + d.slice(5, 7);
  return `${day} ${ilHm(ms)}`;
}
/* the call round the board shows: the morning after the last planned wave, for a plan with calls */
export function callRoundDay(waves) {
  const last = [waves[1], waves[2], waves[3]].filter(x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || ''))).sort().pop();
  if (!last) return '';
  let d = addDays(last, 1);
  while ([5, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, 1);
  return d;
}

/* ══ §2 gather ═════════════════════════════════════════════════════════════ */
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
/* every key name under a prefix (a failed page throws: a partial set would make "exact" lie) */
async function listNames(env, prefix, cap = 50000) {
  const out = []; if (!env.RATE) return out; let cursor;
  do { const pg = await env.RATE.list({ prefix, cursor, limit: 1000 }); for (const k of pg.keys || []) out.push(k.name); cursor = pg.list_complete ? null : pg.cursor; } while (cursor && out.length < cap);
  return out;
}

/* one guest's planned sends: projectItems over that guest alone, minus the types the guest's marks already close */
export async function guestPlannedSends(env, d, inp, token, guest, today, days = 30) {
  const ev = (inp.events || []).find(e => e.token === token);
  if (!ev) return [];
  const items = projectItems({ events: [ev], guests: { [token]: [guest] }, flags: inp.flags, today, days, isNoContactDay: d.isNoContactDay });
  const out = [];
  const invite = d.inviteTemplateFor ? await d.inviteTemplateFor(env, token).catch(() => 'hazmana_ishur') : 'hazmana_ishur';
  for (const it of items) {
    const marks = await Promise.all(markKeys(it.type, token, guest.phone).map(k => kget(env, k)));
    if (marks.some(Boolean)) continue;
    out.push({ day: it.day, type: it.type, type_he: TYPE_HE[it.type] || it.type, held: !!it.held, dropped: !!it.dropped, template: templateOf(it.type, { invite, table: !!guest.table }), skip_key: skipKey(it.type, token, guest.phone) });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export async function guestStops(env, token, phone, guestId) {
  const p = norm(phone);
  const [optout, block, nocall, wrong] = await Promise.all(['optout:' + p, 'block:' + p, 'nocall:' + p, `wrong:${token}:${p}`].map(k => kget(env, k)));
  return { optout: !!optout, block: !!block, nocall: !!nocall, wrong: !!wrong, guest_id: guestId || '' };
}

/* the guest's place in Shir's queue and the next ring */
export async function guestCall(env, d, raw, token, guestId, now = Date.now()) {
  const addons = d.callsAddonTokens ? await d.callsAddonTokens(env).catch(() => null) : null;
  const q = (d.buildCallQueue(raw, 3, addons).queue || []).find(g => g.guest_id === guestId && g.token === token);
  if (!q) return { in_queue: false };
  const today = ilDayOf(now);
  const why = [];
  if (q.capped) why.push('מוצו הניסיונות');
  if (q.rsvp === 'מגיע' || q.rsvp === 'לא מגיע') why.push('כבר ענה');
  if (await kget(env, 'hold:' + token)) why.push('האירוע מוקפא');
  if (await kget(env, 'callstop:' + token)) why.push('סבב השיחות עצור');
  if (await kget(env, 'nocalls:' + token)) why.push('האירוע בלי שיחות');
  const st = await guestStops(env, token, q.phone, guestId);
  if (st.nocall || st.block) why.push('המספר הוצא משיחות');
  if (st.wrong) why.push('סומן לא לשלוח באירוע הזה');
  const triedToday = !!(await kget(env, `shirtry:${guestId}:${today}`));
  const at = why.length ? null : nextCallAt({ now, triedToday, callWindowState: d.callWindowState, isNoContactDay: d.isNoContactDay });
  return { in_queue: true, tries: q.tries, max_tries: q.max_tries, tried_today: triedToday, next_at: at ? new Date(at).toISOString() : null, next_he: at ? whenHe(at, now) : '', blocked_he: why.join(' · '), skip_key: `shirtry:${guestId}:${at ? ilDayOf(at) : today}` };
}

export async function buildFuture(env, d, { days = 14, token = '', now = Date.now() } = {}) {
  const today = d.ilDate(new Date(now));
  const inp = await projectionInputs(env, d, today, days);
  if (!inp) return { ok: false, error: 'no-snapshot' };
  const evs = token ? inp.events.filter(e => e.token === token) : inp.events;
  const items = projectItems({ events: evs, guests: inp.guests, flags: inp.flags, today, days, isNoContactDay: d.isNoContactDay });
  const invite = {};
  for (const e of evs) invite[e.token] = d.inviteTemplateFor ? await d.inviteTemplateFor(env, e.token).catch(() => 'hazmana_ishur') : 'hazmana_ishur';
  const sends = [];
  /* one event: read each per-guest mark family ONCE by prefix (one KV op per 1,000 keys) instead of a get per guest —
     a 600-guest event would otherwise pass the Worker's KV budget and silently count everyone */
  let have = null;
  if (token) {
    const fam = ['wsent:', 'wdead:', 's5d:', 's5t:', 's5e:', 'ed:', 's3t:', 'wrong:'].map(f => f + token + ':');
    const lists = await Promise.all([...fam, 'optout:', 'block:'].map(pre => listNames(env, pre)));
    have = new Set(lists.flat());
  }
  for (const it of items) {
    let count = it.count, exact = false;
    if (have) {
      const seen = new Set();
      count = 0;
      for (const g of inp.guests[token] || []) {
        const p = norm(g.phone); if (!p || seen.has(p)) continue; seen.add(p);
        const solo = projectItems({ events: evs, guests: { [token]: [g] }, flags: inp.flags, today, days, isNoContactDay: d.isNoContactDay }).some(x => x.type === it.type && x.day === it.day);
        if (!solo) continue;
        if ([...markKeys(it.type, token, p), 'optout:' + p, 'block:' + p, `wrong:${token}:${p}`].some(k => have.has(k))) continue;
        count++;
      }
      exact = true;
    }
    if (count <= 0 && !it.dropped) continue;
    sends.push({ day: it.day, token: it.token, tok8: it.tok8, event: it.name, type: it.type, type_he: TYPE_HE[it.type] || it.type, count, exact, held: !!it.held, dropped: !!it.dropped, template: templateOf(it.type, { invite: invite[it.token] }) });
  }
  sends.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.event < b.event ? -1 : 1));
  /* calls: Shir's queue per event, and the planned round */
  const addons = d.callsAddonTokens ? await d.callsAddonTokens(env).catch(() => null) : null;
  const queue = d.buildCallQueue(inp.raw, 3, addons).queue || [];
  let noCalls = {}; try { noCalls = await d.kvPrefix(env, 'nocalls:'); } catch {}
  const byTok = {};
  for (const g of queue) { if (token && g.token !== token) continue; (byTok[g.token] = byTok[g.token] || []).push(g); }
  const calls = [];
  const evTokens = new Set([...evs.map(e => e.token), ...Object.keys(byTok)]);
  for (const t of evTokens) {
    const ev = evs.find(e => e.token === t) || {};
    const q = byTok[t] || [];
    const open = q.filter(g => !g.capped && g.rsvp !== 'מגיע' && g.rsvp !== 'לא מגיע');
    const why = [];
    if (await kget(env, 'hold:' + t)) why.push('האירוע מוקפא');
    if (await kget(env, 'callstop:' + t)) why.push('סבב השיחות עצור');
    if (noCalls[t] != null) why.push('האירוע בלי שיחות');
    const at = open.length && !why.length ? nextCallAt({ now, callWindowState: d.callWindowState, isNoContactDay: d.isNoContactDay }) : null;
    const plan = ev.plan || (q[0] && q[0].plan) || '';
    const roundDay = plan && plan !== 'basic' && ev.waves ? callRoundDay(ev.waves) : '';
    const roundN = roundDay && roundDay >= today ? (inp.guests[t] || []).filter(g => (!g.rsvp || g.rsvp === 'מתלבט') && /^9725\d{8}$/.test(norm(g.phone))).length : 0;
    if (!open.length && !roundN) continue;
    calls.push({ token: t, tok8: t.slice(0, 8), event: ev.name || (q[0] && q[0].event_name) || '', date: ev.date || (q[0] && q[0].event_date) || '', plan,
      queued: open.length, capped: q.filter(g => g.capped).length, next_at: at ? new Date(at).toISOString() : null, next_he: at ? whenHe(at, now) : '', blocked_he: why.join(' · '),
      round_day: roundDay >= today ? roundDay : '', round_n: roundN, guests: open.slice(0, 200).map(g => ({ guest_id: g.guest_id, name: g.name, tries: g.tries, max_tries: g.max_tries, rsvp: g.rsvp })) });
  }
  calls.sort((a, b) => ((a.next_at || a.round_day || '9') < (b.next_at || b.round_day || '9') ? -1 : 1));
  return { ok: true, at: new Date(now).toISOString(), today, days, sends, calls,
    notes: token ? ['מספרי השליחה נבדקו אורח-אורח (סימוני נשלח, הסרה, חסימה, טעות)'] : ['מספרי השליחה הם גבול עליון: לכל האירועים לא נבדקים סימוני נשלח/הסרה/טעות לכל אורח. בחרו אירוע לספירה מדויקת', 'הזמן לשיחה הבאה = הדקה הראשונה שחלון החיוג פתוח; בפועל הדיאלר מחייג עד 10 שיחות במקביל'] };
}

export async function buildLive(env, d, { now = Date.now() } = {}) {
  const out = { ok: true, at: new Date(now).toISOString(), in_progress: [], recent: [] };
  if (d.retellListCalls && env.RETELL_KEY) {
    const list = await d.retellListCalls(env, { sort_order: 'descending', limit: 50, filter_criteria: { start_timestamp: { lower_threshold: now - 3 * 3600e3 } } }).catch(() => null);
    for (const c of list || []) {
      if (!/^(ongoing|registered)$/.test(String(c.call_status || ''))) continue;
      const m = c.metadata || {};
      let em = null; try { em = m.token ? JSON.parse((await kget(env, 'evmeta:' + m.token)) || 'null') : null; } catch {}
      let gm = null; try { gm = m.token ? JSON.parse((await kget(env, 'gmap:' + m.token)) || 'null') : null; } catch {}
      const phone = norm(c.to_number || '');
      out.in_progress.push({ call_id: c.call_id, status: c.call_status, started_at: c.start_timestamp ? new Date(c.start_timestamp).toISOString() : null, seconds: c.start_timestamp ? Math.max(0, Math.round((now - c.start_timestamp) / 1000)) : 0,
        phone, guest_id: String(m.guest_id || ''), token: String(m.token || ''), tok8: String(m.token || '').slice(0, 8), event: (em && em.event) || '', guest: (gm && gm[phone] && gm[phone].name) || '' });
    }
  }
  const items = [];
  for (let i = 0; i < 3 && items.length < 50; i++) {
    const day = ilDayOf(now - i * 864e5).replace(/-/g, '');
    try { for (const r of (await d.auditQuery(env, { kind: 'call', from: day, to: day, limit: 50 - items.length })) || []) items.push(r); } catch {}
  }
  out.recent = items.slice(0, 50).map(r => { const x = rowFromAudit(r); return { ...x, call_id: x.id, has_recording: !!x.recording }; });
  return out;
}

/* ══ §3 the route ══════════════════════════════════════════════════════════ */
export async function handleFutureLog(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!(await d.adminKeyOk(env, b.admin_key))) return d.deny(403, 'bad-admin-key', origin);
  if (b.action === 'live') return d.okJson(await buildLive(env, d), origin);
  const token = String(b.token || '').trim();
  if (token && !/^[0-9a-f-]{36}$/.test(token)) return d.deny(400, 'bad-token', origin);
  let r; try { r = await buildFuture(env, d, { days: Math.max(1, Math.min(45, Number(b.days) || 14)), token }); } catch { return d.deny(503, 'try-again', origin); }
  return r.ok ? d.okJson(r, origin) : d.deny(503, r.error || 'no-snapshot', origin);
}
