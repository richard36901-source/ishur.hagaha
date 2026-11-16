/* ============================================================================
   Two small things beside the leads mirror (16/11/2026, Richard):
   1. the updates written on a lead in monday (the item's own thread), read live
      when a lead is opened — they are not copied anywhere
   2. registering monday's webhooks for the leads board from here, so a change
      in monday reaches us within seconds without Make. The URL carries
      MONDAY_WEBHOOK_SECRET; the ids monday returns are kept in KV so the same
      route can show them and remove them (the off switch).
   POST /api/leads-monday {admin_key, updates_of:<item id>} | {webhook:'status'|'register'|'remove'}
   ============================================================================ */
import { BOARD } from './leads-sync.js';
export const WEBHOOK_EVENTS = ['change_column_value', 'create_item', 'item_archived', 'item_deleted', 'change_name'];
const KEY = 'mlb:webhooks';
const pj = v => { try { return JSON.parse(v); } catch { return null; } };
export const hookUrl = env => 'https://go.ishur.io/webhooks/monday-leads?k=' + encodeURIComponent(String(env.MONDAY_WEBHOOK_SECRET || ''));
export function shapeUpdates(items) {
  const it = items && items[0]; if (!it) return [];
  return (it.updates || []).map(u => ({ id: String(u.id || ''), at: String(u.created_at || ''), who: String((u.creator && u.creator.name) || '').slice(0, 40), text: String(u.text_body || '').replace(/\s+\n/g, '\n').trim().slice(0, 1500) })).filter(u => u.text);
}
export async function handleLeadsMonday(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  if (!env.MONDAY_API_TOKEN) return d.okJson({ ok: false, error: 'no-monday-token' }, origin);
  const gql = d.gql;
  if (b.updates_of_phone != null && d.findLead) { const f = await d.findLead(env, String(b.updates_of_phone).replace(/\D/g, '')).catch(() => null); if (!f || !f.found || !f.id) return d.okJson({ ok: true, updates: [], in_monday: false }, origin); b.updates_of = f.id; }
  if (b.updates_of != null) {
    const id = String(b.updates_of).replace(/\D/g, ''); if (!id) return d.okJson({ ok: false, error: 'bad-id' }, origin);
    try { const r = await gql(env, 'query($i:[ID!]){ items(ids:$i){ id updates(limit:15){ id text_body created_at creator{ name } } } }', { i: [id] }); return d.okJson({ ok: true, updates: shapeUpdates(r && r.items) }, origin); }
    catch (e) { return d.okJson({ ok: false, error: 'monday-read-failed' }, origin); }
  }
  if (b.webhook) {
    const have = pj(await env.RATE.get(KEY).catch(() => null) || 'null') || [];
    if (b.webhook === 'status') return d.okJson({ ok: true, secret_set: !!env.MONDAY_WEBHOOK_SECRET, registered: have.map(h => h.event) }, origin);
    if (b.webhook === 'register') {
      if (!env.MONDAY_WEBHOOK_SECRET) return d.okJson({ ok: false, error: 'no-webhook-secret' }, origin);
      const out = [...have], failed = [];
      for (const ev of WEBHOOK_EVENTS) { if (out.some(h => h.event === ev)) continue;
        try { const r = await gql(env, 'mutation($b:ID!,$u:String!,$e:WebhookEventType!){ create_webhook(board_id:$b,url:$u,event:$e){ id } }', { b: BOARD, u: hookUrl(env), e: ev }); const id = r && r.create_webhook && r.create_webhook.id; if (id) out.push({ id: String(id), event: ev, at: new Date().toISOString() }); else failed.push(ev); }
        catch (e) { failed.push(ev + ': ' + String(e && e.message || e).slice(0, 80)); } }
      await env.RATE.put(KEY, JSON.stringify(out));
      return d.okJson({ ok: !failed.length, registered: out.map(h => h.event), failed }, origin);
    }
    if (b.webhook === 'remove') {
      const left = [];
      for (const h of have) { try { await gql(env, 'mutation($i:ID!){ delete_webhook(id:$i){ id } }', { i: h.id }); } catch (e) { left.push(h); } }
      if (left.length) await env.RATE.put(KEY, JSON.stringify(left)); else await env.RATE.delete(KEY);
      return d.okJson({ ok: !left.length, registered: left.map(h => h.event) }, origin);
    }
  }
  return d.deny(400, 'bad-request', origin);
}
