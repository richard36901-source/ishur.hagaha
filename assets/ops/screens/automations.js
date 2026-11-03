/* Automations: every automation in day order (like the clients page), on/off with blast radius,
   plain-Hebrew explanation, code, dependencies, counts, run history. */
import { esc, fmtN, fmtTime, fmtDT, relTime, Table, Toggle, Select, Tabs, Badge, statusDot, Sparkline, Skeleton, Code, Button, Drawer, confirmTyped, toast, busy, icon, SKIP_HE, timeTag } from '../ui.js';

export const DAYPARTS = [
  ['continuous', 'כל 10 דקות · כל היום'], ['night', 'לילה · 00:00–08:00'], ['morning', 'בוקר · 08:00–12:00'],
  ['noon', 'צהריים · 12:00–17:00'], ['evening', 'ערב · 17:00–24:00'], ['event', 'לפי אירוע · webhook או ידני'],
];
export const KIND_HE = { send_guest: 'הודעה לאורחים', send_client: 'הודעה ללקוח', call: 'שיחה', slack: 'סלאק', internal: 'פנימי', trigger: 'טריגר' };
export const SIDE_HE = { wa_guest: 'וואטסאפ לאורחים', wa_client: 'וואטסאפ ללקוחות', call: 'שיחות בתשלום', sms: 'SMS', email: 'מייל', sheet: 'גיליון', kv: 'מצב פנימי', monday: 'מאנדיי', slack: 'סלאק', money: 'כסף' };

export function nodeStatus(n) {
  if (n.state && n.state.enabled === false) return 'off';
  const lr = n.stats && n.stats.last_run;
  if (n.stats && n.stats.fail_24h) return lr && lr.status === 'failed' ? 'failed' : 'partial';
  return lr ? lr.status : 'skipped';
}
export function sortNodes(nodes) {
  const order = Object.fromEntries(DAYPARTS.map(([k], i) => [k, i]));
  return nodes.filter((n) => n.layer > 0).sort((a, b) => (order[a.daypart] ?? 9) - (order[b.daypart] ?? 9) || (a.next_fire || '').localeCompare(b.next_fire || '') || a.layer - b.layer || a.name_he.localeCompare(b.name_he, 'he'));
}
export function filterNodes(nodes, f) {
  const q = (f.q || '').trim().toLowerCase();
  return nodes.filter((n) => (!q || (n.name_he + ' ' + n.id + ' ' + (n.explain_he || '')).toLowerCase().includes(q))
    && (!f.kind || n.kind === f.kind)
    && (!f.state || (f.state === 'on' ? n.state.enabled !== false : f.state === 'off' ? n.state.enabled === false : f.state === 'failing' ? n.stats.fail_24h > 0 : true)));
}

export function listView(nodes, f = {}) {
  const rows = filterNodes(sortNodes(nodes), f);
  const label = Object.fromEntries(DAYPARTS);
  return Table({
    rows, rowKey: (n) => n.id, groupBy: (n) => esc(label[n.daypart] || 'אחר'), empty: 'אין אוטומציה שמתאימה לסינון',
    columns: [
      { label: 'אוטומציה', render: (n) => `<span style="display:inline-flex;gap:8px;align-items:center">${statusDot(nodeStatus(n), n.daypart === 'continuous' && n.state.enabled !== false)}<span><b>${esc(n.name_he)}</b><br><span class="sub mono" dir="ltr">${esc(n.id)}</span></span></span>` },
      { label: 'סוג', hideM: true, render: (n) => `<span class="badge">${esc(KIND_HE[n.kind] || n.kind)}</span>` },
      { label: 'הבא', render: (n) => (n.state.enabled === false ? '<span class="muted">כבוי</span>' : n.next_fire ? `<span class="num">${esc(fmtTime(n.next_fire))}</span>` : `<span class="muted">${esc(n.daypart === 'event' ? 'לפי אירוע' : '—')}</span>`) },
      { label: 'ריצות 24ש׳', hideM: true, render: (n) => `<span style="display:inline-flex;gap:8px;align-items:center">${Sparkline(n.stats.spark_24h, { fails: n.stats.spark_fail_24h, w: 96, h: 22 })}<span class="num">${fmtN(n.stats.runs_24h)}</span></span>` },
      { label: 'כשלים', num: true, render: (n) => (n.stats.fail_24h ? `<span style="color:var(--crit-ink);font-weight:650">${fmtN(n.stats.fail_24h)}</span>` : '<span class="muted">0</span>') },
      { label: 'ריצה אחרונה', hideM: true, render: (n) => (n.stats.last_run ? `${timeTag(n.stats.last_run.at)}` : '<span class="muted">—</span>') },
      { label: 'פעיל', render: (n) => (n.kill || n.state.enabled === false ? Toggle({ id: n.id, on: n.state.enabled !== false }) : `<span class="sub" data-tip="אין לו מתג נפרד עדיין; נעצר דרך העצירה הכללית">עצירה כללית</span>`) },
    ],
  });
}

/* dependency graph: upstream → node → downstream, plus "needs" (depends_on) */
export function depGraph(n, nodes) {
  const byId = Object.fromEntries(nodes.map((x) => [x.id, x]));
  const up = (n.from || []).map((id) => byId[id]).filter(Boolean);
  const down = nodes.filter((x) => (x.from || []).includes(n.id));
  const needs = (n.depends_on || []).map((id) => byId[id]).filter(Boolean);
  const W = 600, rowH = 30, colX = [480, 300, 120], bw = 150;
  const H = Math.max(up.length, down.length + needs.length, 1) * rowH + 20;
  const ys = (k, len) => 10 + (H - 20 - len * rowH) / 2 + k * rowH + rowH / 2;
  const box = (x, y, t, id, tone = '') => `<a href="#/automations/${esc(id)}"><rect x="${x - bw / 2}" y="${y - 11}" width="${bw}" height="22" rx="6" fill="var(--surface)" stroke="var(--${tone || 'line-2'})"/><text x="${x}" y="${y + 4}" text-anchor="middle" style="fill:var(--ink)">${esc(t.length > 20 ? t.slice(0, 19) + '…' : t)}</text></a>`;
  const edge = (x1, y1, x2, y2, dash) => `<path d="M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}" fill="none" stroke="var(--ink-3)" stroke-width="1.2"${dash ? ' stroke-dasharray="3 3"' : ''}/>`;
  const my = H / 2;
  const right = down.concat(needs);
  let s = '';
  up.forEach((u, k) => { const y = ys(k, up.length); s += edge(colX[0] - bw / 2, y, colX[1] + bw / 2, my) + box(colX[0], y, u.name_he, u.id); });
  right.forEach((d, k) => { const y = ys(k, right.length), need = k >= down.length; s += edge(colX[1] - bw / 2, my, colX[2] + bw / 2, y, need) + box(colX[2], y, (need ? 'צריך: ' : '') + d.name_he, d.id); });
  s += `<rect x="${colX[1] - bw / 2}" y="${my - 13}" width="${bw}" height="26" rx="7" fill="var(--brand-soft)" stroke="var(--brand)"/><text x="${colX[1]}" y="${my + 4}" text-anchor="middle" style="fill:var(--ink);font-weight:650">${esc(n.name_he.slice(0, 20))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="תלויות: ${up.length} מעליו, ${down.length} מושפעים, ${needs.length} נדרשים">${s}</svg><div class="legend"><span>ימין: מי מפעיל אותו</span><span>שמאל: מה מושפע ממנו</span><span>מקווקו: מה הוא צריך</span></div>`;
}

export function runsTable(items) {
  return Table({
    rows: items, rowKey: (r) => r.id, empty: 'אין ריצות בטווח',
    columns: [
      { label: 'מתי', render: (r) => `<span class="num">${esc(fmtDT(r.started_at))}</span>` },
      { label: 'מצב', render: (r) => Badge(r.status, r.status === 'skipped' && r.skip_reason ? 'דולג · ' + (SKIP_HE[r.skip_reason] || r.skip_reason) : '') },
      { label: 'ספירות', render: (r) => esc(Object.entries(r.counts || {}).map(([k, v]) => k + ' ' + v).join(' · ')) || '<span class="muted">—</span>' },
      { label: 'משך', num: true, hideM: true, render: (r) => (r.duration_ms ? fmtN(Math.round(r.duration_ms / 100) / 10) + 'ש׳' : '—') },
      { label: 'טיפול', render: (r) => (r.error ? `<span class="ellip" title="${esc(r.error)}">${esc(r.handled || r.error)}</span>` : '') },
    ],
  });
}

export function detailView(n, nodes) {
  const st = n.stats || {}, on = n.state.enabled !== false;
  const lr = st.last_run;
  const side = (n.side_effects || []).map((s) => `<span class="badge ${['wa_guest', 'call', 'money'].includes(s) ? 'serious' : ''}">${esc(SIDE_HE[s] || s)}</span>`).join('');
  return `
<div class="bar">${Badge(nodeStatus(n), on ? null : 'כבוי')} ${Badge(n.severity)} <span class="badge">${esc(KIND_HE[n.kind] || n.kind)}</span> <span class="sub mono" dir="ltr">${esc(n.id)}</span></div>
<p style="margin:0;font-size:15px;line-height:1.65">${esc(n.explain_he || '')}</p>
<section class="${n.kill ? 'danger-zone' : 'card'}"><div class="sec-h"><h3 class="h2">${on ? 'פעיל' : 'כבוי'}</h3><span class="sp"></span>${n.kill || !on ? Toggle({ id: n.id, on, label: on ? 'לכבות' : 'להדליק' }) : ''}</div>
${!on ? `<p class="sub" style="margin:0">כובה ע״י ${esc(n.state.disabled_by || '—')} ${esc(relTime(n.state.disabled_at))}${n.state.reason ? ' · ' + esc(n.state.reason) : ''}</p>` : ''}
<p class="sub" style="margin:6px 0 0">${n.kill ? 'כיבוי מציג קודם בדיוק מה ייעצר, ודורש להקליד את שם האוטומציה.' + (n.kill.via ? ' המתג המשותף: ' + esc(n.kill.via) + '.' : '') + (n.kill.wired === false ? ' שימו לב: המתג עוד לא מחובר בקוד.' : '') : 'אין לו מתג נפרד עדיין. נעצר רק דרך העצירה הכללית.'}</p>
${side ? `<div class="chips" style="margin-top:10px"><span class="sub">משפיע על:</span>${side}</div>` : ''}</section>
<section><div class="grid g-tiles" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
<div class="tile" style="min-height:0"><span class="l">ריצות 24ש׳</span><span class="v">${fmtN(st.runs_24h)}</span></div>
<div class="tile" style="min-height:0"><span class="l">לפי מצב 24ש׳</span><span class="v" style="font-size:15px">${esc(Object.entries(st.by_status_24h || {}).map(([k, v]) => k + ' ' + v).join(' · ') || '—')}</span></div>
<div class="tile" style="min-height:0"><span class="l">כשלים 24ש׳</span><span class="v" style="${st.fail_24h ? 'color:var(--crit-ink)' : ''}">${fmtN(st.fail_24h)}</span></div>
<div class="tile" style="min-height:0"><span class="l">ריצה אחרונה</span><span class="v" style="font-size:18px">${lr ? esc(relTime(lr.at)) : '—'}</span><span class="s">${lr ? Badge(lr.status) : ''}</span></div>
</div>
${st.handled ? `<p class="sub">איך טופלו הכשלים: ${esc(st.handled)}</p>` : ''}
${(st.spark_24h || []).length ? `<div style="margin-top:8px">${Sparkline(st.spark_24h, { fails: st.spark_fail_24h, w: 560, h: 40 })}<div class="legend"><span><i></i>ריצות לשעה</span><span><i class="over"></i>כשל</span><span class="muted">ימין = לפני 24 שעות</span></div></div>` : ''}</section>
<section><h3 class="h2">מתי</h3><dl class="kv" style="margin-top:8px"><dt>תזמון</dt><dd>${esc(n.schedule_he || (n.trigger && n.trigger.il) || '—')}</dd><dt>הבא</dt><dd class="num">${n.next_fire ? esc(fmtDT(n.next_fire)) : '—'}</dd>${n.budget ? `<dt>תקציב</dt><dd>${esc(n.budget)}</dd>` : ''}${n.audience ? `<dt>למי</dt><dd>${esc(n.audience)}</dd>` : ''}${(n.templates || []).length ? `<dt>תבניות</dt><dd class="mono" dir="ltr">${esc(n.templates.join(', '))}</dd>` : ''}</dl>
${(n.conditions || []).length ? `<ul style="margin:10px 0 0;padding-inline-start:18px;color:var(--ink-2)">${n.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}</section>
${(n.warnings || []).length ? `<section class="card" style="background:var(--warn-bg);border-color:transparent"><h3 class="h2">פערים שנמצאו בקוד</h3><ul style="margin:6px 0 0;padding-inline-start:18px">${n.warnings.map((w) => `<li>${esc(typeof w === 'string' ? w : w.he || w.claim || JSON.stringify(w))}</li>`).join('')}</ul></section>` : ''}
<section><h3 class="h2">תלויות</h3>${depGraph(n, nodes)}</section>
<section><div class="sec-h"><h3 class="h2">הקוד</h3><span class="sp"></span>${n.code_ref ? `<span class="sub mono" dir="ltr">${esc(n.code_ref.ref)}</span>` : ''}</div><div id="au-code">${n.code ? Code(n.code) : n.code_ref ? Skeleton.lines(4) : '<p class="sub">אין קוד ברשומה לאוטומציה הזו.</p>'}</div></section>
<section><div class="sec-h"><h3 class="h2">עריכה</h3><span class="sp"></span><span class="sub">שלב 2: נשמר עם גרסה וכפתור החזרה</span></div>
${n.editable ? `<div class="bar">${Object.entries(n.editable).map(([k, v]) => `<label class="sub">${esc({ il_time: 'שעה', budget: 'תקציב יומי' }[k] || k)} <input class="in num" data-edit="${esc(k)}" value="${esc(v)}" dir="ltr" style="width:90px"></label>`).join('')}${Button('שמירה', { variant: 'primary', size: 'sm', act: 'edit-save', attr: { 'data-id': n.id } })}</div>` : '<p class="sub">לאוטומציה הזו אין שדות לעריכה ברשומה.</p>'}</section>
<section><div class="sec-h"><h3 class="h2">היסטוריית ריצות</h3><span class="sp"></span><a class="btn ghost sm" href="#/runs?automation_id=${esc(n.id)}">הכל</a></div><div id="au-runs">${Skeleton.lines(5)}</div></section>`;
}

export function blastBody(n, blast) {
  const ds = blast.downstream || [], imp = blast.impact || [];
  return `<p style="margin:0 0 8px">כיבוי <b>${esc(n.name_he)}</b> עוצר מיד${imp.length ? ':' : '. השרת לא מצא הודעות או שיחות מתוכננות שייעצרו.'}</p>
${imp.length ? `<ul style="margin:0 0 8px;padding-inline-start:18px">${imp.map((i) => `<li><b class="num">${fmtN(i.count)}</b> ${esc(i.label)}</li>`).join('')}</ul>` : ''}
${ds.length ? `<p class="sub" style="margin:0 0 4px">וגם ${ds.length} אוטומציות שתלויות בו:</p><div class="chips">${ds.slice(0, 18).map((d) => `<span class="badge">${esc(d.name)}</span>`).join('')}${ds.length > 18 ? `<span class="badge">+${ds.length - 18}</span>` : ''}</div>` : '<p class="sub">אין אוטומציות אחרות שתלויות בו.</p>'}
${(blast.side_effects || n.side_effects || []).length ? `<p class="sub" style="margin:8px 0 0">סוגי פעולות שייעצרו: ${esc((blast.side_effects || n.side_effects).map((s) => SIDE_HE[s] || s).join(', '))}</p>` : ''}`;
}

export default {
  skeleton: () => `<div class="bar">${Skeleton.lines(1)}</div>${Skeleton.table(12)}`,
  async mount(el, ctx) {
    const f = { q: '', kind: '', state: '' };
    let reg = ctx.api.cached('registry')?.data;
    const kinds = [{ value: '', label: 'כל הסוגים' }, ...Object.entries(KIND_HE).filter(([k]) => k !== 'trigger').map(([value, label]) => ({ value, label }))];
    el.innerHTML = `<div class="bar"><div class="search">${icon('search')}<input class="in" data-search placeholder="חיפוש אוטומציה" aria-label="חיפוש"></div>${Select({ name: 'kind', value: '', options: kinds })}<span id="au-tabs"></span><span class="sp" style="flex:1"></span><span class="sub" id="au-count"></span></div><div class="card flush" id="au-list">${Skeleton.table(12)}</div>`;
    const list = el.querySelector('#au-list');
    const paint = () => {
      if (!reg) return;
      const nodes = reg.nodes.filter((n) => n.layer > 0);
      el.querySelector('#au-tabs').innerHTML = Tabs({ name: 'state', value: f.state, items: [{ value: '', label: 'הכל', count: nodes.length }, { value: 'on', label: 'פעילות' }, { value: 'off', label: 'כבויות', count: nodes.filter((n) => n.state.enabled === false).length }, { value: 'failing', label: 'נכשלות', count: nodes.filter((n) => n.stats.fail_24h).length }] });
      list.innerHTML = listView(reg.nodes, f);
      el.querySelector('#au-count').textContent = filterNodes(sortNodes(reg.nodes), f).length + ' מוצגות';
    };
    const refresh = async () => { reg = await ctx.api.get('registry'); paint(); if (Drawer.el && this._open) this.openNode(this._open, ctx, reg, true); };
    this._reg = () => reg;
    paint();
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { f.q = e.target.value; paint(); } });
    ctx.on(el, 'ops:change', (e) => { f[e.detail.name] = e.detail.value; paint(); });
    ctx.on(el, 'click', (e) => {
      const sw = e.target.closest('[data-act=toggle]'); if (sw) { e.stopPropagation(); this.toggle(sw.dataset.id, ctx, refresh); return; }
      const row = e.target.closest('tr[data-row]'); if (row) ctx.nav('automations/' + row.dataset.row);
    });
    this._drawerClick = (e) => {
      const sw = e.target.closest('.drawer [data-act=toggle]'); if (sw) { this.toggle(sw.dataset.id, ctx, refresh); return; }
      const save = e.target.closest('.drawer [data-act=edit-save]');
      if (save) { const vals = Object.fromEntries([...document.querySelectorAll('.drawer [data-edit]')].map((i) => [i.dataset.edit, i.value])); busy(save, () => ctx.api.post('edit', { id: save.dataset.id, overrides: vals })).then(() => toast('נשמר' + (ctx.MOCK ? ' (דמה)' : ''))).catch((er) => toast(er.message, 'crit')); }
      const r = e.target.closest('.drawer #au-runs tr[data-row]'); if (r) ctx.nav('runs/' + r.dataset.row);
    };
    ctx.on(document, 'click', this._drawerClick);
    reg = await ctx.api.get('registry'); paint();
    ctx.poll(refresh, 30000);
  },
  onArg(arg, ctx) { const reg = this._reg && this._reg(); if (reg && arg) this.openNode(arg, ctx, reg); else if (!arg) Drawer.close(); },
  async openNode(id, ctx, reg, keepScroll = false) {
    const n = reg.nodes.find((x) => x.id === id); if (!n) { toast('אוטומציה לא נמצאה: ' + id, 'crit'); return; }
    this._open = id;
    const prev = keepScroll && Drawer.body() ? Drawer.body().scrollTop : 0;
    const body = Drawer.open(n.name_he, detailView(n, reg.nodes), { onClose: () => { this._open = null; if (location.hash.startsWith('#/automations/')) history.replaceState(null, '', '#/automations'); } });
    body.scrollTop = prev;
    const codeP = n.code_ref ? ctx.api.get('code', { id }).then((c) => { const box = body.querySelector('#au-code'); if (box) box.innerHTML = Code(c.code) + (c.code.truncated ? '<p class="sub">הקטע קוצר ל-200 שורות</p>' : ''); }).catch((e) => { const box = body.querySelector('#au-code'); if (box) box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }) : null;
    try { const r = await ctx.api.get('runs', { automation_id: id, limit: 30 }, { cache: false }); const box = body.querySelector('#au-runs'); if (box) box.innerHTML = runsTable(r.items); }
    catch (e) { const box = body.querySelector('#au-runs'); if (box) box.innerHTML = ctx.errorBox(e, 'noop'); }
    await codeP;
  },
  async toggle(id, ctx, refresh) {
    const reg = this._reg(), n = reg.nodes.find((x) => x.id === id), on = n.state.enabled !== false;
    try {
      if (!on) { /* turning ON is not destructive: still confirmed, but no typing */
        const r = await ctx.api.post('toggle', { id, enabled: true });
        if (r.needs_confirm) await ctx.api.post('toggle', { id, enabled: true, confirm: id });
        toast(n.name_he + ' הודלק'); return refresh();
      }
      const first = await ctx.api.post('toggle', { id, enabled: false });
      if (!first.needs_confirm) { toast('השרת לא החזיר רדיוס פגיעה. לא שונה כלום.', 'crit'); return; }
      const ok = await confirmTyped({ title: 'לכבות את ' + n.name_he + '?', body: blastBody(n, first.blast || {}), word: id, action: 'לכבות ' + n.name_he });
      if (!ok) return;
      await ctx.api.post('toggle', { id, enabled: false, confirm: id });
      toast(n.name_he + ' כובה. נרשם ביומן.'); refresh();
    } catch (e) { toast('לא הצלחנו: ' + e.message, 'crit'); }
  },
};
