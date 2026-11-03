/* ishur ops · mock (?mock=1 only — app.js imports this lazily, so live mode never downloads it):
   make the real-shaped fixtures/ops/*.json behave like the /api/ops/* endpoints. */
class HttpError extends Error { constructor(status, msg) { super(msg || 'HTTP ' + status); this.status = status; } }
let VER = '2';
let fixtureCache = {};
const fixture = (name) => (fixtureCache[name] = fixtureCache[name] || fetch(`fixtures/ops/${name}.json?v=${VER}`).then((r) => { if (!r.ok) throw new HttpError(r.status); return r.json(); }));
const mockState = { off: {}, liveTs: 0, brainStep: 2, decided: {}, reverted: {}, added: [] };
export async function mockApi(name, body, ver, qs) {
  if (ver) VER = ver;
  /* 03/11 Phase 4b call center (fixtures built by running the real ops-calls.js handlers on masked data) */
  if (name === '/voice-prompt') {
    const sh = await fixture('shir');
    if (body.action === 'get') return { ok: true, agent: 'shir_out', name: sh.name, prompt: sh.prompt, head: sh.head, history: sh.history };
    if (body.action === 'version') { const h = sh.history.find((x) => x.n === +body.n); return h ? { ok: true, agent: 'shir_out', n: h.n, at: h.at, note: h.note, prompt: sh.prompt + '\n(גרסה ' + h.n + ', דמה)' } : { ok: false, error: 'no-such-version' }; }
    return { ok: true, agent: 'shir_out', version: sh.head + 1, note: body.note || 'דמה' };
  }
  if (name === 'calls') {
    const f = structuredClone(await fixture('calls'));
    const want = body.outcome ? String(body.outcome).split(',') : null, num = String(body.number || '').replace(/\D/g, '').replace(/^0/, '');
    f.items = f.items.filter((r) => (!want || want.includes(r.outcome)) && (!body.event || r.tok8 === body.event) && (!body.agent || r.agent === body.agent) && (!num || r.phone.includes(num)) && (body.week || r.day === f.to));
    return f;
  }
  if (name === 'call') { const c = structuredClone(await fixture('call')); if (body.id && body.id !== c.call.id) { const r = (await fixture('calls')).items.find((x) => x.id === body.id); if (!r) return { ok: false, error: 'not-found' }; return { ok: true, call: r, transcript: r.has_transcript ? [{ role: 'agent', text: 'היי, מדברת ' + r.agent }, { role: 'user', text: r.summary || 'כן' }] : [], transcript_source: 'audit', summary: r.summary, sentiment: r.sentiment, analysis: {}, recording: null, recording_missing: 'no-metadata', sources: { retell: false, audit: true, recmeta: false } }; } return c; }
  if (name === 'call-rounds') { const f = structuredClone(await fixture('call-rounds')); f.events.forEach((e) => { const o = mockState.stop && mockState.stop[e.token]; if (o !== undefined) { e.stopped = o; e.will_dial = !o && !e.why.filter((w) => w.code !== 'stopped').length; e.why = o ? [{ code: 'stopped', he: 'הסבב נעצר ידנית' }, ...e.why.filter((w) => w.code !== 'stopped')] : e.why.filter((w) => w.code !== 'stopped'); } }); return f; }
  if (name === 'call-round') {
    const word = String(body.token || '').slice(0, 8);
    if (body.confirm !== word) return { ok: true, applied: false, token: body.token, action: body.action, confirm_required: word, extra_round_guests: body.extra ? 3 : null, he: body.action === 'stop' ? 'שיר תפסיק לחייג לאורחי האירוע הזה עד שיופעל שוב (דמה).' : 'שיר תחזור לחייג לאורחי האירוע (דמה).' };
    mockState.stop = mockState.stop || {}; mockState.stop[body.token] = body.action === 'stop' ? { at: new Date().toISOString(), by: 'richard', reason: '' } : null;
    return { ok: true, applied: true, token: body.token, action: body.action, stopped_now: body.action === 'stop' };
  }
  if (name === 'manual-calls') {
    if (body.action === 'note') return { ok: true, guest_id: body.guest_id, note: body.note ? { text: body.note, at: new Date().toISOString(), by: 'richard' } : null };
    if (body.action === 'done') { const gone = ['מגיע', 'לא מגיע', 'לא להתקשר'].includes(body.outcome); return { ok: true, guest_id: body.guest_id, rsvp: body.outcome, call_status: gone ? '' : 'נדרשת שיחה', answer: body.outcome, tries: (+body.tries || 0) + (body.outcome === 'לא ענה' ? 1 : 0) }; }
    return structuredClone(await fixture('manual-calls'));
  }
  if (name === 'shir') return structuredClone(await fixture('shir'));
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
