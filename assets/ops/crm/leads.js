/* ishur ops · לידים: kanban by status (custom pointer drag, touch long-press, arrow keys) + table
   with bulk status/tag; filters (status, source, date range, owner, tag) + search; lead drawer with
   contact buttons, next action, quick close, tags, notes timeline, activity. All data via crm/adapt.js. */
import { esc, fmtN, Select, Tabs, Table, Badge, Skeleton, Drawer, Button, icon, toast, relTime } from '../ui.js';
import { crm, adaptCrm, STATUSES, STATUS_HE, SOURCE_HE, OWNER_HE } from './adapt.js';
import { money, dayHe, phoneHe, contactBtns, Check, tagChips, dueBadge, notesBlock, timeline, bindNotes, actionBar } from './kit.js';

const RANGES = [{ value: '', label: 'כל הזמן' }, { value: '7', label: '7 ימים' }, { value: '30', label: '30 יום' }, { value: '90', label: '90 יום' }];
export const TONE = { new: 'info', talking: 'warn', quoted: 'serious', closed: 'good', not_relevant: '', lost: 'crit' };
export const statusBadge = (s) => `<span class="badge ${TONE[s] || ''}"><span aria-hidden="true">${{ new: '●', talking: '◐', quoted: '➤', closed: '✓', not_relevant: '○', lost: '✕' }[s] || '•'}</span>${esc(STATUS_HE[s] || s)}</span>`;

export function match(l, f, now = Date.now()) {
  if (f.status && l.status !== f.status) return false;
  if (f.source && l.source !== f.source) return false;
  if (f.owner && l.owner !== f.owner) return false;
  if (f.tag && !l.tags.includes(f.tag)) return false;
  if (f.range && now - Date.parse(l.created_at) > +f.range * 864e5) return false;
  if (f.q) { const q = f.q.toLowerCase(); if (!(l.name + ' ' + l.phone + ' ' + phoneHe(l.phone) + ' ' + l.occasion_he + ' ' + l.tags.join(' ') + ' ' + l.next_text).toLowerCase().includes(q)) return false; }
  return true;
}

export const card = (l) => `<article class="kb-card" data-id="${esc(l.id)}" tabindex="0" role="button" aria-roledescription="כרטיס ניתן לגרירה" aria-label="${esc(l.name || phoneHe(l.phone))} · ${esc(STATUS_HE[l.status])}">
<div class="kb-t"><b dir="auto">${esc(l.name || phoneHe(l.phone))}</b><span class="av" title="${esc(l.owner_he)}">${esc((l.owner_he || '?').slice(0, 1))}</span></div>
<div class="kb-m">${esc([l.occasion_he, l.event_date ? dayHe(l.event_date) : '', l.records ? l.records + ' רש׳' : ''].filter(Boolean).join(' · '))}</div>
<div class="kb-b"><span class="chip src">${esc(l.source_he)}</span>${dueBadge(l)}${tagChips(l.tags.slice(0, 2))}</div></article>`;

export function board(leads, f) {
  const cols = f.status ? STATUSES.filter((s) => s.id === f.status) : STATUSES;
  return `<div class="kb" role="list" aria-label="לוח לידים לפי סטטוס">${cols.map((s) => { const xs = leads.filter((l) => l.status === s.id); return `<section class="kb-col" role="listitem" data-status="${s.id}" aria-label="${esc(s.he)}"><header>${statusBadge(s.id)}<span class="num muted">${fmtN(xs.length)}</span></header><div class="kb-list">${xs.map(card).join('') || '<div class="kb-empty">גררו לכאן</div>'}</div></section>`; }).join('')}</div>`;
}

export function table(leads, sel) {
  const all = leads.length && leads.every((l) => sel.has(l.id));
  const cols = [
    { label: '', render: (l) => Check({ on: sel.has(l.id), act: 'sel', id: l.id, label: 'בחירה' }) },
    { label: 'שם', render: (l) => `<b dir="auto">${esc(l.name || '—')}</b><div class="sub mono" dir="ltr">${esc(phoneHe(l.phone))}</div>` },
    { label: 'סטטוס', render: (l) => statusBadge(l.status) },
    { label: 'אירוע', hideM: true, render: (l) => esc(l.occasion_he) + (l.event_date ? ` <span class="muted num">${esc(dayHe(l.event_date))}</span>` : '') },
    { label: 'רשומות', num: true, hideM: true, render: (l) => (l.records ? fmtN(l.records) : '—') },
    { label: 'מקור', hideM: true, render: (l) => esc(l.source_he) },
    { label: 'אחראי', hideM: true, render: (l) => esc(l.owner_he) },
    { label: 'פעולה הבאה', render: (l) => dueBadge(l) || '<span class="muted">—</span>' },
    { label: 'תגיות', hideM: true, render: (l) => tagChips(l.tags) },
  ];
  return `<div class="tbl-head-sel">${Check({ on: all, act: 'sel-all', label: 'בחירת הכל' })}<span class="sub">בחירת הכל</span></div>` + Table({ columns: cols, rows: leads, rowKey: (l) => l.id, empty: 'אין לידים שמתאימים לסינון' });
}

export function bulkBar(n, tags) {
  if (!n) return '';
  return `<div class="bulk" role="region" aria-label="פעולה על הנבחרים"><b class="num">${fmtN(n)} נבחרו</b>${Select({ name: 'bulk_status', value: '', options: [{ value: '', label: 'שינוי סטטוס…' }, ...STATUSES.map((s) => ({ value: s.id, label: s.he }))] })}
<input class="in" data-bulk-tag list="crm-tags" placeholder="תגית להוספה" aria-label="תגית להוספה"><datalist id="crm-tags">${tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>${Button('הוספת תגית', { act: 'bulk-tag' })}${Button('ניקוי', { variant: 'ghost', act: 'bulk-clear' })}</div>`;
}

/* drawer body (string; behaviour bound in openLead) */
export function drawerView(d) {
  const l = d.lead;
  return `${l.status === 'closed' && l.client_token ? `<div class="okbox"><span aria-hidden="true">✓</span><span>סגר · <a href="#/clients/${esc(l.client_token)}">לכרטיס הלקוח</a></span></div>` : ''}
<header class="crm-head"><div><div class="bar">${statusBadge(l.status)}<span class="chip src">${esc(l.source_he)}</span>${l.window_open ? '<span class="badge good">כתב/ה ' + esc(relTime(l.last_in)) + '</span>' : ''}</div>
<p class="sub">${esc([l.occasion_he, l.event_date ? 'תאריך ' + dayHe(l.event_date) : 'בלי תאריך', l.records ? 'כ-' + l.records + ' רשומות' : '', 'נכנס ' + relTime(l.created_at)].filter(Boolean).join(' · '))}</p>
<p class="mono" dir="ltr" style="margin:0">${esc(phoneHe(l.phone))}</p></div><div class="bar">${contactBtns(l.phone)}</div></header>
<section class="crm-sec"><div class="grid2">
<div class="f-row"><span class="f-l">סטטוס</span><div class="f-v">${Select({ name: 'ld_status', value: l.status, options: STATUSES.map((s) => ({ value: s.id, label: s.he })) })}</div></div>
<div class="f-row"><span class="f-l">אחראי</span><div class="f-v">${Select({ name: 'ld_owner', value: l.owner, options: ['richard', 'shalev'].map((o) => ({ value: o, label: OWNER_HE[o] })) })}</div></div></div></section>
<section class="crm-sec" aria-label="פעולה הבאה"><div class="sec-h"><h3 class="h2">פעולה הבאה</h3>${dueBadge(l)}</div>
<div class="next-row"><input class="in" type="datetime-local" data-next-at aria-label="מתי" value="${esc(l.next_at ? toLocal(l.next_at) : '')}"><input class="in grow" data-next-text placeholder="מה לעשות" aria-label="מה לעשות" value="${esc(l.next_text)}" dir="auto">${Button('שמירה', { act: 'next-save' })}</div></section>
<div id="qc-host">${Skeleton.card(5)}</div>
<section class="crm-sec" aria-label="תגיות"><h3 class="h2">תגיות</h3><div class="chips">${tagChips(l.tags, true)}<span class="tag-add"><input class="in sm" data-tag-new placeholder="תגית" aria-label="תגית חדשה">${Button('+', { size: 'sm', act: 'tag-add', title: 'הוספת תגית' })}</span></div></section>
<div id="ld-notes">${notesBlock(d.notes)}</div>
<section class="crm-sec" aria-label="פעילות"><h3 class="h2">פעילות</h3>${timeline(d.activity)}</section>
${actionBar(`${contactBtns(l.phone, 'grow')}${Button('סגירה מהירה', { variant: 'primary grow', act: 'to-qc' })}`)}`;
}
const toLocal = (iso) => { const d = new Date(iso); const p = (x) => String(x).padStart(2, '0'); const il = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })); return `${il.getFullYear()}-${p(il.getMonth() + 1)}-${p(il.getDate())}T${p(il.getHours())}:${p(il.getMinutes())}`; };
/* datetime-local is Israel wall time → ISO (offset taken from the IL zone on that day) */
const fromLocal = (v) => { if (!v) return null; const guess = new Date(v + 'Z'); const il = new Date(guess.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })), utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })); return new Date(guess - (il - utc)).toISOString(); };

/* ── custom drag and drop: 1:1 with the pointer, keeps the grab offset; touch needs a 280 ms press ── */
export function dnd(root, onDrop) {
  let st = null;
  const colAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest('.kb-col'); };
  const begin = () => {
    const r = st.card.getBoundingClientRect();
    st.dx = st.x - r.left; st.dy = st.y - r.top; st.active = true;
    st.ghost = st.card.cloneNode(true); st.ghost.classList.add('kb-ghost'); st.ghost.style.width = r.width + 'px';
    document.body.appendChild(st.ghost); st.card.classList.add('kb-src'); place();
    if (navigator.vibrate && st.touch) navigator.vibrate(8);
  };
  const place = () => { st.ghost.style.transform = `translate(${st.x - st.dx}px,${st.y - st.dy}px) rotate(-1.5deg)`; const c = colAt(st.x, st.y); root.querySelectorAll('.kb-col.over').forEach((x) => x !== c && x.classList.remove('over')); if (c) c.classList.add('over'); };
  const end = (drop) => {
    if (!st) return; clearTimeout(st.timer);
    if (st.active) {
      const c = drop ? colAt(st.x, st.y) : null; st.ghost.remove(); st.card.classList.remove('kb-src'); root.querySelectorAll('.kb-col.over').forEach((x) => x.classList.remove('over'));
      st.moved = true; const id = st.id; if (c && c.dataset.status !== st.from) onDrop(id, c.dataset.status);
      const swallow = (e) => { e.stopPropagation(); e.preventDefault(); }; root.addEventListener('click', swallow, { capture: true, once: true }); setTimeout(() => root.removeEventListener('click', swallow, true), 50);
    }
    st = null;
  };
  root.addEventListener('pointerdown', (e) => {
    const c = e.target.closest('.kb-card'); if (!c || e.button > 0 || e.target.closest('a,button')) return;
    st = { card: c, id: c.dataset.id, from: c.closest('.kb-col').dataset.status, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, touch: e.pointerType !== 'mouse', active: false };
    if (st.touch) st.timer = setTimeout(() => st && !st.active && begin(), 280);
  });
  const W = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); W.push(() => t.removeEventListener(ev, fn, o)); };
  on(window, 'pointermove', (e) => {
    if (!st) return; st.x = e.clientX; st.y = e.clientY;
    const far = Math.hypot(st.x - st.x0, st.y - st.y0);
    if (!st.active) { if (st.touch) { if (far > 8) { clearTimeout(st.timer); st = null; } } else if (far > 4) begin(); return; }
    place();
    /* auto-scroll the board near its edges */
    const kb = root.querySelector('.kb'), r = kb.getBoundingClientRect();
    if (st.x < r.left + 40) kb.scrollLeft -= 14; else if (st.x > r.right - 40) kb.scrollLeft += 14;
  });
  /* once a touch drag is live, stop the page from scrolling under the finger */
  on(window, 'touchmove', (e) => { if (st && st.active) e.preventDefault(); }, { passive: false });
  on(window, 'pointerup', () => end(true));
  on(window, 'pointercancel', () => end(false));
  /* keyboard: ←/→ moves the focused card one column (RTL: ← = next status) */
  root.addEventListener('keydown', (e) => {
    const c = e.target.closest && e.target.closest('.kb-card'); if (!c || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = STATUSES.findIndex((s) => s.id === c.closest('.kb-col').dataset.status), j = i + (e.key === 'ArrowLeft' ? 1 : -1);
    if (STATUSES[j]) { e.preventDefault(); onDrop(c.dataset.id, STATUSES[j].id, true); }
  });
  return () => { W.splice(0).forEach((f) => f()); if (st && st.ghost) st.ghost.remove(); st = null; };
}

export default {
  skeleton: () => `<div class="bar">${Skeleton.lines(1)}</div><div class="kb">${STATUSES.map(() => `<section class="kb-col">${Skeleton.lines(6)}</section>`).join('')}</div>`,
  async mount(el, ctx) {
    const api = crm(ctx);
    let view = 'board'; try { view = localStorage.getItem('ops:leads:view') || 'board'; } catch (e) {}
    const f = { q: '', status: '', source: '', range: '', owner: '', tag: '' }, sel = new Set();
    const cached = ctx.api.cached('crm/leads');
    let leads = cached ? adaptCrm('leads', cached.data).items : [];
    el.innerHTML = `<div class="bar crm-filters"><div class="search">${icon('search')}<input class="in" data-search placeholder="חיפוש שם, טלפון, תגית" aria-label="חיפוש לידים"></div>
<span id="ld-f"></span><span class="sp" style="flex:1"></span><span class="sub num" id="ld-count"></span>${Tabs({ name: 'view', value: view, items: [{ value: 'board', label: 'לוח' }, { value: 'table', label: 'טבלה' }] })}</div>
<div id="ld-bulk"></div><div id="ld-body">${this.skeleton()}</div>`;
    const body = el.querySelector('#ld-body');
    const filters = () => {
      const tags = [...new Set(leads.flatMap((l) => l.tags))].sort(), srcs = [...new Set(leads.map((l) => l.source))];
      el.querySelector('#ld-f').innerHTML = `<span class="bar">${Select({ name: 'status', value: f.status, options: [{ value: '', label: 'כל הסטטוסים' }, ...STATUSES.map((s) => ({ value: s.id, label: s.he }))] })}${Select({ name: 'source', value: f.source, options: [{ value: '', label: 'כל המקורות' }, ...srcs.map((s) => ({ value: s, label: SOURCE_HE[s] || s }))] })}${Select({ name: 'range', value: f.range, options: RANGES })}${Select({ name: 'owner', value: f.owner, options: [{ value: '', label: 'כל האחראים' }, { value: 'richard', label: 'ריצארד' }, { value: 'shalev', label: 'שלו' }] })}${Select({ name: 'tag', value: f.tag, options: [{ value: '', label: 'כל התגיות' }, ...tags.map((t) => ({ value: t, label: t }))] })}</span>`;
    };
    const paint = () => {
      const xs = leads.filter((l) => match(l, f)).sort((a, b) => (b.due_today - a.due_today) || Date.parse(b.created_at) - Date.parse(a.created_at));
      el.querySelector('#ld-count').textContent = fmtN(xs.length) + ' לידים' + (leads.filter((l) => l.due_today).length ? ' · ' + leads.filter((l) => l.due_today).length + ' להיום' : '');
      const keepScroll = body.querySelector('.kb') ? body.querySelector('.kb').scrollLeft : 0, ae = document.activeElement, keepFocus = ae && body.contains(ae) && ae.dataset ? ae.dataset.id : null;
      body.innerHTML = view === 'board' ? board(xs, f) : table(xs, sel);
      if (keepScroll && body.querySelector('.kb')) body.querySelector('.kb').scrollLeft = keepScroll;
      if (keepFocus) { const c = body.querySelector(`.kb-card[data-id="${CSS.escape(keepFocus)}"]`); if (c) c.focus({ preventScroll: true }); } /* a background reload must not steal keyboard focus */
      el.querySelector('#ld-bulk').innerHTML = view === 'table' ? bulkBar(sel.size, [...new Set(leads.flatMap((l) => l.tags))]) : '';
      ctx.setBadge('leads', leads.filter((l) => l.due_today || l.overdue).length);
    };
    /* optimistic moves still in flight win over any list that was fetched before they landed */
    const pending = new Map();
    const load = async () => { try { leads = (await api.leads()).items; leads.forEach((l) => { if (pending.has(l.id)) l.status = pending.get(l.id); }); filters(); paint(); } catch (e) { body.innerHTML = ctx.errorBox(e, 'ld-retry'); } };
    this.reload = load;
    const move = async (id, status, kbd) => {
      const l = leads.find((x) => x.id === id); if (!l || l.status === status) return;
      const prev = l.status; l.status = status; paint();
      if (kbd) { const c = body.querySelector(`.kb-card[data-id="${CSS.escape(id)}"]`); c && c.focus(); }
      toast((l.name || 'הליד') + ' → ' + STATUS_HE[status]);
      pending.set(id, status);
      try { await api.updateLead(id, { status }); } catch (e) { const cur = leads.find((x) => x.id === id); if (cur) cur.status = prev; paint(); toast('לא נשמר, הכרטיס חזר ל' + STATUS_HE[prev], 'crit'); } finally { if (pending.get(id) === status) pending.delete(id); }
    };
    ctx.onDispose(dnd(body, move));
    let qT = 0;
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { clearTimeout(qT); qT = setTimeout(() => { f.q = e.target.value.trim(); paint(); }, 120); } });
    ctx.on(el, 'ops:change', async (e) => {
      const { name, value } = e.detail;
      if (name === 'view') { view = value; try { localStorage.setItem('ops:leads:view', view); } catch (x) {} paint(); return; }
      if (name === 'bulk_status') { if (!value || !sel.size) return; const ids = [...sel]; ids.forEach((id) => { const l = leads.find((x) => x.id === id); if (l) l.status = value; pending.set(id, value); }); paint(); try { await api.bulk(ids, { status: value }); toast(ids.length + ' לידים → ' + STATUS_HE[value]); } catch (x) { toast('השינוי נכשל', 'crit'); ids.forEach((id) => pending.delete(id)); load(); } finally { ids.forEach((id) => pending.get(id) === value && pending.delete(id)); } return; }
      if (name in f) { f[name] = value; paint(); }
    });
    ctx.on(el, 'click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (b) {
        const a = b.dataset.act;
        if (a === 'sel') { sel.has(b.dataset.id) ? sel.delete(b.dataset.id) : sel.add(b.dataset.id); paint(); return; }
        if (a === 'sel-all') { const xs = leads.filter((l) => match(l, f)); const all = xs.every((l) => sel.has(l.id)); xs.forEach((l) => (all ? sel.delete(l.id) : sel.add(l.id))); paint(); return; }
        if (a === 'bulk-clear') { sel.clear(); paint(); return; }
        if (a === 'bulk-tag') { const t = el.querySelector('[data-bulk-tag]').value.trim(); if (!t || !sel.size) return; const ids = [...sel]; ids.forEach((id) => { const l = leads.find((x) => x.id === id); if (l && !l.tags.includes(t)) l.tags.push(t); }); paint(); try { await api.bulk(ids, { add_tag: t }); toast('התגית נוספה ל-' + ids.length); } catch (x) { toast('לא נשמר', 'crit'); load(); } return; }
        if (a === 'ld-retry') return load();
      }
      const c = e.target.closest('.kb-card,tr[data-row]'); if (c) ctx.nav('leads/' + (c.dataset.id || c.dataset.row));
    });
    ctx.on(el, 'keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.kb-card')) ctx.nav('leads/' + e.target.dataset.id); });
    if (leads.length) { filters(); paint(); }
    await load();
    ctx.poll(() => (Drawer.el ? null : load()), 45000);
  },
  async onArg(id, ctx) {
    if (!id) { Drawer.close(); return; }
    const api = crm(ctx), self = this;
    const b = Drawer.open('ליד', Skeleton.lines(10), { onClose: () => { if (location.hash.startsWith('#/leads/')) history.replaceState(null, '', '#/leads'); self.reload && self.reload(); } });
    Drawer.el.classList.add('crm-drawer');
    let d;
    const paint = async () => {
      d = await api.lead(id); if (Drawer.body() !== b) return;
      Drawer.el.querySelector('.drawer-h h2').textContent = d.lead.name || phoneHe(d.lead.phone);
      b.innerHTML = drawerView(d);
      const { mountQuick } = await import('./quick.js');
      mountQuick(b.querySelector('#qc-host'), { lead: d.lead, api, onStatus: (s) => { d.lead.status = s; const bd = b.querySelector('.crm-head .badge'); if (bd) bd.outerHTML = statusBadge(s); } }).catch(() => { b.querySelector('#qc-host').innerHTML = '<div class="errbox">המחירון לא נטען (config.js)</div>'; });
    };
    const repaintNotes = async () => { const r = await api.lead(id); d.notes = r.notes; b.querySelector('#ld-notes').innerHTML = notesBlock(r.notes); };
    bindNotes(b, api, 'lead', id, repaintNotes);
    const save = async (patch, msg) => { try { await api.updateLead(id, patch); Object.assign(d.lead, patch); toast(msg); } catch (e) { toast('לא נשמר', 'crit'); } };
    b.addEventListener('ops:change', (e) => {
      if (e.detail.name === 'ld_status') save({ status: e.detail.value }, 'הסטטוס עודכן ל' + STATUS_HE[e.detail.value]).then(paint);
      if (e.detail.name === 'ld_owner') save({ owner: e.detail.value }, 'האחראי עודכן');
    });
    b.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-act]'); if (!x) return;
      const a = x.dataset.act;
      if (a === 'next-save') { const at = fromLocal(b.querySelector('[data-next-at]').value), text = b.querySelector('[data-next-text]').value.trim(); await save({ next_at: at, next_text: text }, 'הפעולה הבאה נשמרה'); paint(); }
      if (a === 'tag-add') { const i = b.querySelector('[data-tag-new]'), t = i.value.trim(); if (!t || d.lead.tags.includes(t)) return; await save({ tags: [...d.lead.tags, t] }, 'התגית נוספה'); paint(); }
      if (a === 'tag-rm') { await save({ tags: d.lead.tags.filter((t) => t !== x.dataset.tag) }, 'התגית הוסרה'); paint(); }
      if (a === 'to-qc') { const q = b.querySelector('#qc'); if (q) q.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
    });
    try { await paint(); } catch (e) { b.innerHTML = ctx.errorBox(e, 'noop'); }
  },
};
