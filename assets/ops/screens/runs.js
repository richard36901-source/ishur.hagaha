/* Runs ledger: filterable, virtual rows, run drawer with children, logs and linked audit rows. */
import { esc, fmtN, fmtDT, fmtTime, Table, mountVirtual, Select, Tabs, Badge, Skeleton, Drawer, icon, SKIP_HE, toast } from '../ui.js';

const TRIG_HE = { cron: 'תזמון', manual: 'ידני', brain: 'מוח', webhook: 'webhook' };
const trig = (t) => TRIG_HE[(t || '').split(':')[0]] || t || '—';
export const COLS = [
  { label: 'מתי', render: (r) => `<span class="num">${esc(fmtDT(r.started_at))}</span>` },
  { label: 'אוטומציה', render: (r) => `<span class="ellip" style="max-width:220px;display:inline-block;vertical-align:middle">${esc(r.name)}</span>` },
  { label: 'מצב', render: (r) => Badge(r.status, r.status === 'skipped' && r.skip_reason ? 'דולג · ' + (SKIP_HE[r.skip_reason] || r.skip_reason) : '') },
  { label: 'הופעל ע״י', hideM: true, render: (r) => esc(trig(r.triggered_by)) },
  { label: 'ספירות', hideM: true, render: (r) => esc(Object.entries(r.counts || {}).map(([k, v]) => k + ' ' + v).join(' · ')) },
  { label: 'עלות', num: true, hideM: true, render: (r) => (r.cost_usd ? '$' + r.cost_usd.toFixed(2) : '<span class="muted">—</span>') },
  { label: 'שגיאה / טיפול', render: (r) => (r.error ? `<span class="ellip" style="max-width:260px;display:inline-block;vertical-align:middle;color:var(--crit-ink)" title="${esc(r.error)}">${esc(r.error_class || '')} ${esc(r.handled || '')}</span>` : '') },
];
export const listView = (items) => Table({ columns: COLS, rows: items, rowKey: (r) => r.id, empty: 'אין ריצות שמתאימות לסינון' });

export function runDetail(d) {
  const r = d.run;
  const counts = Object.entries(r.counts || {});
  return `<div class="bar">${Badge(r.status)} <span class="badge">${esc(trig(r.triggered_by))}</span> <span class="sub mono" dir="ltr">${esc(r.id)}</span></div>
<dl class="kv"><dt>אוטומציה</dt><dd><a href="#/automations/${esc(r.automation_id)}">${esc(r.name)}</a></dd><dt>התחיל</dt><dd class="num">${esc(fmtDT(r.started_at))}</dd><dt>הסתיים</dt><dd class="num">${esc(fmtDT(r.ended_at))}${r.duration_ms ? ` · ${fmtN(Math.round(r.duration_ms / 100) / 10)} שניות` : ''}</dd>
${r.skip_reason ? `<dt>למה דולג</dt><dd>${esc(SKIP_HE[r.skip_reason] || r.skip_reason)}</dd>` : ''}${counts.length ? `<dt>ספירות</dt><dd class="num">${esc(counts.map(([k, v]) => k + ' ' + v).join(' · '))}</dd>` : ''}${r.cost_usd ? `<dt>עלות</dt><dd class="num">$${r.cost_usd.toFixed(2)}</dd>` : ''}${r.parent_id ? `<dt>ריצת אב</dt><dd><a href="#/runs/${esc(r.parent_id)}">${esc(r.parent_id)}</a></dd>` : ''}</dl>
${r.error ? `<div class="errbox"><span>✕</span><span><b class="mono" dir="ltr">${esc(r.error)}</b>${r.handled ? '<br>איך טופל: ' + esc(r.handled) : ''}</span></div>` : ''}
${(d.children || []).length ? `<section><h3 class="h2">שלבים (${d.children.length})</h3>${Table({ rows: d.children, rowKey: (c) => c.id, columns: [{ label: 'שלב', render: (c) => esc(c.name) }, { label: 'מצב', render: (c) => Badge(c.status, c.skip_reason ? 'דולג · ' + (SKIP_HE[c.skip_reason] || c.skip_reason) : '') }, { label: 'ספירות', render: (c) => esc(Object.entries(c.counts || {}).map(([k, v]) => k + ' ' + v).join(' · ')) }] })}</section>` : ''}
<section><h3 class="h2">לוג</h3><div class="code" dir="ltr" style="margin-top:8px"><pre>${(d.logs || []).map((l) => `<span class="ln${l.level === 'error' ? ' hl' : ''}" data-n="${esc(fmtTime(l.ts))}" dir="auto">${esc((l.level !== 'info' ? l.level.toUpperCase() + ' ' : '') + l.msg)}</span>`).join('') || '<span class="ln">—</span>'}</pre></div></section>
<section><h3 class="h2">רשומות ביומן (audit)</h3>${Table({ rows: d.audit || [], rowKey: (a) => a.id, empty: 'אין רשומות מקושרות', columns: [{ label: 'מתי', render: (a) => `<span class="num">${esc(fmtTime(a.at))}</span>` }, { label: 'סוג', render: (a) => `<span class="badge">${esc(a.kind)}</span>` }, { label: 'מה', render: (a) => esc(a.summary) }, { label: 'id', render: (a) => `<span class="mono">${esc(a.id)}</span>` }] })}</section>`;
}

export default {
  skeleton: () => Skeleton.table(14),
  async mount(el, ctx) {
    const qs = new URLSearchParams((location.hash.split('?')[1]) || '');
    const f = { automation_id: qs.get('automation_id') || '', status: qs.get('status') || '', triggered_by: '', q: '' };
    let items = [], cursor = null, vt = null;
    const reg = ctx.api.cached('registry')?.data || await ctx.api.get('registry').catch(() => null);
    const autos = [{ value: '', label: 'כל האוטומציות' }, ...(reg ? reg.nodes.filter((n) => n.layer > 0).map((n) => ({ value: n.id, label: n.name_he })) : [])];
    el.innerHTML = `<div class="bar"><div class="search">${icon('search')}<input class="in" data-search placeholder="חיפוש (שם, שגיאה, id)" aria-label="חיפוש"></div>
${Select({ name: 'automation_id', value: f.automation_id, options: autos })}
${Tabs({ name: 'status', value: f.status, items: [{ value: '', label: 'הכל' }, { value: 'ok', label: 'הצליחו' }, { value: 'failed', label: 'נכשלו' }, { value: 'partial', label: 'חלקי' }, { value: 'skipped', label: 'דולגו' }] })}
${Select({ name: 'triggered_by', value: '', options: [{ value: '', label: 'כל המפעילים' }, { value: 'cron', label: 'תזמון' }, { value: 'manual', label: 'ידני' }, { value: 'brain', label: 'מוח' }, { value: 'webhook', label: 'webhook' }] })}
<span class="sp" style="flex:1"></span><span class="sub num" id="rn-count"></span></div>
<div class="card flush" id="rn-list">${Skeleton.table(12)}</div><div id="rn-more"></div>`;
    const list = el.querySelector('#rn-list');
    const load = async (more = false) => {
      const body = { ...f, limit: 200 }; if (more && cursor) body.cursor = cursor;
      Object.keys(body).forEach((k) => body[k] === '' && delete body[k]);
      try {
        const r = await ctx.api.get('runs', body, { cache: !more });
        items = more ? items.concat(r.items) : r.items; cursor = r.next_cursor;
        el.querySelector('#rn-count').textContent = fmtN(items.length) + (r.total ? ' מתוך ' + fmtN(r.total) : '') + ' ריצות';
        if (!items.length) { list.innerHTML = listView([]); vt = null; }
        else if (vt && more) vt.update(items);
        else vt = mountVirtual(list, { columns: COLS, rows: items, rowH: 42, height: Math.max(360, innerHeight - 220) });
        el.querySelector('#rn-more').innerHTML = cursor ? '<button type="button" class="btn" data-act="more">לטעון עוד</button>' : '';
      } catch (e) { list.innerHTML = ctx.errorBox(e, 'rn-retry'); }
    };
    let qT = 0;
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { clearTimeout(qT); qT = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 180); } });
    ctx.on(el, 'ops:change', (e) => { f[e.detail.name] = e.detail.value; load(); });
    ctx.on(el, 'click', (e) => {
      if (e.target.closest('[data-act=more]')) return load(true);
      if (e.target.closest('[data-act=rn-retry]')) return load();
      const row = e.target.closest('tr[data-row]'); if (row) ctx.nav('runs/' + row.dataset.row);
    });
    await load();
    ctx.poll(() => (!f.q && !cursor ? load() : null), 20000);
  },
  async onArg(id, ctx) {
    if (!id) { Drawer.close(); return; }
    const b = Drawer.open('ריצה ' + id, Skeleton.lines(8), { onClose: () => { if (location.hash.startsWith('#/runs/')) history.replaceState(null, '', '#/runs'); } });
    try { const d = await ctx.api.get('run', { id }, { cache: false }); if (Drawer.body() === b) b.innerHTML = runDetail(d); }
    catch (e) { b.innerHTML = ctx.errorBox(e, 'noop'); toast(e.message, 'crit'); }
  },
};
