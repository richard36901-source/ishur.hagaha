/* ============================================================================
   ishur.io · answers-log.js · who answered, how, and the proof (Richard 25/11/2026)
   ----------------------------------------------------------------------------
   Richard, after a day of wrong answers on boards: "אני רוצה לוג של מי אישר,
   באותה שורה את הדרך שבה אישר, עם ההודעה שקבעה את זה: וואטסאפ → החלק מהשיחה,
   שיחה → הקלטה. לסנן לפי אירוע, לתקן ידנית מתוך הלוג, בלי לעבור מסכים."

   POST /api/answers-log   (admin)
     {}                                  → the active events, with counts
     {token, filter?, q?}                → every guest of the event: answer, count, HOW it was given, when
     {action:'proof', token, guest_id}   → the WhatsApp messages and the calls (transcript + recording link) behind it
     {action:'set', token, guest_id, rsvp:'מגיע'|'לא מגיע'|'מתלבט', party}
                                         → a correction by the team, written like any answer and logged

   The reads come from the sheet snapshot (answers), KV log:<phone>:<ts> (WhatsApp) and the audit log (calls).
   The only write is 'set', through the same writer every answer uses.
   ========================================================================== */

export const METHODS = { call: 'שיחת טלפון', wa: 'וואטסאפ', link: 'קישור הרשמה', manual: 'סומן ידנית', unknown: 'לא ידוע', none: '' };

/* how the answer on the row was given, from what the sheet keeps */
export function methodOf(g) {
  const rsvp = String((g || [])[15] || '').trim(), w = String((g || [])[22] || '').trim(), note = String((g || [])[24] || '');
  if (!rsvp) return 'none';
  if (/נרשם מהקישור/.test(note)) return 'link';
  if (/ידנית/.test(w)) return 'manual';
  if (w === 'ענה בוואטסאפ') return 'wa';
  if (/^ענה($| - )/.test(w)) return 'call';
  return 'unknown';
}

export function rowOf(g) {
  const c = i => String((g || [])[i] ?? '').trim();
  const m = methodOf(g);
  return { id: c(2), name: c(3), phone: c(4), invited: Number(c(5)) || 1, rsvp: c(15), party: Number(c(13)) || 0, method: m, method_he: METHODS[m],
    call_answer: c(22), tries: Number(c(29)) || 0, table: c(30), at: c(25), awaiting_call: c(21) === 'נדרשת שיחה' };
}

const FILTERS = {
  all: () => true,
  answered: r => !!r.rsvp, confirmed: r => r.rsvp === 'מגיע', declined: r => r.rsvp === 'לא מגיע', undecided: r => r.rsvp === 'מתלבט',
  none: r => !r.rsvp, call: r => r.method === 'call', wa: r => r.method === 'wa', manual: r => r.method === 'manual' || r.method === 'unknown',
};

export function listRows(raw, token, { filter = 'all', q = '' } = {}) {
  const rows = ((raw && raw.guests && raw.guests.values) || []).filter(g => String((g || [])[28] || '').trim() === token).map(rowOf);
  const counts = { all: rows.length };
  for (const k of Object.keys(FILTERS)) if (k !== 'all') counts[k] = rows.filter(FILTERS[k]).length;
  counts.seats = rows.filter(r => r.rsvp === 'מגיע').reduce((n, r) => n + r.party, 0);
  const needle = String(q || '').trim();
  const digits = needle.replace(/\D/g, '');
  let out = rows.filter(FILTERS[filter] || FILTERS.all);
  if (needle) out = out.filter(r => r.name.includes(needle) || (digits.length >= 3 && r.phone.replace(/\D/g, '').includes(digits)));
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { rows: out, counts };
}

export function eventsOf(raw, today) {
  const g = (raw && raw.guests && raw.guests.values) || [];
  const per = {};
  for (const r of g) { const t = String((r || [])[28] || '').trim(); if (!t) continue; const p = per[t] || (per[t] = { guests: 0, answered: 0, confirmed: 0 }); p.guests++; if (String(r[15] || '').trim()) p.answered++; if (String(r[15] || '').trim() === 'מגיע') p.confirmed++; }
  const out = [];
  for (const e of (raw && raw.events && raw.events.values) || []) {
    const t = String((e || [])[1] || '').trim(), date = String(e[6] || '').slice(0, 10);
    if (!/^[0-9a-f-]{36}$/.test(t) || !per[t] || String(e[27] || '').trim() === 'כן') continue;
    out.push({ token: t, name: String(e[34] || e[2] || '').trim(), client: String(e[2] || '').trim(), occasion: String(e[5] || '').trim(), date, past: !!date && date < today, ...per[t] });
  }
  return out.sort((a, b) => (a.past - b.past) || ((a.date || '9') < (b.date || '9') ? -1 : 1));
}

/* the Hebrew words of one WhatsApp log entry, short */
function waLine(key, v) {
  return { ts: Number(String(key).split(':')[2]) || 0, dir: v.dir === 'in' ? 'in' : 'out', type: String(v.type || ''), text: String(v.text || '').slice(0, 400), who: String(v.who || ''), ok: v.ok !== false };
}

export async function handleAnswersLog(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!(await d.adminKeyOk(env, b.admin_key))) return d.deny(403, 'bad-admin-key', origin);
  const raw = await d.readSnapshot(env).catch(() => null);
  if (!raw) return d.deny(503, 'no-snapshot', origin);
  const token = String(b.token || '').trim();
  if (!token) return d.okJson({ ok: true, events: eventsOf(raw, d.ilDate()) }, origin);
  if (!/^[0-9a-f-]{36}$/.test(token)) return d.deny(400, 'bad-token', origin);
  const gRow = () => ((raw.guests && raw.guests.values) || []).find(g => String((g || [])[2] || '').trim() === String(b.guest_id || '').trim() && String(g[28] || '').trim() === token);

  if (b.action === 'proof') {
    const g = gRow(); if (!g) return d.deny(404, 'unknown-guest', origin);
    const row = rowOf(g), phone = d.normPhone(row.phone);
    const wa = [];
    if (phone && env.RATE) {
      const keys = []; let cursor;
      do { const pg = await env.RATE.list({ prefix: 'log:' + phone + ':', cursor, limit: 1000 }); keys.push(...(pg.keys || []).map(k => k.name)); cursor = pg.list_complete ? null : pg.cursor; } while (cursor && keys.length < 3000);
      for (const k of keys.sort().slice(-40)) { let v = null; try { v = JSON.parse(await env.RATE.get(k) || 'null'); } catch {} if (v) wa.push(waLine(k, v)); }
    }
    /* calls: the audit log by event, kept to this guest (an inbound call carries OUR line as its phone, so the guest id decides) */
    const calls = [];
    try {
      const items = await d.auditQuery(env, { kind: 'call', token, days: Math.max(2, Math.min(30, Number(b.days) || 14)), limit: 4000 });
      for (const r of items || []) {
        const x = r.data || {};
        if (String(x.guest_id || '') !== row.id && d.normPhone(r.phone || '') !== phone) continue;
        const id = String(x.call_id || '');
        calls.push({ id, ts: Number(r.ts) || Date.parse(r.at) || 0, duration_s: Number(x.duration_s) || 0, outcome: x.outcome === '__keep__' ? '' : String(x.outcome || ''), answer: String(x.answer || ''),
          disconnection: String(x.disconnection || ''), transcript: String(r.detail || ''), has_recording: !!x.recording, recording: x.recording && id ? await d.recordingLink(env, id, 7) : '', recording_name: String(x.recording_name || '') });
      }
    } catch {}
    calls.sort((a, b2) => a.ts - b2.ts);
    return d.okJson({ ok: true, guest: row, whatsapp: wa, calls }, origin);
  }

  if (b.action === 'set') {
    const g = gRow(); if (!g) return d.deny(404, 'unknown-guest', origin);
    const rsvp = String(b.rsvp || '').trim();
    if (!['מגיע', 'לא מגיע', 'מתלבט'].includes(rsvp)) return d.deny(400, 'bad-rsvp', origin);
    const party = rsvp === 'מגיע' ? Math.max(1, Math.min(30, parseInt(b.party, 10) || 1)) : undefined;
    const row = rowOf(g);
    const ok = await d.writeAnswer(env, { guest_id: row.id, token, phone: d.normPhone(row.phone), name: row.name, by_client: true, answer_label: 'תוקן ידנית (צוות)' }, rsvp, party);
    await d.logEvent(env, { area: 'אישורים', action: 'תשובה תוקנה ידנית מלוג האישורים', ok: !!ok, review: !ok, token, phone: d.normPhone(row.phone),
      detail: `${row.name}: ${row.rsvp || 'ללא תשובה'}${row.party ? ' ' + row.party : ''} → ${rsvp}${party ? ' ' + party : ''} · ${String(b.who || 'צוות').slice(0, 30)}${b.reason ? ' · ' + String(b.reason).slice(0, 120) : ''}` }).catch(() => {});
    return d.okJson({ ok: !!ok, guest_id: row.id, rsvp, party: party || 0 }, origin);
  }

  const ev = eventsOf(raw, d.ilDate()).find(e => e.token === token) || null;
  const { rows, counts } = listRows(raw, token, { filter: String(b.filter || 'all'), q: b.q });
  return d.okJson({ ok: true, event: ev, counts, rows: rows.slice(0, 1500) }, origin);
}
