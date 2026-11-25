/* ============================================================================
   ishur.io · guest-card.js · one guest, everything (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   POST /api/guest-card   (admin; the iOS/Android app uses the same route)
     {token, guest_id}                 → read:
        { ok, guest:{id,name,phone,rsvp,party,invited,table,tries,call_flag},
          event:{token,name,date,time,plan},
          whatsapp:[{ts,dir:'in'|'out',type,text,who,ok,status}]   every KV log:<phone>: line (newest 300, oldest first)
          calls:[{call_id,ts,duration_s,outcome,answer,disconnection,transcript,summary,has_recording,recording_name}]  audit kind 'call', 30 days
          planned:{ sends:[{day,type,type_he,template,held,dropped}], call:{in_queue,tries,max_tries,next_at,next_he,blocked_he} },
          stops:{ optout, block, nocall, wrong, skips:[{type,day}] } }
     {token, guest_id, action, who?, reason?}  → { ok, done_he, key }   every action is logged (logEvent → journal + audit)
        cancel_send   {type?}  the next planned send (or that type) is skipped: the sender's own per-guest mark
                               with value 'skip' (wsent:/s5d:/s3t: as /api/skip writes, ed: for the event day)
        undo_send     {type}   the 'skip' mark is removed (a real "sent" mark is never touched)
        cancel_call            shirtry:<guest_id>:<day of the next ring> = 'skip': the dispatcher skips the guest that day
        undo_call              that 'skip' mark is removed
        stop_event             wrong:<token>:<phone>: no messages AND no calls for THIS event (the "טעות" mark the
                               senders and the dispatcher already obey; the client board stops counting the guest as waiting)
        resume_event           wrong: removed
        stop_all               block:<phone>: no messages and no calls, every event (the /api/block-phone mark)
        resume_all             block: removed (a guest's own הסר, optout:, stays: it was the guest's request)
   Recordings play through GET /rec/<call_id> with the admin key in a header (assets/rec-player.js).
   ========================================================================== */
import { guestPlannedSends, guestCall, guestStops, skipKey, norm } from './future-log.js';
import { projectionInputs } from './ops.js';
import { rowFromAudit } from './calls-log.js';

const ilDayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms));
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dm = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}` : ''; };
export const ACTIONS = ['cancel_send', 'undo_send', 'cancel_call', 'undo_call', 'stop_event', 'resume_event', 'stop_all', 'resume_all'];
const TYPE_HE = { w1: 'ההזמנה', w2: 'התזכורת', w3: 'השליחה הנוספת', daybefore: 'הודעת יום-לפני', table: 'הודעת השולחן', eventday: 'הודעת יום האירוע', thanks: 'הודעת התודה' };

export function guestOf(g) {
  const c = i => String((g || [])[i] ?? '').trim();
  return { id: c(2), name: c(3), phone: norm(c(4)), rsvp: c(15), party: Number(c(13)) || 0, invited: Number(c(5)) || 1, table: c(30), tries: Number(c(29)) || 0, call_flag: c(21) === 'נדרשת שיחה', call_answer: c(22) };
}
export function waLine(key, v) {
  return { ts: Number(String(key).split(':')[2]) || 0, dir: v.dir === 'in' ? 'in' : 'out', type: String(v.type || ''), text: String(v.text || '').slice(0, 1200), who: String(v.who || ''), ok: v.ok !== false, status: String(v.status || '') };
}
/* the text the users page and the journal show */
export function doneHe(action, { name = 'האורח', type = '', day = '', when = '' } = {}) {
  switch (action) {
    case 'cancel_send': return `ביטול ${TYPE_HE[type] || 'השליחה הבאה'}${day ? ` (${dm(day)})` : ''} ל${name}`;
    case 'undo_send': return `החזרת ${TYPE_HE[type] || 'השליחה'} ל${name}`;
    case 'cancel_call': return `ביטול השיחה הבאה${when ? ` (${when})` : ''} ל${name}`;
    case 'undo_call': return `החזרת השיחה ל${name}`;
    case 'stop_event': return `עצירת כל ההודעות והשיחות ל${name} באירוע הזה`;
    case 'resume_event': return `החזרת ${name} להודעות ולשיחות באירוע הזה`;
    case 'stop_all': return `חסימת ${name} לכל ההודעות והשיחות, בכל האירועים`;
    case 'resume_all': return `שחרור החסימה של ${name}`;
    default: return '';
  }
}

async function readAll(env, prefix, cap = 3000) {
  const keys = []; let cursor;
  do { const pg = await env.RATE.list({ prefix, cursor, limit: 1000 }).catch(() => null); if (!pg) break; keys.push(...(pg.keys || []).map(k => k.name)); cursor = pg.list_complete ? null : pg.cursor; } while (cursor && keys.length < cap);
  return keys;
}

export async function handleGuestCard(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!(await d.adminKeyOk(env, b.admin_key))) return d.deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return d.deny(503, 'no-kv', origin);
  const token = String(b.token || '').trim(), gid = String(b.guest_id || '').trim();
  if (!/^[0-9a-f-]{36}$/.test(token) || !gid) return d.deny(400, 'bad-request', origin);
  const action = String(b.action || '');
  if (action && !ACTIONS.includes(action)) return d.deny(400, 'bad-action', origin);
  const raw = await d.readSnapshot(env).catch(() => null);
  if (!raw) return d.deny(503, 'no-snapshot', origin);
  const row = ((raw.guests && raw.guests.values) || []).find(g => String((g || [])[2] || '').trim() === gid && String(g[28] || '').trim() === token);
  if (!row) return d.deny(404, 'unknown-guest', origin);
  const guest = guestOf(row), p = guest.phone;
  const now = Date.now(), today = d.ilDate();
  const inp = await projectionInputs(env, { ...d, snapshotCached: async () => raw }, today, 45).catch(() => null);
  const pgGuest = { name: guest.name, phone: p, id: guest.id, rsvp: guest.rsvp, table: guest.table };
  const sends = inp ? await guestPlannedSends(env, d, inp, token, pgGuest, today, 45) : [];
  const call = await guestCall(env, d, raw, token, gid, now).catch(() => ({ in_queue: false }));

  if (action) {
    const who = String(b.who || 'צוות').slice(0, 40), reason = String(b.reason || '').slice(0, 160);
    let key = '', done = '', ok = true;
    if (action === 'cancel_send' || action === 'undo_send') {
      const want = String(b.type || '');
      if (action === 'cancel_send') {
        const next = want ? sends.find(s => s.type === want) : sends[0];
        if (!next) return d.deny(409, 'no-planned-send', origin);
        key = skipKey(next.type, token, p);
        if (await env.RATE.get(key)) return d.deny(409, 'already-closed', origin);
        await env.RATE.put(key, 'skip', { expirationTtl: 400 * 86400 });
        done = doneHe(action, { name: guest.name, type: next.type, day: next.day });
      } else {
        key = skipKey(want, token, p);
        if (!key) return d.deny(400, 'bad-type', origin);
        if ((await env.RATE.get(key)) !== 'skip') return d.deny(409, 'not-skipped', origin);
        await env.RATE.delete(key);
        done = doneHe(action, { name: guest.name, type: want });
      }
    } else if (action === 'cancel_call') {
      if (!call.in_queue || !call.next_at) return d.deny(409, 'no-planned-call', origin);
      key = call.skip_key;
      await env.RATE.put(key, 'skip', { expirationTtl: 3 * 86400 });
      done = doneHe(action, { name: guest.name, when: call.next_he });
    } else if (action === 'undo_call') {
      for (let i = 0; i < 9; i++) { const k = `shirtry:${gid}:${addDays(today, i)}`; if ((await env.RATE.get(k)) === 'skip') { await env.RATE.delete(k); key = k; } }
      if (!key) return d.deny(409, 'not-skipped', origin);
      done = doneHe(action, { name: guest.name });
    } else if (action === 'stop_event') {
      key = `wrong:${token}:${p}`;
      await env.RATE.put(key, new Date().toISOString(), { expirationTtl: 400 * 86400 });
      done = doneHe(action, { name: guest.name });
    } else if (action === 'resume_event') {
      key = `wrong:${token}:${p}`; await env.RATE.delete(key); done = doneHe(action, { name: guest.name });
    } else if (action === 'stop_all') {
      key = 'block:' + p; await env.RATE.put(key, new Date().toISOString()); done = doneHe(action, { name: guest.name });
    } else if (action === 'resume_all') {
      key = 'block:' + p; await env.RATE.delete(key); done = doneHe(action, { name: guest.name });
    }
    await d.logEvent(env, { area: 'כרטיס אורח', action: done, ok, token, phone: p, ref: key.split(':')[0], detail: `${who}${reason ? ' · ' + reason : ''} · ${key.replace(/\d{6}(\d{3})$/, '******$1')}` }).catch(() => {});
    if (d.logRow && (action === 'stop_event' || action === 'stop_all')) await d.logRow(env, 'removals', { kind: action === 'stop_all' ? 'חסימה ידנית' : 'לא לשלוח באירוע', channel: 'כרטיס אורח', phone: p, token: token.slice(0, 8), scope: action === 'stop_all' ? 'כל ההודעות והשיחות' : 'האירוע הזה', said: '', detail: reason }).catch(() => {});
    return d.okJson({ ok, action, done_he: done, key: key.split(':')[0] }, origin);
  }

  /* WhatsApp: everything the log keeps for this phone */
  const wa = [];
  if (p) {
    const keys = (await readAll(env, 'log:' + p + ':')).sort().slice(-300);
    const vals = await Promise.all(keys.map(k => env.RATE.get(k).catch(() => null)));
    keys.forEach((k, i) => { let v = null; try { v = JSON.parse(vals[i] || 'null'); } catch {} if (v) wa.push(waLine(k, v)); });
  }
  /* calls: the audit log of this event, kept to this guest */
  const calls = [];
  try {
    const days = Math.max(2, Math.min(60, Number(b.days) || 30));
    for (const r of (await d.auditQuery(env, { kind: 'call', token, days, limit: 4000 })) || []) {
      const x = r.data || {};
      if (String(x.guest_id || '') !== gid && norm(r.phone || '') !== p) continue;
      const c = rowFromAudit(r);
      calls.push({ call_id: c.id, ts: c.ts, duration_s: c.duration_s, outcome: c.outcome, answer: c.answer, disconnection: c.disconnection, transcript: c.transcript, summary: c.summary, has_recording: !!c.recording, recording_name: c.recording_name });
    }
  } catch {}
  calls.sort((a, b2) => a.ts - b2.ts);
  const stops = await guestStops(env, token, p, gid);
  /* the 'skip' marks the team set, so the card can offer to undo them */
  const skips = [];
  for (const t of ['w1', 'w2', 'w3', 'daybefore', 'eventday', 'thanks']) { const k = skipKey(t, token, p); if (k && (await env.RATE.get(k)) === 'skip') skips.push({ type: t }); }
  let callSkip = '';
  for (let i = 0; i < 9 && !callSkip; i++) { if ((await env.RATE.get(`shirtry:${gid}:${addDays(today, i)}`)) === 'skip') callSkip = addDays(today, i); }
  let em = null; try { em = JSON.parse((await env.RATE.get('evmeta:' + token)) || 'null'); } catch {}
  const evRow = ((raw.events && raw.events.values) || []).find(e => String((e || [])[1] || '').trim() === token) || [];
  const c = i => String(evRow[i] ?? '').trim();
  return d.okJson({ ok: true, guest, event: { token, name: (em && em.event) || c(34) || c(2), date: c(6).slice(0, 10), time: c(36), plan: d.planKeyOf ? d.planKeyOf(evRow) : '' },
    whatsapp: wa, calls, planned: { sends: sends.map(({ skip_key, ...s }) => s), call: (({ skip_key, ...x }) => x)(call) }, stops: { ...stops, skips, call_skip_day: callSkip }, at: new Date(now).toISOString(), day: ilDayOf(now) }, origin);
}
