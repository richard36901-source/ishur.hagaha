/* ============================================================================
   ishur.io · ops-inbox.js · Phase 4a of the ops center (03/11/2026)
   ----------------------------------------------------------------------------
   docs/OPS-P4A-2026-11-03.md. Read-only builders behind:
     GET /api/ops/messages?day=&cursor=&tab=   one row per MESSAGE (wa_out joined to its
                                               wa_status rows by wamid, the guest's reply =
                                               the next wa_in from that phone within 24 h)
     GET /api/ops/inbox?channel=               conversations (Noa 4499 + both Shir numbers),
                                               unread first, lead/client/guest badge, event
     GET /api/ops/thread?phone=                one conversation + 24 h window + takeover state
     GET /api/ops/control                      state for the manual-control screen
   Nothing here sends or writes. Replies go through the existing POST /api/wa-send,
   takeover through /api/human, media through /api/media-dl (the UI calls them).

   §1 pure (unit-tested) · §2 builders (I/O through env + the ops deps)
   ========================================================================== */
import { reasonOf, ilDayOf, addDays } from './ops.js';
import { codeOf } from './send-board.js';

const DAY_MS = 864e5;
export const WINDOW_MS = 24 * 3600e3;
export const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };
export const STATUS_HE = { sent: 'נשלח', delivered: 'נמסר', read: 'נקרא', failed: 'נכשל' };
export const TYPE_HE = { wave: 'גל הזמנה', daybefore: 'תזכורת יום לפני', eventday: 'יום האירוע', table: 'מספר שולחן', thanks: 'תודה', gift: 'קישור מתנה',
  subevent: 'אירוע-בן', reply: 'מענה בשיחה', manual: 'ידני', client: 'ללקוח' };
/* the templates the old inbox.html offered outside the 24 h window (same names, same params) */
export const INBOX_TEMPLATES = [
  { name: 'ishur_tashlum', label: 'קישור העלאה למשלם', params: ['שם פרטי', 'קישור העלאה'], ch: 'client' },
  { name: 'ishur_doch', label: 'דוח ללקוח', params: ['שם האירוע', 'אישרו', 'סועדים', 'סירבו', 'ממתינים', 'קישור דשבורד'], ch: 'client' },
  { name: 'hazmana_ishur', label: 'הזמנה לאורח', params: ['שם האורח', 'סוג האירוע', 'בעלי השמחה', 'תאריך', 'שעה', 'מקום'], ch: 'guests' },
  { name: 'ishur_shulchan', label: 'מספר שולחן', params: ['שם האורח', 'שם האירוע', 'מספר שולחן'], ch: 'guests' },
  { name: 'ishur_syum', label: 'סיום אירוע', params: ['שם האירוע', 'אישרו', 'סועדים', 'סירבו', 'ללא מענה', 'קישור ביקורת', 'קישור המלצה'], ch: 'client' },
];

const normP = p => { let x = String(p || '').replace(/\D/g, ''); if (x.startsWith('0')) x = '972' + x.slice(1); return x; };

/* phone → {name, role:'client'|'guest', token}, token → {name, date, cancel} from the sheet snapshot */
export function directory(raw) {
  const phones = {}, events = {};
  for (const ev of (raw && raw.events && raw.events.values) || []) {
    const tok = String(ev[1] || '').trim(); if (!tok) continue;
    const name = String(ev[34] || ev[2] || '').trim();
    events[tok] = { token: tok, tok8: tok.slice(0, 8), name, client: String(ev[2] || '').trim(), date: String(ev[6] || '').trim().slice(0, 10), occasion: String(ev[5] || '').trim(), cancel: String(ev[27] || '').trim() === 'כן', active: String(ev[7] || '').trim() === 'כן' };
    const p = normP(ev[3]);
    if (p && !phones[p]) phones[p] = { name: String(ev[2] || '').trim(), role: 'client', token: tok };
  }
  for (const g of (raw && raw.guests && raw.guests.values) || []) {
    const p = normP(g[4]); const tok = String(g[28] || '').trim();
    if (p && !phones[p]) phones[p] = { name: String(g[3] || '').trim(), role: 'guest', token: tok };
  }
  return { phones, events };
}

/* the text a wa_out row carries: detail is "<error> · <summary>" when Meta refused it */
export function outText(r) {
  const d = String(r.detail || '');
  if (r.ok !== false) return d;
  const err = String((r.data || {}).error || '');
  if (err && d.startsWith(err)) return d.slice(err.length).replace(/^\s*·\s*/, '');
  const i = d.indexOf(' · '); return i >= 0 ? d.slice(i + 3) : d;
}

/* THE per-message join. outRows: audit wa_out; statusRows: wa_status; inRows: wa_in.
   numbers: {phone_id: {label, role}}. One item per sent message; status = the highest-ranked
   status seen for its wamid (failed > read > delivered > sent); reply = the first wa_in from
   the same phone after the send and within 24 h (and before that phone's next send). */
export function groupMessages(outRows, statusRows, inRows, { numbers = {}, clientIds = [], subTemplates = new Set(), dir = { phones: {}, events: {} } } = {}) {
  const stBy = {};
  for (const r of statusRows || []) {
    if (r.kind !== 'wa_status') continue;
    const d = r.data || {}; if (!d.wamid) continue;
    (stBy[d.wamid] = stBy[d.wamid] || []).push({ status: String(d.status || ''), at: r.at, ts: r.ts, code: d.status === 'failed' ? codeOf(r.detail) : '', error: d.status === 'failed' ? String(r.detail || '') : '', token: r.token || '' });
  }
  const ins = (inRows || []).filter(r => r.kind === 'wa_in').map(r => ({ ts: r.ts, at: r.at, phone: normP(r.phone), text: String(r.detail || ''), area: r.area || '', id: r.id })).sort((a, b) => a.ts - b.ts);
  const outs = (outRows || []).filter(r => r.kind === 'wa_out').sort((a, b) => a.ts - b.ts);
  const nextOutTs = {};   /* per phone, the ts of the following send (a reply after it belongs to it) */
  const items = [];
  for (let i = outs.length - 1; i >= 0; i--) {
    const r = outs[i]; const d = r.data || {}; const to = normP(r.phone);
    const sms = d.channel === 'sms';
    const pid = String(d.phone_id || '');
    const num = sms ? { label: 'SMS', role: 'sms' } : (numbers[pid] || { label: r.area || (pid ? '…' + pid.slice(-4) : '?'), role: 'unknown' });
    const sts = (d.wamid && stBy[d.wamid]) || [];
    let best = r.ok === false ? { status: 'failed', at: r.at, code: codeOf(d.error || r.detail), error: String(d.error || '') } : { status: 'sent', at: r.at, code: '', error: '' };
    for (const s of sts) if ((STATUS_RANK[s.status] || 0) > (STATUS_RANK[best.status] || 0)) best = s;
    const limit = Math.min(r.ts + WINDOW_MS, nextOutTs[to] || Infinity);
    const rep = ins.find(x => x.phone === to && x.ts > r.ts && x.ts <= limit) || null;
    nextOutTs[to] = r.ts;
    const tok = String(r.token || (sts.find(s => s.token) || {}).token || '').trim();
    const who = dir.phones[to] || null;
    const evTok = tok || (who && who.token) || '';
    const ev = evTok ? (dir.events[evTok] || Object.values(dir.events).find(e => e.tok8 === evTok.slice(0, 8))) : null;
    const type = sms ? 'manual' : reasonOf(r, { clientIds, subTemplates });
    items.push({
      id: d.wamid || r.id, row_id: r.id, wamid: d.wamid || '', ts: r.ts, at: r.at, dir: 'out',
      number: { phone_id: pid, label: num.label, role: num.role }, to, to_name: who ? who.name : '', to_role: who ? who.role : '',
      token8: evTok.slice(0, 8), event: ev ? ev.name : '', type, type_he: TYPE_HE[type] || type, template: String(d.template || ''),
      text: outText(r).slice(0, 2000), ok: r.ok !== false,
      status: best.status, status_he: STATUS_HE[best.status] || best.status, status_at: best.at, error_code: best.code || '', error: best.error || '',
      statuses: sts.sort((a, b) => a.ts - b.ts).map(s => ({ status: s.status, at: s.at })),
      reply: rep ? { at: rep.at, ts: rep.ts, text: rep.text.slice(0, 1000) } : null,
      reason: type === 'reply' ? 'תשובה בתוך חלון 24 השעות' : type === 'manual' ? 'נשלח ידנית' : (TYPE_HE[type] || type) + (d.template ? ' · ' + d.template : ''),
    });
  }
  items.sort((a, b) => b.ts - a.ts);
  /* inbound rows, each pointing at the send it answers */
  const inbound = ins.map(x => {
    const prev = items.find(o => o.to === x.phone && o.ts < x.ts && o.ts >= x.ts - WINDOW_MS) || null;
    const who = dir.phones[x.phone] || null;
    return { id: x.id, ts: x.ts, at: x.at, dir: 'in', from: x.phone, from_name: who ? who.name : '', from_role: who ? who.role : '', number: { label: x.area || '' }, text: x.text.slice(0, 2000),
      token8: prev ? prev.token8 : (who && who.token ? who.token.slice(0, 8) : ''), event: prev ? prev.event : '', in_reply_to: prev ? { id: prev.id, at: prev.at, type: prev.type, template: prev.template } : null };
  }).sort((a, b) => b.ts - a.ts);
  return { items, inbound };
}

/* tab + cursor (ts, exclusive) + limit → one page */
export function pageMessages({ items, inbound }, { tab = 'all', cursor = 0, limit = 100 } = {}) {
  const rows = tab === 'replies' ? inbound : tab === 'failed' ? items.filter(x => x.status === 'failed') : items;
  const after = cursor ? rows.filter(x => x.ts < cursor) : rows;
  const page = after.slice(0, limit);
  return { items: page, next_cursor: after.length > limit ? page[page.length - 1].ts : null,
    counts: { all: items.length, failed: items.filter(x => x.status === 'failed').length, replies: inbound.length, read: items.filter(x => x.status === 'read').length, delivered: items.filter(x => x.status === 'delivered').length } };
}

/* conversation list → ops view: role badge, event, unread (last message is theirs, nobody answered),
   24 h window, takeover state; unread first, then newest */
export function inboxView(convs, { leads = new Set(), humans = new Set(), aioff = new Set(), dir = { phones: {}, events: {} }, now = Date.now() } = {}) {
  return (convs || []).map(c => {
    const p = normP(c.phone); const who = dir.phones[p] || null;
    const role = who && who.role === 'client' ? 'client' : leads.has(p) ? 'lead' : who && who.role === 'guest' ? 'guest' : (c.ch || []).includes('guests') ? 'guest' : 'unknown';
    const ev = who && who.token ? dir.events[who.token] : null;
    const lastIn = Number(c.last_in_ts) || (c.last_dir === 'in' ? Number(c.last_ts) || 0 : 0);
    return { phone: p, name: (who && who.name) || c.name || c.wa_name || '', wa_name: c.wa_name || '', role, ch: c.ch || [], numbers: (c.ch || []).map(x => (x === 'guests' ? 'שיר' : 'נועה')),
      token8: ev ? ev.tok8 : '', token: role === 'client' && ev ? ev.token : '', event: ev ? ev.name : '', event_date: ev ? ev.date : '',
      last_ts: Number(c.last_ts) || 0, last_dir: c.last_dir || '', last_text: String(c.last_text || '').slice(0, 160), msgs: c.msgs || 0,
      unread: c.last_dir === 'in', window_open: !!lastIn && now - lastIn < WINDOW_MS, last_in_ts: lastIn,
      human: humans.has(p), ai_off: aioff.has(p), nonrelevant: !!c.nonrelevant };
  }).sort((a, b) => (b.unread - a.unread) || (b.last_ts - a.last_ts));
}

/* one thread (inbox log rows) → bubbles + the 24 h window */
export function threadView(t, { now = Date.now(), dir = { phones: {}, events: {} }, lead = false } = {}) {
  const msgs = (t.messages || []).map(m => ({ id: m.id || '', ts: Number(m.ts) || 0, at: new Date(Number(m.ts) || 0).toISOString(), dir: m.dir === 'out' ? 'out' : 'in', type: m.type || 'text',
    text: String(m.text || '').slice(0, 4000), tmpl: m.tmpl || '', status: m.dir === 'out' ? (m.ok === false ? 'failed' : (m.status || (m.id ? 'sent' : ''))) : '', error: m.error || '',
    ch: m.ch || '', who: m.who || '', media: m.media ? { id: m.media.id || '', url: m.media.url || '', kind: m.media.kind || '', name: m.media.name || '', mime: m.media.mime || '' } : null,
    buttons: Array.isArray(m.buttons) ? m.buttons.slice(0, 6).map(b => ({ text: String(b.text || ''), type: b.type || '', url: b.url || '' })) : [] })).sort((a, b) => a.ts - b.ts);
  const lastIn = msgs.filter(m => m.dir === 'in').reduce((x, m) => Math.max(x, m.ts), 0);
  const lastCh = [...msgs].reverse().find(m => m.ch);
  const p = normP(t.phone); const who = dir.phones[p] || null; const ev = who && who.token ? dir.events[who.token] : null;
  const role = who && who.role === 'client' ? 'client' : lead ? 'lead' : who && who.role === 'guest' ? 'guest' : 'unknown';
  return { phone: p, name: (who && who.name) || t.wa_name || '', wa_name: t.wa_name || '', role, token8: ev ? ev.tok8 : '', token: role === 'client' && ev ? ev.token : '', event: ev ? ev.name : '',
    channel: lastCh ? (lastCh.ch === 'guests' ? 'guests' : 'client') : (role === 'guest' ? 'guests' : 'client'),
    window: { open: !!lastIn && now - lastIn < WINDOW_MS, last_in_at: lastIn ? new Date(lastIn).toISOString() : null, closes_at: lastIn ? new Date(lastIn + WINDOW_MS).toISOString() : null },
    takeover: { human: !!t.human, ai: !t.ai_off_perm, ai_off: !!t.ai_off }, nonrelevant: !!t.nonrelevant, messages: msgs,
    templates: INBOX_TEMPLATES };
}

/* ══ §2 builders ═══════════════════════════════════════════════════════════ */
async function names(env, prefix, cap = 5000) {
  const out = new Set(); if (!env.RATE || !env.RATE.list) return out; let cursor;
  for (let i = 0; i < 6 && out.size < cap; i++) {
    const p = await env.RATE.list({ prefix, cursor, limit: 1000 }).catch(() => null); if (!p) break;
    for (const k of p.keys || []) out.add(k.name.slice(prefix.length));
    if (p.list_complete) break; cursor = p.cursor;
  }
  return out;
}
const dirOf = async (env, d) => directory(await d.snapshotCached(env).catch(() => null));
function numberMap(env, d) {
  const m = {}; d.guestPhoneIds(env).forEach((id, i) => { m[String(id)] = { label: `שיר #${i + 1}`, role: 'guests' }; });
  const c = d.clientPhoneId(env); if (c) m[String(c)] = { label: 'נועה', role: 'client' };
  return m;
}

export async function buildMessages(env, d, q = {}, now = Date.now()) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(q.day || '')) ? String(q.day) : ilDayOf(now);
  const ymd = day.replace(/-/g, ''), next = addDays(day, 1).replace(/-/g, '');
  const tab = ['all', 'failed', 'replies'].includes(q.tab) ? q.tab : 'all';
  const limit = Math.max(1, Math.min(200, Number(q.limit) || 100));
  const [outQ, stQ, inQ, dir, subs] = await Promise.all([
    d.auditQueryEx(env, { from: ymd, to: ymd, kind: 'wa_out', limit: 20000 }),
    d.auditQueryEx(env, { from: ymd, to: next, kind: 'wa_status', limit: 20000 }),
    d.auditQueryEx(env, { from: ymd, to: next, kind: 'wa_in', limit: 5000 }),
    dirOf(env, d), d.kvPrefix(env, 'subevent:').catch(() => ({}))]);
  const subTemplates = new Set(Object.values(subs).map(v => { try { return JSON.parse(v).template; } catch { return ''; } }).filter(Boolean));
  const g = groupMessages(outQ.items || [], stQ.items || [], (inQ.items || []), { numbers: numberMap(env, d), clientIds: [d.clientPhoneId(env)].filter(Boolean), subTemplates, dir });
  if (tab === 'replies') g.inbound = g.inbound.filter(x => ilDayOf(x.ts) === day);
  return { ok: true, day, tab, ...pageMessages(g, { tab, cursor: Number(q.cursor) || 0, limit }), statuses: STATUS_HE, types: TYPE_HE,
    truncated: !!(outQ.truncated || stQ.truncated || inQ.truncated) };
}

export async function buildInbox(env, d, q = {}, now = Date.now()) {
  const channel = ['client', 'guests'].includes(q.channel) ? q.channel : '';
  const [list, dir, leads, humans, aioff] = await Promise.all([d.inboxData(env, { channel }), dirOf(env, d), names(env, 'lead:'), names(env, 'human:'), names(env, 'aioff:')]);
  const items = inboxView(list.conversations || [], { leads, humans, aioff, dir, now });
  const limit = Math.max(1, Math.min(400, Number(q.limit) || 200));
  return { ok: true, channel, items: items.slice(0, limit), total: list.total || items.length, counts: { ...(list.counts || {}), unread: items.filter(x => x.unread).length } };
}

export async function buildThread(env, d, q = {}, now = Date.now()) {
  const phone = d.normPhone(q.phone || '');
  if (!phone) return { status: 400, body: { ok: false, error: 'bad-phone' } };
  const [t, dir, lead] = await Promise.all([d.inboxData(env, { phone }), dirOf(env, d), env.RATE ? env.RATE.get('lead:' + phone).catch(() => null) : null]);
  return { status: 200, body: { ok: true, ...threadView(t, { now, dir, lead: !!lead }) } };
}

/* manual-control state: global pause, Noa AI, pacer heartbeat, events (with hold/cancel) for the picker */
export async function buildControl(env, d, now = Date.now()) {
  const today = ilDayOf(now);
  const [paused, brain, noaOff, pacerLast, raw, holds] = await Promise.all([d.sendingPaused(env).catch(() => null), d.getBrain(env).catch(() => null), env.RATE ? env.RATE.get('noa:off').catch(() => null) : null,
    env.RATE ? env.RATE.get('pacer:last').then(v => JSON.parse(v || 'null')).catch(() => null) : null, d.snapshotCached(env).catch(() => null), names(env, 'hold:')]);
  const dir = directory(raw);
  const gCount = {}; for (const g of (raw && raw.guests && raw.guests.values) || []) { const t = String(g[28] || '').trim(); if (t) { const c = gCount[t] = gCount[t] || { guests: 0, pending: 0 }; c.guests++; if (!String(g[15] || '').trim()) c.pending++; } }
  const from = addDays(today, -3);
  const events = Object.values(dir.events).filter(e => e.active && (!e.date || e.date >= from)).map(e => ({ token: e.token, tok8: e.tok8, name: e.name, client: e.client, date: e.date, occasion: e.occasion,
    hold: holds.has(e.token), cancel: e.cancel, guests: (gCount[e.token] || {}).guests || 0, pending: (gCount[e.token] || {}).pending || 0 })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { ok: true, at: new Date(now).toISOString(), today, paused: paused == null ? null : !!paused, brain_active: noaOff ? false : brain ? !!brain.active : null,
    pacer: { last_tick_at: pacerLast ? pacerLast.at : null }, events, event_flags: d.EVENT_FLAGS || ['extrasend', 'hold', 'cancel', 'postponeok'] };
}
