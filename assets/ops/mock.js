/* ishur ops · mock (?mock=1 only — app.js imports this lazily, so live mode never downloads it):
   make the real-shaped fixtures/ops/*.json behave like the /api/ops/* endpoints. */
class HttpError extends Error { constructor(status, msg) { super(msg || 'HTTP ' + status); this.status = status; } }
let VER = '2';
let fixtureCache = {};
const fixture = (name) => (fixtureCache[name] = fixtureCache[name] || fetch(`fixtures/ops/${name}.json?v=${VER}`).then((r) => { if (!r.ok) throw new HttpError(r.status); return r.json(); }));
const mockState = { off: {}, liveTs: 0, brainStep: 2, decided: {} };
export async function mockApi(name, body, ver) {
  if (ver) VER = ver;
  if (name.includes('/') || name === 'pay-link') return (await import('./crm/mock.js')).crmMock(name, body, VER);
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
  return fixture(name);
}
