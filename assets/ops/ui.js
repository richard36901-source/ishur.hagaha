/* ishur ops · component kit. Renderers return HTML strings (testable in plain node);
   behaviour is attached by delegation in init() so re-rendering never leaks listeners.
   No native select elements, checkboxes or browser alert dialogs anywhere. */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
export const attrs = (o = {}) => Object.entries(o).filter(([, v]) => v !== false && v != null).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');

/* ── formatting (he-IL, tabular) ── */
const NF = new Intl.NumberFormat('he-IL');
export const fmtN = (n) => (n == null || Number.isNaN(+n) ? '—' : NF.format(+n));
export const fmtK = (n) => (n == null ? '—' : Math.abs(n) >= 1e4 ? NF.format(Math.round(n / 100) / 10) + 'K' : NF.format(n));
export const fmtMoney = (n, cur = 'USD') => (n == null ? '—' : new Intl.NumberFormat('he-IL', { style: cur === 'ops' ? 'decimal' : 'currency', currency: cur === 'ops' ? undefined : cur, maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n) + (cur === 'ops' ? ' ops' : ''));
const pad = (x) => String(x).padStart(2, '0');
const IL = (d) => new Date(new Date(d).toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
export const fmtTime = (d) => { if (!d) return '—'; const x = IL(d); return pad(x.getHours()) + ':' + pad(x.getMinutes()); };
export const fmtDate = (d) => { if (!d) return '—'; const x = IL(d); return pad(x.getDate()) + '/' + pad(x.getMonth() + 1); };
export const fmtDT = (d) => (d ? fmtDate(d) + ' ' + fmtTime(d) : '—');
export function relTime(d, now = Date.now()) {
  if (!d) return '—';
  const s = Math.round((now - Date.parse(d)) / 1000), a = Math.abs(s), fut = s < 0;
  if (a < 45) return fut ? 'עוד רגע' : 'עכשיו';
  const [v, u] = a < 3600 ? [Math.round(a / 60), 'דק׳'] : a < 86400 ? [Math.round(a / 3600), 'שע׳'] : [Math.round(a / 86400), 'ימים'];
  if (a >= 7 * 86400) return fmtDT(d);
  return (fut ? 'בעוד ' : 'לפני ') + v + ' ' + u;
}
export const timeTag = (d, rel = true) => `<time class="num" datetime="${esc(d || '')}" title="${esc(fmtDT(d))}">${esc(rel ? relTime(d) : fmtTime(d))}</time>`;

/* ── icons (inline, 24 grid, stroke) ── */
const P = {
  overview: 'M4 13h6V4H4zm10 7h6v-9h-6zM4 20h6v-4H4zm10-11h6V4h-6z',
  auto: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  runs: 'M4 6h16M4 12h16M4 18h10',
  live: 'M3 12h4l3-8 4 16 3-8h4',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 3 5 3 3 0 0 0 5 1V5a3 3 0 0 0-3-1zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-3 5 3 3 0 0 1-5 1',
  msg: 'M4 5h16v11H8l-4 4z',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2',
  cap: 'M4 20V10m5 10V4m5 16v-7m5 7V8',
  bal: 'M3 7h18v12H3zM3 11h18M7 15h3',
  clients: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 19v-1a4 4 0 0 0-3-3.8M16 4.2a3 3 0 0 1 0 5.6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  side: 'M3 4h18v16H3zM15 4v16',
  ext: 'M14 4h6v6m0-6-9 9M18 14v6H4V6h6',
  pause: 'M8 5v14m8-14v14',
  play: 'M7 5l12 7-12 7z',
};
export const icon = (n, cls = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}"><path d="${P[n] || ''}"/></svg>`;

/* ── Button ── */
export function Button(label, { variant = '', size = '', kbd = '', act = '', title = '', disabled = false, attr = {} } = {}) {
  const cls = ['btn', variant, size].filter(Boolean).join(' ');
  return `<button type="button" class="${cls}"${attrs({ 'data-act': act || null, title: title || null, 'aria-disabled': disabled ? 'true' : null, ...attr })}>${label}${kbd ? ` <span class="kbd">${esc(kbd)}</span>` : ''}</button>`;
}

/* ── Toggle (role=switch) ── */
export const Toggle = ({ id, on, label = '', act = 'toggle' }) =>
  `<button type="button" class="sw" role="switch" aria-checked="${on ? 'true' : 'false'}" data-act="${esc(act)}" data-id="${esc(id)}"${label ? '' : ' aria-label="הפעלה"'}><span class="tr"></span>${label ? `<span>${esc(label)}</span>` : ''}</button>`;

/* ── Select (button + listbox popover) ── */
export function Select({ name, value, options, label = '' }) {
  const cur = options.find((o) => String(o.value) === String(value)) || options[0];
  return `<div class="sel" data-sel="${esc(name)}" data-value="${esc(cur ? cur.value : '')}"><button type="button" aria-haspopup="listbox" aria-expanded="false">${label ? `<span class="lbl">${esc(label)}</span>` : ''}<span class="cur">${esc(cur ? cur.label : '')}</span></button>
<script type="application/json">${JSON.stringify(options).replace(/</g, '\\u003c')}</script></div>`;
}

/* ── Tabs / segmented ── */
export const Tabs = ({ name, value, items }) =>
  `<div class="seg" role="tablist" data-tabs="${esc(name)}">${items.map((i) => `<button type="button" role="tab" data-v="${esc(i.value)}" aria-selected="${String(i.value) === String(value)}">${esc(i.label)}${i.count != null ? ` <span class="muted num">${fmtN(i.count)}</span>` : ''}</button>`).join('')}</div>`;

/* ── Badge / status ── */
const ST = {
  ok: ['good', '✓', 'הצליח'], partial: ['warn', '◐', 'חלקי'], failed: ['crit', '✕', 'נכשל'], skipped: ['', '⤼', 'דולג'],
  running: ['info', '●', 'רץ'], stale: ['serious', '!', 'לא רץ בזמן'], off: ['', '○', 'כבוי'],
  open: ['crit', '!', 'פתוח'], resolved: ['good', '✓', 'טופל'], handling: ['info', '●', 'בטיפול'], needs_approval: ['warn', '?', 'מחכה לאישור'],
  P1: ['crit', '▲', 'P1'], P2: ['serious', '▲', 'P2'], P3: ['', '▲', 'P3'],
};
export const SKIP_HE = { window: 'מחוץ לחלון', 'no-work': 'אין עבודה', cap: 'תקרה', paused: 'עצירה', holiday: 'חג', 'already-today': 'כבר רץ היום' };
export function Badge(status, text) {
  const [tone, glyph, he] = ST[status] || ['', '•', status];
  return `<span class="badge ${tone}"><span aria-hidden="true">${glyph}</span>${esc(text || he)}</span>`;
}
export const statusDot = (status, pulse = false) => { const tone = (ST[status] || [''])[0]; return `<span class="dot ${status === 'off' ? 'off' : tone}${pulse ? ' pulse' : ''}" aria-hidden="true"></span>`; };

/* ── Skeleton ── */
export const Skeleton = { lines: (n = 3) => Array.from({ length: n }, (_, i) => `<div class="sk sk-line" style="width:${92 - ((i * 17) % 40)}%"></div>`).join(''),
  tiles: (n = 6) => `<div class="grid g-tiles">${Array.from({ length: n }, () => '<div class="sk sk-tile"></div>').join('')}</div>`,
  card: (n = 4) => `<div class="card">${Skeleton.lines(n)}</div>`,
  table: (n = 8) => `<div class="card">${Array.from({ length: n }, () => '<div class="sk sk-line" style="height:18px;margin:14px 0"></div>').join('')}</div>` };

/* ── Sparkline (single series → no legend; failures overlay as critical ticks) ── */
export function Sparkline(values = [], { w = 120, h = 28, fails = null, label = '', color = 'var(--s1)' } = {}) {
  const n = values.length; if (!n) return '';
  const max = Math.max(1, ...values), bw = w / n;
  const bars = values.map((v, i) => { const bh = Math.max(v ? 2 : 0, (v / max) * (h - 4)); return bh ? `<rect x="${(w - (i + 1) * bw + 0.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${color}"><title>${esc(i + 1 + ': ' + v)}</title></rect>` : ''; }).join('');
  const fl = fails ? fails.map((v, i) => (v ? `<rect x="${(w - (i + 1) * bw + 0.5).toFixed(1)}" y="0" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="3" rx="1" fill="var(--crit)"><title>${esc(v + ' כשלים')}</title></rect>` : '')).join('') : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label || 'ריצות ב-24 שעות')}"><line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}" stroke="var(--line-2)"/>${bars}${fl}</svg>`;
}

/* ── StatTile ── */
export function StatTile({ label, value, unit = '', sub = '', status = '', href = '', spark = '', meter = null }) {
  const tag = href ? 'a' : 'div';
  const m = meter ? `<div class="meter" role="meter" aria-valuenow="${meter.value}" aria-valuemax="${meter.max}" aria-label="${esc(label)}"><i style="width:${Math.min(100, (meter.value / Math.max(1, meter.max)) * 100).toFixed(1)}%" class="${meter.value > meter.max ? 'crit' : ''}"></i></div>` : '';
  return `<${tag} class="tile"${href ? ` href="${esc(href)}"` : ''}><span class="l">${status ? statusDot(status) : ''}${esc(label)}</span><span class="v">${value}${unit ? ` <small>${esc(unit)}</small>` : ''}</span>${sub ? `<span class="s">${sub}</span>` : ''}${m}${spark ? `<span class="spark">${spark}</span>` : ''}</${tag}>`;
}

/* ── Table (string; rows over `virtualAt` use mountVirtual) ── */
export function Table({ columns, rows, rowKey = (r) => r.id, empty = 'אין נתונים', groupBy = null, selected = null }) {
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
  const head = `<thead><tr>${columns.map((c) => `<th class="${c.num ? 'n' : ''}${c.hideM ? ' hide-m' : ''}" scope="col">${esc(c.label)}</th>`).join('')}</tr></thead>`;
  let last = null;
  const body = rows.map((r) => {
    let g = '';
    if (groupBy) { const k = groupBy(r); if (k !== last) { last = k; g = `<tr class="grp"><td colspan="${columns.length}">${k}</td></tr>`; } }
    const key = rowKey(r);
    return g + `<tr data-row="${esc(key)}"${selected === key ? ' class="sel"' : ''} tabindex="-1">${columns.map((c) => `<td class="${c.num ? 'n' : ''}${c.hideM ? ' hide-m' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="tbl-wrap"><table class="tbl">${head}<tbody>${body}</tbody></table></div>`;
}
/* Virtual rows: fixed row height, renders only the visible slice + overscan. */
export function mountVirtual(el, { columns, rows, rowH = 40, height = 560, rowKey = (r) => r.id }) {
  el.innerHTML = `<div class="tbl-wrap" style="height:${height}px"><table class="tbl"><thead><tr>${columns.map((c) => `<th class="${c.num ? 'n' : ''}${c.hideM ? ' hide-m' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`;
  const wrap = el.firstElementChild, tb = wrap.querySelector('tbody');
  let raf = 0;
  const paint = () => {
    raf = 0;
    const top = wrap.scrollTop, start = Math.max(0, Math.floor(top / rowH) - 10), end = Math.min(rows.length, start + Math.ceil(height / rowH) + 20);
    const cell = (r) => `<tr data-row="${esc(rowKey(r))}" tabindex="-1" style="height:${rowH}px">${columns.map((c) => `<td class="${c.num ? 'n' : ''}${c.hideM ? ' hide-m' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('')}</tr>`;
    tb.innerHTML = `<tr style="height:${start * rowH}px" aria-hidden="true"></tr>` + rows.slice(start, end).map(cell).join('') + `<tr style="height:${(rows.length - end) * rowH}px" aria-hidden="true"></tr>`;
  };
  wrap.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(paint); }, { passive: true });
  paint();
  return { update(next) { rows = next; paint(); }, scrollToIndex(i) { wrap.scrollTop = Math.max(0, i * rowH - height / 3); } };
}

/* ── KeyHints ── */
export const KeyHints = (pairs) => `<div class="keys">${pairs.map(([k, d]) => `<span>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</span><span>${esc(d)}</span>`).join('')}</div>`;

/* ── code with line numbers ── */
export function Code({ file, start, line, lines }) {
  return `<div class="code" dir="ltr"><pre>${lines.map((l, i) => `<span class="ln${start + i === line ? ' hl' : ''}" data-n="${start + i}">${esc(l) || ' '}</span>`).join('')}</pre></div><div class="sub mono" dir="ltr">${esc(file)}:${line || start}</div>`;
}

/* ═══ DOM behaviour (browser only) ═══════════════════════════════════════ */
const D = typeof document !== 'undefined' ? document : null;
let lastFocus = null;
const layer = () => D.getElementById('layer');

export function toast(msg, kind = '') {
  if (!D) return;
  let box = D.querySelector('.toasts');
  if (!box) { box = D.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); D.body.appendChild(box); }
  const t = D.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; box.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .2s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 220); }, kind === 'crit' ? 6000 : 3200);
}

function trap(el) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...el.querySelectorAll('button,[href],input,[tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && D.activeElement === a) { z.focus(); e.preventDefault(); } else if (!e.shiftKey && D.activeElement === z) { a.focus(); e.preventDefault(); }
  });
}

export const Drawer = {
  el: null,
  open(title, html, { onClose } = {}) {
    if (!D) return;
    if (!this.el) lastFocus = D.activeElement;
    this.close(true);
    const s = D.createElement('div'); s.className = 'scrim'; s.dataset.act = 'drawer-close';
    const d = D.createElement('aside'); d.className = 'drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', title);
    d.innerHTML = `<div class="drawer-h"><h2>${esc(title)}</h2>${Button(icon('close'), { variant: 'ghost', size: 'icon', act: 'drawer-close', title: 'סגירה (Esc)' })}</div><div class="drawer-b">${html}</div>`;
    layer().append(s, d); trap(d); this.el = d; this.scrim = s; this.onClose = onClose;
    d.querySelector('.btn').focus();
    return d.querySelector('.drawer-b');
  },
  body() { return this.el && this.el.querySelector('.drawer-b'); },
  close(instant = false) {
    if (!this.el) return;
    const d = this.el, s = this.scrim; this.el = null;
    if (this.onClose) this.onClose();
    if (instant) { d.remove(); s.remove(); return; }
    d.classList.add('out'); s.style.opacity = '0'; s.style.transition = 'opacity .2s';
    setTimeout(() => { d.remove(); s.remove(); }, 200);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  },
};

/* Dialog with typed confirmation. Resolves true only when the typed word matches. */
export function confirmTyped({ title, body, word, action = 'אישור', danger = true }) {
  return new Promise((resolve) => {
    if (!D) return resolve(false);
    const prev = D.activeElement;
    const s = D.createElement('div'); s.className = 'scrim'; s.style.zIndex = 70;
    const d = D.createElement('div'); d.className = 'dialog'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'dlg-t');
    d.innerHTML = `<h2 id="dlg-t">${esc(title)}</h2><div>${body}</div>
<label class="sub" for="dlg-in">כדי לאשר, הקלידו <b class="mono" dir="ltr">${esc(word)}</b></label>
<input id="dlg-in" class="in mono" dir="ltr" autocomplete="off" spellcheck="false">
<div class="acts">${Button('ביטול', { act: 'dlg-no' })}${Button(esc(action), { variant: danger ? 'danger' : 'primary', act: 'dlg-yes', disabled: true })}</div>`;
    layer().append(s, d); trap(d);
    const inp = d.querySelector('input'), yes = d.querySelector('[data-act=dlg-yes]');
    const done = (v) => { d.remove(); s.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    inp.addEventListener('input', () => yes.setAttribute('aria-disabled', inp.value.trim() === word ? 'false' : 'true'));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim() === word) done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
    d.addEventListener('click', (e) => { const a = e.target.closest('[data-act]'); if (!a) return; if (a.dataset.act === 'dlg-no') done(false); if (a.dataset.act === 'dlg-yes' && inp.value.trim() === word) done(true); });
    s.addEventListener('click', () => done(false));
    inp.focus();
  });
}

/* Busy-button helper: one intent, one request, width locked. */
export async function busy(btn, fn) {
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1'; const w = btn.offsetWidth, html = btn.innerHTML;
  btn.style.width = w + 'px'; btn.innerHTML = '<span class="spin"></span>'; btn.setAttribute('aria-busy', 'true');
  try { const r = await fn(); btn.innerHTML = '✓'; setTimeout(() => { btn.innerHTML = html; btn.style.width = ''; }, 900); return r; }
  catch (e) { btn.innerHTML = 'נכשל'; setTimeout(() => { btn.innerHTML = html; btn.style.width = ''; }, 1600); throw e; }
  finally { delete btn.dataset.busy; btn.removeAttribute('aria-busy'); }
}

/* Delegated behaviour for Select, Tabs, Drawer close, tooltips. */
let openSel = null;
function closeSel() { if (!openSel) return; openSel.querySelector('.pop')?.remove(); openSel.querySelector('button').setAttribute('aria-expanded', 'false'); openSel = null; }
function openSelect(sel) {
  closeSel(); openSel = sel;
  const opts = JSON.parse(sel.querySelector('script').textContent), cur = sel.dataset.value;
  const pop = D.createElement('div'); pop.className = 'pop'; pop.setAttribute('role', 'listbox'); pop.tabIndex = -1;
  pop.innerHTML = opts.map((o, i) => `<div role="option" id="${sel.dataset.sel}-o${i}" data-v="${esc(o.value)}" aria-selected="${String(o.value) === cur}">${esc(o.label)}</div>`).join('');
  sel.appendChild(pop); sel.querySelector('button').setAttribute('aria-expanded', 'true');
  let i = Math.max(0, opts.findIndex((o) => String(o.value) === cur));
  const mark = () => { pop.querySelectorAll('[role=option]').forEach((o, k) => o.classList.toggle('act', k === i)); pop.setAttribute('aria-activedescendant', sel.dataset.sel + '-o' + i); pop.children[i]?.scrollIntoView({ block: 'nearest' }); };
  mark(); pop.focus();
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { i = Math.min(opts.length - 1, i + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { i = Math.max(0, i - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { choose(sel, opts[i]); e.preventDefault(); }
    else if (e.key === 'Escape') { closeSel(); sel.querySelector('button').focus(); e.stopPropagation(); }
  });
}
function choose(sel, o) {
  sel.dataset.value = o.value; sel.querySelector('.cur').textContent = o.label; closeSel(); sel.querySelector('button').focus();
  sel.dispatchEvent(new CustomEvent('ops:change', { bubbles: true, detail: { name: sel.dataset.sel, value: o.value } }));
}
export function init() {
  if (!D) return;
  D.addEventListener('pointerdown', (e) => { const b = e.target.closest('.btn'); if (b) b.classList.add('pressed'); }, true);
  D.addEventListener('pointerup', () => D.querySelectorAll('.btn.pressed').forEach((b) => b.classList.remove('pressed')), true);
  D.addEventListener('click', (e) => {
    const selBtn = e.target.closest('.sel>button');
    if (selBtn) { const s = selBtn.parentElement; if (openSel === s) closeSel(); else openSelect(s); return; }
    const opt = e.target.closest('.pop [role=option]');
    if (opt && openSel) { const opts = JSON.parse(openSel.querySelector('script').textContent); choose(openSel, opts.find((o) => String(o.value) === opt.dataset.v)); return; }
    if (openSel && !e.target.closest('.sel')) closeSel();
    const tab = e.target.closest('[data-tabs] [role=tab]');
    if (tab) { const g = tab.parentElement; g.querySelectorAll('[role=tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab))); g.dispatchEvent(new CustomEvent('ops:change', { bubbles: true, detail: { name: g.dataset.tabs, value: tab.dataset.v } })); return; }
    if (e.target.closest('[data-act=drawer-close]')) Drawer.close();
  });
  let tip = null;
  D.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]'); if (!t) return;
    tip = tip || Object.assign(D.createElement('div'), { className: 'tip' }); tip.textContent = t.dataset.tip; D.body.appendChild(tip);
    const r = t.getBoundingClientRect(); tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + 'px'; tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
  });
  D.addEventListener('pointerout', (e) => { if (tip && e.target.closest('[data-tip]')) tip.remove(); });
}
