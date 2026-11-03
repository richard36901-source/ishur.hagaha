/* ══ המוקד · floor.js (02/11, noa-chase R9) ══════════════════════════════════
   One screen, three columns — נועה · שיר · המוח — refreshed every 3 s by
   floor.html through POST /api/floor. Everything here is read-mostly:

     · state per agent        idle | in_call | queued
     · the live transcript    livecall:<agent> (written by noteLiveCall from
                              the Retell webhook) + GET /v2/get-call/<id>,
                              fetched at most every 3 s and cached in KV
     · the last 10 calls      Retell list-calls, joined with the audit stream
                              (kind:'call' → recording link; kind:'qa' →
                              the reviewer's verdict, if the other agent wrote one)
     · lessons                <agent>-memory in KV, last 10 (read-only here)
     · the brain column       memory sizes, pending lessons, prompt heads

   POST /api/floor-note appends a line to <agent>-memory (Richard / שלו only —
   admin key, R9) or deletes one, through noa.js' addMemory/removeMemory so
   the shape {text, at, source, by} and the 40-line cap have one owner. A
   floor note skips the model gate (trusted) EXCEPT for the iron rules: a
   banned word (הנחה, חינם, ללא הגבלה…) or an unknown price is refused with a
   Hebrew reason. setFloorHooks() can still override both writers.

   Never writes to Retell. Never places a call. No PII in lessons: phone
   numbers and e-mails are scrubbed before a note is stored.
   ═══════════════════════════════════════════════════════════════════════════ */

import { isAdmin, okJson, deny, isTestPhone } from './lib.js';
import { stream } from './evlog.js';
import * as audit from './audit.js';
import { addMemory as noaAddMemory, removeMemory as noaRemoveMemory, memoryGuard } from './noa.js';

/* ── knobs ──────────────────────────────────────────────────────────────── */
const AGENTS = ['noa', 'shir'];
const MEMORY_KEY = a => `${a}-memory`;          /* KV: JSON array, newest last */
const MEMORY_MAX = 40;                          /* R8: 40 lines, oldest out */
const LIVE_KEY = a => `livecall:${a}`;          /* set by noteLiveCall */
const LIVE_TTL_S = 3600;                        /* a call never runs an hour */
const LIVE_STALE_MS = 45 * 60e3;                /* marker without call_ended → ignore */
const TX_CACHE_KEY = id => `livetx:${id}`;      /* get-call snapshot */
const TX_MIN_GAP_MS = 3000;                     /* R9: poll Retell ≤ every 3 s */
const LIST_CACHE_KEY = 'floor:list';            /* list-calls snapshot */
const LIST_MIN_GAP_MS = 3000;
const TAIL_LINES = 12;
const LAST_N = 10;

/* ── hooks the other agent may register (noa.js owns the memory rules) ──── */
let hooks = {};
export function setFloorHooks(h) { hooks = { ...hooks, ...(h || {}) }; return hooks; }

/* ── who is this call? ──────────────────────────────────────────────────── */
export function floorAgentOf(call, env) {
  const c = call || {};
  const meta = c.metadata || {};
  if (meta.kind === 'dial') return meta.who === 'richard' ? 'richard' : 'shalev';
  if (meta.line === 'noa' || meta.kind === 'lead') return 'noa';
  const inbound = String(c.direction || c.call_type || '').includes('inbound') || meta.kind === 'inbound';
  const ourLine = inbound ? String(c.to_number || '') : String(c.from_number || '');
  const noaFrom = (env && env.NOA_FROM) || '+972555077733';
  if (ourLine && ourLine === noaFrom) return 'noa';
  if (meta.kind === 'callback' && meta.noa) return 'noa';
  return 'shir';
}
const AGENT_HE = { noa: 'נועה', shir: 'שיר', shalev: 'שלו', richard: 'ריצארד', brain: 'המוח' };

/* ── the live marker: called from the Retell webhook (NOT here) ─────────────
   The other agent owns worker/index.js' webhook path; it must call
     await noteLiveCall(env, body.event, body.call)
   at the top of processRetellEvent for event ∈ call_started | call_ended |
   call_analyzed (and for the mid-call tool body, event is undefined → noop).
   Idempotent, never throws. */
export async function noteLiveCall(env, event, call) {
  try {
    if (!env || !env.RATE || !call || !call.call_id) return null;
    const agent = floorAgentOf(call, env);
    if (agent !== 'noa' && agent !== 'shir') return null;   /* rep dials are not a column */
    const key = LIVE_KEY(agent);
    if (event === 'call_started') {
      const dv = call.retell_llm_dynamic_variables || {};
      const meta = call.metadata || {};
      const inbound = String(call.direction || '').includes('inbound') || meta.kind === 'inbound';
      const other = String((inbound ? call.from_number : call.to_number) || '').replace('+', '');
      const rec = {
        call_id: String(call.call_id),
        with: String(dv.guest_name || dv.lead_name || dv.caller_name || dv.name || '').trim() || localPhone(other),
        phone: other,
        since: call.start_timestamp ? new Date(Number(call.start_timestamp)).toISOString() : new Date().toISOString(),
        kind: String(meta.kind || (inbound ? 'inbound' : 'guest')),
        event_name: String(dv.event_name || dv.host_name || '').trim(),
        state: 'in_call',
      };
      await env.RATE.put(key, JSON.stringify(rec), { expirationTtl: LIVE_TTL_S });
      return rec;
    }
    if (event === 'call_ended' || event === 'call_analyzed') {
      let cur = null; try { cur = JSON.parse(await env.RATE.get(key)); } catch {}
      if (cur && cur.call_id === String(call.call_id)) await env.RATE.delete(key);
      await env.RATE.delete(TX_CACHE_KEY(String(call.call_id))).catch(() => {});
      return { cleared: true };
    }
    return null;
  } catch { return null; }
}
function localPhone(p) { const s = String(p || '').replace('+', ''); return s.startsWith('972') ? '0' + s.slice(3) : s; }

/* ── Retell reads (GET only) ────────────────────────────────────────────── */
async function retellGet(env, path) {
  if (!env.RETELL_KEY) return null;
  const r = await fetch('https://api.retellai.com' + path, { headers: { Authorization: 'Bearer ' + env.RETELL_KEY } }).catch(() => null);
  if (!r || !r.ok) return null;
  return r.json().catch(() => null);
}
async function retellList(env, limit) {
  if (!env.RETELL_KEY) return [];
  const r = await fetch('https://api.retellai.com/v3/list-calls', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RETELL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sort_order: 'descending', limit }),
  }).catch(() => null);
  if (!r || !r.ok) return [];
  const j = await r.json().catch(() => null);
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.items)) return j.items;
  if (j && Array.isArray(j.calls)) return j.calls;
  return [];
}
/* KV's minimum TTL is 60 s, so the 3-second rule lives in the value: a
   snapshot younger than TX_MIN_GAP_MS is served as-is. */
async function cachedJson(env, key, minGapMs, fetcher) {
  let cur = null;
  try { cur = JSON.parse(await env.RATE.get(key)); } catch {}
  if (cur && cur.fetched_at && Date.now() - cur.fetched_at < minGapMs) return cur.value;
  const value = await fetcher();
  if (value == null) return cur ? cur.value : null;
  await env.RATE.put(key, JSON.stringify({ fetched_at: Date.now(), value }), { expirationTtl: 120 }).catch(() => {});
  return value;
}

/* ── transcript shaping ─────────────────────────────────────────────────── */
export function transcriptTail(call, n = TAIL_LINES) {
  const twc = Array.isArray(call && call.transcript_with_tool_calls) ? call.transcript_with_tool_calls
    : Array.isArray(call && call.transcript_object) ? call.transcript_object : [];
  const lines = [];
  const tools = [];
  for (const u of twc) {
    if (!u) continue;
    if (u.role === 'tool_call_invocation') {
      let args = u.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch {} }
      tools.push({ name: String(u.name || ''), args: args && typeof args === 'object' ? args : {}, at: u.time_offset != null ? Number(u.time_offset) : null });
      continue;
    }
    if (u.role === 'tool_call_result') continue;
    if (u.role === 'agent' || u.role === 'user') lines.push({ role: u.role, text: String(u.content || '').trim() });
  }
  if (!lines.length && call && typeof call.transcript === 'string' && call.transcript.trim()) {
    for (const ln of call.transcript.split('\n')) {
      const m = /^(Agent|User):\s*(.*)$/i.exec(ln.trim());
      if (m) lines.push({ role: m[1].toLowerCase(), text: m[2] });
    }
  }
  return { tail: lines.slice(-n), tools };
}

/* ── one agent's live block ─────────────────────────────────────────────── */
async function liveFor(env, agent, listed) {
  let marker = null;
  try { marker = JSON.parse(await env.RATE.get(LIVE_KEY(agent))); } catch {}
  if (marker && marker.since && Date.now() - Date.parse(marker.since) > LIVE_STALE_MS) marker = null;
  /* the list is the fallback when the webhook never said call_started */
  const running = (listed || []).find(x => x.agent === agent && x.live);
  const callId = (marker && marker.call_id) || (running && running.id) || '';
  if (!callId) return { state: 'idle', current_call: null };
  const call = await cachedJson(env, TX_CACHE_KEY(callId), TX_MIN_GAP_MS, () => retellGet(env, '/v2/get-call/' + encodeURIComponent(callId)));
  const st = String((call && call.call_status) || '');
  if (call && st && st !== 'ongoing' && st !== 'registered') {
    /* ended but the marker survived: clean up quietly */
    if (marker) await env.RATE.delete(LIVE_KEY(agent)).catch(() => {});
    return { state: 'idle', current_call: null };
  }
  const { tail, tools } = transcriptTail(call || {});
  const dv = (call && call.retell_llm_dynamic_variables) || {};
  return {
    state: 'in_call',
    current_call: {
      call_id: callId,
      with: (marker && marker.with) || String(dv.guest_name || dv.lead_name || dv.caller_name || '').trim() || (running && running.name) || '',
      since: (marker && marker.since) || (call && call.start_timestamp ? new Date(Number(call.start_timestamp)).toISOString() : null),
      event_name: (marker && marker.event_name) || String(dv.event_name || dv.host_name || ''),
      kind: (marker && marker.kind) || String(((call || {}).metadata || {}).kind || ''),
      transcript_tail: tail,
      tools_fired: tools,
    },
  };
}

/* ── last calls, per agent, joined with the audit stream ────────────────── */
function shapeListed(env, calls) {
  const out = [];
  for (const cl of calls || []) {
    if (!cl || !cl.call_id) continue;
    const meta = cl.metadata || {};
    const inbound = String(cl.direction || cl.call_type || '').includes('inbound');
    const other = String((inbound ? cl.from_number : cl.to_number) || '');
    if (other && isTestPhone(env, other)) continue;
    const st = String(cl.call_status || '');
    const live = st === 'ongoing' || st === 'registered';
    const cad = (cl.call_analysis || {}).custom_analysis_data || {};
    const dv = cl.retell_llm_dynamic_variables || {};
    const dur = cl.start_timestamp && cl.end_timestamp ? Math.round((cl.end_timestamp - cl.start_timestamp) / 1000) : null;
    const reason = String(cl.disconnection_reason || '');
    const noans = /dial_no_answer|dial_busy|voicemail/.test(reason);
    out.push({
      id: cl.call_id,
      agent: floorAgentOf(cl, env),
      at: cl.start_timestamp || null,
      name: String(dv.guest_name || dv.lead_name || dv.caller_name || meta.lead_name || '').trim(),
      phone: localPhone(other),
      event: String(dv.event_name || dv.host_name || meta.occasion || '').trim(),
      kind: inbound ? 'inbound' : String(meta.kind || 'guest'),
      live,
      duration_s: dur,
      outcome: String(cad.outcome || '') || (live ? '' : noans ? 'לא ענה' : (dur != null && dur <= 9 ? 'ניתוק בפתיח' : '')),
      reason,
      recording: '',
      verdict: '',
      verdict_note: '',
    });
  }
  return out;
}
async function joinAudit(env, rows) {
  if (!env.RATE || !rows.length) return rows;
  const byId = new Map(rows.map(r => [r.id, r]));
  const items = await audit.query(env, { days: 4, limit: 1500 }).catch(() => []);
  for (const it of items) {
    const d = it && it.data;
    if (!d || !d.call_id || !byId.has(d.call_id)) continue;
    const r = byId.get(d.call_id);
    if (it.kind === 'call') {
      if (d.recording && !r.recording) r.recording = d.recording;
      if (!r.outcome && (d.answer || d.outcome)) r.outcome = String(d.answer || d.outcome);
      if (!r.name && d.guest_name) r.name = d.guest_name;
      if (!r.event && d.event_name) r.event = d.event_name;
    } else if (it.kind === 'qa' || d.verdict) {
      /* the reviewer (callqa.js) writes kind:'qa' with data.{call_id, verdict,
         suggested_outcome, note}. Any shape with data.verdict is accepted. */
      if (!r.verdict) { r.verdict = String(d.verdict || ''); r.verdict_note = String(d.note || d.suggested_outcome || '').slice(0, 160); }
    }
  }
  return rows;
}

/* ── memory (read) ──────────────────────────────────────────────────────── */
export function parseMemory(raw) {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j.map(x => typeof x === 'string' ? { text: x, at: '', source: '', by: '' } : (x && typeof x === 'object' ? { text: String(x.text || ''), at: String(x.at || ''), source: String(x.source || ''), by: String(x.by || '') } : null)).filter(x => x && x.text);
    if (j && Array.isArray(j.lines)) return parseMemory(JSON.stringify(j.lines));
  } catch {}
  /* plain text, one lesson per line */
  return String(raw).split('\n').map(s => s.trim()).filter(Boolean).map(text => ({ text, at: '', source: '', by: '' }));
}
async function readMemory(env, agent) {
  if (!env.RATE) return [];
  return parseMemory(await env.RATE.get(MEMORY_KEY(agent)).catch(() => null));
}
async function readJson(env, key, dflt) {
  try { const v = JSON.parse(await env.RATE.get(key)); return v == null ? dflt : v; } catch { return dflt; }
}

/* ── queue sizes ────────────────────────────────────────────────────────── */
async function countPrefix(env, prefix) {
  if (!env.RATE) return 0;
  let n = 0, cursor;
  for (let i = 0; i < 5; i++) {
    const page = await env.RATE.list({ prefix, cursor, limit: 1000 }).catch(() => null);
    if (!page) break;
    n += page.keys.length;
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return n;
}

/* ── POST /api/floor ────────────────────────────────────────────────────── */
export async function floorState(env) {
  const listedRaw = await cachedJson(env, LIST_CACHE_KEY, LIST_MIN_GAP_MS, () => retellList(env, 80)) || [];
  const listed = await joinAudit(env, shapeListed(env, listedRaw));
  const [noaLive, shirLive, noaMem, shirMem, nq, lq, shirQ] = await Promise.all([
    liveFor(env, 'noa', listed), liveFor(env, 'shir', listed),
    readMemory(env, 'noa'), readMemory(env, 'shir'),
    countPrefix(env, 'nq:'), countPrefix(env, 'lq:'), readJson(env, 'calls:queue-n', 0),
  ]);
  const lastOf = a => listed.filter(x => x.agent === a && !x.live).slice(0, LAST_N);
  const column = (a, live, mem, queue_n) => ({
    name: AGENT_HE[a],
    state: live.state === 'in_call' ? 'in_call' : (queue_n > 0 ? 'queued' : 'idle'),
    current_call: live.current_call,
    queue_n,
    last_calls: lastOf(a),
    lessons: mem.slice(-LAST_N).reverse(),
    memory_n: mem.length,
  });
  /* the brain: what it knows and what waits for Richard */
  const [vpNoa, vpShir, pending, suggestNoa, suggestShir] = await Promise.all([
    readJson(env, 'vpmeta:noa_out', { head: 0, list: [] }), readJson(env, 'vpmeta:shir_out', { head: 0, list: [] }),
    readJson(env, 'brain:pending', []),                 /* callqa.js: lessons awaiting approval */
    readJson(env, 'vpsuggest:noa_out', null), readJson(env, 'vpsuggest:shir_out', null),   /* R8 weekly prompt proposal */
  ]);
  const headOf = m => ({ head: Number(m.head || 0), at: (m.list && m.list.length ? m.list[m.list.length - 1].at : '') || '', note: (m.list && m.list.length ? m.list[m.list.length - 1].note : '') || '' });
  return {
    ok: true,
    now: Date.now(),
    agents: {
      noa: column('noa', noaLive, noaMem, nq + lq),
      shir: column('shir', shirLive, shirMem, Number(shirQ) || 0),
      brain: {
        name: AGENT_HE.brain,
        memory: { noa: noaMem.length, shir: shirMem.length, max: MEMORY_MAX },
        pending: Array.isArray(pending) ? pending.slice(-LAST_N).reverse() : [],
        pending_n: Array.isArray(pending) ? pending.length : 0,
        prompts: { noa_out: headOf(vpNoa), shir_out: headOf(vpShir) },
        suggestions: { noa_out: suggestNoa, shir_out: suggestShir },
      },
    },
    /* rep dials (R7) are listed, not a column */
    reps: listed.filter(x => x.agent === 'shalev' || x.agent === 'richard').slice(0, LAST_N),
  };
}
export async function handleFloor(request, env, origin) {
  let b = {};
  try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, b.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(503, 'not-configured', origin);
  return okJson(await floorState(env), origin);
}

/* ── POST /api/floor-note ───────────────────────────────────────────────── */
export function scrubPii(text) {
  return String(text || '')
    .replace(/(\+?972|0)5\d[\s-]?\d{3}[\s-]?\d{4}/g, '[טלפון]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[מספר]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[מייל]')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}
async function kvDeleteMemory(env, agent, match) {
  const list = await readMemory(env, agent);
  const kept = list.filter(x => !((match.at && x.at === match.at) || (!match.at && x.text === match.text)));
  await env.RATE.put(MEMORY_KEY(agent), JSON.stringify(kept));
  return list.length - kept.length;
}
export async function handleFloorNote(request, env, origin) {
  let b = {};
  try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, b.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(503, 'not-configured', origin);
  const agent = String(b.agent || '');
  if (!AGENTS.includes(agent)) return deny(400, 'unknown-agent', origin);
  const by = String(b.by || '').trim().slice(0, 24) || 'מוקד';
  const action = String(b.action || 'add');

  if (action === 'delete') {
    const match = { at: String(b.at || ''), text: scrubPii(b.text) };
    if (!match.at && !match.text) return deny(400, 'nothing-to-delete', origin);
    const removed = hooks.deleteMemory ? await hooks.deleteMemory(env, agent, match) : (match.text ? (await noaRemoveMemory(env, agent, match.text)).removed : await kvDeleteMemory(env, agent, match));
    stream(env, { kind: 'event', area: 'מוקד', action: `🧠 לקח נמחק מהזיכרון של ${AGENT_HE[agent]}`, ok: true, detail: `${by} · ${match.text || match.at}`, data: { agent, by, at: match.at } }).catch(() => {});
    return okJson({ ok: true, removed: Number(removed) || 0 }, origin);
  }

  const text = scrubPii(b.text);
  if (!text) return deny(400, 'empty-note', origin);
  const entry = { text, at: new Date().toISOString(), source: 'floor', by };
  /* iron rules still apply to a human note; everything else (length, names) is trusted */
  const g = memoryGuard(text);
  if (!g.ok && /^(banned|price):/.test(String(g.why))) return okJson({ ok: false, error: 'iron-rule', why: g.why, msg: /^banned:/.test(g.why) ? 'לא נשמר · המילה "' + g.why.slice(7) + '" אסורה בזיכרון' : 'לא נשמר · מחיר שלא במחירון' }, origin);
  let n;
  if (hooks.addMemory) n = await hooks.addMemory(env, agent, entry);
  else {
    const r = await noaAddMemory(env, agent, text, { source: 'floor', by, trusted: true });
    if (!r.added.length) return okJson({ ok: false, error: 'not-added', why: (r.rejected[0] || {}).why || '?', msg: (r.rejected[0] || {}).why === 'duplicate' ? 'כבר בזיכרון' : 'לא נשמר' }, origin);
    n = (await readMemory(env, agent)).length;
  }
  stream(env, { kind: 'event', area: 'מוקד', action: `🧠 הערה נכנסה לזיכרון של ${AGENT_HE[agent]}`, ok: true, detail: `${by}: ${text}`, data: { agent, by, text, at: entry.at } }).catch(() => {});
  return okJson({ ok: true, agent, entry, memory_n: Number(n) || undefined, msg: 'נשמר · ייכנס לשיחה הבאה' }, origin);
}
