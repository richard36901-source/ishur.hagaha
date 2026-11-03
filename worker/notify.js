/* ============================================================================
   ishur.io · notify.js · smart notifications + the business overview (03/11/2026)
   ----------------------------------------------------------------------------
   docs/OPS-CENTER-PLAN-2026-11-03.md §10 · docs/OPS-NOTIFY-2026-11-03.md

   Richard: "I don't want to open each screen to understand; I want smart alerts
   and updates, important things surface on the overview."

   Rules (RULES below) run in the 10-minute brain tick (runNotify, scheduled() in
   index.js) and on events (notifyEvent(env, d, rule, payload) — callable from any
   hook). Event rules ALSO catch up in the tick from state (new CRM leads, lead
   replies, Grow `pay` audit rows, the change log for deploy/template/brain), so
   nothing is lost when a hook isn't wired yet.

   Notification: {id, at, severity P0–P3, rule, title_he, body_he, deep_link,
                  entity, read, snoozed_until, channels[], data}
   Storage: D1 OPS_DB `notifications` (migrations/0005), else the KV ring
     ntf:r:<inverted ms>:<id> with the whole notification in the key metadata
     (one list() call reads a page), ntf:i:<id> → ring key (for mark).
   De-dup: KV ntf:dd:<rule>:<entity> for the rule's window (TTL).
   Channels (per rule, KV cfg:notify:<rule> {on, min_severity, channels[], quiet, digest_hour}):
     app       always (when the rule is on)
     slack     d.slackSend (slack.js has its own quiet-hours queue)
     push      KV push:queue (≤50, newest last), pulled + cleared by
               POST /api/ops/notifications/push-pull — a session-side watcher
               (Claude's PushNotification while a session is open) polls it.
     whatsapp  free text to Richard 972545764327 via Noa (client channel); only P0,
               only 09:00–21:00 IL, never Shabbat. Quiet hours never apply to app.
   Severity filter: a notification below the rule's min_severity is kept in-app only.

   Routes (mounted from ops.js with one line):
     GET  /api/ops/notifications?unread=1&cursor=&limit=   list + unread count
     POST /api/ops/notifications/mark      {ids[], read?:bool, snooze_until?:ISO|null}
     POST /api/ops/notifications/push-pull the push queue (and clears it)
     GET  /api/ops/notify-settings         every rule with its effective setting
     POST /api/ops/notify-settings         {rule, patch:{on,min_severity,channels,quiet,digest_hour}}
     POST /api/ops/edit {id:'notify:<rule>', field, value}   same, through the edit route
     GET  /api/ops/overview                the whole overview payload in one call
     POST /api/ops/overview {seen:true}    stamps lastseen:ops (the "since last visit" mark)
   Every settings change is written to the change log (kind 'edit').
   ========================================================================== */
import { recordChange, listChanges } from './changes.js';

export const RICHARD_PHONE = '972545764327';
export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
export const CHANNELS = ['app', 'slack', 'push', 'whatsapp'];
export const CFG_PREFIX = 'cfg:notify:';
export const LASTSEEN_KEY = 'lastseen:ops';
export const PUSH_KEY = 'push:queue';
export const TICK_KEY = 'ntf:tick';
const RING = 'ntf:r:', IDX = 'ntf:i:', DD = 'ntf:dd:';
const TTL = 60 * 86400, INV = 9999999999999, H = 3600e3, MIN = 60e3;

/* ── the rule catalog (defaults Richard can change on the settings tab) ── */
export const RULES = [
  { id: 'incident', he: 'תקלה במערכת (מהמוח)', sev: 'P1', window: 6 * H, d: { on: true, min_severity: 'P1', channels: ['app', 'slack', 'push', 'whatsapp'], quiet: true } },
  { id: 'new_lead', he: 'ליד חדש', sev: 'P2', window: 24 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'slack', 'push'], quiet: true } },
  { id: 'lead_reply', he: 'ליד ענה בשיחת המכירה', sev: 'P2', window: 1 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'push'], quiet: true } },
  { id: 'payment', he: 'תשלום התקבל', sev: 'P1', window: 7 * 24 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'slack', 'push'], quiet: true } },
  { id: 'unanswered', he: 'ליד / לקוח מחכה לתשובה מעל שעתיים', sev: 'P1', window: 6 * H, d: { on: true, min_severity: 'P1', channels: ['app', 'slack', 'push'], quiet: true } },
  { id: 'event_readiness', he: 'אירוע בעוד 3 ימים וחסר משהו', sev: 'P1', window: 24 * H, d: { on: true, min_severity: 'P1', channels: ['app', 'slack', 'push'], quiet: true } },
  { id: 'failures_spike', he: 'קפיצה בכשלי וואטסאפ', sev: 'P1', window: 3 * H, d: { on: true, min_severity: 'P1', channels: ['app', 'slack', 'push'], quiet: true } },
  { id: 'cap_high', he: 'התקרה היומית מעל 85%', sev: 'P2', window: 12 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'slack'], quiet: true } },
  { id: 'hold_stale', he: 'אירוע בהחזקה יותר מיומיים', sev: 'P2', window: 24 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'slack'], quiet: true } },
  { id: 'balances_low', he: 'יתרה נמוכה אצל ספק', sev: 'P1', window: 24 * H, d: { on: true, min_severity: 'P1', channels: ['app', 'slack', 'push'], quiet: true } },
  { id: 'template_status', he: 'תבנית אושרה / נדחתה', sev: 'P2', window: 24 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'slack'], quiet: true } },
  { id: 'brain_autofix', he: 'המוח תיקן משהו לבד', sev: 'P3', window: 6 * H, d: { on: true, min_severity: 'P2', channels: ['app', 'slack'], quiet: true } },
  { id: 'deploy', he: 'גרסה חדשה עלתה', sev: 'P3', window: 30 * 24 * H, d: { on: true, min_severity: 'P3', channels: ['app'], quiet: true } },
  { id: 'weekly_digest', he: 'סיכום שבועי (ראשון)', sev: 'P3', window: 6 * 24 * H, d: { on: true, min_severity: 'P3', channels: ['app', 'slack'], quiet: false, digest_hour: 9 } },
];
export const RULE = Object.fromEntries(RULES.map(r => [r.id, r]));

/* ══ §1 pure ═══════════════════════════════════════════════════════════════ */
export const sevRank = s => { const i = SEVERITIES.indexOf(s); return i < 0 ? 3 : i; };
export function ilClock(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { h: Number(p.hour), m: Number(p.minute), dow: p.weekday, day: `${p.year}-${p.month}-${p.day}` };
}
export const ilDay = ts => ilClock(ts).day;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/* 21:00–09:00 IL = quiet (push + WhatsApp held; in-app always) */
export function isQuiet(ts) { const c = ilClock(ts); return c.h >= 21 || c.h < 9; }
/* "in hours" for the unanswered rule and WhatsApp to Richard: 09–21, not Shabbat */
export function inHours(ts) { const c = ilClock(ts); return c.dow !== 'Sat' && c.h >= 9 && c.h < 21; }
/* hours of business time between a and b (only 09–21 Sun–Fri count), coarse: 10-minute steps */
export function hoursInHours(a, b) { let n = 0; for (let t = a; t < b; t += 10 * MIN) if (inHours(t)) n++; return n / 6; }

export function newNotifId(now = Date.now()) { return `n${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`; }

export function defaultCfg(ruleId) { const r = RULE[ruleId]; return r ? { ...r.d, channels: [...r.d.channels], digest_hour: r.d.digest_hour ?? null } : null; }
export function mergeCfg(ruleId, stored) {
  const d = defaultCfg(ruleId); if (!d) return null;
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = { ...d };
  if (typeof s.on === 'boolean') out.on = s.on;
  if (SEVERITIES.includes(s.min_severity)) out.min_severity = s.min_severity;
  if (Array.isArray(s.channels)) out.channels = ['app', ...s.channels.filter(c => CHANNELS.includes(c) && c !== 'app')];
  if (typeof s.quiet === 'boolean') out.quiet = s.quiet;
  if (Number.isInteger(s.digest_hour) && s.digest_hour >= 0 && s.digest_hour <= 23) out.digest_hour = s.digest_hour;
  if (s.muted && typeof s.muted === 'object') out.muted = s.muted;   /* per-entity mute {entity: untilISO} */
  return out;
}
/* validate one settings patch → {ok, patch} | {ok:false, why} */
export function validPatch(ruleId, patch) {
  if (!RULE[ruleId]) return { ok: false, why: 'unknown-rule' };
  const p = patch && typeof patch === 'object' ? patch : null; if (!p) return { ok: false, why: 'patch-required' };
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'on' || k === 'quiet') { if (typeof v !== 'boolean') return { ok: false, why: k + ' must be true/false' }; out[k] = v; }
    else if (k === 'min_severity') { if (!SEVERITIES.includes(v)) return { ok: false, why: 'min_severity must be P0–P3' }; out[k] = v; }
    else if (k === 'channels') { if (!Array.isArray(v) || v.some(c => !CHANNELS.includes(c))) return { ok: false, why: 'channels ⊂ ' + CHANNELS.join(',') }; out[k] = ['app', ...new Set(v.filter(c => c !== 'app'))]; }
    else if (k === 'digest_hour') { if (!Number.isInteger(v) || v < 0 || v > 23) return { ok: false, why: 'digest_hour 0–23' }; out[k] = v; }
    else if (k === 'mute') { if (!v || typeof v.entity !== 'string') return { ok: false, why: 'mute {entity, until}' }; out.mute = { entity: v.entity.slice(0, 80), until: v.until ? String(v.until) : null }; }
    else return { ok: false, why: 'unknown field ' + k };
  }
  if (!Object.keys(out).length) return { ok: false, why: 'empty-patch' };
  return { ok: true, patch: out };
}

/* where one notification goes, given its rule setting and the clock */
export function routeChannels(n, cfg, now = Date.now()) {
  if (!cfg || !cfg.on) return [];
  if (cfg.muted && n.entity && cfg.muted[n.entity] && (!cfg.muted[n.entity].until || Date.parse(cfg.muted[n.entity].until) > now)) return ['app'];
  const out = ['app'];
  if (sevRank(n.severity) > sevRank(cfg.min_severity)) return out;   /* below threshold: in-app only */
  const quiet = cfg.quiet !== false && isQuiet(now);
  for (const c of cfg.channels || []) {
    if (c === 'slack') out.push('slack');
    if (c === 'push' && !quiet) out.push('push');
    if (c === 'whatsapp' && n.severity === 'P0' && inHours(now) && !isQuiet(now)) out.push('whatsapp');
  }
  return [...new Set(out)];
}

export function makeNotification({ rule, severity, title_he, body_he = '', deep_link = '', entity = '', data = null, at = null, id = null }, now = Date.now()) {
  const r = RULE[rule];
  return {
    id: id || newNotifId(now), at: at || new Date(now).toISOString(), severity: SEVERITIES.includes(severity) ? severity : (r ? r.sev : 'P3'),
    rule: r ? rule : 'incident', title_he: String(title_he || (r && r.he) || '').slice(0, 200), body_he: String(body_he || '').slice(0, 1000),
    deep_link: String(deep_link || '#/overview').slice(0, 300), entity: String(entity || '').slice(0, 120), read: false, snoozed_until: null, channels: [], data,
  };
}
export const visible = (n, now = Date.now()) => !n.snoozed_until || Date.parse(n.snoozed_until) <= now;
export const isUnread = (n, now = Date.now()) => !n.read && visible(n, now);
const hhmm = ts => { const c = ilClock(ts); return String(c.h).padStart(2, '0') + ':' + String(c.m).padStart(2, '0'); };
const ils = n => '₪' + Math.round(Number(n) || 0).toLocaleString('en-US');
const mask = p => { const s = String(p || ''); return s.length >= 9 ? '0' + s.slice(3, 5) + '-***-' + s.slice(-4) : s; };
const nameOrPhone = l => (l && (l.name || mask(l.phone))) || 'ליד';
const SRC_HE = { meta_form: 'טופס פייסבוק', whatsapp: 'וואטסאפ', web: 'האתר', manual: 'ידני', referral: 'המלצה' };

/* ── the rules, pure: data in → candidate notifications out ─────────────── */
export const evaluate = {
  new_lead(leads, sinceIso) {
    return (leads || []).filter(l => l.created_at && l.created_at > sinceIso).map(l => ({
      rule: 'new_lead', entity: 'lead:' + l.id, at: l.created_at,
      title_he: `ליד חדש: ${nameOrPhone(l)} מ${SRC_HE[l.source] || 'מקור לא ידוע'}. לענות תוך שעה.`,
      body_he: [l.last_text || l.message || l.note ? `כתב/ה: "${String(l.last_text || l.message || l.note).slice(0, 160)}"` : '', l.occasion ? 'אירוע: ' + l.occasion : '', l.guests ? 'אורחים: ' + l.guests : '', 'הצעד הבא: לפתוח את הליד ולשלוח הצעה (יש נוסח מוכן).'].filter(Boolean).join('\n'),
      deep_link: '#/leads/' + encodeURIComponent(l.id),
    }));
  },
  lead_reply(leads, sinceIso) {
    return (leads || []).filter(l => l.last_inbound_at && l.last_inbound_at > sinceIso && (l.created_at || '') < l.last_inbound_at && ['new', 'talking', 'quoted'].includes(l.status))
      .map(l => ({ rule: 'lead_reply', entity: 'lead:' + l.id, at: l.last_inbound_at,
        title_he: `${nameOrPhone(l)} ענה/תה${l.status === 'quoted' ? ' על ההצעה' : ''}. לפתוח ולהמשיך את השיחה.`, deep_link: '#/inbox?focus=' + encodeURIComponent(l.phone || ''), data: { status: l.status } }));
  },
  payment(closed) {
    return (closed || []).map(c => ({ rule: 'payment', entity: 'pay:' + c.ref, at: c.at,
      title_he: `שולם ${ils(c.sum)}: ${c.event}${c.package ? ' · ' + c.package : ''}. לוודא שהרשימה הועלתה.`,
      body_he: 'הצעד הבא: הלקוח מקבל קישור העלאה אוטומטית. אם תוך יום אין רשימה, לשלוח תזכורת מכרטיס הלקוח.',
      deep_link: c.tok8 ? '#/clients?focus=' + c.tok8 : '#/clients', data: { sum: c.sum, ref: c.ref } }));
  },
  changes(rows) {
    const out = [];
    for (const r of rows || []) {
      if (r.kind === 'deploy') out.push({ rule: 'deploy', entity: 'chg:' + r.id, at: r.at, title_he: `גרסה חדשה עלתה: ${String(r.summary_he || '').slice(0, 120)}`, deep_link: '#/changes?focus=' + r.id });
      else if (r.kind === 'template') { const rej = /דח|reject|paused|disabled/i.test(r.summary_he || '') || /REJECT/i.test(JSON.stringify(r.details || {}));
        out.push({ rule: 'template_status', severity: rej ? 'P1' : 'P2', entity: 'chg:' + r.id, at: r.at, title_he: `${rej ? 'תבנית נדחתה' : 'עדכון תבנית'}: ${String(r.summary_he || '').slice(0, 120)}${rej ? '. לתקן נוסח ולהגיש שוב.' : ''}`, deep_link: '#/changes?focus=' + r.id }); }
      else if (r.kind === 'brain' && r.actor === 'brain') out.push({ rule: 'brain_autofix', entity: 'chg:' + r.id, at: r.at, title_he: `המוח תיקן לבד: ${String(r.summary_he || '').slice(0, 140)}. אין צורך לעשות כלום.`, body_he: (r.details && (r.details.why || r.details.did)) ? String(r.details.why || r.details.did).slice(0, 400) : '', deep_link: '#/brain' });
    }
    return out;
  },
  incident(findings) {
    const map = { P1: 'P0', P2: 'P1', P3: 'P2' };
    return (findings || []).filter(f => f.status === 'fail' && f.state !== 'resolved').map(f => ({ rule: 'incident', severity: map[f.severity] || 'P2', entity: 'finding:' + f.id, at: f.first_seen || f.last_seen,
      title_he: `${f.title_he}${f.state === 'needs_approval' ? '. יש תיקון שמחכה לאישור שלך.' : f.state === 'handling' ? '. המוח מטפל.' : '. לבדוק במסך המוח.'}`, body_he: f.detail || '', deep_link: '#/brain?focus=' + encodeURIComponent(f.id) }));
  },
  failures_spike(rt) {
    const t = (rt && rt.wa && rt.wa.totals) || {}; const failed = (t.rejected_today || 0) + (t.failed_async_today || 0), sent = t.sent_today || 0;
    if (failed < 15 || failed < 0.05 * Math.max(sent, 1)) return [];
    return [{ rule: 'failures_spike', severity: failed >= 50 ? 'P0' : 'P1', entity: 'day:' + (rt.today || ''), title_he: `${failed} הודעות וואטסאפ נכשלו היום (מתוך ${sent}). לבדוק את הסיבה במסך ההודעות.`, deep_link: '#/messaging?tab=failed', data: { failed, sent } }];
  },
  cap_high(rt) {
    const c = rt && rt.cap; if (!c || !c.limit) return [];
    const pct = Math.round(100 * (c.used || 0) / c.limit);
    return pct >= 85 ? [{ rule: 'cap_high', severity: pct >= 97 ? 'P1' : 'P2', entity: 'day:' + (rt.today || ''), title_he: `התקרה היומית ב-${pct}% (${c.used}/${c.limit}). מה שלא ייצא היום יידחה למחר.`, deep_link: '#/capacity', data: { pct } }] : [];
  },
  hold_stale(holds, now) {
    return (holds || []).filter(h => h.since && now - Date.parse(h.since) > 48 * H).map(h => ({ rule: 'hold_stale', entity: 'event:' + h.tok8, title_he: `האירוע ${h.name || h.tok8} עצור כבר ${Math.floor((now - Date.parse(h.since)) / (24 * H))} ימים. לשחרר או לבטל.`, deep_link: '#/control?focus=' + h.tok8 }));
  },
  unanswered(convs, now) {
    return (convs || []).filter(c => ['lead', 'client'].includes(c.role) && c.last_dir === 'in' && !c.nonrelevant && c.last_in_ts && hoursInHours(c.last_in_ts, now) >= 2)
      .map(c => ({ rule: 'unanswered', entity: c.role + ':' + c.phone, title_he: `${c.role === 'client' ? 'לקוח' : 'ליד'} ${c.name || c.wa_name || mask(c.phone)} מחכה לתשובה מ-${hhmm(c.last_in_ts)}. לענות עכשיו.`, body_he: c.last_text ? `"${String(c.last_text).slice(0, 160)}"` : '', deep_link: '#/inbox?focus=' + encodeURIComponent(c.phone) }));
  },
  event_readiness(events, today) {
    const out = [];
    for (const e of events || []) {
      if (!e.date || e.date < today || e.date > addDays(today, 3)) continue;
      const gaps = (e.readiness || []).filter(x => x.state === 'missing');
      if (!gaps.length) continue;
      out.push({ rule: 'event_readiness', entity: 'event:' + e.tok8 + ':' + gaps.map(g => g.id).join(','), title_he: `${e.names || e.tok8} ב-${e.date.slice(8, 10)}/${e.date.slice(5, 7)}: חסר ${gaps.map(g => g.he).join(', ')}. לטפל היום.`, deep_link: '#/clients?focus=' + e.tok8, data: { gaps: gaps.map(g => g.id) } });
    }
    return out;
  },
  balances_low(bal) {
    return ((bal && bal.vendors) || []).filter(v => v.status === 'low').map(v => ({ rule: 'balances_low', entity: 'vendor:' + v.vendor, title_he: `יתרה נמוכה ב-${v.label || v.vendor}${v.amount != null ? ` (${v.amount} ${v.currency || ''})` : ''}. לטעון לפני שזה עוצר שליחה/שיחות.`, deep_link: '#/balances' }));
  },
};

/* readiness checklist for one client row (crm.js mergeClients shape + extra KV facts) */
export function readinessOf(c, x = {}) {
  const out = [];
  out.push({ id: 'list', he: 'רשימת מוזמנים', state: c.file_uploaded || (c.counts && c.counts.invited > 0) ? 'ok' : 'missing' });
  out.push({ id: 'invite', he: 'הזמנה', state: x.invite == null ? 'unknown' : x.invite ? 'ok' : 'missing' });
  if (c.addons && c.addons.design) out.push({ id: 'design', he: 'עיצוב', state: /done|approved|delivered|sent|final|ready/i.test(String(c.addons.design)) ? 'ok' : 'missing' });
  if (c.addons && c.addons.hostesses && c.addons.hostesses.n) out.push({ id: 'hostess', he: 'דיילות', state: c.addons.hostesses.booked ? 'ok' : 'missing' });
  if (x.gifts && x.gifts.on) out.push({ id: 'gifts', he: 'קישורי מתנה', state: x.gifts.bit || x.gifts.paybox ? 'ok' : 'missing' });
  return out;
}

export function digestText(s) {
  return `סיכום שבוע: ${ils(s.revenue)} הכנסות, ${s.orders} עסקאות, ${s.leads} לידים חדשים (${s.closed} נסגרו), ${s.sends} הודעות לאורחים, ${s.calls} שיחות.`;
}

/* ══ §2 storage ════════════════════════════════════════════════════════════ */
const COLS = ['id', 'at', 'severity', 'rule', 'title_he', 'body_he', 'deep_link', 'entity', 'read', 'snoozed_until', 'channels_json', 'data_json'];
const toRow = n => ({ ...n, read: n.read ? 1 : 0, channels_json: JSON.stringify(n.channels || []), data_json: n.data == null ? null : JSON.stringify(n.data) });
const fromRow = r => { const j = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } }; return { id: r.id, at: r.at, severity: r.severity, rule: r.rule, title_he: r.title_he, body_he: r.body_he || '', deep_link: r.deep_link || '', entity: r.entity || '', read: !!r.read, snoozed_until: r.snoozed_until || null, channels: j(r.channels_json) || [], data: j(r.data_json) }; };
const ringKey = n => `${RING}${String(INV - Date.parse(n.at)).padStart(13, '0')}:${n.id}`;
const meta = n => { const m = { ...n, data: undefined }; let s = JSON.stringify(m); if (s.length > 1000) { m.body_he = m.body_he.slice(0, Math.max(0, m.body_he.length - (s.length - 1000) - 4)); s = JSON.stringify(m); } if (s.length > 1000) m.title_he = m.title_he.slice(0, 120); return m; };

async function kjson(env, k) { try { return JSON.parse((env.RATE && await env.RATE.get(k)) || 'null'); } catch { return null; } }
async function kput(env, k, v, ttl) { try { if (env.RATE) await env.RATE.put(k, typeof v === 'string' ? v : JSON.stringify(v), ttl ? { expirationTtl: Math.max(60, Math.round(ttl)) } : undefined); } catch {} }

export async function storeNotification(env, n) {
  if (env.OPS_DB) {
    try { const row = toRow(n); await env.OPS_DB.prepare(`INSERT OR REPLACE INTO notifications (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).bind(...COLS.map(c => row[c] ?? null)).run(); return 'd1'; } catch {}
  }
  if (!env.RATE) return null;
  const k = ringKey(n);
  try { await env.RATE.put(k, '1', { expirationTtl: TTL, metadata: meta(n) }); await env.RATE.put(IDX + n.id, k, { expirationTtl: TTL }); return 'kv'; } catch { return null; }
}
async function ringPage(env, limit = 1000) {
  const out = []; let cursor;
  for (let i = 0; i < 3 && out.length < limit; i++) {
    const p = await env.RATE.list({ prefix: RING, cursor, limit: 1000 }).catch(() => null); if (!p) break;
    for (const k of p.keys || []) if (k.metadata) out.push(k.metadata);
    if (p.list_complete) break; cursor = p.cursor;
  }
  return out;
}
export async function listNotifications(env, { unread = false, cursor = '', limit = 50, now = Date.now() } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50)); const nowIso = new Date(now).toISOString();
  let rows = [], unreadN = 0, source = 'none';
  if (env.OPS_DB) {
    try {
      const w = [], b = [];
      if (unread) { w.push('read = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)'); b.push(nowIso); }
      if (cursor) { w.push('at < ?'); b.push(String(cursor)); }
      const r = await env.OPS_DB.prepare(`SELECT * FROM notifications${w.length ? ' WHERE ' + w.join(' AND ') : ''} ORDER BY at DESC LIMIT ?`).bind(...b, lim + 1).all();
      rows = (r.results || []).map(fromRow);
      const c = await env.OPS_DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read = 0 AND (snoozed_until IS NULL OR snoozed_until <= ?)').bind(nowIso).first();
      unreadN = Number(c && c.n) || 0; source = 'd1';
    } catch { rows = []; source = 'none'; }
  }
  if (source === 'none' && env.RATE) {
    const all = await ringPage(env);
    unreadN = all.filter(n => isUnread(n, now)).length;
    rows = all.filter(n => (!unread || isUnread(n, now)) && (!cursor || n.at < cursor)).slice(0, lim + 1); source = 'kv';
  }
  const more = rows.length > lim; rows = rows.slice(0, lim);
  return { items: rows, unread: unreadN, next_cursor: more ? rows[rows.length - 1].at : null, source };
}
export async function markNotifications(env, ids, { read, snooze_until } = {}) {
  const list = [...new Set((ids || []).map(String))].slice(0, 200); let n = 0;
  if (!list.length) return 0;
  if (env.OPS_DB) {
    try {
      const sets = [], b = [];
      if (typeof read === 'boolean') { sets.push('read = ?'); b.push(read ? 1 : 0); }
      if (snooze_until !== undefined) { sets.push('snoozed_until = ?'); b.push(snooze_until || null); }
      if (!sets.length) return 0;
      const r = await env.OPS_DB.prepare(`UPDATE notifications SET ${sets.join(', ')} WHERE id IN (${list.map(() => '?').join(',')})`).bind(...b, ...list).run();
      return Number(r && r.meta && r.meta.changes) || list.length;
    } catch {}
  }
  if (!env.RATE) return 0;
  for (const id of list) {
    const k = await env.RATE.get(IDX + id).catch(() => null); if (!k) continue;
    const page = await env.RATE.list({ prefix: k, limit: 1 }).catch(() => null);
    const m = page && page.keys && page.keys[0] && page.keys[0].metadata; if (!m) continue;
    if (typeof read === 'boolean') m.read = read;
    if (snooze_until !== undefined) m.snoozed_until = snooze_until || null;
    await env.RATE.put(k, '1', { expirationTtl: TTL, metadata: m }).catch(() => {}); n++;
  }
  return n;
}

/* ══ §3 settings ═══════════════════════════════════════════════════════════ */
export async function loadSettings(env) {
  const vals = await Promise.all(RULES.map(r => kjson(env, CFG_PREFIX + r.id)));
  return Object.fromEntries(RULES.map((r, i) => [r.id, mergeCfg(r.id, vals[i])]));
}
export async function saveSetting(env, ruleId, patch, { who = 'admin', now = Date.now() } = {}) {
  const v = validPatch(ruleId, patch); if (!v.ok) return { status: 400, body: { ok: false, error: 'invalid', why: v.why } };
  const before = mergeCfg(ruleId, await kjson(env, CFG_PREFIX + ruleId));
  const stored = (await kjson(env, CFG_PREFIX + ruleId)) || {};
  const { mute, ...rest } = v.patch;
  const next = { ...stored, ...rest };
  if (mute) { next.muted = { ...(stored.muted || {}) }; if (mute.until === 'off') delete next.muted[mute.entity]; else next.muted[mute.entity] = { until: mute.until }; }
  next.at = new Date(now).toISOString(); next.by = String(who).slice(0, 40);
  await kput(env, CFG_PREFIX + ruleId, next);
  const after = mergeCfg(ruleId, next);
  const show = c => `${c.on ? 'פעיל' : 'כבוי'} · ${c.min_severity}+ · ${c.channels.join('/')}${c.quiet ? ' · שקט בלילה' : ''}${c.digest_hour != null ? ' · ' + c.digest_hour + ':00' : ''}`;
  const chg = await recordChange(env, { kind: 'edit', who, summary_he: `התראות · ${RULE[ruleId].he}: ${show(before)} → ${show(after)}`,
    details: { setting: 'notify:' + ruleId, from: before, to: after, who },
    revert: null }, now);
  return { status: 200, body: { ok: true, applied: true, rule: ruleId, before, after, change_id: chg ? chg.id : null } };
}

/* ══ §4 delivery ═══════════════════════════════════════════════════════════ */
/* one candidate → de-dup → store → channels. Returns the stored notification or null (dup / off). */
export async function deliver(env, d, cand, { settings = null, now = Date.now() } = {}) {
  const rule = RULE[cand.rule]; if (!rule) return null;
  const cfg = (settings || {})[cand.rule] || mergeCfg(cand.rule, await kjson(env, CFG_PREFIX + cand.rule));
  if (!cfg.on) return null;
  const ddk = DD + cand.rule + ':' + String(cand.entity || '-').slice(0, 200);
  if (env.RATE && await env.RATE.get(ddk).catch(() => null)) return null;
  await kput(env, ddk, new Date(now).toISOString(), (rule.window || H) / 1000);
  const n = makeNotification({ ...cand, at: null, severity: cand.severity || rule.sev }, now);
  if (cand.at) n.data = { ...(n.data || {}), happened_at: cand.at };
  n.channels = routeChannels(n, cfg, now);
  const icon = { P0: '🚨', P1: '🔴', P2: '🟡', P3: 'ℹ️' }[n.severity];
  const link = 'https://ishur.io/ops.html' + n.deep_link;
  if (n.channels.includes('slack') && d && d.slackSend) await d.slackSend(env, `${icon} *${rule.he}* · ${n.title_he}${n.body_he ? '\n' + n.body_he : ''}\n${link}`, { urgent: sevRank(n.severity) <= 1 }).catch(() => { n.channels = n.channels.filter(c => c !== 'slack'); });
  if (n.channels.includes('push')) {
    const q = (await kjson(env, PUSH_KEY)) || [];
    q.push({ id: n.id, at: n.at, severity: n.severity, title_he: n.title_he, deep_link: n.deep_link, url: link });
    await kput(env, PUSH_KEY, q.slice(-50), 7 * 86400);
  }
  if (n.channels.includes('whatsapp')) {
    const r = d && d.sendText ? await d.sendText(env, RICHARD_PHONE, `${icon} ${n.title_he}\n${link}`, 'client').catch(e => ({ ok: false, error: String(e && e.message || e) })) : { ok: false };
    if (!r || r.ok === false || r.error) n.channels = n.channels.filter(c => c !== 'whatsapp');
  }
  n.stored = await storeNotification(env, n);
  return n;
}
export async function notifyEvent(env, d, rule, cand, now = Date.now()) {
  try { return await deliver(env, d, { ...cand, rule }, { now }); } catch { return null; }
}

/* ══ §5 the tick (every 10 min, after the brain) ═══════════════════════════ */
async function storeLeads(env) {
  try { const { makeStore } = await import('./store.js'); const s = makeStore(env); return { store: s, leads: await s.all('leads'), reminders: await s.all('reminders').catch(() => []) }; } catch { return { store: null, leads: [], reminders: [] }; }
}
async function clientRows(env, d, store, now) {
  if (!store) return [];
  try { const { listClients } = await import('./crm.js'); const r = await listClients(env, d, store, now); return r && r.ok ? r.clients : []; } catch { return []; }
}
async function readinessFacts(env, tok) {
  const has = async p => { try { const r = await env.RATE.list({ prefix: p + tok, limit: 1 }); return !!(r.keys && r.keys.length); } catch { return null; } };
  const [img, vid, gl] = await Promise.all([has('img:'), has('vidok:'), kjson(env, 'giftlinks:' + tok)]);
  return { invite: img == null && vid == null ? null : !!(img || vid), gifts: gl };
}
export async function upcomingEvents(env, d, clients, today, days = 7) {
  const ev = (clients || []).filter(c => c.date && c.date >= today && c.date <= addDays(today, days) && !['cancelled'].includes(c.status));
  ev.sort((a, b) => a.date.localeCompare(b.date));
  return Promise.all(ev.slice(0, 30).map(async c => ({ token: c.token, tok8: c.tok8, names: c.names, date: c.date, plan_he: c.plan_he, status: c.status, invited: (c.counts || {}).invited || 0, confirmed: (c.counts || {}).confirmed || 0,
    readiness: readinessOf(c, env.RATE ? await readinessFacts(env, c.token) : {}) })));
}
async function payRows(env, d, sinceTs, now) {
  if (!d || !d.auditQueryEx) return [];
  const from = ilDay(sinceTs).replace(/-/g, ''), to = ilDay(now).replace(/-/g, '');
  const r = await d.auditQueryEx(env, { from, to, kind: 'pay', limit: 2000, budget: 1500 }).catch(() => ({ items: [] }));
  return (r.items || []).filter(x => x.ts > sinceTs);
}
async function holdsList(env, clients) {
  if (!env.RATE) return [];
  const p = await env.RATE.list({ prefix: 'hold:', limit: 1000 }).catch(() => null);
  const keys = ((p && p.keys) || []).map(k => k.name.slice(5)).filter(t => /^[0-9a-f-]{36}$/.test(t));
  const by = Object.fromEntries((clients || []).map(c => [c.token, c]));
  return Promise.all(keys.slice(0, 50).map(async t => { const v = await env.RATE.get('hold:' + t).catch(() => null); return { tok8: t.slice(0, 8), name: (by[t] || {}).names || '', since: /^\d{4}-/.test(String(v || '')) ? v : null }; }));
}

export async function runNotify(env, d, { now = Date.now(), fns = {} } = {}) {
  const out = { ok: true, at: new Date(now).toISOString(), fired: [], errors: [] };
  const st = (await kjson(env, TICK_KEY)) || {};
  const since = st.at ? Date.parse(st.at) : now - 30 * MIN;   /* first run looks back 30 minutes only */
  const sinceIso = new Date(since).toISOString(), today = ilDay(now);
  const settings = await loadSettings(env);
  const cands = [];
  const step = async (name, fn) => { try { const r = await fn(); if (r && r.length) cands.push(...r); } catch (e) { out.errors.push(name + ': ' + String(e && e.message || e).slice(0, 120)); } };
  const { store, leads } = await storeLeads(env);
  let clients = null; const getClients = async () => (clients = clients || await clientRows(env, d, store, now));
  await step('new_lead', async () => evaluate.new_lead(leads, sinceIso));
  await step('lead_reply', async () => evaluate.lead_reply(leads, sinceIso));
  await step('payment', async () => { const { closedFromPay } = await import('./ops.js'); return evaluate.payment(closedFromPay(await payRows(env, d, since, now), { parsePaidDesc: d.parsePaidDesc || (() => null) })); });
  await step('changes', async () => evaluate.changes((await listChanges(env, { from: sinceIso, limit: 200 })).items));
  await step('incident', async () => { const { buildBrain } = await import('./brain.js'); return evaluate.incident((await buildBrain(env, { now })).findings.open); });
  await step('realtime', async () => { const rt = fns.realtime ? await fns.realtime() : await (await import('./ops.js')).buildRealtime(env, d, now); return [...evaluate.failures_spike(rt), ...evaluate.cap_high(rt)]; });
  await step('balances_low', async () => evaluate.balances_low(fns.balances ? await fns.balances() : await (await import('./ops.js')).buildBalances(env, d, {})));
  await step('hold_stale', async () => evaluate.hold_stale(await holdsList(env, await getClients()), now));
  await step('unanswered', async () => { if (!inHours(now)) return []; const { buildInbox } = await import('./ops-inbox.js'); const ib = fns.inbox ? await fns.inbox() : await buildInbox(env, d, { channel: 'client', limit: 200 }); return evaluate.unanswered(ib.items, now); });
  await step('event_readiness', async () => evaluate.event_readiness(await upcomingEvents(env, d, await getClients(), today, 3), today));
  await step('weekly_digest', async () => {
    const c = ilClock(now), cfg = settings.weekly_digest;
    if (c.dow !== 'Sun' || c.h !== (cfg.digest_hour ?? 9)) return [];
    const s = await weekStats(env, d, now, leads);
    return [{ rule: 'weekly_digest', entity: 'week:' + today, title_he: digestText(s), deep_link: '#/overview', data: s }];
  });
  for (const cnd of cands) { const n = await deliver(env, d, cnd, { settings, now }).catch(() => null); if (n) out.fired.push({ id: n.id, rule: n.rule, severity: n.severity, channels: n.channels }); }
  await kput(env, TICK_KEY, { at: new Date(now).toISOString(), fired: out.fired.length, errors: out.errors });
  return out;
}

/* ══ §6 the overview payload ═══════════════════════════════════════════════ */
async function weekStats(env, d, now, leads) {
  const today = ilDay(now), from = addDays(today, -6);
  const aq = kind => d.auditQueryEx ? d.auditQueryEx(env, { from: from.replace(/-/g, ''), to: today.replace(/-/g, ''), kind, limit: 20000, budget: 1500 }).catch(() => ({ items: [] })) : { items: [] };
  const [{ closedFromPay }, pay, out, calls] = await Promise.all([import('./ops.js'), aq('pay'), aq('wa_out'), aq('call')]);
  const cl = closedFromPay(pay.items, { parsePaidDesc: d.parsePaidDesc || (() => null) });
  const ls = (leads || []).filter(l => l.created_at && ilDay(Date.parse(l.created_at)) >= from);
  return { from, to: today, revenue: cl.reduce((s, x) => s + x.sum, 0), orders: cl.length, leads: ls.length, closed: ls.filter(l => l.status === 'closed').length, sends: (out.items || []).filter(x => x.ok !== false).length, calls: (calls.items || []).length };
}
const series = (rows, days, valueOf) => days.map(dd => rows.filter(r => r.day === dd).reduce((s, r) => s + valueOf(r), 0));

/* what blocks on Richard: approve brain actions, reply to people, overdue reminders, readiness gaps */
export function waitingFor({ pending = [], convs = [], reminders = [], events = [], leads = [] }, now = Date.now()) {
  const out = [];
  for (const p of pending) out.push({ kind: 'approve', title_he: `לאשר: ${p.name_he || p.playbook} · ${p.title_he || ''}`.trim(), action: { type: 'brain-decision', id: p.id, confirm: p.confirm || p.id }, href: '#/brain?focus=' + encodeURIComponent(p.finding_id || p.id) });
  for (const c of convs.filter(c => ['lead', 'client'].includes(c.role) && c.last_dir === 'in' && !c.nonrelevant && now - (c.last_in_ts || now) > H).slice(0, 8)) out.push({ kind: 'reply', title_he: `לענות ל${c.role === 'client' ? 'לקוח' : 'ליד'} ${c.name || c.wa_name || mask(c.phone)} (מחכה מ-${hhmm(c.last_in_ts)})`, action: { type: 'nav', href: '#/inbox?focus=' + encodeURIComponent(c.phone) }, href: '#/inbox?focus=' + encodeURIComponent(c.phone) });
  const iso = new Date(now).toISOString();
  for (const r of reminders.filter(r => !r.done && r.due_at && r.due_at < iso).slice(0, 6)) out.push({ kind: 'reminder', title_he: `תזכורת שעברה: ${String(r.text || r.title || '').slice(0, 80)}`, action: { type: 'nav', href: r.entity_type === 'lead' ? '#/leads/' + r.entity_id : '#/clients' }, href: r.entity_type === 'lead' ? '#/leads/' + r.entity_id : '#/clients' });
  for (const l of leads.filter(l => l.status === 'quoted' && l.quote_id && l.last_outbound_at && now - Date.parse(l.last_outbound_at) > 48 * H).slice(0, 5)) out.push({ kind: 'followup', title_he: `הצעה ל${nameOrPhone(l)} פתוחה יומיים בלי תשובה. לשלוח תזכורת.`, action: { type: 'nav', href: '#/leads/' + l.id }, href: '#/leads/' + l.id });
  for (const e of events) { const g = (e.readiness || []).filter(x => x.state === 'missing'); if (g.length) out.push({ kind: 'event', title_he: `${e.names || e.tok8} (${e.date.slice(8, 10)}/${e.date.slice(5, 7)}): חסר ${g.map(x => x.he).join(', ')}`, action: { type: 'nav', href: '#/clients?focus=' + e.tok8 }, href: '#/clients?focus=' + e.tok8 }); }
  return out;
}

export async function buildOverview(env, d, { now = Date.now(), fns = {} } = {}) {
  const today = ilDay(now), monthStart = today.slice(0, 8) + '01';
  const lastMonthStart = (() => { const [y, m] = today.split('-').map(Number); return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`; })();
  const sameDayLastMonth = (() => { const dd = Number(today.slice(8, 10)); const lm = lastMonthStart.slice(0, 8); return lm + String(Math.min(dd, 28)).padStart(2, '0'); })();
  const days7 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const ops = await import('./ops.js');
  const lastSeen = (await kjson(env, LASTSEEN_KEY)) || null;
  const aq = (kind, from, limit = 20000) => d.auditQueryEx ? d.auditQueryEx(env, { from: from.replace(/-/g, ''), to: today.replace(/-/g, ''), kind, limit, budget: 1500 }).catch(() => ({ items: [], truncated: true })) : Promise.resolve({ items: [] });
  const S = await Promise.allSettled([
    fns.realtime ? fns.realtime() : ops.buildRealtime(env, d, now),
    fns.balances ? fns.balances() : ops.buildBalances(env, d, {}),
    (async () => (await import('./brain.js')).buildBrain(env, { now }))(),
    storeLeads(env),
    aq('pay', lastMonthStart, 5000), aq('wa_out', days7[0]), aq('call', days7[0]),
    fns.inbox ? fns.inbox() : (async () => (await import('./ops-inbox.js')).buildInbox(env, d, { channel: 'client', limit: 200 }))(),
    listChanges(env, { from: lastSeen ? lastSeen.at : new Date(now - 24 * H).toISOString(), limit: 50 }),
    listNotifications(env, { unread: true, limit: 10, now }),
  ]);
  const v = (i, dflt = null) => (S[i].status === 'fulfilled' ? S[i].value : dflt);
  const errors = S.map((s, i) => s.status === 'rejected' ? ['realtime', 'balances', 'brain', 'crm', 'pay', 'wa_out', 'calls', 'inbox', 'changes', 'notifications'][i] + ': ' + String(s.reason && s.reason.message || s.reason).slice(0, 100) : null).filter(Boolean);
  const rt = v(0), bal = v(1), brain = v(2), crm = v(3, { store: null, leads: [], reminders: [] }), inbox = v(7, { items: [] });
  const leads = crm.leads || [];
  /* money */
  const closed = ops.closedFromPay((v(4, { items: [] }).items || []), { parsePaidDesc: d.parsePaidDesc || (() => null) });
  const sum = xs => xs.reduce((s, x) => s + (x.sum || 0), 0);
  const money = { today: sum(closed.filter(c => c.day === today)), today_orders: closed.filter(c => c.day === today).length,
    month: sum(closed.filter(c => c.day >= monthStart)), last_month_to_date: sum(closed.filter(c => c.day >= lastMonthStart && c.day < monthStart && c.day <= sameDayLastMonth)),
    open_quotes: leads.filter(l => l.status === 'quoted').length, open_quotes_sum: sum(leads.filter(l => l.status === 'quoted').map(l => ({ sum: Number(l.quote_sum || l.sum) || 0 }))),
    spark: series(closed, days7, r => r.sum), recent: closed.slice(-5).reverse().map(c => ({ at: c.at, sum: c.sum, event: c.event, package: c.package })) };
  /* leads */
  const dayOf = iso => (iso ? ilDay(Date.parse(iso)) : '');
  const convs = inbox.items || [];
  const leadsT = { new_today: leads.filter(l => dayOf(l.created_at) === today).length,
    waiting_1h: convs.filter(c => c.role === 'lead' && c.last_dir === 'in' && !c.nonrelevant && now - (c.last_in_ts || now) > H).length,
    quoted: leads.filter(l => l.status === 'quoted').length, closed_today: leads.filter(l => l.status === 'closed' && dayOf(l.closed_at) === today).length,
    spark: days7.map(dd => leads.filter(l => dayOf(l.created_at) === dd).length) };
  /* sends + calls */
  const outRows = (v(5, { items: [] }).items || []).map(r => ({ day: ilDay(r.ts), ok: r.ok !== false }));
  const callRows = (v(6, { items: [] }).items || []).map(r => ({ day: ilDay(r.ts) }));
  const tot = (rt && rt.wa && rt.wa.totals) || {};
  const sends = rt ? { sent: tot.sent_today || 0, failed: (tot.rejected_today || 0) + (tot.failed_async_today || 0), cap_used: rt.cap ? rt.cap.used : null, cap_limit: rt.cap ? rt.cap.limit : null, cap_pct: rt.cap && rt.cap.limit ? Math.round(100 * rt.cap.used / rt.cap.limit) : null,
    queue_why: rt.queue && rt.queue.sends ? rt.queue.sends.why : null, next_tick_at: rt.queue ? rt.queue.next_tick_at : null, paused: !!(rt.pacer && (rt.pacer.paused || rt.pacer.off)), spark: series(outRows, days7, r => (r.ok ? 1 : 0)) } : null;
  const c0 = rt && rt.calls;
  const calls = rt ? { dialed: c0 ? c0.dialed || 0 : 0, answered: c0 ? c0.answered || 0 : 0, remaining: c0 ? c0.capacity_left_today ?? null : null,
    shir: !c0 ? 'off' : c0.source === 'retell-unreadable' ? 'unreadable' : rt.queue && rt.queue.calls && rt.queue.calls.will_run ? 'dialing' : 'idle', why: rt.queue && rt.queue.calls ? rt.queue.calls.why : null, spark: series(callRows, days7, () => 1) } : null;
  /* events */
  const clients = await clientRows(env, d, crm.store, now).catch(() => []);
  const events = await upcomingEvents(env, d, clients, today, 7).catch(() => []);
  /* incidents: brain findings + realtime-derived rule candidates, ranked */
  const findings = brain ? brain.findings.open : [];
  const pending = brain ? brain.pending : [];
  const incidents = [...evaluate.incident(findings), ...(rt ? [...evaluate.failures_spike(rt), ...evaluate.cap_high(rt)] : []), ...evaluate.balances_low(bal)]
    .map(c => { const f = c.entity.startsWith('finding:') ? findings.find(x => 'finding:' + x.id === c.entity) : null; const p = f ? pending.find(x => x.finding_id === f.id) : null;
      return { severity: c.severity || RULE[c.rule].sev, rule: c.rule, title_he: c.title_he, href: c.deep_link, action: p ? { type: 'brain-decision', id: p.id, confirm: p.confirm || p.id, label_he: 'לאשר תיקון' } : { type: 'nav', href: c.deep_link, label_he: 'לפתוח' } }; })
    .sort((a, b) => sevRank(a.severity) - sevRank(b.severity)).slice(0, 8);
  const changesSince = v(8, { items: [] }).items || [];
  const nt = v(9, { items: [], unread: 0 });
  return {
    ok: true, at: new Date(now).toISOString(), today, last_seen: lastSeen ? lastSeen.at : null,
    waiting: waitingFor({ pending, convs, reminders: crm.reminders || [], events, leads }, now).slice(0, 12),
    incidents, money, leads: leadsT, sends, calls, spark_days: days7, events,
    changes: { since: lastSeen ? lastSeen.at : new Date(now - 24 * H).toISOString(), count: changesSince.length, items: changesSince.slice(0, 12).map(c => ({ id: c.id, at: c.at, kind: c.kind, actor: c.actor, summary_he: c.summary_he })) },
    balances: { low: ((bal && bal.vendors) || []).filter(x => x.status === 'low').map(x => ({ vendor: x.vendor, amount: x.amount ?? null, currency: x.currency || '', status: x.status })), checked_at: bal ? bal.at : null },
    notifications: { unread: nt.unread, latest: nt.items },
    errors,
  };
}

/* ══ §7 router (mounted from ops.js handleOps) ═════════════════════════════ */
export const NOTIFY_ROUTE = /^(notifications(\/mark|\/push-pull)?|notify-settings|overview)$/;
export async function handleNotify(request, env, url, d, body, json, path) {
  const q = k => body[k] ?? url.searchParams.get(k);
  const isPost = request.method === 'POST';
  const who = String(body.who || 'admin').slice(0, 40);
  if (path === 'edit') {   /* /api/ops/edit {id:'notify:<rule>', field, value} — no typed confirm for notification settings */
    const rule = String(body.id || '').slice(7); const field = String(body.field || '');
    const r = await saveSetting(env, rule, field ? { [field]: body.value } : body.value, { who }); return json(r.body, r.status);
  }
  if (path === 'notifications') {
    const r = await listNotifications(env, { unread: ['1', 'true', true].includes(q('unread')), cursor: q('cursor') || '', limit: q('limit') || 50 });
    return json({ ok: true, rules: Object.fromEntries(RULES.map(x => [x.id, x.he])), ...r });
  }
  if (path === 'notifications/mark') {
    if (!isPost) return json({ ok: false, error: 'POST-only' }, 405);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return json({ ok: false, error: 'ids-required' }, 400);
    if (body.snooze_until && !Number.isFinite(Date.parse(body.snooze_until))) return json({ ok: false, error: 'bad-snooze_until' }, 400);
    const n = await markNotifications(env, ids, { read: typeof body.read === 'boolean' ? body.read : undefined, snooze_until: 'snooze_until' in body ? body.snooze_until : undefined });
    return json({ ok: true, updated: n });
  }
  if (path === 'notifications/push-pull') {
    if (!isPost) return json({ ok: false, error: 'POST-only' }, 405);
    const qd = (await kjson(env, PUSH_KEY)) || []; if (qd.length && env.RATE) await env.RATE.delete(PUSH_KEY).catch(() => {});
    return json({ ok: true, items: qd });
  }
  if (path === 'notify-settings') {
    if (isPost) { const r = await saveSetting(env, String(body.rule || ''), body.patch, { who }); return json(r.body, r.status); }
    const s = await loadSettings(env);
    return json({ ok: true, severities: SEVERITIES, channels: CHANNELS, quiet_hours: { from: '21:00', to: '09:00' }, rules: RULES.map(r => ({ id: r.id, he: r.he, default_severity: r.sev, dedupe_min: Math.round(r.window / MIN), defaults: defaultCfg(r.id), ...s[r.id] })) });
  }
  if (path === 'overview') {
    if (isPost && body.seen) { const at = new Date().toISOString(); await kput(env, LASTSEEN_KEY, { at, by: who }); return json({ ok: true, last_seen: at }); }
    return json(await buildOverview(env, d));
  }
  return json({ ok: false, error: 'unknown-notify-route' }, 404);
}
