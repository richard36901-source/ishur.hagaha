/* ishur ops · mock (?mock=1 only — app.js imports this lazily, so live mode never downloads it):
   make the real-shaped fixtures/ops/*.json behave like the /api/ops/* endpoints. */
class HttpError extends Error { constructor(status, msg) { super(msg || 'HTTP ' + status); this.status = status; } }
let VER = '2';
let fixtureCache = {};
const fixture = (name) => (fixtureCache[name] = fixtureCache[name] || fetch(`fixtures/ops/${name}.json?v=${VER}`).then((r) => { if (!r.ok) throw new HttpError(r.status); return r.json(); }));
const mockState = { off: {}, liveTs: 0, brainStep: 2, decided: {}, reverted: {}, added: [] };
export async function mockApi(name, body, ver, qs) {
  if (ver) VER = ver;
  if (P4A_POST.test(name)) return p4aPost(name, body);
  if (name === 'messages') { const f = structuredClone(await fixture('messages')); const rows = body.tab === 'replies' ? f.inbound : body.tab === 'failed' ? f.items.filter((x) => x.status === 'failed') : f.items; return { ...f, tab: body.tab || 'all', items: rows.filter((x) => !body.cursor || x.ts < +body.cursor).slice(0, body.limit || 100), next_cursor: null }; }
  if (name === 'inbox') { const f = structuredClone(await fixture('inbox')); if (body.channel) f.items = f.items.filter((c) => c.ch.includes(body.channel)); f.items.forEach((c) => { if (mockState.human[c.phone] != null) c.human = mockState.human[c.phone]; }); return f; }
  if (name === 'thread') { const t = (await fixture('thread')).by_phone[String(body.phone || '')]; if (!t) return { ok: false, error: 'bad-phone' }; const c = structuredClone(t); if (mockState.human[c.phone] != null) c.takeover = { human: mockState.human[c.phone], ai: !mockState.human[c.phone], ai_off: mockState.human[c.phone] }; c.messages.push(...(mockState.sent[c.phone] || [])); return { ok: true, fixture: true, ...c }; }
  if (name === 'control') { const f = structuredClone(await fixture('control')); Object.assign(f, mockState.ctl); f.events.forEach((e) => Object.assign(e, mockState.flags[e.token] || {})); return f; }
  /* phase 4c writes (money screens) */
  if (name === '/fixedcost' || name === '/adspend') return { ok: true, fixture: true };
  if (name === 'finance' && body.set_manual) return { ok: true, fixture: true, month: body.set_manual.month, manual: { [body.set_manual.vendor]: body.set_manual.ils } };
  if (name === 'invoice-resend') { const p = { token: body.token, name: 'לקוח לדוגמה', phone: '0500000000', url: 'https://example.invalid/inv', number: '1001', template: 'ishur_heshbonit_n', confirm_required: String(body.token || '').slice(0, 8) }; return body.confirm ? { ok: true, applied: true, preview: p } : { ok: true, applied: false, preview: p }; }
  if (name === 'template-variant') return body.confirm ? { ok: true, applied: true, meta: { id: 'mock' } } : { ok: true, applied: false, confirm_required: body.new_name, preview: { name: body.new_name, category: 'UTILITY' } };
  if (name.includes('/') || name === 'pay-link') return (await import('./crm/mock.js')).crmMock(name, body, VER, qs != null ? 'GET' : 'POST');
  const now = new Date().toISOString();
  if (name === 'registry') {
    const r = structuredClone(await fixture('registry'));
    r.nodes.forEach((n) => { const o = mockState.off[n.id]; if (o !== undefined) n.state = { ...n.state, enabled: !o, off: o }; });
    return r;
  }
  if (name === 'runs') {
    const r = await fixture('runs');
    const items = r.items.filter((x) => (!body.automation_id || x.automation_id === body.automation_id) && (!body.status || x.status === body.status) && (!body.triggered_by || x.triggered_by.startsWith(body.triggered_by)) && (!body.q || (x.automation_id + x.id + (x.error || '')).includes(body.q)));
    const off = body.cursor ? +body.cursor : 0, lim = body.limit || 50;
    return { ok: true, fixture: true, source: r.source, items: items.slice(off, off + lim), next_cursor: off + lim < items.length ? String(off + lim) : null };
  }
  if (name === 'run') {
    const d = await fixture('run');
    if (!body.id || (d.run && body.id === d.run.id)) return d;
    const run = (await fixture('runs')).items.find((x) => x.id === body.id);
    return run ? { ok: true, fixture: true, source: 'kv', run, children: [], audit: [], audit_window: { from: run.started_at, to: run.ended_at, token: null } } : { ok: false, error: 'not-found' };
  }
  if (name === 'live') {
    const f = await fixture('live');
    if (!body.since) { mockState.liveTs = f.cursor; return f; }
    const n = Math.random() < 0.35 ? 0 : 1 + Math.floor(Math.random() * 2);
    const items = Array.from({ length: n }, () => { const t = f.items[Math.floor(Math.random() * f.items.length)]; const ts = Math.max(Date.now(), ++mockState.liveTs); mockState.liveTs = ts; return { ...t, ts, id: t.id + '-m' + ts, at: new Date(ts).toISOString() }; });
    return { ok: true, fixture: true, items, cursor: mockState.liveTs, now: Date.now() };
  }
  if (name === 'code') { const c = (await fixture('code')).by_id[body.id]; return c || { ok: false, error: 'no-code-snapshot' }; }
  if (name === 'brain') {
    const b = structuredClone(await fixture('brain')), n = b.stream.length;
    b.pending = b.pending.filter((p) => !mockState.decided[p.id]);
    if (!body.since) { mockState.brainStep = 3; return { ...b, stream: b.stream.slice(0, 3), cursor: b.stream[2].id }; }
    const id = b.stream[n - 1].id + ++mockState.brainStep;
    return { ...b, stream: [{ ...b.stream[mockState.brainStep % n], id, at: now }], cursor: id };
  }
  if (name === 'brain-decision') mockState.decided[body.id] = 1;
  if (name === 'edit' && body.confirm == null) return { ok: true, applied: false, confirm_required: body.id, blast_radius: { effects: [{ label: 'דמה', count: 1 }] } };
  if (/^(edit|brain-)/.test(name)) return { ok: true, applied: true, checks: 16 };
  if (name === 'toggle') {
    const reg = await fixture('registry'), node = reg.nodes.find((n) => n.id === body.id);
    if (!node) return { ok: false, error: 'unknown-id' };
    const sw = node.kill_switch ? (node.kill_switch.via || node.id) : null;
    if (!sw) return { ok: false, error: 'no-kill-switch' };
    if (body.confirm !== body.id && body.confirm !== sw) {
      const t = body.enabled === false ? (await fixture('toggle')).by_id[sw] : null;
      return t ? { ...t, id: body.id } : { ok: true, id: body.id, switch_id: sw, requested_enabled: body.enabled, blast_radius: null, confirm_required: sw, applied: false };
    }
    mockState.off[body.id] = body.enabled ? null : { at: now, by: body.who || 'richard', reason: body.reason || 'כובה מלוח הבקרה (דמה)' };
    return { ok: true, id: body.id, switch_id: sw, applied: true };
  }
  if (name === 'changes') {
    const f = structuredClone(await fixture('changes'));
    const kinds = body.kind ? String(body.kind).split(',') : null;
    f.items = f.items.map((x) => (mockState.reverted[x.id] ? { ...x, reverted_at: mockState.reverted[x.id].at, reverted_by: mockState.reverted[x.id].by } : x))
      .filter((x) => (!kinds || kinds.includes(x.kind)) && (!body.actor || x.actor === body.actor) && (!body.from || x.at >= new Date(body.from).toISOString()) && (!body.to || x.at <= new Date(body.to).toISOString()));
    f.items = mockState.added.concat(f.items).sort((a, b) => (a.at < b.at ? 1 : -1));
    return f;
  }
  if (name === 'revert') {
    const it = (await fixture('changes')).items.find((x) => x.id === body.id);
    if (!it || !it.revert.possible) return { ok: false, error: it ? 'not-revertible' : 'unknown-change' };
    if (mockState.reverted[it.id]) return { ok: false, error: 'already-reverted' };
    const p = it.revert.payload || {};
    const preview = it.revert.how === 'rollback' ? { version_id: p.version_id, command: `cd worker && npx wrangler rollback ${p.version_id} --name ishur-webhooks`, api: false } : it.revert.how === 'edit' ? { setting: p.id, back_to: p.value } : p.pause !== undefined ? { pause: p.pause } : { switch: p.id, enabled: p.enabled };
    if (body.confirm !== it.revert.confirm) return { ok: true, applied: false, id: it.id, how: it.revert.how, preview, confirm_required: it.revert.confirm };
    if (it.revert.how === 'rollback') return { ok: true, applied: false, manual: true, preview, he: 'אין CF_API_TOKEN בוורקר: להריץ את הפקודה במחשב (דמה)', command: preview.command };
    const nid = 'cmock' + Date.now().toString(36);
    mockState.reverted[it.id] = { at: now, by: nid };
    mockState.added.unshift({ id: nid, at: now, kind: it.kind, actor: 'Richard', summary_he: 'שחזור: ' + it.summary_he, details: { reverts: it.id }, revert: { possible: false, how: 'none', payload: null, confirm: null }, reverted_at: null, reverted_by: null });
    return { ok: true, applied: true, id: it.id, revert_change_id: nid };
  }
  if (name === 'calendar') { const f = await fixture('calendar'); return !body.month || body.month === f.month ? f : { ok: true, fixture: true, month: body.month, days: [], events: [] }; }
  return fixture(name);
}

/* Phase 4a POST routes (?mock=1): nothing leaves the browser */
const P4A_POST = /^\/(wa-send|human|pause|pacer|daily-run|event-flag|block-phone|brain-toggle|ipn-replay)$/;
Object.assign(mockState, { human: {}, sent: {}, ctl: {}, flags: {}, blocked: {} });
function p4aPost(name, b) {
  const r = name.slice(1);
  if (r === 'wa-send') { const m = { id: 'wamid.MOCK' + Date.now(), ts: Date.now(), at: new Date().toISOString(), dir: 'out', type: b.mode === 'template' ? 'template' : 'text', text: b.text || '', tmpl: b.template || '', status: 'sent', ch: b.channel || 'client', who: 'ריצארד', media: null, buttons: [] }; (mockState.sent[b.to] = mockState.sent[b.to] || []).push(m); return { ok: true, id: m.id, fixture: true }; }
  if (r === 'human') { if (typeof b.ai === 'boolean') mockState.human[b.phone] = !b.ai; return { ok: true, phone: b.phone, human: !!mockState.human[b.phone], ai: !mockState.human[b.phone] }; }
  if (r === 'pause') { if (typeof b.paused === 'boolean') mockState.ctl.paused = b.paused; return { ok: true, paused: !!mockState.ctl.paused }; }
  if (r === 'brain-toggle') { if (typeof b.active === 'boolean') mockState.ctl.brain_active = b.active; return { ok: true, active: !!mockState.ctl.brain_active }; }
  if (r === 'pacer') return { ok: true, fixture: true, sends: { ran: true, sent: 3 }, calls: { dialed: 1 } };
  if (r === 'daily-run') return { ok: true, fixture: true, dry: !!b.dry, events: [{ a: 1 }, { a: 2 }, { a: 3 }] };
  if (r === 'event-flag') { if (typeof b.on === 'boolean') (mockState.flags[b.token] = mockState.flags[b.token] || {})[b.flag] = b.on; return { ok: true, flag: b.flag, on: b.on }; }
  if (r === 'block-phone') { if (typeof b.blocked === 'boolean') mockState.blocked[b.phone] = b.blocked; return { ok: true, phone: b.phone, blocked: !!mockState.blocked[b.phone], opted_out: false }; }
  if (r === 'ipn-replay') return /^ipnmiss:\d+$/.test(b.id || '') ? { ok: true, status: 200, result: 'ok (דמה)' } : { ok: false, error: 'bad-id' };
  return { ok: false, error: 'unknown' };
}
