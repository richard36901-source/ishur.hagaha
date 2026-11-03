/* ============================================================================
   ishur.io · brain.js · self-healing checks + playbooks (03/11/2026, Phase 2)
   ----------------------------------------------------------------------------
   docs/OPS-CENTER-PLAN-2026-11-03.md §3(d), docs/BRAIN-2026-11-03.md.

   runBrain(env, d, opts) — called by the every-10-minutes cron inside withRun('brain_health')
   and by POST /api/ops/brain-run. Pure code, no LLM:
     1. every due CHECK returns results {id, status: ok|warn|fail, title_he,
        detail, evidence[], playbook?, severity?, data?}; a throwing check
        becomes a warn finding "<check>:error" and resolves nothing.
     2. findings are upserted (KV brain:finding:<id> with history, index
        brain:index; D1 table `findings` when OPS_DB is bound); an open finding
        its check no longer reports is resolved.
     3. a NEW (or re-opened, or 6 h old) fail finding → one Slack alert.
     4. a finding with an `auto` playbook runs it (withRun 'brain_fix:<pb>',
        per-playbook cooldown); a non-auto playbook creates a pending action the
        UI approves (POST /api/ops/brain-decision); a finding no playbook handles
        is POSTed to BRAIN_AGENT_HOOK (6 h de-dup).
   Every step writes a line to the run's log (brain:log:<run_id>), which the
   Brain screen streams.

   Guardrails enforced HERE (not in a prompt):
     · a playbook with messages:true can never be auto (assertCatalog()).
     · messaging playbooks re-check paused / the send window / client
       messaging hours (09–21) at run time, even after approval.
     · Noa AI and NOA_CHASE are never touched by any playbook.
   d (deps from index.js opsDeps): see BRAIN_DEPS in docs/BRAIN-2026-11-03.md.
   ========================================================================== */
import { withRun, listRuns } from './ops-run.js';
import { recordChange, actorOf } from './changes.js';   /* 03/11 change log */
import { shouldDial } from './shir.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
export const GUEST_WABA = '1378764257421712';
export const P = { finding: 'brain:finding:', pending: 'brain:pending:', log: 'brain:log:', index: 'brain:index', runs: 'brain:runs', last: 'brain:last', tmpl: 'brain:tmpl', biz: 'brain:biz', monday: 'brain:monday' };
export const REALERT_MS = 6 * 3600e3;
const LOG_TTL = 7 * 86400, FINDING_TTL = 30 * 86400;
const MIN = 60e3, H = 3600e3;

/* ══ small helpers ═════════════════════════════════════════════════════════ */
export const ilDay = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
export function ilClock(ts) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  return { dow: g('weekday'), h: Number(g('hour')) % 24, m: Number(g('minute')) };
}
/* client/lead messaging hours (memory rule): no WhatsApp 21:00–09:00, none on Shabbat */
export function clientHoursOpen(ts) { const c = ilClock(ts); if (c.dow === 'Sat') return false; return c.h >= 9 && c.h < 21; }
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export const mask = p => { const s = String(p || ''); return s.length >= 9 ? s.slice(0, 5) + '****' + s.slice(-3) : s; };
const maskText = t => String(t || '').replace(/(?<!\d)(972\d{8,9}|0\d{8,9})(?!\d)/g, m => (/(6673|9799|4499)$/.test(m) ? m : mask(m)));
async function kget(env, k) { try { return env.RATE ? await env.RATE.get(k) : null; } catch { return null; } }
async function kjson(env, k) { try { return JSON.parse((await kget(env, k)) || 'null'); } catch { return null; } }
async function kput(env, k, v, ttl) { try { if (env.RATE) await env.RATE.put(k, typeof v === 'string' ? v : JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined); return true; } catch { return false; } }
async function kdel(env, k) { try { if (env.RATE) await env.RATE.delete(k); } catch {} }
async function getJson(url, headers) { const r = await fetch(url, { headers }).catch(() => null); const j = r ? await r.json().catch(() => null) : null; return { ok: !!(r && r.ok), status: r ? r.status : 0, j }; }
const hash = s => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };

/* ══ checks ════════════════════════════════════════════════════════════════ */
/* each: { id, name_he, every_min, run(c) → result[] }  (c = check context, see makeCtx) */
export const CHECKS = [
  { id: 'template_watch', name_he: 'תבניות: ממתינות מעל 24 שעות או נדחו', every_min: 60, async run(c) {
    const wabas = [{ name: 'guests', waba: GUEST_WABA, tok: c.env.WA_TOKEN_GUESTS }, { name: 'client', waba: c.d.clientWaba ? c.d.clientWaba(c.env) : '', tok: c.d.clientToken ? c.d.clientToken(c.env) : '' }].filter(w => w.tok && w.waba);
    if (!wabas.length) return [{ id: 'template_watch:no-token', status: 'warn', severity: 'P3', title_he: 'אין טוקן וואטסאפ: אי אפשר לבדוק תבניות', detail: 'WA_TOKEN_GUESTS / client token missing' }];
    const state = (await kjson(c.env, P.tmpl)) || { base: false, t: {} };
    const first = !state.base; let changed = first; const out = [];
    for (const w of wabas) {
      const r = await getJson(`${GRAPH}/${w.waba}/message_templates?fields=name,status,category,language,rejected_reason&limit=250`, { Authorization: 'Bearer ' + w.tok });
      if (!r.ok || !r.j || !Array.isArray(r.j.data)) { out.push({ id: `template_watch:read:${w.name}`, status: 'warn', severity: 'P3', title_he: `לא הצלחתי לקרוא תבניות (${w.name})`, detail: 'graph ' + r.status }); continue; }
      for (const t of r.j.data) {
        const key = `${w.waba}/${t.name}/${t.language || ''}`; const st = String(t.status || '').toUpperCase();
        const prev = state.t[key];
        if (!prev || prev.status !== st) {
          if (prev) { c.log(`תבנית ${t.name} (${w.name}): ${prev.status} → ${st}`);
            await recordChange(c.env, { kind: 'template', actor: 'brain', summary_he: `תבנית ${t.name} (${w.name === 'guests' ? 'אורחים' : 'לקוחות'}): ${prev.status} → ${st}`,
              details: { waba: w.waba, number: w.name, name: t.name, language: t.language || '', category: t.category || '', from: prev.status, to: st, rejected_reason: String(t.rejected_reason || '').slice(0, 300) } }, c.now); }
          if (prev && prev.status === 'PENDING' && st === 'APPROVED') c.note(`✅ תבנית ${t.name} אושרה במטא (${w.name})`);
          state.t[key] = { status: st, since: first && st === 'REJECTED' ? 0 : c.now, category: t.category || '' }; changed = true;
        }
        const s = state.t[key];
        if (st === 'PENDING' && c.now - s.since > 24 * H) out.push({ id: `template_watch:pending:${t.name}:${t.language || ''}`, status: 'warn', severity: 'P2', playbook: 'template_variant',
          title_he: `תבנית ${t.name} ממתינה לאישור ${Math.round((c.now - s.since) / H)} שעות`, detail: `${w.name} · ${t.category || ''}`, evidence: [`status=${st}`, `since=${new Date(s.since).toISOString()}`],
          data: { waba: w.waba, tok: w.name, name: t.name, language: t.language || 'he', category: t.category || '' } });
        if (st === 'REJECTED' && s.since && c.now - s.since < 7 * 86400e3) out.push({ id: `template_watch:rejected:${t.name}:${t.language || ''}`, status: 'fail', severity: 'P2',
          title_he: `תבנית ${t.name} נדחתה במטא`, detail: String(t.rejected_reason || '').slice(0, 200), evidence: [`${w.name}`, `rejected_reason=${t.rejected_reason || '—'}`] });
      }
    }
    state.base = true;
    if (changed) await kput(c.env, P.tmpl, state, 60 * 86400);
    return out;
  } },

  { id: 'cap_hold_stale', name_he: 'עצירת תקרה ישנה על מספר אורחים', every_min: 10, async run(c) {
    const ids = c.d.guestPhoneIds(c.env); const out = []; let anyHeld = false;
    for (const id of ids) {
      const held = await kget(c.env, 'wacap:' + id); if (!held) continue; anyHeld = true;
      const age = c.now - (Date.parse(held) || c.now); const until = Number(await kget(c.env, 'wacapuntil:' + id)) || 0;
      let can = '';
      if (c.env.WA_TOKEN_GUESTS) { const r = await getJson(`${GRAPH}/${id}?fields=health_status`, { Authorization: 'Bearer ' + c.env.WA_TOKEN_GUESTS }); can = String((r.j && r.j.health_status && r.j.health_status.can_send_message) || ''); }
      const stale = age >= 24 * H || (age >= 30 * MIN && until <= c.now && ['AVAILABLE', 'LIMITED'].includes(can));
      c.log(`מספר ${id}: מוחזק ${Math.round(age / MIN)} דק׳, backoff ${until > c.now ? 'פעיל' : 'נגמר'}, health=${can || '?'}`);
      if (stale) out.push({ id: 'cap_hold_stale:' + id, status: 'warn', severity: 'P2', playbook: 'cap_probe_release', title_he: `מספר ${id} מוחזק בתקרה ${Math.round(age / H * 10) / 10} שעות למרות שמטא פתוחה`,
        detail: `health_status.can_send_message=${can || 'unknown'}`, evidence: [`wacap:${id}=${held}`, `wacapuntil=${until ? new Date(until).toISOString() : '—'}`], data: { phone_id: id } });
    }
    const g = await kget(c.env, 'wacap:guests');
    if (g && !anyHeld && ids.length) out.push({ id: 'cap_hold_stale:guests', status: 'warn', severity: 'P1', playbook: 'cap_probe_release', title_he: 'עצירת תקרה גלובלית לאורחים בלי אף מספר מוחזק',
      detail: 'wacap:guests set while no wacap:<id> is', evidence: [`wacap:guests=${g}`], data: { phone_id: 'guests' } });
    return out;
  } },

  { id: 'pacer_tick', name_he: 'הפייסר לא רץ מעל 25 דקות', every_min: 10, async run(c) {
    const last = await kjson(c.env, 'pacer:last'); const at = last && Date.parse(last.at);
    const age = at ? c.now - at : Infinity;
    if (age <= 25 * MIN) return [];
    const paused = await c.d.sendingPaused(c.env).catch(() => false);
    return [{ id: 'pacer_tick', status: paused ? 'warn' : 'fail', severity: paused ? 'P3' : 'P1', title_he: at ? `הפייסר לא רץ ${Math.round(age / MIN)} דקות` : 'אין תיעוד לפעימת פייסר',
      detail: paused ? 'paused פעיל — צפוי' : 'pacer:last ישן', evidence: [`pacer:last.at=${last ? last.at : '—'}`] }];
  } },

  { id: 'snapshot_fail', name_he: 'קובץ האורחים לא נטען (no-snapshot) פעמיים ב-30 דקות', every_min: 10, async run(c) {
    const rows = (await c.audit()).filter(r => r.ts >= c.now - 30 * MIN && /no-snapshot|snapshot-unreadable|reader-failed/.test(String(r.detail || '') + ' ' + String(r.action || '')));
    if (rows.length < 2) return [];
    return [{ id: 'snapshot_fail', status: 'fail', severity: 'P1', playbook: 'snapshot_retry', title_he: `קובץ האורחים לא נטען ${rows.length} פעמים ב-30 דקות`, detail: 'fetchSnapshot נכשל', evidence: rows.slice(0, 5).map(r => `${r.at} ${String(r.action || '').slice(0, 60)}`) }];
  } },

  { id: 'noa_billing', name_he: 'נועה 4499: שגיאת חיוב 131042', every_min: 10, async run(c) {
    const f = await kget(c.env, 'billingalert:client');
    return f ? [{ id: 'noa_billing', status: 'fail', severity: 'P1', title_he: 'נועה 4499: מטא מחזירה 131042 (בעיית תשלום) — כל שליחה מ-4499 נכשלת', detail: 'billingalert:client set (6 h flag)', evidence: ['billingalert:client'] }] : [];
  } },

  { id: 'telnyx_order', name_he: 'הזמנת מספר בטלניקס ממתינה', every_min: 60, async run(c) {
    if (!c.env.TELNYX_KEY) return [];
    const r = await getJson('https://api.telnyx.com/v2/number_orders?filter[status]=pending', { Authorization: 'Bearer ' + c.env.TELNYX_KEY });
    if (!r.ok || !r.j) return [{ id: 'telnyx_order:read', status: 'warn', severity: 'P3', title_he: 'לא הצלחתי לקרוא הזמנות מספרים בטלניקס', detail: 'http ' + r.status }];
    return (r.j.data || []).map(o => ({ id: 'telnyx_order:' + o.id, status: 'warn', severity: 'P2', playbook: 'telnyx_nudge',
      title_he: `הזמנת מספר בטלניקס ממתינה ${o.created_at ? Math.round((c.now - Date.parse(o.created_at)) / 86400e3) + ' ימים' : ''}`.trim(),
      detail: (o.phone_numbers || []).map(p => p.phone_number).join(', '), evidence: [`order=${o.id}`, `created=${o.created_at || '—'}`], data: { order_id: o.id } }));
  } },

  { id: 'lead_monday', name_he: 'ליד בלי פריט במאנדיי', every_min: 30, async run(c) {
    if (!c.env.MONDAY_API_TOKEN) return [];
    const leads = await c.d.kvPrefix(c.env, 'lead:').catch(() => ({}));
    const leadx = await c.d.kvPrefix(c.env, 'leadx:').catch(() => ({}));
    const known = (await kjson(c.env, P.monday)) || {};
    const missing = [];
    for (const [k, v] of Object.entries(leads)) {
      const phone = k.replace(/^lead:/, '');
      let rec = null; try { rec = JSON.parse(v); } catch {}
      if (!rec) continue;
      const at = Date.parse(rec.at || rec.lastAt || '') || 0;
      if (at && c.now - at < 30 * MIN) continue;   /* /api/lead is still writing it */
      let x = null; try { x = JSON.parse(leadx[phone] || leadx['leadx:' + phone] || 'null'); } catch {}
      if ((x && x.mondayId) || known[phone]) continue;
      missing.push(phone);
    }
    if (!missing.length) return [];
    return [{ id: 'lead_monday', status: 'warn', severity: 'P3', playbook: 'lead_monday_create', title_he: `${missing.length} לידים בלי פריט מאנדיי ידוע`, detail: 'lead:<phone> without leadx.mondayId / brain:monday',
      evidence: missing.slice(0, 10).map(mask), data: { phones: missing.slice(0, 50) } }];
  } },

  { id: 'reply_wrong_number', name_he: 'תשובה מהמספר הלא נכון (131047) היום', every_min: 10, async run(c) {
    const today = c.today;
    const rows = (await c.audit()).filter(r => ilDay(r.ts) === today && ((r.kind === 'wa_out' && r.ok === false) || (r.kind === 'wa_status' && (r.data || {}).status === 'failed')) && /131047/.test(String(r.detail || '') + JSON.stringify(r.data || {})));
    if (!rows.length) return [];
    const phones = [...new Set(rows.map(r => String(r.phone || '')).filter(Boolean))];
    const items = rows.filter(r => r.kind === 'wa_out' && r.phone).slice(0, 20).map(r => ({ phone: String(r.phone), at: r.at, text: String(r.detail || '').split(' · ').slice(1).join(' · ').slice(0, 900) })).filter(x => x.text);
    return [{ id: 'reply_wrong_number', status: rows.length >= 10 ? 'fail' : 'warn', severity: rows.length >= 10 ? 'P2' : 'P3', playbook: items.length ? 'requeue_reply' : undefined,
      title_he: `${rows.length} הודעות נכשלו היום ב-131047 (נשלחו מהמספר הלא נכון / חלון 24 שעות)`, detail: `${phones.length} נמענים`, evidence: phones.slice(0, 10).map(mask), data: { items } }];
  } },

  { id: 'capacity_overflow', name_he: 'חריגת קיבולת ב-3 הימים הקרובים', every_min: 30, async run(c) {
    if (!c.fns.buildCapacity) return [];
    const cap = await c.fns.buildCapacity(c.env, c.d, c.now, 3);
    if (!cap || cap.ok === false) return [{ id: 'capacity_overflow:read', status: 'warn', severity: 'P3', title_he: 'תכנון הקיבולת לא נקרא', detail: String((cap && cap.error) || 'no capacity') }];
    const last = addDays(c.today, 2);
    return (cap.days || []).filter(d => d.day >= c.today && d.day <= last && d.overflow > 0).map(d => ({ id: 'capacity_overflow:' + d.day, status: 'warn', severity: d.day === c.today ? 'P1' : 'P2', playbook: 'capacity_warning',
      title_he: `קיבולת ${d.day}: מתוכנן ${d.planned} מול תקרה ${d.capacity} (חריגה ${d.overflow})`, detail: (d.by_event || []).slice(0, 4).map(e => `${e.name || e.tok8} ${e.type_he || e.type} ${e.count}`).join(' · '),
      evidence: [`planned=${d.planned}`, `capacity=${d.capacity}`], data: { day: d.day, planned: d.planned, capacity: d.capacity, overflow: d.overflow, recs: (cap.recommendations || []).filter(r => (r.due || r.day) && [r.due, r.day, r.needs_capacity_by].includes(d.day)).map(r => r.he).filter(Boolean).slice(0, 6) } }));
  } },

  { id: 'noa_unanswered', name_he: 'פנייה של לקוח/ליד ל-4499 בלי מענה מעל שעתיים', every_min: 10, async run(c) {
    if (!clientHoursOpen(c.now)) return [];
    const rows = await c.audit(); const clientId = String(c.d.clientPhoneId(c.env) || '');
    const lastIn = {}, lastOut = {};
    for (const r of rows) {
      const p = String(r.phone || ''); if (!p) continue;
      if (r.kind === 'wa_in' && r.area === 'נועה') lastIn[p] = Math.max(lastIn[p] || 0, r.ts);
      if (r.kind === 'wa_out' && r.ok && (String((r.data || {}).phone_id || '') === clientId || r.area === 'נועה')) lastOut[p] = Math.max(lastOut[p] || 0, r.ts);
    }
    const waiting = [];
    for (const [p, ts] of Object.entries(lastIn)) {
      if (c.now - ts < 2 * H || (lastOut[p] || 0) > ts) continue;
      const who = (await kget(c.env, 'client:' + p)) ? 'client' : ((await kget(c.env, 'lead:' + p)) || (await kget(c.env, 'leadchase:' + p))) ? 'lead' : '';
      if (who) waiting.push({ p, ts, who });
    }
    if (!waiting.length) return [];
    return [{ id: 'noa_unanswered', status: 'warn', severity: 'P2', title_he: `${waiting.length} פניות ל-4499 בלי מענה מעל שעתיים (נועה AI כבויה בהחלטה)`,
      detail: 'תשובה מהטלפון עצמו לא נראית ביומן (smb_message_echoes חסר) — לבדוק לפני שמניחים שלא נענו', evidence: waiting.slice(0, 10).map(w => `${mask(w.p)} · ${w.who} · ${new Date(w.ts).toISOString()}`) }];
  } },

  { id: 'balances_low', name_he: 'יתרה נמוכה אצל ספק', every_min: 60, async run(c) {
    if (!c.fns.buildBalances) return [];
    const b = await c.fns.buildBalances(c.env, c.d, {});
    return (b.vendors || []).filter(v => v.status === 'low').map(v => ({ id: 'balances_low:' + v.vendor, status: 'warn', severity: 'P2', title_he: `יתרה נמוכה: ${v.vendor} ${v.amount ?? ''} ${v.currency || ''}`.trim(), detail: v.topup_url || '', evidence: [`low_threshold=${v.low_threshold}`, `source=${v.source}`] }));
  } },

  { id: 'crm_overdue', name_he: 'תזכורות CRM ופעולות-הבאות של לידים שעבר זמנן', every_min: 30, async run(c) {
    const { overdueCount } = await import('./crm.js');
    const o = await overdueCount(c.env, c.now).catch(() => null);
    if (!o) return [];
    const n = o.reminders.length + o.leads.length; if (!n) return [];
    const ev = [...o.reminders.map(r => `תזכורת ${r.entity_type}:${r.entity_id} · ${r.due_at} · ${String(r.text || '').slice(0, 60)}`), ...o.leads.map(l => `ליד ${l.name || mask(l.phone)} · ${l.next_action_at} · ${String(l.next_action_text || '').slice(0, 60)}`)];
    const old = [...o.reminders.map(r => r.due_at), ...o.leads.map(l => l.next_action_at)].sort()[0];
    const late = c.now - Date.parse(old) > 24 * H;
    return [{ id: 'crm_overdue', status: 'warn', severity: late ? 'P2' : 'P3', title_he: `${n} משימות CRM באיחור (${o.reminders.length} תזכורות, ${o.leads.length} לידים)`, detail: 'GET /api/crm/agenda מציג אותן ראשונות', evidence: ev.slice(0, 10) }];
  } },
  { id: 'd1_ledger', name_he: 'יומן הריצות ב-D1 לא זמין', every_min: 10, async run(c) {
    if (!c.env.OPS_DB) return [{ id: 'd1_ledger', status: 'warn', severity: 'P3', title_he: 'D1 לא מחובר: יומן הריצות על KV (3 ימים בלבד)', detail: 'OPS_DB binding missing — bash worker/scripts/ops-d1-setup.sh', evidence: ['env.OPS_DB undefined'] }];
    try { await c.env.OPS_DB.prepare('SELECT 1 AS x').first(); return []; }
    catch (e) { return [{ id: 'd1_ledger', status: 'fail', severity: 'P2', title_he: 'D1 לא עונה: הריצות נכתבות ל-KV', detail: String(e && e.message || e).slice(0, 200) }]; }
  } },

  { id: 'failed_runs', name_he: 'ריצות שנכשלו בשעה האחרונה', every_min: 10, async run(c) {
    const r = await listRuns(c.env, { status: 'failed', from: new Date(c.now - H).toISOString(), limit: 100 });
    const by = {};
    for (const x of r.items || []) { if (/^brain_health$/.test(x.automation_id)) continue; (by[x.automation_id] = by[x.automation_id] || []).push(x); }
    return Object.entries(by).map(([aid, xs]) => ({ id: 'failed_runs:' + aid, status: 'fail', severity: /^(d_pacer|d_engine|event_day_blast|wave\d)$/.test(aid) ? 'P1' : 'P2',
      title_he: `${aid}: ${xs.length} ריצות נכשלו בשעה האחרונה`, detail: String(xs[0].error || '').split('\n')[0].slice(0, 200), evidence: xs.slice(0, 5).map(x => x.id) }));
  } },

  { id: 'biz_verification', name_he: 'שינוי בסטטוס אימות העסק במטא', every_min: 60, async run(c) {
    if (!c.env.WA_TOKEN_GUESTS) return [];
    const r = await getJson(`${GRAPH}/${GUEST_WABA}?fields=business_verification_status`, { Authorization: 'Bearer ' + c.env.WA_TOKEN_GUESTS });
    const status = r.j && r.j.business_verification_status ? String(r.j.business_verification_status) : '';
    if (!status) return [];
    const prev = (await kjson(c.env, P.biz)) || null;
    const st = prev ? { ...prev } : { status, at: c.now, changed_at: 0, history: [] };
    if (prev && prev.status !== status) {
      st.history = [...(prev.history || []), { at: new Date(c.now).toISOString(), from: prev.status, to: status }].slice(-20);
      st.status = status; st.changed_at = c.now; st.from = prev.status;
      c.log(`אימות עסק: ${prev.status} → ${status}`);
      await kput(c.env, 'biz:verif', { status, verified: status === 'verified', source: 'meta', at: new Date(c.now).toISOString() }, 6 * 3600);
    }
    st.at = c.now;
    await kput(c.env, P.biz, st);
    if (st.changed_at && c.now - st.changed_at < 24 * H) return [{ id: 'biz_verification', status: 'warn', severity: 'P2', title_he: `אימות העסק במטא השתנה: ${st.from} → ${st.status}`, detail: status === 'verified' ? 'אפשר להעלות את תקרת הקיבולת' : '', evidence: [`at=${new Date(st.changed_at).toISOString()}`] }];
    return [];
  } },

  /* the three chat-side watchers, now in the Worker (docs/BRAIN-2026-11-03.md §6) */
  { id: 'gift_blast', name_he: 'מתנה לאורחים: כשלים או ממתינים', every_min: 30, async run(c) {
    const rows = (await c.audit()).filter(r => ilDay(r.ts) === c.today && /gift-blast/.test(String(r.action || '')));
    const out = [];
    for (const r of rows) {
      const tok = String(r.token || ''); if (!tok || out.some(o => o.data.token === tok)) continue;
      const m = /נכשלו (\d+)/.exec(String(r.detail || '')), w = /ממתינים (\d+)/.exec(String(r.detail || ''));
      const failed = m ? Number(m[1]) : 0, waiting = w ? Number(w[1]) : 0;
      if (!failed && !waiting && r.ok !== false) continue;
      out.push({ id: 'gift_blast:' + tok.slice(0, 8), status: failed ? 'fail' : 'warn', severity: 'P2', playbook: 'gift_blast_resume', title_he: `מתנה לאורחים · אירוע ${tok.slice(0, 8)}: ${failed} נכשלו, ${waiting} ממתינים`,
        detail: String(r.detail || '').slice(0, 200), evidence: [r.at], data: { token: tok } });
    }
    return out;
  } },

  { id: 'wedding_day', name_he: 'יום האירוע: הודעה לא יצאה או אירוע מוחזק', every_min: 10, async run(c) {
    const raw = await c.snapshot(); if (!raw) return [];
    const evs = ((raw.events && raw.events.values) || []).filter(e => String(e[6] || '').trim().slice(0, 10) === c.today && String(e[7] || '').trim() === 'כן' && String(e[27] || '').trim() !== 'כן');
    const clock = ilClock(c.now); const out = [];
    for (const e of evs) {
      const tok = String(e[1] || '').trim(); if (!tok) continue;
      const name = String(e[34] || e[2] || '').trim();
      if (await kget(c.env, 'hold:' + tok)) out.push({ id: 'wedding_day:hold:' + tok.slice(0, 8), status: 'fail', severity: 'P1', playbook: 'event_hold',
        title_he: `האירוע של היום (${name || tok.slice(0, 8)}) מוחזק (hold) — שום הודעה לא יוצאת`, detail: 'hold:<token> set on the event day', evidence: ['hold:' + tok.slice(0, 8)], data: { token: tok, on: false } });
      const job = await kjson(c.env, 'edblast:' + tok);
      if (job && String(job.at || '') <= c.today && clock.h >= 12) out.push({ id: 'wedding_day:blast:' + tok.slice(0, 8), status: 'fail', severity: 'P1', playbook: 'eventday_retry',
        title_he: `הודעת יום האירוע (${name || tok.slice(0, 8)}) עוד לא יצאה ב-${String(clock.h).padStart(2, '0')}:${String(clock.m).padStart(2, '0')}`, detail: String(job.what || '').slice(0, 120), evidence: ['edblast:' + tok.slice(0, 8)], data: { token: tok } });
    }
    return out;
  } },

  /* 04/11: the last chat-side watcher, moved here. An event with an active call round
     (callround:/callsaddon: key, or a plan that includes calls) inside dial hours
     10:00–19:00 IL, with dialable guests queued and no dial for 60 minutes → P1 with
     the reason. calllast:<token> is written by runShirDispatch on every dial. */
  { id: 'call_round_not_dialing', name_he: 'סבב שיחות: יש תור ואין חיוגים 60 דקות', every_min: 10, async run(c) {
    const clock = ilClock(c.now);
    if (clock.dow === 'Sat' || clock.h < 10 || clock.h >= 19) return [];
    const sinceOpen = (clock.h - 10) * 60 + clock.m;   /* minutes since 10:00 — the first ticks of the day are not a stall */
    if (sinceOpen < 20 || !c.d.buildCallQueue) return [];
    const raw = await c.snapshot(); if (!raw) return [];
    const { queue = [] } = c.d.buildCallQueue(raw) || {};
    const byTok = {};
    for (const g of queue) { const t = String(g.token || ''); if (t) (byTok[t] = byTok[t] || []).push(g); }
    if (!Object.keys(byTok).length) return [];
    const evRow = t => ((raw.events && raw.events.values) || []).find(e => String(e[1] || '').trim() === t) || null;
    const out = [];
    let shared = null;
    for (const [tok, gs] of Object.entries(byTok)) {
      const ev = evRow(tok);
      const [roundRaw, addon] = await Promise.all([kget(c.env, 'callround:' + tok), kget(c.env, 'callsaddon:' + tok)]);
      let round = null; try { round = JSON.parse(roundRaw || 'null'); } catch {}
      const planCalls = !!(ev && c.d.planKeyOf && c.d.planKeyOf(ev) !== 'basic');
      if (!round && !addon && !planCalls) continue;
      if (round && String(round.at || '') > c.today) continue;   /* the round is for a later day */
      const dialable = [];
      for (const g of gs) { if (!shouldDial(g, c.today)) continue; if (g.guest_id && await kget(c.env, `shirtry:${g.guest_id}:${c.today}`)) continue; dialable.push(g); }
      if (!dialable.length) continue;   /* everyone queued was already tried today — nothing to dial */
      const last = Date.parse((await kget(c.env, 'calllast:' + tok)) || '') || 0;
      if (last && c.now - last < 60 * MIN) continue;
      if (!shared) {
        const pacer = (await kjson(c.env, 'pacer:last')) || {};
        const win = c.d.callWindowState ? c.d.callWindowState() : { open: true };
        shared = {
          paused: await c.d.sendingPaused(c.env).catch(() => false),
          noContact: c.d.isNoContactDay ? !!c.d.isNoContactDay(c.today) : false,
          win, calls: pacer.calls || {}, pacerAt: pacer.at || '',
          killDispatch: !!(await kget(c.env, 'auto:off:shir_dispatch')), killPacer: !!(await kget(c.env, 'auto:off:d_pacer')),
          retell: !!(await kget(c.env, 'billretell')), noRetell: !c.env.RETELL_KEY || !c.env.SHIR_FROM,
          cap: c.d.dailyCallCap ? c.d.dailyCallCap(c.env) : 0, dialsToday: Number(await kget(c.env, 'dials:day:' + c.today)) || 0,
        };
      }
      const s = shared, why = [];
      if (s.noContact) why.push('יום ללא פניות (חג)');
      if (s.win && s.win.open === false) why.push('חלון החיוג סגור (' + (s.win.why || 'שעות') + ')');
      if (s.paused) why.push('paused — העצירה הכללית פעילה');
      if (s.killPacer) why.push('מתג כיבוי: d_pacer');
      if (s.killDispatch) why.push('מתג כיבוי: shir_dispatch');
      if (await kget(c.env, 'hold:' + tok)) why.push('האירוע מוחזק (hold)');
      if (await kget(c.env, 'callstop:' + tok)) why.push('הסבב נעצר ידנית (callstop)');
      if (s.cap && s.dialsToday >= s.cap) why.push(`תקרת חיוגים יומית (${s.dialsToday}/${s.cap})`);
      if (s.calls.why === 'callbacks-took-the-slice') why.push('החזרות שיחה לקחו את כל הפרוסה');
      if (s.retell) why.push('Retell: בעיית חיוב/יתרה (billretell)');
      if (s.noRetell) why.push('Retell לא מוגדר (RETELL_KEY / SHIR_FROM)');
      if (s.calls.why && !why.length && !/callbacks/.test(s.calls.why)) why.push('Retell/חייגן: ' + String(s.calls.why).slice(0, 80));
      if (!why.length) why.push('סיבה לא ידועה — החייגן רץ ולא חייג');
      const name = ev ? String(ev[34] || '').trim() : '';
      const lastTxt = last ? `חיוג אחרון ${Math.round((c.now - last) / MIN)} דק׳ לפני` : 'אין חיוג היום';
      out.push({ id: 'call_round_not_dialing:' + tok.slice(0, 8), status: 'fail', severity: 'P1', playbook: 'call_round_kick',
        title_he: `סבב שיחות ${name || tok.slice(0, 8)}: ${dialable.length} בתור ו-0 חיוגים ב-60 דקות`, detail: 'סיבה: ' + why.join(' · '),
        evidence: [`queued=${gs.length}`, `dialable=${dialable.length}`, lastTxt, round ? `callround.at=${round.at || '—'}` : addon ? 'callsaddon' : 'plan=' + (c.d.planKeyOf ? c.d.planKeyOf(ev) : '?'), `pacer.calls=${JSON.stringify(s.calls).slice(0, 120)}`],
        data: { token: tok, queued: gs.length, dialable: dialable.length, reasons: why } });
    }
    return out;
  } },
];

/* ══ playbooks ═════════════════════════════════════════════════════════════ */
/* each: { id, name_he, auto, messages, cooldown_ms, run(c, finding, {dry, log}) → {ok, preview?, did?} } */
export const PLAYBOOKS = [
  { id: 'cap_probe_release', name_he: 'שחרור עצירת תקרה ישנה אחרי בדיקה', auto: true, messages: false, cooldown_ms: H, async run(c, f, { dry, log }) {
    const pid = f.data.phone_id; const ids = c.d.guestPhoneIds(c.env);
    if (pid === 'guests') {
      const held = (await Promise.all(ids.map(id => kget(c.env, 'wacap:' + id)))).filter(Boolean).length;
      log(`עצירה גלובלית · מספרים מוחזקים: ${held}`);
      if (held) return { ok: false, preview: 'יש עדיין מספר מוחזק — לא משחרר' };
      if (dry) return { ok: true, preview: 'ימחק wacap:guests' };
      await kdel(c.env, 'wacap:guests'); log('נמחק wacap:guests'); return { ok: true, did: 'released wacap:guests' };
    }
    if (dry) return { ok: true, preview: `בדיקת הודעה אחת מ-${pid}, ואם עברה: מחיקת wacap:${pid}` };
    const probe = await c.d.waProbe(c.env, pid);
    log(`בדיקה (${probe.mode}): ${probe.ok ? 'עברה' : 'נכשלה'} · ${probe.detail || ''}`);
    if (!probe.ok) return { ok: false, did: 'probe failed, hold kept' };
    for (const k of ['wacap:', 'wacapuntil:', 'wacapn:']) await kdel(c.env, k + pid);
    log(`נמחקו wacap/wacapuntil/wacapn של ${pid}`);
    if (await kget(c.env, 'wacap:guests')) {
      const still = (await Promise.all(ids.map(id => kget(c.env, 'wacap:' + id)))).filter(Boolean).length;
      if (!still) { await kdel(c.env, 'wacap:guests'); log('גם wacap:guests נמחק'); }
    }
    await kput(c.env, 'pacer:pending', c.today, 2 * 86400);
    return { ok: true, did: 'released ' + pid };
  } },

  { id: 'snapshot_retry', name_he: 'ניסיון חוזר לקובץ האורחים + התראה', auto: true, messages: false, cooldown_ms: 30 * MIN, async run(c, f, { dry, log }) {
    if (dry) return { ok: true, preview: 'עד 3 ניסיונות לטעון את הקובץ, ואם נטען: חימוש pacer:pending להיום; אחרת התראת P1' };
    for (let i = 1; i <= 3; i++) {
      const raw = await c.d.fetchSnapshot(c.env).catch(() => null);
      const ok = !!(raw && raw.events && raw.guests);
      log(`ניסיון ${i}: ${ok ? 'נטען' : 'נכשל'}`);
      if (ok) { await kput(c.env, 'pacer:pending', c.today, 2 * 86400); log('pacer:pending חומש להיום'); return { ok: true, did: `snapshot ok on try ${i}` }; }
      if (i < 3) await c.sleep(i * 2000);
    }
    await c.slack(`🚨 *מוח · קובץ האורחים לא נטען* · 3 ניסיונות נכשלו. השליחות והחיוגים ממתינים עד שהקובץ יחזור.`, true);
    log('שלחתי התראת P1'); return { ok: false, did: 'snapshot still failing, alerted' };
  } },

  { id: 'lead_monday_create', name_he: 'יצירת פריט מאנדיי לליד חסר', auto: true, messages: false, cooldown_ms: 9 * MIN, async run(c, f, { dry, log }) {
    const phones = (f.data.phones || []).slice(0, 10);
    if (dry) return { ok: true, preview: `חיפוש ${phones.length} לידים במאנדיי (קריאה), ויצירה רק למי שלא נמצא` };
    const known = (await kjson(c.env, P.monday)) || {}; let created = 0, found = 0, failed = 0;
    for (const p of phones) {
      try {
        const hit = await c.d.mondayFindLead(c.env, p);
        if (hit && hit.found) { known[p] = String(hit.id || 'found'); found++; log(`${mask(p)}: נמצא במאנדיי (${hit.id})`); continue; }
        let rec = null; try { rec = JSON.parse((await kget(c.env, 'lead:' + p)) || 'null'); } catch {}
        if (!rec) { log(`${mask(p)}: אין רשומת ליד`); continue; }
        const r = await c.d.mondayUpsertLead(c.env, p, rec);
        if (r && r.ok) { known[p] = String(r.id); created++; log(`${mask(p)}: נוצר פריט ${r.id}`); } else { failed++; log(`${mask(p)}: נכשל ${(r && r.why) || ''}`); }
      } catch (e) { failed++; log(`${mask(p)}: שגיאה ${String(e && e.message || e).slice(0, 80)}`); }
    }
    await kput(c.env, P.monday, known, 400 * 86400);
    return { ok: !failed, did: `found ${found}, created ${created}, failed ${failed}` };
  } },

  { id: 'capacity_warning', name_he: 'התראת קיבולת לסלאק עם תוכנית', auto: true, messages: false, cooldown_ms: 6 * H, async run(c, f, { dry, log }) {
    const x = f.data; const text = `📈 *מוח · חריגת קיבולת ${x.day}* · מתוכנן ${x.planned} מול תקרה ${x.capacity} (חריגה ${x.overflow})${x.recs && x.recs.length ? '\nמה מומלץ:\n' + x.recs.map(r => '• ' + r).join('\n') : ''}`;
    if (dry) return { ok: true, preview: text };
    await c.slack(text, x.day === c.today); log('התראה נשלחה לסלאק'); return { ok: true, did: 'slack' };
  } },

  { id: 'template_variant', name_he: 'הגשת וריאנט לתבנית שממתינה מעל 24 שעות', auto: false, messages: false, cooldown_ms: 24 * H, async run(c, f, { dry, log }) {
    const x = f.data; const tok = x.tok === 'client' ? c.d.clientToken(c.env) : c.env.WA_TOKEN_GUESTS;
    const r = await getJson(`${GRAPH}/${x.waba}/message_templates?name=${encodeURIComponent(x.name)}&fields=name,status,category,language,components`, { Authorization: 'Bearer ' + tok });
    const t = ((r.j && r.j.data) || []).find(y => y.name === x.name && (!x.language || y.language === x.language));
    if (!t) { log('התבנית לא נמצאה במטא'); return { ok: false, preview: 'template not found' }; }
    const names = new Set(((await getJson(`${GRAPH}/${x.waba}/message_templates?fields=name&limit=250`, { Authorization: 'Bearer ' + tok })).j || { data: [] }).data.map(y => y.name));
    let n = 2; while (names.has(`${x.name}_v${n}`) && n < 9) n++;
    const name = `${x.name}_v${n}`.slice(0, 512);
    const category = t.category === 'MARKETING' ? 'UTILITY' : t.category === 'UTILITY' ? 'MARKETING' : t.category;
    const body = { name, language: t.language, category, components: (t.components || []).map(({ id, ...k }) => k) };
    log(`וריאנט: ${name} · קטגוריה ${t.category} → ${category}`);
    if (dry) return { ok: true, preview: body };
    const p = await fetch(`${GRAPH}/${x.waba}/message_templates`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    const j = p ? await p.json().catch(() => ({})) : {};
    log(p && p.ok ? `מטא קיבלה: id ${j.id || '?'} · ${j.status || ''}` : `מטא סירבה: ${(j.error && j.error.message) || (p ? p.status : 'unreachable')}`);
    return { ok: !!(p && p.ok), did: p && p.ok ? `submitted ${name}` : 'refused' };
  } },

  { id: 'event_hold', name_he: 'עצירה / שחרור של אירוע (hold)', auto: false, messages: false, cooldown_ms: 0, async run(c, f, { dry, log }) {
    const { token, on } = f.data; const k = 'hold:' + token;
    const before = !!(await kget(c.env, k));
    if (dry) return { ok: true, preview: `${k}: ${before ? 'מוחזק' : 'פתוח'} → ${on ? 'מוחזק' : 'פתוח'}` };
    if (on) await kput(c.env, k, new Date(c.now).toISOString(), 200 * 86400); else await kdel(c.env, k);
    log(`${k}: ${before} → ${!!on}`); await c.slack(`⚙️ מוח · אירוע ${token.slice(0, 8)} ${on ? 'הוחזק' : 'שוחרר'} (אושר בלוח הבקרה)`, false);
    return { ok: true, did: on ? 'parked' : 'unparked' };
  } },

  { id: 'eventday_retry', name_he: 'שליחה חוזרת של הודעת יום האירוע', auto: false, messages: true, cooldown_ms: 20 * MIN, async run(c, f, { dry, log }) {
    const g = await guardMessaging(c, 'guests'); if (!dry && g) { log('לא נשלח: ' + g); return { ok: false, did: g }; }
    const r = await c.d.runEventDayBlasts(c.env, { only: f.data.token, dry: !!dry });
    log(`runEventDayBlasts(${f.data.token.slice(0, 8)}, dry=${!!dry}): ${JSON.stringify(r).slice(0, 300)}`);
    return { ok: true, preview: dry ? r : undefined, did: dry ? undefined : 'ran event-day blast' };
  } },

  { id: 'gift_blast_resume', name_he: 'המשך שליחת מתנה לאורחים שנשארו', auto: false, messages: true, cooldown_ms: 20 * MIN, async run(c, f, { dry, log }) {
    const g = await guardMessaging(c, 'guests'); if (!dry && g) { log('לא נשלח: ' + g); return { ok: false, did: g }; }
    const r = await c.d.giftBlast(c.env, f.data.token, { dry: !!dry, max: 50 });
    log(`gift-blast(${f.data.token.slice(0, 8)}, dry=${!!dry}): ${JSON.stringify(r && (r.counts || r.refused || r)).slice(0, 300)}`);
    return { ok: !!(r && r.ok), preview: dry ? r && r.counts : undefined, did: dry ? undefined : 'gift blast slice' };
  } },

  { id: 'requeue_reply', name_he: 'שליחה חוזרת של תשובה מהמספר הנכון', auto: false, messages: true, cooldown_ms: 30 * MIN, async run(c, f, { dry, log }) {
    const rows = await c.audit(); const plan = [];
    for (const it of (f.data.items || []).slice(0, 10)) {
      const ins = rows.filter(r => r.kind === 'wa_in' && String(r.phone) === it.phone).sort((a, b) => b.ts - a.ts)[0];
      if (!ins || c.now - ins.ts > 23 * H) { plan.push({ phone: mask(it.phone), action: 'skip', why: 'no inbound in 23h (needs a template)' }); continue; }
      plan.push({ phone: mask(it.phone), raw: it.phone, channel: ins.area === 'נועה' ? 'client' : 'guests', text: it.text, action: 'send' });
    }
    for (const p of plan) log(`${p.phone}: ${p.action}${p.channel ? ' · ' + p.channel : ''}${p.why ? ' · ' + p.why : ''}`);
    if (dry) return { ok: true, preview: plan.map(({ raw, text, ...p }) => ({ ...p, text: text ? text.slice(0, 80) : '' })) };
    let sent = 0;
    for (const p of plan.filter(x => x.action === 'send')) {
      const g = await guardMessaging(c, p.channel); if (g) { log(`${p.phone}: לא נשלח · ${g}`); continue; }
      const r = await c.d.sendText(c.env, p.raw, p.text, p.channel, { who: 'מוח (שליחה חוזרת)' });
      log(`${p.phone}: ${r && r.ok ? 'נשלח' : 'נכשל ' + ((r && r.error) || '')}`); if (r && r.ok) sent++;
    }
    return { ok: true, did: `resent ${sent}` };
  } },

  /* 04/11: re-trigger the dialler for a stalled round. Not auto: it rings people (money).
     runShirDispatch itself re-checks the kill switch, paused, the holiday list and the call window. */
  { id: 'call_round_kick', name_he: 'הפעלה מחדש של החייגן לסבב שתקוע', auto: false, messages: false, cooldown_ms: 30 * MIN, async run(c, f, { dry, log }) {
    const why = (f.data && f.data.reasons) || [];
    if (dry) return { ok: true, preview: { token: String(f.data.token || '').slice(0, 8), queued: f.data.queued, dialable: f.data.dialable, reasons: why, will: 'runShirDispatch max 6' } };
    if (!c.d.runShirDispatch) return { ok: false, did: 'no runShirDispatch dep' };
    const r = await c.d.runShirDispatch(c.env, { max: 6, quiet: true });
    log(`runShirDispatch(max 6): ${JSON.stringify(r).slice(0, 300)}`);
    return { ok: !!(r && r.ok !== false && r.dialed), did: `dialed ${(r && r.dialed) || 0}${r && (r.why || r.skipped || r.closed) ? ' · ' + (r.why || r.skipped || r.closed) : ''}` };
  } },

  { id: 'telnyx_nudge', name_he: 'הודעת דחיפה להזמנת מספר בטלניקס', auto: false, messages: false, cooldown_ms: 24 * H, async run(c, f, { dry, log }) {
    const body = { body: 'Hi, this number order has been pending for a while. Is anything missing from our side (documents / address)? Thank you — ishur.io', comment_record_type: 'number_order', comment_record_id: f.data.order_id };
    if (dry) return { ok: true, preview: body };
    if (!c.env.TELNYX_KEY) return { ok: false, did: 'no TELNYX_KEY' };
    const r = await fetch('https://api.telnyx.com/v2/comments', { method: 'POST', headers: { Authorization: 'Bearer ' + c.env.TELNYX_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    log(`telnyx comments: http ${r ? r.status : 'unreachable'}`);
    return { ok: !!(r && r.ok), did: r && r.ok ? 'comment posted' : 'telnyx refused' };
  } },
];
export const PB = Object.fromEntries(PLAYBOOKS.map(p => [p.id, p]));
export const CK = Object.fromEntries(CHECKS.map(x => [x.id, x]));
/* the code-level guardrail: nothing that messages a person runs without a tap */
export function assertCatalog(list = PLAYBOOKS) { for (const p of list) if (p.messages && p.auto) throw new Error(`playbook ${p.id}: messages:true cannot be auto`); return true; }
assertCatalog();

/* a messaging playbook re-checks the world at run time (even after approval) */
async function guardMessaging(c, channel) {
  if (await c.d.sendingPaused(c.env).catch(() => false)) return 'paused';
  if (channel === 'client' && !clientHoursOpen(c.now)) return 'client-hours (21:00–09:00)';
  if (channel === 'guests' && c.d.sendWindowState && !c.d.sendWindowState(new Date(c.now)).open) return 'send-window-closed';
  return '';
}

/* ══ run log ═══════════════════════════════════════════════════════════════ */
export function makeLogger(run_id, automation_id, now = () => Date.now()) {
  const lines = []; let seq = 0;
  const log = (text, src = 'worker') => { const at = now(); seq++; lines.push({ id: 0, seq, at: new Date(at).toISOString(), run_id, step: seq, text: maskText(String(text)).slice(0, 500), src }); };
  return { lines, log, async flush(env) { await appendLog(env, run_id, automation_id, lines.splice(0)); } };
}
/* stream ids are stamped at WRITE time (ms·1000 + i), so a client's `since` cursor never skips lines
   that a longer run flushes after a shorter child run did */
let lastStamp = 0;
const stamp = (lines, floor = 0) => { let b = Math.max(Date.now() * 1000, lastStamp + 1, floor + 1); const out = lines.map((l, i) => ({ ...l, id: b + i })); lastStamp = b + lines.length - 1; return out; };
export async function appendLog(env, run_id, automation_id, lines) {
  if (!lines.length) return;
  const k = P.log + run_id;
  const cur = (await kjson(env, k)) || { run_id, automation_id, lines: [] };
  lines = stamp(lines, Math.max(0, ...cur.lines.map(l => l.id || 0)));
  cur.lines = [...cur.lines, ...lines].slice(-500);
  await kput(env, k, cur, LOG_TTL);
  const idx = (await kjson(env, P.runs)) || [];
  if (!idx.some(r => r.run_id === run_id)) { idx.unshift({ run_id, automation_id, at: lines[0].at }); await kput(env, P.runs, idx.slice(0, 40), LOG_TTL); }
  if (env.OPS_DB) { try { for (const l of lines) await env.OPS_DB.prepare('INSERT OR IGNORE INTO run_logs (run_id, seq, at, text, src) VALUES (?,?,?,?,?)').bind(run_id, l.seq, l.at, l.text, l.src).run(); } catch {} }
}

/* ══ findings store ════════════════════════════════════════════════════════ */
async function d1Finding(env, f) {
  if (!env.OPS_DB) return;
  try {
    await env.OPS_DB.prepare('INSERT OR REPLACE INTO findings (id, check_id, status, severity, state, title, detail, evidence_json, playbook, first_seen, last_seen, resolved_at, history_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(f.id, f.check_id, f.status, f.severity, f.state, f.title_he, f.detail || '', JSON.stringify(f.evidence || []), f.playbook || '', f.first_seen, f.last_seen, f.resolved_at || null, JSON.stringify(f.history || [])).run();
  } catch {}
}
async function saveFinding(env, f) { await kput(env, P.finding + f.id, f, FINDING_TTL); await d1Finding(env, f); }
export async function loadIndex(env) { const i = await kjson(env, P.index); return i && typeof i === 'object' && i.f ? i : { f: {} }; }

/* pure: merge one tick's results into the stored findings → { next, events } */
export function mergeFindings(prev, results, { now, ranChecks, failedChecks = [] }) {
  const next = {}; const events = [];
  const byId = Object.fromEntries(results.filter(r => r.status !== 'ok').map(r => [r.id, r]));
  for (const [id, r] of Object.entries(byId)) {
    const old = prev[id];
    const sev = r.severity || (r.status === 'fail' ? 'P1' : 'P2');
    if (!old || old.state === 'resolved') {
      const f = { id, check_id: r.check_id, status: r.status, severity: sev, state: 'open', title_he: r.title_he, detail: r.detail || '', evidence: r.evidence || [], playbook: r.playbook || null, data: r.data || {},
        first_seen: new Date(now).toISOString(), last_seen: new Date(now).toISOString(), resolved_at: null, alerted_at: old ? old.alerted_at : null, escalated_at: old ? old.escalated_at : null, pb_at: old ? old.pb_at : null,
        history: [...((old && old.history) || []), { at: new Date(now).toISOString(), status: r.status, note: old ? 'reopened' : 'new' }].slice(-30) };
      next[id] = f; events.push({ type: old ? 'reopened' : 'new', f });
    } else {
      const changed = old.status !== r.status || old.title_he !== r.title_he;
      const f = { ...old, status: r.status, severity: sev, title_he: r.title_he, detail: r.detail || '', evidence: r.evidence || [], playbook: r.playbook || old.playbook, data: r.data || old.data, last_seen: new Date(now).toISOString(),
        history: changed ? [...(old.history || []), { at: new Date(now).toISOString(), status: r.status, note: 'changed' }].slice(-30) : old.history };
      next[id] = f; events.push({ type: changed ? 'changed' : 'seen', f });
    }
  }
  for (const [id, old] of Object.entries(prev)) {
    if (next[id] || old.state === 'resolved') continue;
    if (ranChecks.includes(old.check_id) && !failedChecks.includes(old.check_id)) {
      const f = { ...old, state: 'resolved', resolved_at: new Date(now).toISOString(), history: [...(old.history || []), { at: new Date(now).toISOString(), status: 'ok', note: 'resolved' }].slice(-30) };
      next[id] = f; events.push({ type: 'resolved', f });
    }
  }
  return { next, events };
}
export const shouldAlert = (f, now) => f.status === 'fail' && (!f.alerted_at || now - Date.parse(f.alerted_at) >= REALERT_MS);
export const due = (check, last, now) => !last || now - last >= check.every_min * MIN - 30e3;

/* ══ the tick ══════════════════════════════════════════════════════════════ */
function makeCtx(env, d, opts, log) {
  const now = opts.now || Date.now();
  let auditP = null, snapP = null;
  return {
    env, d, now, today: d.ilDate ? d.ilDate(new Date(now)) : ilDay(now), log, fns: opts.fns || {}, notes: [],
    note(t) { this.notes.push(t); },
    audit: () => (auditP = auditP || d.auditQueryEx(env, { days: 1, limit: 20000, budget: 2500 }).then(r => r.items || []).catch(() => [])),
    snapshot: () => (snapP = snapP || d.snapshotCached(env).catch(() => null)),
    sleep: opts.sleep || (ms => new Promise(r => setTimeout(r, ms))),
    slack: (text, urgent) => (d.slackSend ? d.slackSend(env, text, { urgent: !!urgent }) : d.slackPost(env, text)).catch(() => {}),
  };
}

export async function runBrain(env, d, opts = {}) {
  return withRun(env, 'brain_health', async (run) => {
    const L = makeLogger(run.id, 'brain_health');
    const c = makeCtx(env, d, opts, L.log);
    const lastState = (await kjson(env, P.last)) || { checks: {} };
    const only = opts.only ? [].concat(opts.only) : null;
    const checks = CHECKS.filter(k => (only ? only.includes(k.id) : opts.force || due(k, (lastState.checks[k.id] || {}).at, c.now)));
    L.log(`בדיקות שרצות עכשיו: ${checks.map(k => k.id).join(', ') || 'אין'}`);
    const results = []; const failedChecks = []; const checkState = { ...lastState.checks };
    for (const k of checks) {
      let rs = [];
      try { rs = (await k.run(c)) || []; checkState[k.id] = { at: c.now, status: rs.some(r => r.status === 'fail') ? 'fail' : rs.some(r => r.status === 'warn') ? 'warn' : 'ok', n: rs.length }; }
      catch (e) { failedChecks.push(k.id); rs = [{ id: k.id + ':error', status: 'warn', severity: 'P3', title_he: `הבדיקה ${k.id} נפלה`, detail: String(e && e.message || e).slice(0, 200) }]; checkState[k.id] = { at: c.now, status: 'error' }; }
      for (const r of rs) results.push({ ...r, check_id: k.id });
      L.log(`${k.id}: ${rs.length ? rs.map(r => r.status + ' · ' + r.title_he).join(' | ') : 'ok'}`);
      run.count('checks');
    }
    /* findings */
    const idx = await loadIndex(env);
    const prev = {};
    await Promise.all(Object.entries(idx.f).filter(([, m]) => m.state !== 'resolved').map(async ([id]) => { const f = await kjson(env, P.finding + id); if (f) prev[id] = f; }));
    /* the per-check :error finding resolves when the check runs clean again */
    const ran = checks.map(k => k.id);
    const { next, events } = mergeFindings(prev, results, { now: c.now, ranChecks: ran, failedChecks });
    const autofix = String(env.BRAIN_AUTOFIX || 'on') !== 'off';
    for (const ev of events) {
      const f = ev.f; let dirty = ev.type !== 'seen';
      if (ev.type === 'resolved') { L.log(`נפתר: ${f.title_he}`); run.count('resolved'); await obsoletePending(env, f.id); }
      else {
        if (ev.type === 'new' || ev.type === 'reopened') { L.log(`ממצא ${ev.type === 'new' ? 'חדש' : 'חוזר'} (${f.status}/${f.severity}): ${f.title_he}`); run.count('new'); }
        if (shouldAlert(f, c.now)) { await c.slack(`${f.severity === 'P1' ? '🚨' : '⚠️'} *מוח · ${f.title_he}*${f.detail ? '\n' + f.detail : ''}${f.playbook ? `\nפלייבוק: ${(PB[f.playbook] || {}).name_he || f.playbook}${PB[f.playbook] && PB[f.playbook].auto ? ' (אוטומטי)' : ' — מחכה לאישור בלוח הבקרה'}` : ''}`, f.severity === 'P1'); f.alerted_at = new Date(c.now).toISOString(); dirty = true; run.count('alerted'); L.log('התראה לסלאק'); }
        const pb = f.playbook && PB[f.playbook];
        if (pb && pb.auto) {
          if (autofix && (!f.pb_at || c.now - Date.parse(f.pb_at) >= (pb.cooldown_ms || 0))) {
            f.pb_at = new Date(c.now).toISOString(); dirty = true; f.state = 'handling';
            const res = await execPlaybook(env, d, c, pb, f, { dry: false, triggered_by: 'brain', parent: run.id }).catch(e => ({ ok: false, did: String(e && e.message || e) }));
            L.log(`פלייבוק ${pb.id}: ${res.ok ? 'הצליח' : 'לא הצליח'} · ${res.did || ''} (ריצה ${res.run_id || '?'})`); run.count('fixed', res.ok ? 1 : 0);
          }
        } else if (pb && !pb.auto) {
          if (f.state !== 'needs_approval') { await createPending(env, d, c, pb, f, L.log); f.state = 'needs_approval'; dirty = true; run.count('pending'); }
        } else if (!pb && (ev.type === 'new' || ev.type === 'reopened' || !f.escalated_at || c.now - Date.parse(f.escalated_at) >= REALERT_MS)) {
          if (env.BRAIN_AGENT_HOOK && (!f.escalated_at || c.now - Date.parse(f.escalated_at) >= REALERT_MS)) {
            const r = await escalate(env, d, c, f, run.id).catch(e => ({ ok: false, why: String(e && e.message || e) }));
            f.escalated_at = new Date(c.now).toISOString(); dirty = true; run.count('escalated');
            L.log(`נשלח לסוכן (BRAIN_AGENT_HOOK): ${r.ok ? 'התקבל' : 'נכשל ' + (r.why || '')} · ריצת סוכן ${r.run_id || '?'}`);
          }
        }
      }
      if (dirty || ev.type === 'seen' && c.now - Date.parse(f.last_saved || 0) > H) { f.last_saved = new Date(c.now).toISOString(); await saveFinding(env, f); }
      idx.f[f.id] = { state: f.state, status: f.status, severity: f.severity, check_id: f.check_id, last_seen: f.last_seen, resolved_at: f.resolved_at };
    }
    /* keep the index small: resolved > 7 days drop out */
    for (const [id, m] of Object.entries(idx.f)) if (m.state === 'resolved' && m.resolved_at && c.now - Date.parse(m.resolved_at) > 7 * 86400e3) delete idx.f[id];
    await kput(env, P.index, idx);
    for (const n of c.notes) { await c.slack(n, false); L.log(n); }
    await kput(env, P.last, { at: new Date(c.now).toISOString(), run_id: run.id, checks: checkState });
    const open = Object.values(idx.f).filter(m => m.state !== 'resolved');
    L.log(`סיכום: ${open.length} פתוחים (${open.filter(m => m.status === 'fail').length} חמורים), ${checks.length} בדיקות`);
    await L.flush(env);
    return { ok: true, checks: checks.length, open: open.length, events: events.filter(e => e.type !== 'seen').map(e => e.type + ':' + e.f.id) };
  }, { triggered_by: opts.triggered_by || 'cron' });
}

export async function execPlaybook(env, d, c, pb, f, { dry, triggered_by, parent } = {}) {
  let out = null, rid = null;
  const res = await withRun(env, 'brain_fix:' + pb.id, async (run) => {
    rid = run.id;
    const L = makeLogger(run.id, 'brain_fix:' + pb.id);
    L.log(`פלייבוק ${pb.id} · ${pb.name_he} · ממצא ${f.id}${dry ? ' · תצוגה מקדימה' : ''}`);
    try { out = await pb.run(c, f, { dry: !!dry, log: L.log }); }
    catch (e) { L.log('נפל: ' + String(e && e.message || e)); await L.flush(env); throw e; }
    L.log(`תוצאה: ${out && out.ok ? 'ok' : 'לא הושלם'}${out && out.did ? ' · ' + out.did : ''}`);
    await L.flush(env);
    if (!dry && d.auditRecord) await d.auditRecord(env, { kind: 'admin', area: 'מוח', action: `🧠 פלייבוק ${pb.id}: ${(out && out.did) || (out && out.ok ? 'ok' : 'נכשל')}`, ok: !!(out && out.ok), review: !(out && out.ok), data: { playbook: pb.id, finding: f.id, run_id: run.id, triggered_by } }).catch(() => {});
    run.count(out && out.ok ? 'ok' : 'not_ok');
    if (!dry) await recordChange(env, { kind: 'brain', actor: /^manual:/.test(String(triggered_by || '')) ? actorOf(String(triggered_by).slice(7)) : 'brain',
      summary_he: `${/^manual:/.test(String(triggered_by || '')) ? 'אושר' : 'הופעל אוטומטית'}: ${pb.name_he} · ${f.title_he || f.id} → ${out && out.ok ? 'בוצע' : 'לא הושלם'}`,
      details: { playbook: pb.id, finding: f.id, decision: /^manual:/.test(String(triggered_by || '')) ? 'approved' : 'auto', ok: !!(out && out.ok), did: (out && out.did) || '', run_id: run.id, triggered_by: triggered_by || 'brain' } });
    return { ok: !!(out && out.ok), did: out && out.did, preview: out && out.preview };
  }, { triggered_by: triggered_by || 'brain', parent });
  return { ...res, run_id: rid };
}

async function createPending(env, d, c, pb, f, log) {
  const id = 'pa_' + hash(f.id + ':' + pb.id) + '_' + c.now.toString(36);
  let preview = null;
  try { const r = await pb.run(c, f, { dry: true, log: () => {} }); preview = r && r.preview !== undefined ? r.preview : r; } catch (e) { preview = { error: String(e && e.message || e).slice(0, 200) }; }
  const pa = { id, finding_id: f.id, playbook: pb.id, name_he: pb.name_he, messages: !!pb.messages, title_he: f.title_he, preview: JSON.parse(JSON.stringify(preview ?? null, (k, v) => (k === 'raw' ? undefined : typeof v === 'string' ? maskText(v).slice(0, 400) : v))),
    state: 'pending', created_at: new Date(c.now).toISOString(), confirm_word: pb.id, decided_at: null, decided_by: null, run_id: null };
  await kput(env, P.pending + id, pa, FINDING_TTL);
  const idx = (await kjson(env, P.pending + 'index')) || [];
  await kput(env, P.pending + 'index', [id, ...idx.filter(x => x !== id)].slice(0, 100));
  if (env.OPS_DB) { try { await env.OPS_DB.prepare('INSERT OR REPLACE INTO pending_actions (id, finding_id, playbook, state, created_at, preview_json) VALUES (?,?,?,?,?,?)').bind(id, f.id, pb.id, 'pending', pa.created_at, JSON.stringify(pa.preview)).run(); } catch {} }
  log(`נוצרה פעולה לאישור ${id} (${pb.id})`);
  return pa;
}
async function obsoletePending(env, findingId) {
  const idx = (await kjson(env, P.pending + 'index')) || [];
  for (const id of idx) { const pa = await kjson(env, P.pending + id); if (pa && pa.finding_id === findingId && pa.state === 'pending') { pa.state = 'obsolete'; pa.decided_at = new Date().toISOString(); await kput(env, P.pending + id, pa, FINDING_TTL); } }
}

/* findings no playbook handles → the external agent (claude.ai routine trigger) */
async function escalate(env, d, c, f, parentRun) {
  let out = { ok: false };
  await withRun(env, 'brain_agent', async (run) => {
    const L = makeLogger(run.id, 'brain_agent');
    L.log(`הסלמה לסוכן: ${f.title_he}`);
    const payload = { kind: 'ishur.brain.finding', finding: { id: f.id, check_id: f.check_id, status: f.status, severity: f.severity, title_he: f.title_he, detail: f.detail, evidence: f.evidence, first_seen: f.first_seen },
      run_id: run.id, brain_url: 'https://go.ishur.io/api/ops/brain', run_log_url: 'https://go.ishur.io/api/ops/run-log', rules: 'read-only on /api/ops/*; never send WhatsApp; write reasoning to run-log' };
    const headers = { 'Content-Type': 'application/json', ...(env.BRAIN_AGENT_HOOK_TOKEN ? { Authorization: 'Bearer ' + env.BRAIN_AGENT_HOOK_TOKEN } : {}) };
    const r = await fetch(env.BRAIN_AGENT_HOOK, { method: 'POST', headers, body: JSON.stringify(payload) }).catch(() => null);
    out = { ok: !!(r && r.ok), why: r ? 'http ' + r.status : 'unreachable', run_id: run.id };
    L.log(`hook: ${out.why}`); await L.flush(env);
    return { ok: out.ok, escalated: f.id };
  }, { triggered_by: 'brain', parent: parentRun });
  return out;
}

/* ══ API helpers (ops.js routes) ═══════════════════════════════════════════ */
export async function decide(env, d, b, now = Date.now()) {
  const id = String(b.id || '');
  const pa = await kjson(env, P.pending + id);
  if (!pa) return { status: 404, body: { ok: false, error: 'unknown-pending-action' } };
  if (pa.state !== 'pending') return { status: 409, body: { ok: false, error: 'already-' + pa.state, action: pa } };
  const approve = b.approve === true || b.decision === 'approve';
  const reject = b.approve === false || b.decision === 'reject';
  if (!approve && !reject) return { status: 400, body: { ok: false, error: 'approve-must-be-boolean' } };
  const who = String(b.who || 'admin').slice(0, 40);
  if (reject) {
    pa.state = 'rejected'; pa.decided_at = new Date(now).toISOString(); pa.decided_by = who;
    await kput(env, P.pending + id, pa, FINDING_TTL);
    await d.auditRecord(env, { kind: 'admin', area: 'מוח', action: `🧠 נדחה: ${pa.playbook} · ${pa.title_he}`, ok: true, data: { pending: id, who } }).catch(() => {});
    await recordChange(env, { kind: 'brain', who, summary_he: `נדחה: ${pa.name_he || pa.playbook} · ${pa.title_he || pa.finding_id}`, details: { playbook: pa.playbook, finding: pa.finding_id, decision: 'rejected', pending: id, who } }, now);
    return { status: 200, body: { ok: true, action: pa } };
  }
  const pb = PB[pa.playbook];
  if (!pb.auto && b.confirm !== pa.confirm_word) return { status: 200, body: { ok: true, applied: false, confirm_required: pa.confirm_word, action: pa, he: `כדי לבצע, לשלוח שוב עם confirm: "${pa.confirm_word}"` } };
  const f = await kjson(env, P.finding + pa.finding_id);
  if (!f) return { status: 409, body: { ok: false, error: 'finding-gone' } };
  pa.state = 'running'; pa.decided_at = new Date(now).toISOString(); pa.decided_by = who; await kput(env, P.pending + id, pa, FINDING_TTL);
  const c = makeCtx(env, d, { now }, () => {});
  const res = await execPlaybook(env, d, c, pb, f, { dry: false, triggered_by: 'manual:' + who }).catch(e => ({ ok: false, did: String(e && e.message || e) }));
  pa.state = res.ok ? 'done' : 'failed'; pa.run_id = res.run_id || null; pa.result = res.did || '';
  await kput(env, P.pending + id, pa, FINDING_TTL);
  await d.slackPost(env, `🧠 *מוח · אושר* · ${pb.name_he} · ${f.title_he} → ${res.ok ? 'בוצע' : 'לא הושלם'}${res.did ? ' (' + res.did + ')' : ''} · ${who}`).catch(() => {});
  return { status: 200, body: { ok: true, applied: true, action: pa, result: res } };
}

export async function runLogAppend(env, b) {
  const run_id = String(b.run_id || '');
  if (!/^r[0-9a-z]{6,24}$/.test(run_id)) return { status: 400, body: { ok: false, error: 'bad-run-id' } };
  const raw = Array.isArray(b.lines) ? b.lines : [b.line];
  const texts = raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 20);
  if (!texts.length) return { status: 400, body: { ok: false, error: 'line-required' } };
  const idx = (await kjson(env, P.runs)) || [];
  const known = idx.find(r => r.run_id === run_id);
  if (!known && !b.automation_id) return { status: 404, body: { ok: false, error: 'unknown-run (pass automation_id to open an external run)' } };
  const cur = (await kjson(env, P.log + run_id)) || { lines: [] };
  if (cur.lines.length >= 500) return { status: 429, body: { ok: false, error: 'run-log-full' } };
  let seq = cur.lines.length; const at = new Date().toISOString();
  const lines = texts.map(text => ({ id: 0, seq: ++seq, at, run_id, step: seq, text: maskText(text).slice(0, 500), src: 'agent' }));
  await appendLog(env, run_id, known ? known.automation_id : String(b.automation_id).slice(0, 40), lines);
  return { status: 200, body: { ok: true, run_id, appended: lines.length, total: seq } };
}

export async function buildBrain(env, { since = 0, now = Date.now() } = {}) {
  const [idx, last, runsIdx, pidx] = await Promise.all([loadIndex(env), kjson(env, P.last), kjson(env, P.runs), kjson(env, P.pending + 'index')]);
  const ids = Object.keys(idx.f);
  const fs = (await Promise.all(ids.map(id => kjson(env, P.finding + id)))).filter(Boolean)
    .map(({ data, last_saved, ...f }) => ({ ...f, title_he: maskText(f.title_he), evidence: (f.evidence || []).map(maskText), detail: maskText(f.detail) }));
  fs.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
  const pending = (await Promise.all((pidx || []).slice(0, 50).map(id => kjson(env, P.pending + id)))).filter(Boolean);
  const runList = (runsIdx || []).slice(0, 12);
  const logs = (await Promise.all(runList.map(r => kjson(env, P.log + r.run_id)))).filter(Boolean);
  const stream = logs.flatMap(l => l.lines || []).filter(l => !since || l.id > since).sort((a, b) => a.id - b.id).slice(-300);
  const sevenAgo = new Date(now - 7 * 86400e3).toISOString();
  const brainRuns = (await listRuns(env, { from: sevenAgo, limit: 200 })).items.filter(r => /^brain_/.test(r.automation_id));
  const pbStats = id => { const xs = brainRuns.filter(r => r.automation_id === 'brain_fix:' + id); return { runs_7d: xs.length, last_run: xs[0] ? xs[0].started_at : null, last_status: xs[0] ? xs[0].status : null }; };
  return {
    ok: true, at: new Date(now).toISOString(), last_check_at: last ? last.at : null, last_check_run_id: last ? last.run_id : null,
    checks: CHECKS.map(k => ({ id: k.id, name_he: k.name_he, every_min: k.every_min, last: (last && last.checks && last.checks[k.id]) || null })),
    findings: { open: fs.filter(f => f.state !== 'resolved'), resolved: fs.filter(f => f.state === 'resolved').slice(0, 30) },
    pending: pending.filter(p => p.state === 'pending'), decided: pending.filter(p => p.state !== 'pending').slice(0, 20),
    playbooks: PLAYBOOKS.map(p => ({ id: p.id, name_he: p.name_he, auto: p.auto, messages: p.messages, ...pbStats(p.id) })),
    runs: brainRuns.slice(0, 30).map(r => ({ id: r.id, automation_id: r.automation_id, started_at: r.started_at, ended_at: r.ended_at, status: r.status, triggered_by: r.triggered_by, counts: r.counts })),
    stream, cursor: stream.length ? stream[stream.length - 1].id : (since || null),
    autofix: String(env.BRAIN_AUTOFIX || 'on') !== 'off', agent_hook: !!env.BRAIN_AGENT_HOOK,
  };
}
