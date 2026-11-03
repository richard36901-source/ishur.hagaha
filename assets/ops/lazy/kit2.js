/* ishur ops · lazy kit behaviours (outside the counted JS budget, imported on first use by ui.js):
   column sort (asc/desc, saved per table id), the person drawer (a phone anywhere → lead / client / guest),
   and the DatePicker popover (Hebrew, RTL, week starts Sunday, keyboard, today / clear). */
import { esc, Drawer, Skeleton, Phone, hooks, sortVal, cmp, savedSort } from '../ui.js';

/* ── sort ── */
const units = (tb) => { const out = []; for (const tr of tb.rows) { if (tr.classList.contains('grp')) continue; if (tr.hasAttribute('data-row') || !out.length) out.push([tr]); else out[out.length - 1].push(tr); } return out; };
const cellVal = (tr, col) => { const td = tr.cells[col]; if (!td) return ''; return sortVal(td.dataset.sv != null ? td.dataset.sv : td.textContent.trim()); };
export function applySort(table, st) {
  if (!table || !st) return;
  const tb = table.tBodies[0]; if (!tb) return;
  const us = units(tb).map((u, i) => [cellVal(u[0], st.col), i, u]);
  us.sort((a, b) => cmp(a[0], b[0]) * (st.dir === 'desc' ? -1 : 1) || a[1] - b[1]);
  const f = document.createDocumentFragment(); us.forEach(([, , u]) => u.forEach((tr) => f.appendChild(tr))); tb.appendChild(f);
  table.querySelectorAll('thead th').forEach((th) => { if (+th.dataset.col === st.col) th.setAttribute('aria-sort', st.dir === 'desc' ? 'descending' : 'ascending'); else th.removeAttribute('aria-sort'); });
}
export const applySaved = (table) => applySort(table, savedSort(table.dataset.sortId));
function sortClick(btn) {
  const table = btn.closest('table'), id = table && table.dataset.sortId; if (!id) return;
  const col = +btn.dataset.col, prev = savedSort(id), st = { col, dir: prev && prev.col === col && prev.dir === 'asc' ? 'desc' : 'asc' };
  try { localStorage.setItem('ops:sort:' + id, JSON.stringify(st)); } catch (e) { /* private mode: sort still applies for this view */ }
  if (table.hasAttribute('data-sort-virtual')) table.querySelectorAll('thead th').forEach((th) => { if (+th.dataset.col === col) th.setAttribute('aria-sort', st.dir === 'desc' ? 'descending' : 'ascending'); else th.removeAttribute('aria-sort'); });
  else applySort(table, st);
  table.dispatchEvent(new CustomEvent('ops:sort', { bubbles: true, detail: { id, ...st } }));
}

/* ── person drawer ── */
async function person(btn) {
  const d = btn.dataset.person, name = btn.dataset.name || '';
  const b = Drawer.open(name || 'איש קשר', Skeleton.lines(6), { modal: true });
  let lead = null, client = null;
  try {
    const { crm } = await import('../crm/adapt.js');
    const api = crm({ api: hooks.api });
    const [ls, cs] = await Promise.allSettled([api.leads(), api.clients()]);
    const same = (p) => String(p || '').replace(/\D/g, '').replace(/^0/, '972') === d;
    lead = ls.status === 'fulfilled' ? ls.value.items.find((l) => same(l.phone)) : null;
    client = cs.status === 'fulfilled' ? cs.value.items.find((c) => same(c.phone)) : null;
  } catch (e) { /* lookups are best-effort; the drawer still offers WhatsApp / call / inbox */ }
  if (Drawer.body() !== b) return;
  const who = (client && client.name) || (lead && lead.name) || name || 'לא מזוהה';
  Drawer.el.querySelector('.drawer-h h2').textContent = who;
  const role = client ? '<span class="badge good">לקוח</span>' : lead ? '<span class="badge warn">ליד</span>' : '<span class="badge">אורח / לא מזוהה</span>';
  b.innerHTML = `<header class="crm-head"><div><div class="bar">${role}${client ? `<span class="chip">${esc(client.occasion_he || '')}</span>` : ''}</div><p class="sub">${esc(client ? [client.event_date, client.venue].filter(Boolean).join(' · ') : lead ? [lead.occasion_he, lead.status_he || ''].filter(Boolean).join(' · ') : 'המספר לא נמצא בלידים או בלקוחות')}</p></div><div>${Phone(d, { name: who })}</div></header>
<section class="crm-sec"><h3 class="h2">לאן</h3><div class="acts-g">${lead ? `<a class="btn" href="#/leads/${esc(lead.id)}">כרטיס הליד</a>` : ''}${client ? `<a class="btn primary" href="#/clients/${esc(client.token)}">כרטיס הלקוח</a>` : ''}<a class="btn" href="#/inbox/${esc(d)}">השיחה באינבוקס</a><a class="btn" href="https://wa.me/${esc(d)}" target="_blank" rel="noopener">וואטסאפ</a><a class="btn" href="tel:+${esc(d)}">חיוג</a></div></section>`;
  b.addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) Drawer.close(true); });
}

/* ── DatePicker popover ── */
const MON = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const DW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const p2 = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${p2(m + 1)}-${p2(d)}`;
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const addDays = (s, n) => new Date(Date.parse(s + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
export function monthGrid(y, m, sel, focus) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay(), n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), t = todayIso();
  const cells = Array.from({ length: first }, () => '<span></span>');
  for (let d = 1; d <= n; d++) { const v = iso(y, m, d); cells.push(`<button type="button" role="gridcell" data-d="${v}" tabindex="${v === focus ? 0 : -1}"${v === sel ? ' aria-selected="true"' : ''}${v === t ? ' class="td"' : ''}>${d}</button>`); }
  return `<div class="dp-h"><button type="button" class="btn ghost sm icon" data-dpm="-1" aria-label="חודש קודם">›</button><b>${MON[m]} ${y}</b><button type="button" class="btn ghost sm icon" data-dpm="1" aria-label="חודש הבא">‹</button></div><div class="dp-w">${DW.map((x) => `<span>${x}</span>`).join('')}</div><div class="dp-g" role="grid">${cells.join('')}</div><div class="dp-f"><button type="button" class="btn sm" data-dpx="today">היום</button><button type="button" class="btn ghost sm" data-dpx="clear">ניקוי</button></div>`;
}
export function setPicked(wrap, v) {
  const hid = wrap.querySelector('input[type=hidden]'), btn = wrap.querySelector('.dp-btn'), tm = wrap.querySelector('.dp-time');
  hid.value = v ? v + (tm && /^\d\d:\d\d$/.test(tm.value) ? 'T' + tm.value : '') : '';
  btn.querySelector('span').textContent = v ? v.slice(8, 10) + '/' + v.slice(5, 7) + '/' + v.slice(0, 4) : 'בחירת תאריך';
  btn.classList.toggle('dp-empty', !v);
  hid.dispatchEvent(new Event('input', { bubbles: true })); hid.dispatchEvent(new Event('change', { bubbles: true }));
  wrap.dispatchEvent(new CustomEvent('ops:change', { bubbles: true, detail: { name: hid.name || hid.dataset.q || hid.id, value: hid.value } }));
}
let openDp = null;
function closeDp(refocus = true) { if (!openDp) return; const w = openDp; openDp = null; w.querySelector('.dp-pop')?.remove(); w.querySelector('.dp-btn').setAttribute('aria-expanded', 'false'); if (refocus) w.querySelector('.dp-btn').focus(); }
function picker(btn) {
  const wrap = btn.closest('[data-dp]'); if (openDp === wrap) return closeDp();
  closeDp(false); openDp = wrap;
  const cur = (wrap.querySelector('input[type=hidden]').value || '').slice(0, 10);
  let focus = cur || todayIso(), y = +focus.slice(0, 4), m = +focus.slice(5, 7) - 1;
  const pop = document.createElement('div'); pop.className = 'dp-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'בחירת תאריך');
  wrap.appendChild(pop); btn.setAttribute('aria-expanded', 'true');
  const paint = () => { pop.innerHTML = monthGrid(y, m, cur, focus); const f = pop.querySelector(`[data-d="${focus}"]`); if (f) f.focus(); };
  const go = (v) => { focus = v; y = +v.slice(0, 4); m = +v.slice(5, 7) - 1; paint(); };
  pop.addEventListener('click', (e) => {
    const d = e.target.closest('[data-d]'), mv = e.target.closest('[data-dpm]'), x = e.target.closest('[data-dpx]');
    if (d) { setPicked(wrap, d.dataset.d); closeDp(); }
    else if (mv) { m += +mv.dataset.dpm; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } focus = iso(y, m, 1); paint(); }
    else if (x) { setPicked(wrap, x.dataset.dpx === 'today' ? todayIso() : ''); closeDp(); }
  });
  pop.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 }[e.key]; /* RTL: ← is the next day */
    if (k) { e.preventDefault(); go(addDays(focus, k)); }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); const dt = new Date(Date.UTC(y, m + (e.key === 'PageDown' ? 1 : -1), 1)); go(iso(dt.getUTCFullYear(), dt.getUTCMonth(), Math.min(+focus.slice(8), new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate()))); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDp(); }
    else if (e.key === 'Enter' && e.target.dataset.d) { e.preventDefault(); setPicked(wrap, e.target.dataset.d); closeDp(); }
  });
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!wrap.contains(ev.target)) { closeDp(false); document.removeEventListener('pointerdown', off); } }), 0);
  paint();
}

export function handle(el) {
  if (el.matches('[data-act=sort]')) return sortClick(el);
  if (el.matches('[data-person]')) return person(el);
  if (el.matches('[data-act=dp-open]')) return picker(el);
}
