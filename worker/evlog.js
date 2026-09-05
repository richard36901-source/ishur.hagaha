/* ============================================================================
   ishur.io · the system journal ("יומן מערכת")
   ----------------------------------------------------------------------------
   One tab in the Google Sheet where EVERYTHING that happens is written down:
   a payment that arrived, a payment that was parked, a WhatsApp that went out,
   one that Meta refused, a wave that finished, a call Shir made, a check that
   ran. Every row carries an area, an action, a status, and a flag that turns
   the row red when a human has to look at it.

   Why it exists: on 05/09 the very first real payment was parked by a matcher
   that had never seen a real payload. The safety net worked (Slack alert,
   payload kept, replay tool) but the only signal was a Slack line. Richard's
   requirement, verbatim: a log of every action, in the sheet, tagged, success
   or failure, with rows needing his attention in red.

   How it works, cheaply:
     logEvent()      → one KV write. Nothing else happens on the hot path.
     flushEventLog() → the pacer calls it every ten minutes: reads what has
                       accumulated, writes ALL of it to the sheet in ONE Sheets
                       API call (one Make operation), then deletes the keys.
   So a day of 2,000 messages costs ~140 Make operations, not 2,000.

   Red rows: a conditional-format rule on the tab (column E = "כן") set once
   by ensureLogSheet(). No per-row formatting calls.
   ========================================================================== */

export const SHEET_ID = '1VAHaP32Jt2MDmyca_TDqOddpomnUxDd47ePSAyOFG-Q';
export const LOG_TAB = 'יומן מערכת';
const HEADER = ['זמן', 'תחום', 'פעולה', 'סטטוס', 'דורש בדיקה', 'טלפון', 'אירוע', 'מזהה', 'פירוט'];
const MAX_FLUSH = 400;          // rows per flush — well under the ceiling
const BUF_TTL = 3 * 86400;      // an unflushed event survives a bad weekend

/* the owner's phone for the handful of events that cannot wait for Slack */
export const OWNER_PHONE = '972545764327';

function ilStamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = t => (parts.find(p => p.type === t) || {}).value || '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
}

/* ── write one event. Never throws, never blocks the caller for long. ─────── */
export async function logEvent(env, e) {
  if (!env || !env.RATE) return;
  try {
    const rec = {
      at: new Date().toISOString(),
      area: String(e.area || 'מערכת').slice(0, 30),
      action: String(e.action || '').slice(0, 80),
      ok: e.ok === undefined ? null : !!e.ok,
      review: !!e.review,
      phone: String(e.phone || '').slice(0, 20),
      token: String(e.token || '').slice(0, 8),
      ref: String(e.ref || '').slice(0, 60),
      detail: String(e.detail || '').slice(0, 400),
    };
    const id = `evlog:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    await env.RATE.put(id, JSON.stringify(rec), { expirationTtl: BUF_TTL });
  } catch {}
}

/* ── the sheet plumbing, all through the Make proxy that already exists ───── */
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

/* find (or create) the tab; remember its numeric id, which appendCells needs */
export async function ensureLogSheet(env) {
  if (!env.RATE) return null;
  const cached = await env.RATE.get('evlog:sheetId');
  if (cached) return Number(cached);

  const meta = await proxy(env, `spreadsheets/${SHEET_ID}`, { qk: 'fields', qv: 'sheets.properties' });
  const sheets = (meta && meta.sheets) || [];
  let found = sheets.find(s => s.properties && s.properties.title === LOG_TAB);
  let sheetId = found ? found.properties.sheetId : null;

  if (sheetId == null) {
    const res = await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      payload: { requests: [{ addSheet: { properties: {
        title: LOG_TAB, gridProperties: { frozenRowCount: 1 }, tabColor: { red: 0.66, green: 0.52, blue: 0.24 },
      } } }] },
    });
    sheetId = res && res.replies && res.replies[0] && res.replies[0].addSheet &&
      res.replies[0].addSheet.properties.sheetId;
    if (sheetId == null) return null;

    /* header + the red rule, once */
    await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      payload: { requests: [
        { updateCells: {
          start: { sheetId, rowIndex: 0, columnIndex: 0 },
          rows: [{ values: HEADER.map(h => ({ userEnteredValue: { stringValue: h },
            userEnteredFormat: { textFormat: { bold: true } } })) }],
          fields: 'userEnteredValue,userEnteredFormat.textFormat',
        } },
        { addConditionalFormatRule: { index: 0, rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER.length }],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$E2="כן"' }] },
            format: { backgroundColor: { red: 0.99, green: 0.86, blue: 0.84 } },
          },
        } } },
        { addConditionalFormatRule: { index: 1, rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER.length }],
          booleanRule: {
            condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$D2="נכשל"' }] },
            format: { backgroundColor: { red: 1, green: 0.95, blue: 0.85 } },
          },
        } } },
      ] },
    });
  }
  await env.RATE.put('evlog:sheetId', String(sheetId));
  return sheetId;
}

/* ── the flush: everything pending → one appendCells call ─────────────────── */
export async function flushEventLog(env) {
  if (!env.RATE || !env.BRAIN_HOOK) return { ok: false, why: 'not-configured' };
  const page = await env.RATE.list({ prefix: 'evlog:1', limit: MAX_FLUSH }).catch(() => null);
  if (!page || !page.keys.length) return { ok: true, flushed: 0 };

  const rows = [], keys = [];
  for (const k of page.keys) {
    /* list() lags; get() does not. A key already flushed and deleted by a
       previous tick can still be listed for a while — get() says it is gone. */
    const raw = await env.RATE.get(k.name);
    if (!raw) continue;
    let e; try { e = JSON.parse(raw); } catch { await env.RATE.delete(k.name); continue; }
    rows.push([
      ilStamp(new Date(e.at)), e.area, e.action,
      e.ok === null ? '' : (e.ok ? 'הצליח' : 'נכשל'),
      e.review ? 'כן' : '',
      e.phone, e.token, e.ref, e.detail,
    ]);
    keys.push(k.name);
  }
  if (!rows.length) return { ok: true, flushed: 0 };

  const sheetId = await ensureLogSheet(env);
  if (sheetId == null) return { ok: false, why: 'no-sheet' };

  const res = await proxy(env, `spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    payload: { requests: [{ appendCells: {
      sheetId,
      rows: rows.map(r => ({ values: r.map(v => ({ userEnteredValue: { stringValue: String(v ?? '') } })) })),
      fields: 'userEnteredValue',
    } }] },
  });
  /* Sheets answers with replies[] on success; the Make proxy passes it through.
     Only then do the buffered keys die — a failed flush retries next tick. */
  if (!res || !Array.isArray(res.replies)) return { ok: false, why: 'append-failed', pending: rows.length };
  for (const k of keys) await env.RATE.delete(k).catch(() => {});
  return { ok: true, flushed: rows.length };
}

/* the last rows of the tab, for the admin endpoint / verification */
export async function readLogTail(env, n = 20) {
  const res = await proxy(env, `spreadsheets/${SHEET_ID}/values:batchGet`, { qk: 'ranges', qv: `${LOG_TAB}!A1:I5000` });
  const values = (res && res.valueRanges && res.valueRanges[0] && res.valueRanges[0].values) || [];
  return { total: Math.max(0, values.length - 1), header: values[0] || [], rows: values.slice(-n) };
}
