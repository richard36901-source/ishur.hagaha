/* ============================================================================
   ishur.io · automations.js — POST /api/automations {admin_key}
   ----------------------------------------------------------------------------
   Registry (automations-registry.js) + live state per node + a 7-day timeline
   of what will go out, per event per day. Built 01/11/2026.

   STRICTLY READ-ONLY. This handler never calls env.RATE.put/delete, never
   sends, never runs the engine. Why it does NOT call runDailyEngine(env, true):
   the "dry" path of the engine writes KV (wa:cap via waCapInfo, brain:cache
   via getBrain, and deletes lead:<phone> keys inside chaseAbandonedLeads —
   index.js:4575/8143, 5020/3847, 890/891). runEventDayBlasts dry writes
   snapcache (index.js:2372). So the timeline here is a read-only PROJECTION
   of the engine's date rules, every rule citing its line, labelled as such.

   deps (from index.js, which cannot be imported here — it imports us):
     fetchSnapshot(target) → the Make status snapshot {events, guests, …}
                             (index.js:8402; reads Make only, no KV)
   Everything else is imported from the shared modules directly.

   Caches are module-level (per isolate, in memory, not KV):
     live state 2 min · snapshot + timeline 10 min. body.fresh=true skips them.
   ========================================================================== */
import { AUTOMATIONS, WINDOWS, NUMBERS, CRONS, edges, baseTemplate } from './automations-registry.js';
import { isAdmin, okJson, deny, kvPrefix, normPhone } from './lib.js';
import { sendWindowState, callWindowState, ilDate, isNoContactDay } from './shir.js';
import { guestPhoneIds, clientPhoneId } from './whatsapp.js';
import { planKeyOf } from './dashboard.js';
import * as audit from './audit.js';

const cache = { live: null, liveAt: 0, tl: null, tlAt: 0 };
const LIVE_TTL = 2 * 60e3, TL_TTL = 10 * 60e3;

/* ── a small 5-field cron (UTC) "next fire" — enough for wrangler.toml ── */
function fieldMatch(f, v) {
  return String(f).split(',').some(part => {
    if (part === '*') return true;
    const st = part.match(/^\*\/(\d+)$/); if (st) return v % Number(st[1]) === 0;
    const rg = part.match(/^(\d+)-(\d+)$/); if (rg) return v >= +rg[1] && v <= +rg[2];
    return Number(part) === v;
  });
}
export function cronNext(expr, from = new Date()) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const d = new Date(Math.floor(from.getTime() / 60e3) * 60e3 + 60e3);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (fieldMatch(f[0], d.getUTCMinutes()) && fieldMatch(f[1], d.getUTCHours()) && fieldMatch(f[2], d.getUTCDate()) &&
        fieldMatch(f[3], d.getUTCMonth() + 1) && fieldMatch(f[4], d.getUTCDay())) return d.toISOString();
    d.setTime(d.getTime() + 60e3);
  }
  return null;
}
const BY_ID = Object.fromEntries(AUTOMATIONS.map(n => [n.id, n]));
/* stages without their own trigger inherit their first parent's (engine stage → engine) */
function triggerOf(node, depth = 0) {
  if (node.trigger && node.trigger.cron) return node.trigger.cron;
  const p = BY_ID[(node.from || [])[0]];
  return p && depth < 5 ? triggerOf(p, depth + 1) : '';
}
function nextFor(node, now) {
  const exprs = String(triggerOf(node)).split('+').map(x => x.trim()).filter(Boolean);
  const all = [];
  for (const e of exprs) {
    if (e === '0 17,18,19 * * *') { all.push(cronNext('0 17,18,19 * * *', now)); continue; }
    if (e === '*/10') { all.push(cronNext('*/10 * * * *', now)); continue; }
    all.push(cronNext(e, now));
  }
  return all.filter(Boolean).sort()[0] || null;
}

const ilDay = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const isShabbat = iso => new Date(iso + 'T12:00:00Z').getUTCDay() === 6;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
async function kjson(env, k) { try { return JSON.parse((await kget(env, k)) || 'null'); } catch { return null; } }

/* ── live state ─────────────────────────────────────────────────────────── */
async function liveState(env) {
  const now = new Date();
  const today = ilDate(now);
  const ids = guestPhoneIds(env);
  const [paused, capAll, pacerLast, pacerPending, engineLast, waCap, inviteTmpl] = await Promise.all([
    kget(env, 'paused'), kget(env, 'wacap:guests'), kjson(env, 'pacer:last'), kget(env, 'pacer:pending'),
    kjson(env, 'engine:lastrun'), kjson(env, 'wa:cap'), kget(env, 'invitetmpl')]);
  const numbers = await Promise.all(ids.map(async (id, i) => ({
    id, label: `שיר #${i + 1}`, capped_since: await kget(env, 'wacap:' + id),
    sent_today: Number(await kget(env, `gsend:${id}:${today}`)) || 0 })));
  const holds = Object.entries(await kvPrefix(env, 'hold:')).map(([token, at]) => ({ token, tok8: token.slice(0, 8), at }));

  /* the audit log for the Israeli day: cron runs + messages + statuses */
  const rows = await audit.query(env, { days: 1, limit: 20000 });
  const jobLast = {}, byTmpl = {}, byPid = {}, wamidTmpl = {};
  for (const r of rows) {
    if (r.kind === 'cron' && r.data && r.data.job) {
      const j = r.data.job;
      if (!jobLast[j] || r.ts > jobLast[j].ts) jobLast[j] = { ts: r.ts, at: r.at, ms: r.data.ms, ok: r.ok };
      jobLast[j].runs_today = (jobLast[j].runs_today || 0) + 1;
    } else if (r.kind === 'wa_out' && r.data) {
      const t = baseTemplate(r.data.template) || '(טקסט חופשי)';
      const b = byTmpl[t] = byTmpl[t] || { sent: 0, rejected: 0, failed_async: 0, codes: {} };
      if (r.ok) b.sent++; else b.rejected++;
      if (r.data.wamid) wamidTmpl[r.data.wamid] = t;
      const pid = r.data.phone_id || '?'; byPid[pid] = (byPid[pid] || 0) + 1;
    }
  }
  for (const r of rows) {
    if (r.kind !== 'wa_status' || !r.data || r.data.status !== 'failed') continue;
    const t = wamidTmpl[r.data.wamid]; if (!t) continue;
    const code = (String(r.detail || '').match(/^\d+/) || ['?'])[0];
    byTmpl[t].failed_async++; byTmpl[t].codes[code] = (byTmpl[t].codes[code] || 0) + 1;
  }
  const send = sendWindowState(now), call = callWindowState(now);
  const nodes = {};
  for (const n of AUTOMATIONS) {
    const s = { next_run: nextFor(n, now) };
    const lv = n.live || {};
    const jl = (lv.jobs || []).map(j => jobLast[j] && { job: j, ...jobLast[j] }).filter(Boolean).sort((a, b) => b.ts - a.ts);
    if (jl.length) s.last_run = jl[0];
    if (lv.kv === 'pacer:last' && pacerLast) s.last_run = { at: pacerLast.at, from: 'pacer:last', ...(s.last_run ? { job: s.last_run.job, ms: s.last_run.ms, runs_today: s.last_run.runs_today } : {}) };
    if (lv.kv === 'engine:lastrun' && engineLast) s.last_run = { at: engineLast.at, from: 'engine:lastrun', date: engineLast.date, items: engineLast.items };
    if (lv.pacer && pacerLast) s.pacer_slice = pacerLast[lv.pacer] ?? null;
    if ((n.templates || []).length) {
      const t = {}; let sent = 0, failed = 0;
      for (const name of n.templates) if (byTmpl[name]) { t[name] = byTmpl[name]; sent += byTmpl[name].sent; failed += byTmpl[name].rejected + byTmpl[name].failed_async; }
      s.today = { sent, failed, by_template: t };
    }
    const h = [];
    if (paused && n.kind !== 'trigger') h.push('paused');
    if (capAll && n.kind === 'send_guest') h.push('wacap:guests');
    if (n.kind === 'send_guest' || n.kind === 'call') if (holds.length) h.push(`hold × ${holds.length}`);
    s.holds = h;
    if (n.kind === 'send_guest' || n.kind === 'send_client') s.window = send.open ? 'open' : (send.why || 'closed');
    if (n.kind === 'call') s.window = call.open ? 'open' : (call.why || 'closed');
    nodes[n.id] = s;
  }
  return {
    at: now.toISOString(), today,
    global: { paused: !!paused, paused_since: paused || null, wacap_guests: capAll || null, pacer_pending: pacerPending, pacer_last_at: pacerLast && pacerLast.at,
      engine_last: engineLast, send_window: send, call_window: call, no_contact_day: isNoContactDay(today), numbers, holds,
      client_number: clientPhoneId(env) || null, wa_cap: waCap, invite_template: inviteTmpl || 'hazmana_ishur',
      audit_rows_scanned: rows.length, by_phone_id_today: byPid, by_template_today: byTmpl },
    nodes,
  };
}

/* ── the 7-day projection (read-only) ───────────────────────────────────── */
async function timeline(env, deps, days = 7) {
  const today = ilDate();
  const raw = deps && deps.fetchSnapshot ? await deps.fetchSnapshot(env.HOOK_STATUS).catch(() => null) : null;
  if (!raw) return { ok: false, error: deps && deps.fetchSnapshot ? 'snapshot-unreadable' : 'no-fetchSnapshot-dep' };
  const evRows = (raw.events && raw.events.values) || [];
  const gRows = (raw.guests && raw.guests.values) || [];
  const byTok = {};
  for (const g of gRows) { const t = String((g || [])[28] || '').trim(); if (t) (byTok[t] = byTok[t] || []).push(g); }
  const dayList = Array.from({ length: days }, (_, i) => ilDay(today, i));
  const last = dayList[dayList.length - 1];
  const engineDay = d => !isShabbat(d) && !isNoContactDay(d);         /* index.js:4549, 4552 */
  const inviteTmpl = (await kget(env, 'invitetmpl')) || 'hazmana_ishur'; /* index.js:4374 */
  const gNum = { channel: 'guests', he: `שיר · ${guestPhoneIds(env).length} מספרים (הכי פחות עמוס, לא בתקרה)`, ids: guestPhoneIds(env) };
  const cNum = { channel: 'client', he: 'נועה 4499', ids: [clientPhoneId(env)].filter(Boolean) };
  const edjobs = await kvPrefix(env, 'edblast:');
  const items = [], events = [];
  const uniq = (list, pred) => { const s = new Set(); for (const g of list) { const p = normPhone(g[4] || ''); if (p && pred(g)) s.add(p); } return s.size; };
  const firstEngineDay = (from, to) => { for (const d of dayList) if (d >= from && d <= to && engineDay(d)) return d; return null; };

  for (const ev of evRows) {
    const token = String(ev[1] || '').trim(); if (!token) continue;
    const paid = String(ev[7] || '').trim() === 'כן', cancelled = String(ev[27] || '').trim() === 'כן', fileUp = String(ev[43] || '').trim() === 'כן';
    const date = String(ev[6] || '').trim().slice(0, 10);
    if (!paid || cancelled) continue;
    const guests = byTok[token] || [];
    const rel = isDate(date) && date >= ilDay(today, -14) && date <= ilDay(last, 7);
    const wavesInRange = [39, 40, 41].some(c => { const w = String(ev[c] || '').trim().slice(0, 10); return isDate(w) && w <= last && ilDay(w, 3) >= today; });
    if (!rel && !wavesInRange && !edjobs[token]) continue;
    const hold = await kget(env, 'hold:' + token);
    const plan = planKeyOf(ev);
    const e = { token, tok8: token.slice(0, 8), name: String(ev[34] || ev[2] || '').trim(), date, plan, guests: guests.length, hold: hold || null, in_window: isDate(date) && date >= today && date <= last };
    const push = (day, o) => items.push({ day, token, tok8: e.tok8, held: !!hold && o.hold_applies !== false, ...o });

    /* waves — index.js:4772-4803, claimable when..when+3, flag wave:<t>:<k> */
    if (fileUp) for (const w of [{ k: 1, c: 39, he: 'הזמנה (גל 1)' }, { k: 2, c: 40, he: 'תזכורת (גל 2)' }, { k: 3, c: 41, he: 'שליחה נוספת (גל 3)' }]) {
      const when = String(ev[w.c] || '').trim().slice(0, 10); if (!isDate(when)) continue;
      const d = firstEngineDay(when > today ? when : today, ilDay(when, 3)); if (!d || (isDate(date) && date < d)) continue;
      if (await kget(env, `wave:${token}:${w.k}`)) continue;
      if (w.k === 3 && !(await kget(env, 'extrasend:' + token))) { push(d, { node: 'wave3', he: w.he, template: '—', count: 0, note: 'מוחזק: תוסף לא נרכש', number: null }); continue; }
      const count = uniq(guests, g => { const r = String(g[15] || '').trim(); if (r === 'לא מגיע') return false; return w.k !== 2 || r === '' || r === 'מתלבט'; });
      push(d, { node: 'wave' + w.k, he: w.he, template: inviteTmpl, count, upper_bound: true, number: gNum });
    }
    if (!isDate(date)) { events.push(e); continue; }
    /* report7 — index.js:4921, 0..7 days before, flag report7: */
    if (!(await kget(env, 'report7:' + token))) { const d = firstEngineDay(ilDay(date, -7) > today ? ilDay(date, -7) : today, date); if (d) push(d, { node: 'report7', he: 'דוח שבוע-לפני', template: 'ishur_doch', count: 1, number: cNum }); }
    /* day-before — index.js:5233, daysLeft 0..1, only מגיע */
    if (fileUp && !(await kget(env, 'daybefore:' + token))) { const d = firstEngineDay(ilDay(date, -1) > today ? ilDay(date, -1) : today, date); if (d) push(d, { node: 'day_before', he: 'תזכורת יום-לפני', template: 'ishur_yom_lifnei', count: uniq(guests, g => String(g[15] || '').trim() === 'מגיע'), upper_bound: true, number: gNum }); }
    /* seating — index.js:5063, only on the day */
    if (dayList.includes(date) && engineDay(date) && !(await kget(env, 'seat:' + token))) push(date, { node: 'seating', he: 'השולחן שלך', template: 'ishur_shulchan', count: uniq(guests, g => String(g[15] || '').trim() === 'מגיע' && String(g[30] || '').trim()), upper_bound: true, number: gNum });
    /* thank-you + wrap-up — index.js:4968, 1..14 days after */
    const after = firstEngineDay(ilDay(date, 1) > today ? ilDay(date, 1) : today, ilDay(date, 14));
    if (after && plan !== 'basic' && !(await kget(env, 'toda:' + token))) push(after, { node: 'toda', he: 'תודה לאורחים', template: 'ishur_toda_orach_v2 / ishur_toda_orach', count: uniq(guests, g => String(g[15] || '').trim() === 'מגיע'), upper_bound: true, number: gNum });
    if (after && !(await kget(env, 'eoe:' + token))) push(after, { node: 'syum', he: 'סיכום ללקוח', template: (await kget(env, 'eoe:tmpl')) === 'v3' ? 'ishur_syum_v3' : 'ishur_syum', count: 1, number: cNum });
    events.push(e);
  }
  /* event-day blasts — index.js:4056; NOTE hold does not stop these (no hold check there) */
  for (const [token, rawJob] of Object.entries(edjobs)) {
    let job = null; try { job = JSON.parse(rawJob); } catch {}
    if (!job) continue;
    const at = String(job.at || today), d = at < today ? today : at;
    if (!dayList.includes(d)) continue;
    const s5d = await kvPrefix(env, `s5d:${token}:`);
    const people = new Set();
    for (const g of byTok[token] || []) { const p = normPhone(g[4] || ''); if (!p) continue; const ok = String(g[15] || '').trim() === 'מגיע' || s5d[p]; if (!ok) continue; if (job.no_table && String(g[30] || '').trim()) continue; people.add(p); }
    items.push({ day: d, token, tok8: token.slice(0, 8), node: 'event_day_blast', he: 'הודעת יום האירוע', template: job.template, count: people.size, upper_bound: true, number: gNum,
      held: false, hold_applies: false, note: `מ-09:00${job.time ? ' · ' + job.time : ''}${job.no_table ? ' · בלי מי שיש לו שולחן' : ''} · "החזק" לא עוצר את זה` });
    if (!events.some(x => x.token === token)) events.push({ token, tok8: token.slice(0, 8), name: '', date: '', hold: await kget(env, 'hold:' + token) });
  }
  /* call rounds — index.js:4229 (calls, not messages) */
  for (const [token, rawJob] of Object.entries(await kvPrefix(env, 'callround:'))) {
    let job = null; try { job = JSON.parse(rawJob); } catch {}
    if (!job || job.done) continue;
    const d = String(job.at || '') < today ? today : String(job.at || '');
    if (dayList.includes(d)) items.push({ day: d, token, tok8: token.slice(0, 8), node: 'call_rounds', he: 'סבב שיחות נוסף', template: 'שיחה (שיר)', count: (job.guest_ids || []).length, number: null, note: job.note || '' });
  }
  items.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : a.tok8 < b.tok8 ? -1 : 1);
  return {
    ok: true, projected: true, from: today, days: dayList,
    closed_days: dayList.filter(d => !engineDay(d)),
    rules: 'הקרנה לקריאה בלבד לפי כללי התאריכים של המנוע (לא הרצה יבשה — היא כותבת ל-KV). מספרים מסומנים כגבול עליון: לא נבדקים סימוני נשלח לכל אורח, הסרות וטעות-במספר.',
    not_projected: ['ביטול/דחייה לאורחים', 'שדרוגים ללקוח', 'רצף לידים', 'תזכורות כמות', 'שלבי 0.5/0.55'],
    pace: 'בפועל: 25 הודעות לפעימה של 10 דקות, תקציב אחד לכל השלבים לפי סדר הקוד (index.js:5354)',
    events, items,
  };
}

export async function handleAutomations(request, env, origin, deps = {}) {
  let b = {};
  try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, b.admin_key)) return deny(403, 'bad-admin-key', origin);
  const now = Date.now();
  const fresh = b.fresh === true;
  let live = cache.live, tl = cache.tl;
  if (b.live !== false && (fresh || !live || now - cache.liveAt > LIVE_TTL)) { live = await liveState(env); cache.live = live; cache.liveAt = now; }
  if (b.timeline !== false && (fresh || !tl || now - cache.tlAt > TL_TTL)) {
    tl = await timeline(env, deps, Math.max(1, Math.min(14, Number(b.days) || 7)));
    if (tl.ok) { cache.tl = tl; cache.tlAt = now; }
  }
  return okJson({
    ok: true, generated_at: new Date(now).toISOString(), read_only: true,
    registry: { nodes: AUTOMATIONS, edges: edges(), windows: WINDOWS, numbers: NUMBERS, crons: CRONS },
    live: b.live === false ? null : live,
    timeline: b.timeline === false ? null : tl,
    cache: { live_age_s: Math.round((now - cache.liveAt) / 1000), timeline_age_s: tl ? Math.round((now - cache.tlAt) / 1000) : null, live_ttl_s: LIVE_TTL / 1000, timeline_ttl_s: TL_TTL / 1000 },
  }, origin);
}
