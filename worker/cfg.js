/* ============================================================================
   ishur.io · cfg.js · edit-in-place settings (03/11/2026, ops center Phase 2)
   ----------------------------------------------------------------------------
   A short whitelist of settings the ops center may change without a deploy.
   Stored in KV cfg:<key> = {value, at, by, reason, prev}; history in
   cfg:hist:<key> (last 20). The code reads them through withCfg(env), which
   returns an env copy with the overrides applied, so every reader keeps its
   defaults when nothing is stored (and when KV fails: fail to the defaults).

   Rules baked in here, not in the UI:
     · send_window can only NARROW the guest window (09:00–20:30, Fri 13:00).
     · pacer_batch_size ≤ 25 (the per-tick number the window math assumes).
     · noa_chase stays "off" unless the request carries Richard's own typed
       confirm "noa_chase:on:richard" — no other confirm turns it on.
     · event_hold writes the existing hold:<token> key (the per-event freeze the
       engine, waves, calls and event-day blast already honour).
   ========================================================================== */
import { setSendWindow } from './shir.js';

export const CFG_PREFIX = 'cfg:';
export const NOA_CHASE_ON_CONFIRM = 'noa_chase:on:richard';
const HM = /^(\d{1,2}):(\d{2})$/;
const toMin = s => { const m = HM.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const intIn = (lo, hi) => v => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? { ok: true, value: n } : { ok: false, why: `int ${lo}..${hi}` }; };

export const SETTINGS = {
  send_window: {
    he: 'חלון שליחה לאורחים (שעון ישראל)', node: 'd_pacer', type: 'window',
    default: { start: '09:00', end: '20:30', fri_end: '13:00' },
    fields: { start: { he: 'פתיחה', lo: '09:00', hi: '12:00' }, end: { he: 'סגירה', lo: '13:00', hi: '20:30' }, fri_end: { he: 'סגירה בשישי', lo: '10:00', hi: '13:00' } },
  },
  guest_budget_margin: { he: 'מרווח ביטחון בתקרה היומית', node: 'd_pacer', type: 'int', default: 20, validate: intIn(0, 100), env: 'GUEST_BUDGET_MARGIN' },
  pacer_batch_size: { he: 'הודעות לפעימה (כל 10 דקות)', node: 'd_pacer', type: 'int', default: 25, validate: intIn(1, 25) },
  daily_call_cap: { he: 'תקרת חיוגים יומית (0 = בלי תקרה)', node: 'shir_dispatch', type: 'int', default: 0, validate: intIn(0, 2000) },
  noa_chase: { he: 'נועה רודפת לידים', node: 'noa_chase', type: 'onoff', default: 'off', env: 'NOA_CHASE' },
  event_hold: { he: 'עצירת אירוע (hold)', node: 'd_engine', type: 'bool', per: 'token' },
};

/* pure: validate one edit → { ok, value (the full new stored value), before } | { ok:false, why } */
export function validateEdit(id, field, value, current) {
  const s = SETTINGS[id];
  if (!s) return { ok: false, why: 'unknown-setting', settings: Object.keys(SETTINGS) };
  if (s.type === 'window') {
    const f = s.fields[field];
    if (!f) return { ok: false, why: 'unknown-field', fields: Object.keys(s.fields) };
    const v = String(value || '').trim(); const m = toMin(v);
    if (!HM.test(v) || !(m >= toMin(f.lo) && m <= toMin(f.hi))) return { ok: false, why: `${field} must be HH:MM between ${f.lo} and ${f.hi}` };
    const next = { ...s.default, ...(current || {}), [field]: v.padStart(5, '0') };
    if (toMin(next.start) >= toMin(next.end) || toMin(next.start) >= toMin(next.fri_end)) return { ok: false, why: 'start must be before end and fri_end' };
    return { ok: true, value: next };
  }
  if (s.type === 'int') { const r = s.validate(value); return r.ok ? { ok: true, value: r.value } : { ok: false, why: `${id}: ${r.why}` }; }
  if (s.type === 'onoff') { const v = value === true || value === 'on' ? 'on' : value === false || value === 'off' ? 'off' : null; return v ? { ok: true, value: v } : { ok: false, why: 'on|off' }; }
  if (s.type === 'bool') {
    if (!/^[0-9a-f-]{36}$/.test(String(field || ''))) return { ok: false, why: 'field must be the event token' };
    const v = value === true || value === 'on' || value === 'true' ? true : value === false || value === 'off' || value === 'false' ? false : null;
    return v === null ? { ok: false, why: 'true|false' } : { ok: true, value: v };
  }
  return { ok: false, why: 'unsupported' };
}
/* the confirm word a change needs (typed in the UI) */
export function confirmWord(id, value) { return id === 'noa_chase' && value === 'on' ? NOA_CHASE_ON_CONFIRM : id; }

/* ── read ────────────────────────────────────────────────────────────────── */
const memo = new WeakMap();   /* RATE binding → { at, vals } — one read per minute per isolate */
export async function loadCfg(env, { fresh = false, now = Date.now() } = {}) {
  if (!env || !env.RATE) return {};
  const m = memo.get(env.RATE);
  if (!fresh && m && now - m.at < 60e3) return m.vals;
  const keys = Object.keys(SETTINGS).filter(k => !SETTINGS[k].per);
  const vals = {};
  try {
    const got = await Promise.all(keys.map(k => env.RATE.get(CFG_PREFIX + k).catch(() => null)));
    keys.forEach((k, i) => { try { const r = got[i] ? JSON.parse(got[i]) : null; if (r && r.value !== undefined) vals[k] = r.value; } catch {} });
  } catch {}
  memo.set(env.RATE, { at: now, vals });
  return vals;
}
export function clearCfgMemo(env) { if (env && env.RATE) memo.delete(env.RATE); }
export function effective(vals = {}) {
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS)) if (!s.per) out[k] = vals[k] !== undefined ? vals[k] : s.default;
  return out;
}
/* env copy with the overrides applied (and the send window set for this isolate) */
export async function withCfg(env, opts = {}) {
  if (!env || !env.RATE) return env;
  let vals = {};
  try { vals = await loadCfg(env, opts); } catch { return env; }
  setSendWindow(vals.send_window || null);
  if (!Object.keys(vals).length) return env;
  const out = { ...env, __cfg: vals };
  if (vals.guest_budget_margin !== undefined) out.GUEST_BUDGET_MARGIN = String(vals.guest_budget_margin);
  if (vals.noa_chase !== undefined) out.NOA_CHASE = vals.noa_chase === 'on' ? 'on' : 'off';
  return out;
}
export const paceSends = (env, dflt = 25) => { const v = env && env.__cfg && env.__cfg.pacer_batch_size; return Number.isInteger(v) ? Math.max(1, Math.min(dflt, v)) : dflt; };
export const dailyCallCap = env => { const v = env && env.__cfg && env.__cfg.daily_call_cap; return Number.isInteger(v) && v > 0 ? v : 0; };

/* ── write ───────────────────────────────────────────────────────────────── */
export async function writeSetting(env, id, field, value, { who = 'admin', reason = '', now = Date.now() } = {}) {
  const s = SETTINGS[id];
  if (s.per === 'token') {
    const k = 'hold:' + field;
    const before = !!(await env.RATE.get(k));
    if (value) await env.RATE.put(k, new Date(now).toISOString(), { expirationTtl: 200 * 86400 }); else await env.RATE.delete(k);
    return { before, after: value };
  }
  let prev = null; try { prev = JSON.parse((await env.RATE.get(CFG_PREFIX + id)) || 'null'); } catch {}
  const rec = { value, at: new Date(now).toISOString(), by: String(who).slice(0, 40), reason: String(reason).slice(0, 300), prev: prev ? prev.value : null };
  await env.RATE.put(CFG_PREFIX + id, JSON.stringify(rec));
  let hist = []; try { hist = JSON.parse((await env.RATE.get(CFG_PREFIX + 'hist:' + id)) || '[]'); } catch {}
  hist = [...(Array.isArray(hist) ? hist : []), rec].slice(-20);
  await env.RATE.put(CFG_PREFIX + 'hist:' + id, JSON.stringify(hist)).catch(() => {});
  clearCfgMemo(env);
  return { before: prev ? prev.value : s.default, after: value };
}

/* registry "editable" rows for a node (drawer עריכה) */
export function editableFor(nodeId, vals = {}) {
  const eff = effective(vals); const rows = [];
  for (const [id, s] of Object.entries(SETTINGS)) {
    if (s.node !== nodeId || s.per) continue;
    if (s.type === 'window') for (const [f, fd] of Object.entries(s.fields)) rows.push({ setting: id, field: f, label_he: s.he + ' · ' + fd.he, value: eff[id][f], type: 'time', min: fd.lo, max: fd.hi });
    else rows.push({ setting: id, field: '', label_he: s.he, value: eff[id], type: s.type, confirm: s.type === 'onoff' ? NOA_CHASE_ON_CONFIRM : id });
  }
  return rows.length ? rows : null;
}
