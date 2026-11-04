/* ============================================================================
   ishur.io · slack-gate.js · the state-change gate in front of Slack (04/11/2026)
   ----------------------------------------------------------------------------
   Richard 04/11: "תצמצם ספאם בסלאק". ~15 Slack lines a day, most of them the
   same standing condition said again (notify.js re-alerts every `window`,
   the brain re-alerts every REALERT_MS, index.js has its own once-per-hour /
   once-per-day markers). docs/SLACK-DEDUPE-2026-11-04.md lists every poster.

   One rule, applied in slackSend (slack.js) so no poster can skip it:
     every alert carries a `key` — the identity of the CONDITION, not of the
     message (`131042:4499`, `cap_high`, `hold_stale:<tok8>`, `finding:<id>`).
     Slack gets a line only when
       OPEN   the key is new (no slackstate:<key> in KV)
       WORSE  the severity went up (P2 → P1) or `level` crossed a higher band
       CLOSE  the condition resolved (slackResolve / slackSweep): ONE line
              "✅ נפתר" with how many times it repeated meanwhile
     anything else is SILENT: the repeat is counted in KV and nothing posts.
     A poster with no key and no `oneoff: true` gets an automatic key from its
     title line (autoKey) — so an unannotated poster is deduped, never spammy.
     `oneoff: true` is for genuinely single events (a payment landed, a lead
     came in, a send completed) and the call site must say so in a comment.

   Routing by class (`cls`):
     'p1'   (default) something Richard must do → Slack, through the gate
     'info' cap %, template approved, brain auto-fixed, verification attempts,
            capacity planner overflow… → the ops notifications center (notify.js
            app channel, rule 'info') + the 09:00 morning digest. Never Slack
            on its own.

   State: KV slackstate:<key> {opened_at, last_at, sev, last_level, count, title, cls}
          KV slackclosed:<day> [ {key, title, opened_at, count, closed_at} ]   (digest: נפתר בלילה)
          KV slackinfo:<day>   [ {at, text} ]                                 (digest: info lines)
   The morning digest (slackDigest, 09:00 IL, registry node slack_digest,
   kill switch auto:off:slack_digest) posts "בוקר · סיכום": open conditions,
   what resolved overnight, the info lines, the night queue (slackq:list) and
   today's plan (sends / calls / events) from an injected fn.
   ========================================================================== */

export const STATE = 'slackstate:';
export const CLOSED = 'slackclosed:';
export const INFO = 'slackinfo:';
export const DIGEST_SENT = 'slackdigest:sent:';
const STATE_TTL = 30 * 86400;
const DAY_TTL = 3 * 86400;
export const SEV = ['P0', 'P1', 'P2', 'P3'];
export const DEFAULT_BANDS = [1, 5, 15, 50, 100, 250, 500, 1000];

/* ── pure ──────────────────────────────────────────────────────────────── */
export const sevRank = s => { const i = SEV.indexOf(String(s || '').toUpperCase()); return i < 0 ? 2 : i; };   /* unknown = P2 */
export function band(level, bands = DEFAULT_BANDS) {
  const n = Number(level);
  if (!Number.isFinite(n)) return -1;
  let b = 0; for (const t of bands) if (n >= t) b++;
  return b;
}
/* the identity of a message with no key: its title line without the numbers */
export function autoKey(text) {
  const line = String(text || '').split('\n')[0]
    .replace(/[*_~`>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '')
    .replace(/\b[0-9a-f]{8}\b/gi, '')
    .replace(/[\d₪%:.,()'"]+/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return 'auto:' + (line.slice(0, 60) || 'blank');
}
export function ilDay(ts = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function ilHour(ts = Date.now()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(ts))) % 24;
}
const hhmm = ts => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts));
const ddmm = ts => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' }).format(new Date(ts));

/* the decision, pure: previous state (or null) + this alert → what to do.
   returns { kind: 'open'|'worse'|'silent', next } */
export function decide(prev, cur, now = Date.now()) {
  const sev = SEV[sevRank(cur.sev)];
  const level = Number.isFinite(Number(cur.level)) ? Number(cur.level) : null;
  const at = new Date(now).toISOString();
  if (!prev) return { kind: 'open', next: { opened_at: at, last_at: at, sev, last_level: level, count: 1, title: cur.title, cls: cur.cls || 'p1' } };
  const next = { ...prev, last_at: at, count: (Number(prev.count) || 0) + 1, title: cur.title || prev.title };
  let worse = false;
  if (sevRank(sev) < sevRank(prev.sev)) worse = true;
  if (level != null && (prev.last_level == null || band(level, cur.bands) > band(prev.last_level, cur.bands))) worse = true;
  if (worse) { next.sev = SEV[Math.min(sevRank(sev), sevRank(prev.sev))]; next.last_level = level != null ? Math.max(level, Number(prev.last_level) || 0) : prev.last_level; }
  else if (level != null && (prev.last_level == null || level > prev.last_level)) next.last_level = level;   /* track, within the band */
  return { kind: worse ? 'worse' : 'silent', next };
}

/* Richard's format: title · spaced facts · action footer */
export function withAction(text, action) {
  const t = String(text || '').trim();
  if (!t || /מה לעשות:|נדרשת פעולה ממך|לא נדרשת פעולה/.test(t)) return t;
  return t + '\n\n───\nמה לעשות: ' + (action || 'לבדוק במרכז הבקרה — ishur.io/ops.html');
}
export function closeText(key, st, now = Date.now()) {
  const n = Number(st && st.count) || 1;
  const title = String((st && st.title) || key).split('\n')[0].replace(/[*]/g, '').trim();
  return `✅ *נפתר* · ${title}\n\n• פתוח מ-${st && st.opened_at ? ddmm(st.opened_at) + ' ' + hhmm(st.opened_at) : '?'}${n > 1 ? `\n\n• חזר ${n} פעמים בינתיים (לא דווח שוב)` : ''}\n\n───\nמה לעשות: כלום, נסגר לבד.`;
}
export function worseText(text, prev, cur) {
  const from = prev ? `${prev.sev}${prev.last_level != null ? ' · ' + prev.last_level : ''}` : '?';
  const to = `${SEV[sevRank(cur.sev)]}${cur.level != null ? ' · ' + cur.level : ''}`;
  return `⬆️ *החמיר* (${from} → ${to}) · ` + String(text || '').trim();
}

/* ── KV ────────────────────────────────────────────────────────────────── */
async function kjson(env, k) { try { return JSON.parse((env.RATE && await env.RATE.get(k)) || 'null'); } catch { return null; } }
async function kput(env, k, v, ttl) { try { if (env.RATE) await env.RATE.put(k, JSON.stringify(v), { expirationTtl: ttl }); } catch {} }
async function kdel(env, k) { try { if (env.RATE) await env.RATE.delete(k); } catch {} }
async function kpush(env, k, item, ttl, cap = 200) {
  const list = (await kjson(env, k)) || [];
  (Array.isArray(list) ? list : []).push(item);
  await kput(env, k, list.slice(-cap), ttl);
}

/* the gate: → { post: bool, kind, text, state } . Without KV (tests, local)
   every alert is OPEN — nothing is ever lost, just not deduped. */
export async function gate(env, { key, text, sev = 'P2', level = null, bands, cls = 'p1', action, now = Date.now() }) {
  const title = String(text || '').split('\n')[0].slice(0, 160);
  if (!key) return { post: true, kind: 'open', text: withAction(text, action), state: null };
  const prev = env.RATE ? await kjson(env, STATE + key) : null;
  const { kind, next } = decide(prev, { sev, level, bands, title, cls }, now);
  await kput(env, STATE + key, next, STATE_TTL);
  if (kind === 'open') return { post: true, kind, text: withAction(text, action), state: next };
  if (kind === 'worse') return { post: true, kind, text: withAction(worseText(text, prev, { sev, level }), action), state: next };
  return { post: false, kind, text: '', state: next };
}
export async function isOpen(env, key) { return !!(await kjson(env, STATE + key)); }
/* the condition resolved → one CLOSE line (or nothing when it was never open) */
export async function resolve(env, key, { now = Date.now(), post } = {}) {
  const st = await kjson(env, STATE + key);
  if (!st) return { posted: false, why: 'not-open' };
  await kdel(env, STATE + key);
  const rec = { key, title: st.title, opened_at: st.opened_at, count: st.count, closed_at: new Date(now).toISOString() };
  await kpush(env, CLOSED + ilDay(now), rec, DAY_TTL);
  const text = closeText(key, st, now);
  if (post) await post(text);
  return { posted: !!post, text, state: st };
}
/* standing conditions evaluated each tick: every open key under `prefix`
   that is not in `active` has resolved. Caller passes the FULL current set
   (pre-dedup), and skips the sweep when the evaluation did not run. */
export async function sweep(env, prefix, active, { now = Date.now(), post } = {}) {
  if (!env.RATE) return { closed: [] };
  const keep = new Set(active || []);
  const closed = [];
  let cursor; for (let i = 0; i < 5; i++) {
    const p = await env.RATE.list({ prefix: STATE + prefix, cursor, limit: 1000 }).catch(() => null); if (!p) break;
    for (const k of p.keys || []) { const key = k.name.slice(STATE.length); if (!keep.has(key)) closed.push(key); }
    if (p.list_complete) break; cursor = p.cursor;
  }
  for (const key of closed) await resolve(env, key, { now, post });
  return { closed };
}
/* info-class line: the notifications center + the morning digest, never Slack */
export async function info(env, text, { key, now = Date.now(), notify } = {}) {
  await kpush(env, INFO + ilDay(now), { at: new Date(now).toISOString(), key: key || null, text: String(text || '').slice(0, 400) }, DAY_TTL);
  if (notify) await notify(env, { rule: 'info', title_he: String(text || '').split('\n')[0].slice(0, 200), body_he: String(text || '').split('\n').slice(1).join('\n').slice(0, 1000), entity: key || '' }).catch(() => {});
  return { ok: true };
}

/* ── the morning digest ──────────────────────────────────────────────────── */
export async function openConditions(env) {
  if (!env.RATE) return [];
  const out = []; let cursor;
  for (let i = 0; i < 5; i++) {
    const p = await env.RATE.list({ prefix: STATE, cursor, limit: 1000 }).catch(() => null); if (!p) break;
    for (const k of p.keys || []) { const st = await kjson(env, k.name); if (st) out.push({ key: k.name.slice(STATE.length), ...st }); }
    if (p.list_complete) break; cursor = p.cursor;
  }
  out.sort((a, b) => sevRank(a.sev) - sevRank(b.sev) || String(a.opened_at).localeCompare(String(b.opened_at)));
  return out;
}
export function digestText({ open = [], closed = [], info = [], night = [], plan = null, now = Date.now() }) {
  const L = [`☀️ *בוקר · סיכום* ${ddmm(now)}`];
  if (open.length) L.push(`*פתוח (${open.length}):*\n` + open.slice(0, 15).map(o => `• ${o.sev} · ${String(o.title || o.key).replace(/[*]/g, '')} — מ-${ddmm(o.opened_at)}${Number(o.count) > 1 ? ` · חזר ${o.count}×` : ''}`).join('\n'));
  else L.push('*פתוח:* אין תנאים פתוחים 🎉');
  if (closed.length) L.push(`*נפתר בלילה (${closed.length}):*\n` + closed.slice(0, 15).map(c => `• ${String(c.title || c.key).replace(/[*]/g, '')}${Number(c.count) > 1 ? ` (חזר ${c.count}×)` : ''}`).join('\n'));
  if (info.length) L.push(`*מידע (${info.length}):*\n` + info.slice(-15).map(i => `• ${String(i.text).split('\n')[0].replace(/[*]/g, '')}`).join('\n'));
  if (night.length) L.push(`*מה קרה בלילה (${night.length}):*\n` + night.slice(-15).map((t, i) => `${i + 1}. ${String(t).split('\n')[0].replace(/[*]/g, '')}`).join('\n'));
  if (plan) L.push(`*תוכנית להיום:*\n• שליחות: ${plan.sends ?? '?'}\n• שיחות: ${plan.calls ?? '?'}\n• אירועים: ${plan.events ?? '?'}${plan.note ? '\n• ' + plan.note : ''}`);
  L.push('───\nמה לעשות: ' + (open.some(o => sevRank(o.sev) <= 1) ? 'לטפל בפתוחים האדומים; השאר ממתין.' : 'כלום דחוף. הכל במרכז הבקרה — ishur.io/ops.html'));
  return L.join('\n\n');
}
/* once per Israel day after 09:00; posts straight to the hook (it IS the
   morning window). `post` injected so tests never touch Slack. */
export async function slackDigest(env, { now = Date.now(), post, plan, force = false, flushNight } = {}) {
  if (!env.RATE) return { ok: false, why: 'no-kv' };
  const day = ilDay(now);
  if (!force) {
    if (ilHour(now) < 9) return { ok: true, skipped: 'before-09' };
    if (await env.RATE.get(DIGEST_SENT + day).catch(() => null)) return { ok: true, skipped: 'sent' };
  }
  await kput(env, DIGEST_SENT + day, { at: new Date(now).toISOString() }, 2 * 86400);
  const yday = ilDay(now - 86400e3);
  const [open, closedY, closedT, infoY, infoT] = await Promise.all([openConditions(env), kjson(env, CLOSED + yday), kjson(env, CLOSED + day), kjson(env, INFO + yday), kjson(env, INFO + day)]);
  let night = [];
  try { night = JSON.parse(await env.RATE.get('slackq:list')) || []; } catch {}
  if (!Array.isArray(night)) night = [];
  const p = plan ? await plan().catch(() => null) : null;
  const text = digestText({ open, closed: [...(closedY || []), ...(closedT || [])], info: [...(infoY || []), ...(infoT || [])], night, plan: p, now });
  if (post) await post(text);
  if (night.length) { if (flushNight) await flushNight(); else await kdel(env, 'slackq:list'); }
  await kdel(env, INFO + yday); await kdel(env, CLOSED + yday);
  return { ok: true, posted: !!post, open: open.length, closed: (closedY || []).length + (closedT || []).length, info: (infoY || []).length + (infoT || []).length, night: night.length, text };
}
