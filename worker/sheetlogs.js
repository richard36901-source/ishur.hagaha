/* ============================================================================
   ishur.io · the detailed logs in the Google Sheet
   ----------------------------------------------------------------------------
   Richard (06/09): "every message that went to any lead, client or guest —
   everything, including when Noa answers with AI, or Shir — a full calls log,
   in and out, and every removal (WhatsApp, phone, mistake) in the הסרות tab.
   As much information as possible on every action."

   Four tabs, all fed the same cheap way as the system journal (evlog.js):
     logRow()     → one KV write on the hot path, nothing else
     logUpdate()  → a later fact about the same row (delivered / read / call
                    ended) — also one KV write, keyed by the row's id
     flushSheetLogs() → the pacer, every ten minutes: merges updates into the
                    rows still waiting, writes each tab in ONE appendCells call
   A row waits at least GRACE seconds before it is written, so the usual
   "sent → delivered → read" all land in the same line. A status that arrives
   after its row was already written becomes its own short line ("עדכון").

   Tabs (titles are the ones already in the sheet, spaces included):
     msg_guests   'אורחים לוג הודעות יוצאות'   every message on Shir's 6673
     msg_clients  ' לקוחות לוג הודעות יוצאות'   every message on Noa's 4499
     calls        'לוג שיחות'                    Shir + Noa, in and out
     removals     'הסרות'                        הסר / טעות / לא להתקשר / חסימה
   ========================================================================== */

import { SHEET_ID } from './evlog.js';

const GRACE_S = 150;            // wait this long for delivered/read before writing
const MAX_ROWS = 400;           // per tab per flush
const BUF_TTL = 3 * 86400;

const MSG_HEADER = ['מזהה הודעה', 'זמן', 'נשלח?', 'התקבל?', 'נקרא?', 'שם מקבל', 'מספר טלפון', 'תוכן הודעה', 'טלפון שולח', 'עלות הודעה',
  'כיוון', 'מי שלח', 'סוג', 'תבנית', 'אירוע', 'גל', 'שגיאה', 'סיווג מטא'];
const MSG_COLS = ['id', 'at', 'sent', 'delivered', 'read', 'name', 'phone', 'text', 'sender', 'cost',
  'dir', 'who', 'type', 'tmpl', 'token', 'wave', 'error', 'category'];

const CALL_HEADER = ['זמן', 'סוכנת', 'כיוון', 'טלפון', 'שם', 'סוג', 'אירוע', 'סטטוס', 'משך (שנ\')', 'תוצאה', 'סיכום', 'סנטימנט', 'עלות (₪)', 'סיבת ניתוק', 'מזהה שיחה'];
const CALL_COLS = ['at', 'agent', 'dir', 'phone', 'name', 'kind', 'token', 'status', 'dur', 'outcome', 'summary', 'sentiment', 'cost', 'reason', 'id'];

const REM_HEADER = ['זמן', 'סוג הסרה', 'ערוץ', 'טלפון', 'שם', 'אירוע', 'תוקף', 'מה נכתב', 'פירוט'];
const REM_COLS = ['at', 'kind', 'channel', 'phone', 'name', 'token', 'scope', 'said', 'detail'];

/* every tax invoice-receipt we issued, in one place: the accountant's tab */
const INV_HEADER = ['זמן', 'מספר חשבונית', 'סוג', 'שם לקוח', 'טלפון', 'ח.פ / ת.ז', 'אירוע', 'חבילה', 'סכום ₪',
  'אמצעי תשלום', 'אסמכתא Grow', 'קישור לחשבונית', 'נשלחה בווצאפ', 'מייל הלקוח'];
const INV_COLS = ['at', 'number', 'kind', 'name', 'phone', 'taxId', 'token', 'plan', 'sum',
  'payMethod', 'ref', 'url', 'wa', 'email'];

export const TABS = {
  msg_guests: { title: 'אורחים לוג הודעות יוצאות', header: MSG_HEADER, cols: MSG_COLS, color: { red: 0.36, green: 0.62, blue: 0.45 } },
  msg_clients: { title: ' לקוחות לוג הודעות יוצאות', header: MSG_HEADER, cols: MSG_COLS, color: { red: 0.30, green: 0.50, blue: 0.75 } },
  calls: { title: 'לוג שיחות', header: CALL_HEADER, cols: CALL_COLS, color: { red: 0.55, green: 0.35, blue: 0.65 } },
  removals: { title: 'הסרות', header: REM_HEADER, cols: REM_COLS, color: { red: 0.80, green: 0.30, blue: 0.30 } },
  invoices: { title: 'חשבוניות', header: INV_HEADER, cols: INV_COLS, color: { red: 0.20, green: 0.45, blue: 0.40 } },
};

export function ilStamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
}
export function ilTime(d = new Date()) { return ilStamp(d).slice(11, 16); }

/* ── writers: never throw, one KV write each ─────────────────────────────── */
export async function logRow(env, tab, rec) {
  if (!env || !env.RATE || !TABS[tab]) return;
  try {
    const r = {};
    for (const c of TABS[tab].cols) r[c] = rec[c] === undefined || rec[c] === null ? '' : String(rec[c]).slice(0, 500);
    r.at = rec.at || new Date().toISOString();
    const ts = Date.now();
    await env.RATE.put(`slog:${tab}:r:${ts}:${Math.random().toString(36).slice(2, 7)}`,
      JSON.stringify(r), { expirationTtl: BUF_TTL });
  } catch {}
}

export async function logUpdate(env, tab, id, patch) {
  if (!env || !env.RATE || !TABS[tab] || !id) return;
  try {
    const p = { id: String(id).slice(0, 120), _at: new Date().toISOString() };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!TABS[tab].cols.includes(k)) continue;
      p[k] = v === undefined || v === null ? '' : String(v).slice(0, 500);
    }
    const ts = Date.now();
    await env.RATE.put(`slog:${tab}:u:${ts}:${Math.random().toString(36).slice(2, 7)}`,
      JSON.stringify(p), { expirationTtl: BUF_TTL });
  } catch {}
}

/* ── sheet plumbing (same Make proxy as the journal) ─────────────────────── */
async function proxy(env, url, opts = {}) {
  if (!env.BRAIN_HOOK) return null;
  const body = { url };
  if (opts.method) body.method = opts.method;
  if (opts.payload !== undefined) body.payload = JSON.stringify(opts.payload);
  if (opts.qk) { body.qk1 = opts.qk; body.qv1 = opts.qv; }
  const r = await fetch(env.BRAIN_HOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!r || !r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

/* find or create the tab; write the header once (the two message tabs already
   exist with the first ten columns — the same names go back, plus the new ones) */
export async function ensureTab(env, tab) {
  const def = TABS[tab];
  if (!def || !env.RATE) return null;
  const cached = await env.RATE.get('slog:sid:' + tab);
  if (cached) return Number(cached);

  const meta = await proxy(env, `spreadsheets/${SHEET_ID}`, { qk: 'fields', qv: 'sheets.properties' });
  const sheets = (meta && meta.sheets) || [];
  const found = sheets.find(s => s.properties && s.properties.title === def.title);
  let sheetId = found ? found.properties.sheetId : null;
  if (sheetId == null) {
    const res = await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      payload: { requests: [{ addSheet: { properties: {
        title: def.title, gridProperties: { frozenRowCount: 1 }, tabColor: def.color,
      } } }] },
    });
    sheetId = res && res.replies && res.replies[0] && res.replies[0].addSheet &&
      res.replies[0].addSheet.properties.sheetId;
    if (sheetId == null) return null;
  }
  const requests = [{ updateCells: {
    start: { sheetId, rowIndex: 0, columnIndex: 0 },
    rows: [{ values: def.header.map(h => ({ userEnteredValue: { stringValue: h },
      userEnteredFormat: { textFormat: { bold: true } } })) }],
    fields: 'userEnteredValue,userEnteredFormat.textFormat',
  } }];
  if (tab === 'msg_guests' || tab === 'msg_clients') {
    /* a failed send / failed delivery turns the line red */
    requests.push({ addConditionalFormatRule: { index: 0, rule: {
      ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: def.header.length }],
      booleanRule: {
        condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=OR(LEFT($C2,4)="נכשל",$Q2<>"")' }] },
        format: { backgroundColor: { red: 0.99, green: 0.86, blue: 0.84 } },
      },
    } } });
  }
  const hdr = await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, { method: 'POST', payload: { requests } });
  if (!hdr) return null;
  await env.RATE.put('slog:sid:' + tab, String(sheetId));
  return sheetId;
}

/* ── the flush: rows + updates → merged → one appendCells per tab ────────── */
async function flushTab(env, tab) {
  const def = TABS[tab];
  const now = Date.now();
  const rowPage = await env.RATE.list({ prefix: `slog:${tab}:r:`, limit: MAX_ROWS }).catch(() => null);
  const updPage = await env.RATE.list({ prefix: `slog:${tab}:u:`, limit: 1000 }).catch(() => null);
  const rowKeys = (rowPage && rowPage.keys) || [], updKeys = (updPage && updPage.keys) || [];
  if (!rowKeys.length && !updKeys.length) return { flushed: 0 };

  /* updates first, grouped by id */
  const upd = new Map();
  for (const k of updKeys) {
    const raw = await env.RATE.get(k.name); if (!raw) continue;
    let u; try { u = JSON.parse(raw); } catch { await env.RATE.delete(k.name); continue; }
    const ts = Number(k.name.split(':')[3]) || now;
    if (!upd.has(u.id)) upd.set(u.id, []);
    upd.get(u.id).push({ key: k.name, ts, u });
  }

  const rows = [], done = [];
  let held = 0;
  for (const k of rowKeys) {
    const ts = Number(k.name.split(':')[3]) || 0;
    const raw = await env.RATE.get(k.name); if (!raw) continue;
    let r; try { r = JSON.parse(raw); } catch { await env.RATE.delete(k.name); continue; }
    const pend = r.id ? (upd.get(r.id) || []) : [];
    /* a young row with no update yet may still get delivered/read — wait */
    if (now - ts < GRACE_S * 1000 && !pend.length) { held++; continue; }
    if (now - ts < GRACE_S * 1000 && pend.length && !pend.some(p => p.u.read || p.u.error || p.u.status === 'הסתיימה')) { held++; continue; }
    for (const p of pend.sort((a, b) => a.ts - b.ts)) {
      for (const [kk, vv] of Object.entries(p.u)) if (kk !== 'id' && kk !== '_at' && vv !== '') r[kk] = vv;
      done.push(p.key);
    }
    if (r.id) upd.delete(r.id);
    rows.push(def.cols.map(c => c === 'at' ? ilStamp(new Date(r.at)) : (r[c] ?? '')));
    done.push(k.name);
  }
  /* updates whose row was written on an earlier tick → their own short line */
  for (const [id, list] of upd) {
    for (const p of list) {
      if (now - p.ts < GRACE_S * 1000) continue;     // its row may just be list-lagged
      const r = { ...p.u, at: p.u._at, id };
      if (def.cols.includes('sent') && !r.sent) r.sent = 'עדכון';
      if (def.cols.includes('status') && !r.status) r.status = 'עדכון';
      rows.push(def.cols.map(c => c === 'at' ? ilStamp(new Date(r.at)) : (r[c] ?? '')));
      done.push(p.key);
    }
  }
  if (!rows.length) return { flushed: 0, held };

  const sheetId = await ensureTab(env, tab);
  if (sheetId == null) return { flushed: 0, why: 'no-sheet', pending: rows.length };
  const res = await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    payload: { requests: [{ appendCells: {
      sheetId,
      rows: rows.map(r => ({ values: r.map(v => ({ userEnteredValue: { stringValue: String(v ?? '') } })) })),
      fields: 'userEnteredValue',
    } }] },
  });
  if (!res || !Array.isArray(res.replies)) return { flushed: 0, why: 'append-failed', pending: rows.length };
  for (const k of done) await env.RATE.delete(k).catch(() => {});
  return { flushed: rows.length, held };
}

export async function flushSheetLogs(env) {
  if (!env.RATE || !env.BRAIN_HOOK) return { ok: false, why: 'not-configured' };
  const out = {};
  for (const tab of Object.keys(TABS)) {
    try { out[tab] = await flushTab(env, tab); } catch (e) { out[tab] = { why: String(e && e.message) }; }
  }
  out.ok = !Object.values(out).some(v => v && v.why);
  return out;
}

/* the tail of one tab, for verification */
export async function readTabTail(env, tab, n = 10) {
  const def = TABS[tab]; if (!def) return null;
  const res = await proxy(env, `spreadsheets/${SHEET_ID}/values:batchGet`, { qk: 'ranges', qv: `'${def.title}'!A1:R5000` });
  const values = (res && res.valueRanges && res.valueRanges[0] && res.valueRanges[0].values) || [];
  return { tab: def.title, total: Math.max(0, values.length - 1), header: values[0] || [], rows: values.slice(-n) };
}

/* ── the clients list ─────────────────────────────────────────────────────
   'לקוחות': פעיל | מזהה לקוח | שם לקוח | שם לקוח 2 | טלפון לקוח | טלפון משני |
   ת.ז | מזהי אירועים | שמות אירועים מקושרים
   Make was supposed to add a row per new client and never did (the tab had
   only its header on 06/09 with two paid events in the sheet). The worker
   owns it now: one row per client id, events accumulate in H/I. Reads the
   tab, so it is safe to call twice. */
const CLIENTS_TAB = 'לקוחות';
const CLIENTS_SHEET_ID = 830527183;
export async function upsertClientRow(env, { clientId, name, phone, taxId, token, eventName, invoice }) {
  if (!env.BRAIN_HOOK || !clientId) return { ok: false, why: 'no-config' };
  const res = await proxy(env, `spreadsheets/${SHEET_ID}/values:batchGet`, { qk: 'ranges', qv: `'${CLIENTS_TAB}'!A1:J2000` });
  const values = (res && res.valueRanges && res.valueRanges[0] && res.valueRanges[0].values);
  if (!values) return { ok: false, why: 'read-failed' };
  const idx = values.findIndex((r, i) => i > 0 && (String(r[1] || '').trim() === clientId || (phone && String(r[4] || '').trim() === phone)));
  const tok = String(token || '').trim();
  if (idx < 0) {
    const row = ['כן', clientId, name || '', '', phone || '', '', taxId || '', tok, eventName || '', invoice || ''];
    const w = await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      payload: { requests: [{ appendCells: { sheetId: CLIENTS_SHEET_ID,
        rows: [{ values: row.map(v => ({ userEnteredValue: { stringValue: String(v) } })) }], fields: 'userEnteredValue' } }] },
    });
    return { ok: !!(w && Array.isArray(w.replies)), added: true };
  }
  const r = values[idx];
  const toks = String(r[7] || '').split(/[\s,]+/).filter(Boolean);
  const names = String(r[8] || '').split(/\s*,\s*/).filter(Boolean);
  /* every invoice this client ever got, newest last, in one cell */
  const invs = String(r[9] || '').split(/\s*\|\s*/).filter(Boolean);
  let changed = false, invChanged = false;
  if (tok && !toks.includes(tok)) { toks.push(tok); changed = true; }
  if (eventName && !names.includes(eventName)) { names.push(eventName); changed = true; }
  if (invoice && !invs.some(x => x.indexOf(String(invoice).split(' ')[0]) === 0)) { invs.push(invoice); invChanged = true; }
  const fill = [];
  if (!String(r[2] || '').trim() && name) fill.push({ range: `'${CLIENTS_TAB}'!C${idx + 1}`, values: [[name]] });
  if (!String(r[6] || '').trim() && taxId) fill.push({ range: `'${CLIENTS_TAB}'!G${idx + 1}`, values: [[taxId]] });
  if (changed) fill.push({ range: `'${CLIENTS_TAB}'!H${idx + 1}:I${idx + 1}`, values: [[toks.join(', '), names.join(', ')]] });
  if (invChanged) fill.push({ range: `'${CLIENTS_TAB}'!J${idx + 1}`, values: [[invs.join(' | ')]] });
  if (!fill.length) return { ok: true, added: false, unchanged: true };
  const w = await proxy(env, `spreadsheets/${SHEET_ID}/values:batchUpdate`, {
    method: 'POST', payload: { valueInputOption: 'RAW', data: fill },
  });
  return { ok: !!(w && w.totalUpdatedCells), added: false, updated: fill.length };
}
