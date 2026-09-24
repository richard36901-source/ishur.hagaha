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

function values(cols, phone, rec, isNew) {
  const local = phone.replace(/^972/, '0');
  const stage = t => ({ lead_partial: 'התחיל טופס', lead: 'שלח טופס', checkout: 'הגיע לתשלום', initiate_checkout: 'הגיע לתשלום', purchase: 'שילם' })[t] || t || '';
  const day = iso => (iso ? String(iso).slice(0, 10) : '');
  const v = {};
  v[cols['טלפון']] = { phone: local, countryShortName: 'IL' };
  if (rec.email) v[cols['מייל']] = { email: rec.email, text: rec.email };
  const n = parseInt(String(rec.guests || '').replace(/\D/g, ''), 10);
  if (n) v[cols['כמות']] = String(n);
  v[cols['אירוע']] = rec.occasion || '';
  v[cols['חבילה']] = rec.plan || '';
  if (rec.price) v[cols['מחיר']] = String(rec.price);
  v[cols['שלב']] = stage((rec.types || []).slice(-1)[0]);
  v[cols['כניסות']] = String(rec.seen || 1);
  v[cols['מקור']] = (rec.source || 'ישיר') + (rec.page ? ' · ' + rec.page : '');
  v[cols['עדכונים']] = rec.consent ? 'אישר' : 'לא';
  if (day(rec.at)) v[cols['נכנס לראשונה']] = { date: day(rec.at) };
  if (rec.notes) v[cols['הערות']] = { text: rec.notes };
  /* the humans own סטטוס/טיפול after creation; a new lead starts as חדש → שלו */
  if (isNew) { v[cols['סטטוס']] = { label: (rec.types || []).includes('purchase') ? 'סגר' : 'חדש' }; v[cols['טיפול']] = { label: 'שלו' }; }
  return v;
}

/* create-or-update by phone. Returns { ok, id, created } or { ok:false, why }. */
export async function mondayUpsertLead(env, phone, rec) {
  if (!env.MONDAY_API_TOKEN) return { ok: false, why: 'no-token' };
  const cols = await columnMap(env);
  const local = phone.replace(/^972/, '0');
  const found = await gql(env, `query($b:ID!,$c:String!,$v:[String]!){ items_page_by_column_values(board_id:$b,limit:1,columns:[{column_id:$c,column_values:$v}]){ items{ id } } }`,
    { b: String(BOARD), c: cols['טלפון'], v: [local] });
  const hit = found.items_page_by_column_values && found.items_page_by_column_values.items[0];
  if (hit) {
    const vals = JSON.stringify(values(cols, phone, rec, false));
    await gql(env, `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v){ id } }`, { b: String(BOARD), i: hit.id, v: vals });
    return { ok: true, id: hit.id, created: false };
  }
  const vals = JSON.stringify(values(cols, phone, rec, true));
  const c = await gql(env, `mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$v){ id } }`,
    { b: String(BOARD), n: rec.name || local, v: vals });
  return { ok: true, id: c.create_item.id, created: true };
}
