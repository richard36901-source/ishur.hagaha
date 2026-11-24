/* ============================================================================
   ishur.io · teamnotes.js · requests the team writes to Richard (24/11/2026)
   ----------------------------------------------------------------------------
   Shalev hands Richard work by writing from the business line (Noa, the client
   number) to his own WhatsApp. Those messages reach the Worker as phone echoes.
   Richard, 24/11: nothing here may depend on an assistant being awake ("מה
   דיברנו על תלות?"). So the Worker itself keeps every such note as an open
   request, and the ops brain raises it in Slack when it stays open too long.
   Whoever handles it (a person on the ops screen, or an assistant) closes it.

   KV  teamnote:<ts13>:<id tail>  = { at, text, type, status:'open'|'done', result?, done_at? }   90 days
   One key per note: a burst of messages never races on one document.
   ========================================================================== */
const TTL = 90 * 86400;
export const OPEN_ALERT_MS = 6 * 3600 * 1000;
const digits = p => String(p || '').replace(/\D/g, '');

/* a note = typed by a person on the client line's phone, to the owner's own number, with words in it */
export function isTeamNote({ peer, owner, ch, appAuto, text }) {
  return !!owner && digits(peer) === digits(owner) && ch === 'client' && !appAuto && String(text || '').trim().length >= 3;
}
export function noteKey(ts, id) { return 'teamnote:' + String(ts).padStart(13, '0') + ':' + (String(id || '').replace(/[^A-Za-z0-9]/g, '').slice(-16) || 'x'); }

export async function saveNote(env, { id, ts, text, type }) {
  if (!env || !env.RATE) return null;
  const key = noteKey(ts, id);
  await env.RATE.put(key, JSON.stringify({ at: new Date(ts).toISOString(), text: String(text || '').slice(0, 1200), type: String(type || 'text'), status: 'open' }), { expirationTtl: TTL });
  return key;
}
export async function listNotes(env, { days = 7, now = Date.now() } = {}) {
  if (!env || !env.RATE) return [];
  const out = []; let cursor;
  do {
    const page = await env.RATE.list({ prefix: 'teamnote:', cursor, limit: 1000 });
    for (const k of page.keys || []) {
      const ts = Number(String(k.name).split(':')[1]) || 0;
      if (now - ts > days * 86400e3) continue;
      let v = null; try { v = JSON.parse((await env.RATE.get(k.name)) || 'null'); } catch {}
      if (v) out.push({ key: k.name, ts, ...v });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => a.ts - b.ts);
}
export async function closeNote(env, key, result) {
  if (!env || !env.RATE || !/^teamnote:\d{13}:[A-Za-z0-9]+$/.test(String(key || ''))) return false;
  let v = null; try { v = JSON.parse((await env.RATE.get(key)) || 'null'); } catch {}
  if (!v) return false;
  await env.RATE.put(key, JSON.stringify({ ...v, status: 'done', result: String(result || '').slice(0, 300), done_at: new Date().toISOString() }), { expirationTtl: TTL });
  return true;
}
/* what the ops brain raises: a note still open after OPEN_ALERT_MS */
export function overdueNotes(notes, now = Date.now()) {
  return (notes || []).filter(n => n.status === 'open' && now - n.ts >= OPEN_ALERT_MS);
}
