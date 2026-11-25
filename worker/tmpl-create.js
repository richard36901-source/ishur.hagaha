/* 26/11: submit one WhatsApp template to Meta for approval, from the admin (Richard: "we tried to reach you" for leads).
   POST /api/tmpl-create {admin_key, line:'noa'|'guests', name, category:'UTILITY'|'MARKETING', language:'he', body, example:[..]}
   Only creates; never sends a message. Name: lowercase a-z 0-9 _ (Meta's rule). Body variables {{1}}..{{n}} need one example each. */
export const WABA = { noa: '1060242146337688', guests: '1378764257421712' };

export function templatePayload(b) {
  const name = String(b.name || '').trim();
  if (!/^[a-z0-9_]{3,60}$/.test(name)) return { error: 'bad-name' };
  const category = String(b.category || 'UTILITY').toUpperCase();
  if (!['UTILITY', 'MARKETING'].includes(category)) return { error: 'bad-category' };
  const body = String(b.body || '').trim();
  if (!body || body.length > 1024) return { error: 'bad-body' };
  const vars = (body.match(/\{\{(\d+)\}\}/g) || []).map(x => Number(x.slice(2, -2)));
  const n = vars.length ? Math.max(...vars) : 0;
  for (let i = 1; i <= n; i++) if (!vars.includes(i)) return { error: 'bad-variables' };
  const ex = Array.isArray(b.example) ? b.example.map(String) : [];
  if (ex.length !== n) return { error: 'bad-example' };
  const comp = { type: 'BODY', text: body };
  if (n) comp.example = { body_text: [ex] };
  return { payload: { name, category, language: String(b.language || 'he'), components: [comp] } };
}

export async function handleTmplCreate(request, env, origin, d) {
  let b = {}; try { b = await request.json(); } catch { return d.deny(400, 'bad-json', origin); }
  if (!d.isAdmin(env, b.admin_key)) return d.deny(403, 'bad-admin-key', origin);
  const line = b.line === 'guests' ? 'guests' : 'noa';
  const tok = line === 'guests' ? env.WA_TOKEN_GUESTS : env.WA_TOKEN;
  if (!tok) return d.deny(503, 'not-configured', origin);
  const p = templatePayload(b);
  if (p.error) return d.okJson({ ok: false, error: p.error }, origin);
  const r = await fetch(`https://graph.facebook.com/v21.0/${WABA[line]}/message_templates`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(p.payload) }).catch(() => null);
  const j = r ? await r.json().catch(() => null) : null;
  await d.logEvent(env, { area: 'תבניות', action: `תבנית הוגשה למטא: ${p.payload.name} (${line})`, ok: !!(r && r.ok), review: !(r && r.ok), detail: JSON.stringify(j || {}).slice(0, 300) }).catch(() => {});
  return d.okJson({ ok: !!(r && r.ok), status: r ? r.status : 0, meta: j }, origin);
}
