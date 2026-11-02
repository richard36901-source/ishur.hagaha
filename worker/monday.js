/* ── monday.com: the leads board ─────────────────────────────────────────────
   Richard 24/09: "each time the sheet of leads gets updated we get it in
   monday as well". Board 18432553641 (rthq-ops). One item per phone number,
   upserted on every form event, so a lead's row on monday always mirrors the
   latest we know. Dormant-safe: no MONDAY_API_TOKEN → every call is a no-op
   that says so, nothing throws into the lead path. */

const API = 'https://api.monday.com/v2';
const BOARD = 18432553641;

/* Richard built the board by hand (24/09); his columns win. Fixed ids for
   his, and only what the board lacks is created by title. */
const FIXED = { 'טלפון': 'phone_mm7g3mjv', 'מייל': 'email_mm7gj1rb', 'כמות': 'numeric_mm7g6kn3', 'סטטוס': 'status', 'טיפול': 'color_mm7g6y7g' };
const COLUMNS = [
  ['אירוע', 'text'], ['חבילה', 'text'], ['מחיר', 'numbers'], ['שלב', 'text'], ['כניסות', 'numbers'],
  ['מקור', 'text'], ['עדכונים', 'text'], ['נכנס לראשונה', 'date'], ['הערות', 'long_text'],
];

export async function mondayGql(env, query, variables) { return gql(env, query, variables); }
async function gql(env, query, variables) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { Authorization: env.MONDAY_API_TOKEN, 'Content-Type': 'application/json', 'API-Version': '2026-07' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error('monday ' + r.status + ': ' + JSON.stringify(j.errors || j).slice(0, 300));
  return j.data;
}

async function columnMap(env) {
  let cached = null;
  try { cached = JSON.parse(await env.RATE.get('monday:cols:' + BOARD)); } catch {}
  if (cached && COLUMNS.every(([t]) => cached[t]) && cached['טלפון'] === FIXED['טלפון']) return cached;
  const d = await gql(env, `query($b:[ID!]){ boards(ids:$b){ columns{ id title type } } }`, { b: [String(BOARD)] });
  const have = { ...FIXED };
  for (const c of ((d.boards && d.boards[0] && d.boards[0].columns) || [])) have[c.title] = c.id;
  for (const [title, type] of COLUMNS) {
    if (have[title]) continue;
    const c = await gql(env, `mutation($b:ID!,$t:String!,$ty:ColumnType!){ create_column(board_id:$b,title:$t,column_type:$ty){ id } }`, { b: String(BOARD), t: title, ty: type });
    have[title] = c.create_column.id;
  }
  await env.RATE.put('monday:cols:' + BOARD, JSON.stringify(have)).catch(() => {});
  return have;
}

/* 02/11: one Israeli number, every way a human types it into Monday */
export function digitsIl(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (/^5\d{8}$/.test(d)) d = '0' + d;
  if (d.startsWith('00972')) d = d.slice(2);
  if (d.startsWith('9720')) d = '972' + d.slice(4);
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}
export function phoneVariants(phone) {
  const p = digitsIl(phone);
  if (!/^972\d{8,9}$/.test(p)) return p ? [p] : [];
  const n = p.slice(3);                       /* 507536247 */
  const local = '0' + n;                      /* 0507536247 */
  const a = n.slice(0, 2), b = n.slice(2, 5), c = n.slice(5);
  return [...new Set([
    local, p, '+' + p, '+972 ' + n,
    `0${a}-${b}-${c}`, `0${a}-${n.slice(2)}`, `0${a} ${b} ${c}`, `0${a} ${n.slice(2)}`,
    `+972 ${a}-${b}-${c}`, `+972-${a}-${b}-${c}`, `+972 ${a} ${b} ${c}`, `+972-${a}-${n.slice(2)}`, `972-${a}-${b}-${c}`,
  ])];
}

/* the column values a write may carry. On an UPDATE (an item that already
   exists — very often one Richard typed in by hand, with his notes) nothing
   is ever blanked, הערות is appended to and never replaced, and the source /
   first-seen date are never moved. The humans own סטטוס/טיפול after creation. */
function values(cols, phone, rec, isNew, existingNotes = '') {
  const local = phone.replace(/^972/, '0');
  const stage = t => ({ lead_partial: 'התחיל טופס', lead: 'שלח טופס', checkout: 'הגיע לתשלום', initiate_checkout: 'הגיע לתשלום', purchase: 'שילם', whatsapp_in: 'כתב בוואטסאפ' })[t] || t || '';
  const day = iso => (iso ? String(iso).slice(0, 10) : '');
  const v = {};
  const put = (col, val) => { if (!col) return; if (!isNew && (val === '' || val == null)) return; v[col] = val; };
  if (isNew) v[cols['טלפון']] = { phone: local, countryShortName: 'IL' };
  if (rec.email) v[cols['מייל']] = { email: rec.email, text: rec.email };
  const n = parseInt(String(rec.guests || '').replace(/\D/g, ''), 10);
  if (n) v[cols['כמות']] = String(n);
  put(cols['אירוע'], rec.occasion || '');
  put(cols['חבילה'], rec.plan || '');
  if (rec.price) v[cols['מחיר']] = String(rec.price);
  put(cols['שלב'], stage((rec.types || []).slice(-1)[0]));
  if (isNew || Number(rec.seen) > 1) v[cols['כניסות']] = String(rec.seen || 1);
  if (isNew) v[cols['מקור']] = (rec.source || 'ישיר') + (rec.page ? ' · ' + rec.page : '');
  if (isNew || rec.consent) v[cols['עדכונים']] = rec.consent ? 'אישר' : 'לא';
  if (isNew && day(rec.at)) v[cols['נכנס לראשונה']] = { date: day(rec.at) };
  const note = String(rec.notes || '').trim();
  if (note && cols['הערות']) {
    if (isNew) v[cols['הערות']] = { text: note };
    else if (!String(existingNotes || '').includes(note)) v[cols['הערות']] = { text: (existingNotes ? existingNotes + '\n' : '') + note };
  }
  /* a new lead starts as חדש → שלו */
  if (isNew) { v[cols['סטטוס']] = { label: (rec.types || []).includes('purchase') ? 'סגר' : 'חדש' }; v[cols['טיפול']] = { label: 'שלו' }; }
  return v;
}

/* find the board item of a phone, however it was typed. Exact column match on
   every common spelling first (one query); then, only when that misses, a scan
   of the board comparing digits — the safety net for Richard's manual items
   (e.g. "+972-50-753-6247", or no phone in the column but in the item name).
   Returns { id, name, notes, phoneText, matched } | null. */
const SCAN_PAGES = 6;          /* 6 × 500 items */
export async function findItemByPhone(env, cols, phone) {
  const want = digitsIl(phone);
  if (!want) return null;
  const ids = [cols['טלפון'], cols['הערות']].filter(Boolean);
  const pick = (it, how) => {
    const cv = Object.fromEntries((it.column_values || []).map(c => [c.id, c.text || '']));
    return { id: it.id, name: it.name || '', notes: cv[cols['הערות']] || '', phoneText: cv[cols['טלפון']] || '', matched: how };
  };
  const found = await gql(env, `query($b:ID!,$c:String!,$v:[String]!,$ids:[String!]){ items_page_by_column_values(board_id:$b,limit:5,columns:[{column_id:$c,column_values:$v}]){ items{ id name column_values(ids:$ids){ id text } } } }`,
    { b: String(BOARD), c: cols['טלפון'], v: phoneVariants(phone), ids });
  const items = ((found && found.items_page_by_column_values) || {}).items || [];
  const exact = items.find(it => digitsIl(pick(it).phoneText) === want) || items[0];
  if (exact) return pick(exact, 'column');
  let page = await gql(env, `query($b:[ID!],$ids:[String!]){ boards(ids:$b){ items_page(limit:500){ cursor items{ id name column_values(ids:$ids){ id text } } } } }`, { b: [String(BOARD)], ids });
  let ip = page && page.boards && page.boards[0] && page.boards[0].items_page;
  for (let n = 0; ip && n < SCAN_PAGES; n++) {
    for (const it of ip.items || []) {
      const x = pick(it);
      if (digitsIl(x.phoneText) === want) return { ...x, matched: 'scan' };
      const inName = String(it.name || '').match(/(?:\+?972|0)[\d\s-]{8,13}/);
      if (inName && digitsIl(inName[0]) === want) return { ...x, matched: 'scan-name' };
    }
    if (!ip.cursor) break;
    page = await gql(env, `query($c:String!,$ids:[String!]){ next_items_page(limit:500,cursor:$c){ cursor items{ id name column_values(ids:$ids){ id text } } } }`, { c: ip.cursor, ids });
    ip = page && page.next_items_page;
  }
  return null;
}

/* read-only, for /api/lead-monday {action:'find'} */
export async function mondayFindLead(env, phone) {
  if (!env.MONDAY_API_TOKEN) return { found: false, why: 'no-token' };
  const cols = await columnMap(env);
  const hit = await findItemByPhone(env, cols, phone);
  return hit ? { found: true, ...hit } : { found: false, variants: phoneVariants(phone) };
}

/* create-or-update by phone. Returns { ok, id, created } or { ok:false, why }. */
export async function mondayUpsertLead(env, phone, rec) {
  if (!env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  const cols = await columnMap(env);
  const local = phone.replace(/^972/, '0');
  const hit = await findItemByPhone(env, cols, phone);
  if (hit) {
    const v = values(cols, phone, rec, false, hit.notes);
    /* a manual item found only by its name gets the phone column filled */
    if (!digitsIl(hit.phoneText) && cols['טלפון']) v[cols['טלפון']] = { phone: local, countryShortName: 'IL' };
    if (Object.keys(v).length) {
      await gql(env, `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`, { b: String(BOARD), i: hit.id, v: JSON.stringify(v) });
    }
    return { ok: true, id: hit.id, created: false, matched: hit.matched };
  }
  const vals = JSON.stringify(values(cols, phone, rec, true));
  const c = await gql(env, `mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$v){ id } }`,
    { b: String(BOARD), n: rec.name || local, v: vals });
  return { ok: true, id: c.create_item.id, created: true };
}

/* Richard 21/10: a payment closes the lead everywhere. The humans own סטטוס
   after creation, except this one transition: money in → "סגר". Phone is
   the join key, same as mondayUpsertLead. { ok, id } or { ok:false, why }.
   02/11: the payment line is APPENDED to הערות — it used to replace them. */
export async function mondayMarkWon(env, phone, note) {
  if (!env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  const cols = await columnMap(env);
  const hit = await findItemByPhone(env, cols, phone);
  if (!hit) return { ok: false, why: 'not-found' };
  const v = {}; v[cols['סטטוס']] = { label: 'סגר' }; v[cols['שלב']] = 'שילם';
  if (note && cols['הערות'] && !String(hit.notes || '').includes(note)) v[cols['הערות']] = { text: (hit.notes ? hit.notes + '\n' : '') + note };
  await gql(env, `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`, { b: String(BOARD), i: hit.id, v: JSON.stringify(v) });
  return { ok: true, id: hit.id };
}
