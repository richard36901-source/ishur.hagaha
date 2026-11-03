/* ishur ops · app: router, data layer (fetch + cache + poll), auth, shortcuts, palette.
   ?mock=1 → fixtures/ops/*.json through mock adapters; otherwise POST go.ishur.io/api/ops/*
   with admin_key + IshurGuard.stamp, the same way live.html / admin.html authenticate. */
import { esc, icon, Button, Skeleton, KeyHints, toast, Drawer, init as uiInit, relTime } from './ui.js';

const Q = new URLSearchParams(location.search);
export const MOCK = Q.get('mock') === '1';
const VER = '1';
const $ = (s, r = document) => r.querySelector(s);

/* ── auth (same key + stamp as admin pages) ── */
let adminKey = '';
try { adminKey = Q.get('key') || localStorage.getItem('ishur_calls_key') || ''; if (Q.get('key')) localStorage.setItem('ishur_calls_key', adminKey); } catch (e) { /* private mode */ }
let BASE = 'https://go.ishur.io';
const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
let liveReady = null;
function ensureLive() {
  if (MOCK) return Promise.resolve();
  liveReady = liveReady || loadScript('config.js?v=72').then(() => loadScript('assets/guard.js?v=19')).then(() => {
    try { BASE = window.ISHUR_CONFIG.endpoint('status').replace(/\/api\/status$/, ''); } catch (e) { /* keep default */ }
  }).catch(() => {});
  return liveReady;
}

/* ── data layer ── */
export class HttpError extends Error { constructor(status, msg) { super(msg || 'HTTP ' + status); this.status = status; } }
const mem = new Map();
const LS = 'ops:c:';
function cacheGet(key) {
  if (mem.has(key)) return mem.get(key);
  try { const v = JSON.parse(localStorage.getItem(LS + key) || 'null'); if (v) mem.set(key, v); return v; } catch (e) { return null; }
}
function cachePut(key, data) {
  const v = { at: Date.now(), data }; mem.set(key, v);
  try { const s = JSON.stringify(v); if (s.length < 400000) localStorage.setItem(LS + key, s); } catch (e) { /* quota */ }
}
let fixtureCache = {};
const fixture = (name) => (fixtureCache[name] = fixtureCache[name] || fetch(`fixtures/ops/${name}.json?v=${VER}`).then((r) => { if (!r.ok) throw new HttpError(r.status); return r.json(); }));
let reqCount = 0;
export const stats = () => ({ requests: reqCount });

async function raw(name, body = {}) {
  reqCount++;
  if (MOCK) { await new Promise((r) => setTimeout(r, 120 + Math.random() * 180)); return mockApi(name, body); }
  await ensureLive();
  const payload = Object.assign({ admin_key: adminKey }, body);
  const r = await fetch(BASE + '/api/ops/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.IshurGuard ? window.IshurGuard.stamp(payload) : payload) });
  if (r.status === 403 || r.status === 401) { showGate('המפתח לא התקבל'); throw new HttpError(r.status, 'אין הרשאה'); }
  if (r.status === 404) throw new HttpError(404, 'נקודת הקצה ' + name + ' עוד לא קיימת בשרת');
  if (!r.ok) throw new HttpError(r.status);
  const j = await r.json();
  if (j && j.ok === false) throw new HttpError(200, j.error || 'השרת החזיר שגיאה');
  return j;
}
const keyOf = (name, body) => name + (body && Object.keys(body).length ? ':' + JSON.stringify(body) : '');
const inflight = new Map();
export const api = {
  cached: (name, body) => cacheGet(keyOf(name, body)),
  async get(name, body = {}, { cache = true } = {}) {
    const k = keyOf(name, body);
    if (inflight.has(k)) return inflight.get(k);
    const p = raw(name, body).then((d) => { if (cache) cachePut(k, d); asOf(Date.now()); return d; }).finally(() => inflight.delete(k));
    inflight.set(k, p); return p;
  },
  post: (name, body) => raw(name, body),
};

/* poll: timeout chain, pauses while the tab is hidden, backs off on errors */
const polls = new Set();
export function poll(fn, ms) {
  const p = { fn, ms, t: 0, dead: false, fails: 0 };
  const tick = async () => {
    if (p.dead) return;
    if (document.hidden) { p.t = 0; return; }
    try { await fn(); p.fails = 0; } catch (e) { p.fails++; }
    if (!p.dead) p.t = setTimeout(tick, ms * Math.min(8, 2 ** p.fails));
  };
  p.kick = () => { clearTimeout(p.t); tick(); };
  p.stop = () => { p.dead = true; clearTimeout(p.t); polls.delete(p); };
  polls.add(p); p.t = setTimeout(tick, ms);
  return p;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) polls.forEach((p) => p.kick()); });

/* ── mock adapters: make fixtures behave like the endpoints (filters, since-cursor, toggle) ── */
const mockState = { off: {}, liveId: 0, brainStep: 2 };
function downstream(nodes, id) {
  const kids = {}; nodes.forEach((n) => (n.from || []).forEach((f) => (kids[f] = kids[f] || []).push(n.id)));
  const seen = new Set(), q = [id];
  while (q.length) { const x = q.shift(); (kids[x] || []).forEach((k) => { if (!seen.has(k)) { seen.add(k); q.push(k); } }); }
  return [...seen].map((k) => nodes.find((n) => n.id === k)).filter(Boolean);
}
async function mockApi(name, body) {
  const now = new Date().toISOString();
  if (name === 'registry') {
    const r = structuredClone(await fixture('registry'));
    r.nodes.forEach((n) => { if (mockState.off[n.id] != null) n.state = mockState.off[n.id]; });
    return r;
  }
  if (name === 'runs') {
    const r = await fixture('runs');
    let items = r.items.filter((x) => (!body.automation_id || x.automation_id === body.automation_id) && (!body.status || x.status === body.status) && (!body.triggered_by || x.triggered_by.startsWith(body.triggered_by)) && (!body.q || (x.name + x.id + (x.error || '')).includes(body.q)));
    const off = body.cursor ? +body.cursor : 0, lim = body.limit || 200;
    return { ok: true, fixture: true, as_of: r.as_of, total: items.length, items: items.slice(off, off + lim), next_cursor: off + lim < items.length ? String(off + lim) : null };
  }
  if (name === 'run') {
    const d = await fixture('run');
    if (!body.id || body.id === d.run.id) return d;
    const all = (await fixture('runs')).items, run = all.find((x) => x.id === body.id) || all[1];
    return { ok: true, fixture: true, run, children: [], logs: [{ ts: run.started_at, level: 'info', msg: 'התחיל · ' + run.name }, ...(run.error ? [{ ts: run.ended_at, level: 'error', msg: run.error }] : []), { ts: run.ended_at, level: 'info', msg: 'הסתיים · ' + run.status }], audit: [{ id: 'a' + run.id, at: run.started_at, kind: 'cron', summary: 'job ' + run.automation_id + ' ' + run.status }] };
  }
  if (name === 'live') {
    const f = await fixture('live');
    if (!body.since) { mockState.liveId = f.cursor; return f; }
    const n = Math.random() < 0.35 ? 0 : 1 + Math.floor(Math.random() * 2);
    const items = Array.from({ length: n }, () => { const t = f.items[Math.floor(Math.random() * f.items.length)]; return { ...t, id: ++mockState.liveId, at: now }; });
    return { ok: true, fixture: true, items, cursor: mockState.liveId };
  }
  if (name === 'brain') {
    const b = await fixture('brain');
    if (!body.since) { mockState.brainStep = 3; return { ...b, stream: b.stream.slice(0, 3), cursor: b.stream[2].id }; }
    const nx = b.stream[mockState.brainStep % b.stream.length]; mockState.brainStep++;
    return { ok: true, fixture: true, findings: b.findings, playbooks: b.playbooks, stream: [{ ...nx, id: 1000 + mockState.brainStep, at: now }], cursor: 1000 + mockState.brainStep };
  }
  if (name === 'toggle') {
    const reg = await fixture('registry'), imp = (await fixture('toggle')).impact;
    const node = reg.nodes.find((n) => n.id === body.id);
    if (!node) return { ok: false, error: 'unknown id' };
    if (body.confirm !== body.id) return { ok: true, needs_confirm: true, blast: { downstream: downstream(reg.nodes, body.id).map((n) => ({ id: n.id, name: n.name_he, kind: n.kind })), impact: (imp[body.id] || []).map(([label, count]) => ({ label, count })), side_effects: node.side_effects } };
    mockState.off[body.id] = body.enabled ? { enabled: true } : { enabled: false, disabled_by: 'richard', disabled_at: now, reason: body.reason || 'כובה מלוח הבקרה' };
    return { ok: true, state: mockState.off[body.id] };
  }
  if (name === 'edit') return { ok: true, fixture: true, saved: body };
  return fixture(name);
}

/* ── as-of indicator ── */
let lastOk = 0;
function asOf(t) { lastOk = t; paintAsOf(); }
function paintAsOf() {
  const el = $('#asof'); if (!el) return;
  const age = Date.now() - lastOk;
  el.className = 'asof' + (!lastOk ? '' : age > 120000 ? ' stale' : '');
  el.querySelector('span:last-child').textContent = lastOk ? 'עודכן ' + relTime(new Date(lastOk).toISOString()) : 'טוען…';
}
setInterval(paintAsOf, 15000);

/* ── routes ── */
export const ROUTES = [
  { id: 'overview', he: 'סקירה', icon: 'overview', key: 'o' },
  { id: 'automations', he: 'אוטומציות', icon: 'auto', key: 'a' },
  { id: 'runs', he: 'ריצות', icon: 'runs', key: 'r' },
  { id: 'live', he: 'לוג חי', icon: 'live', key: 'l' },
  { id: 'brain', he: 'מוח', icon: 'brain', key: 'b' },
  { id: 'messaging', he: 'הודעות', icon: 'msg', key: 'm' },
  { id: 'calls', he: 'שיחות', icon: 'call', key: 'c' },
  { id: 'capacity', he: 'קיבולת', icon: 'cap', key: 'k' },
  { id: 'balances', he: 'יתרות', icon: 'bal', key: 'y' },
];
const screens = {};
const loadScreen = (id) => (screens[id] = screens[id] || import(`./screens/${id}.js?v=${VER}`).then((m) => m.default));
const keep = (h) => h + (MOCK ? '' : '');
export const href = (path) => '#/' + path;

let current = null;
function parseHash() { const [id, ...rest] = (location.hash.replace(/^#\/?/, '') || 'overview').split('/'); return { id: ROUTES.some((r) => r.id === id) ? id : 'overview', arg: rest.length ? decodeURIComponent(rest.join('/')) : null }; }

async function route() {
  const { id, arg } = parseHash();
  const main = $('#main');
  if (current && current.id === id && current.screen.onArg) { current.arg = arg; current.screen.onArg(arg, current.ctx); return; }
  if (current) { current.ctx.dispose(); }
  const r = ROUTES.find((x) => x.id === id);
  document.querySelectorAll('.nav a[data-r]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.r === id) || a.removeAttribute('aria-current'));
  document.querySelectorAll('.nav a[data-r]').forEach((a) => { if (a.dataset.r === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#title').textContent = r.he;
  document.title = r.he + ' · מרכז שליטה · ishur.io';
  main.innerHTML = `<div class="page">${Skeleton.tiles(4)}${Skeleton.table(6)}</div>`;
  const page = document.createElement('div'); page.className = 'page';
  const disposers = [];
  const ctx = {
    id, arg, api, poll: (fn, ms) => { const p = poll(fn, ms); disposers.push(() => p.stop()); return p; },
    on: (el, ev, fn) => { el.addEventListener(ev, fn); disposers.push(() => el.removeEventListener(ev, fn)); },
    dispose: () => { disposers.splice(0).forEach((f) => f()); Drawer.close(true); },
    nav: (p) => { location.hash = '#/' + p; }, toast, page, MOCK,
    errorBox, setBadge,
  };
  current = { id, arg, ctx, screen: null };
  try {
    const screen = await loadScreen(id);
    if (current.ctx !== ctx) return;
    current.screen = screen;
    main.innerHTML = ''; main.appendChild(page);
    page.innerHTML = screen.skeleton ? screen.skeleton() : `${Skeleton.tiles(4)}${Skeleton.table(6)}`;
    main.scrollTop = 0;
    await screen.mount(page, ctx);
    if (arg && screen.onArg) screen.onArg(arg, ctx);
  } catch (e) {
    page.innerHTML = errorBox(e, 'retry-route'); if (!page.isConnected) { main.innerHTML = ''; main.appendChild(page); }
  }
}
export function errorBox(e, act = 'retry-route') {
  const msg = e && e.status === 404 ? e.message : e && e.status === 403 ? 'אין הרשאה. היכנסו מחדש.' : 'לא הצלחנו לטעון' + (e && e.message ? ': ' + e.message : '');
  return `<div class="errbox" role="alert"><span aria-hidden="true">✕</span><span style="flex:1">${esc(msg)}</span>${Button('לנסות שוב', { size: 'sm', act })}</div>`;
}
function setBadge(routeId, n) { const a = document.querySelector(`.nav a[data-r="${routeId}"] .cnt`); if (a) { a.textContent = n > 99 ? '99+' : n; a.hidden = !n; } }

/* ── gate ── */
function showGate(msg = '') {
  if (MOCK) return;
  $('#gate').hidden = false; $('#gate-err').textContent = msg; $('#gate-in').focus();
}

/* ── side live panel (reuses the live screen's feed) ── */
let sideFeed = null;
async function mountSide() {
  const shell = $('.shell');
  let off = false; try { off = localStorage.getItem('ops:side') === 'off'; } catch (e) {}
  shell.classList.toggle('side-off', off);
  if (off || matchMedia('(max-width:1180px)').matches) return;
  if (sideFeed) return;
  const m = await loadScreen('live');
  sideFeed = m.feed($('#side-feed'), { compact: true });
  /* first live fetch waits for the page's own data so load stays at ≤3 requests */
  setTimeout(() => sideFeed.start(), 2500);
}
function toggleSide() {
  const shell = $('.shell'), off = !shell.classList.contains('side-off');
  shell.classList.toggle('side-off', off);
  try { localStorage.setItem('ops:side', off ? 'off' : 'on'); } catch (e) {}
  if (off && sideFeed) { sideFeed.stop(); sideFeed = null; $('#side-feed').innerHTML = ''; } else mountSide();
}

/* ── theme ── */
function toggleTheme() {
  const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('ishur_theme', r.dataset.theme); } catch (e) {}
}

/* ── keyboard ── */
export const KEYMAP = [
  ['g o', 'סקירה'], ['g a', 'אוטומציות'], ['g r', 'ריצות'], ['g l', 'לוג חי'], ['g b', 'מוח'], ['g m', 'הודעות'], ['g c', 'שיחות'], ['g k', 'קיבולת'], ['g y', 'יתרות'],
  ['⌘ K', 'פקודות וחיפוש'], ['/', 'חיפוש בעמוד'], ['j k', 'שורה הבאה / קודמת'], ['Enter', 'פתיחת השורה'], ['Esc', 'סגירה'],
  ['\\', 'פאנל לוג חי'], ['t', 'בהיר / כהה'], ['p', 'עצירת הזרם החי'], ['?', 'קיצורי מקלדת'],
];
function helpDialog() { Drawer.open('קיצורי מקלדת', KeyHints(KEYMAP)); }
function moveRow(dir) {
  const scope = Drawer.el ? Drawer.body() : $('#main');
  const rows = [...scope.querySelectorAll('tr[data-row]')]; if (!rows.length) return;
  let i = rows.findIndex((r) => r.classList.contains('sel'));
  i = Math.max(0, Math.min(rows.length - 1, i + dir));
  rows.forEach((r) => r.classList.remove('sel')); rows[i].classList.add('sel'); rows[i].scrollIntoView({ block: 'nearest' });
}
let gPending = 0;
function onKey(e) {
  const t = e.target, typing = t.matches && t.matches('input,textarea,[contenteditable]');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  if (e.key === 'Escape') { if ($('.palette')) { closePalette(); return; } if (Drawer.el) { Drawer.close(); return; } if (typing) t.blur(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (gPending && Date.now() - gPending < 1200) { gPending = 0; const r = ROUTES.find((x) => x.key === e.key.toLowerCase()); if (r) { location.hash = '#/' + r.id; e.preventDefault(); } return; }
  switch (e.key) {
    case 'g': gPending = Date.now(); break;
    case '/': { const s = document.querySelector('#main [data-search]'); if (s) { s.focus(); e.preventDefault(); } break; }
    case 'j': moveRow(1); break;
    case 'k': moveRow(-1); break;
    case 'Enter': { const r = (Drawer.el ? Drawer.body() : $('#main')).querySelector('tr.sel'); if (r) r.click(); break; }
    case '?': helpDialog(); break;
    case 't': toggleTheme(); break;
    case '\\': toggleSide(); break;
    case 'p': document.dispatchEvent(new CustomEvent('ops:pause-live')); break;
    default:
  }
}

/* ── command palette ── */
let palEl = null, palPrev = null;
function closePalette() { if (palEl) { palEl.remove(); $('#pal-scrim')?.remove(); palEl = null; palPrev?.focus?.(); } }
async function palette() {
  if (palEl) return closePalette();
  palPrev = document.activeElement;
  const cmds = ROUTES.map((r) => ({ label: 'מעבר ל' + r.he, hint: 'g ' + r.key, run: () => (location.hash = '#/' + r.id) }));
  cmds.push({ label: 'בהיר / כהה', hint: 't', run: toggleTheme }, { label: 'פאנל לוג חי', hint: '\\', run: toggleSide }, { label: 'לקוחות (עמוד האדמין)', hint: '', run: () => (location.href = 'admin.html') }, { label: 'שליטה ידנית (העמוד הישן)', hint: '', run: () => (location.href = 'ops-manual.html') });
  const reg = api.cached('registry');
  if (reg) reg.data.nodes.filter((n) => n.layer > 0).forEach((n) => cmds.push({ label: n.name_he, hint: n.id, run: () => (location.hash = '#/automations/' + n.id) }));
  const s = document.createElement('div'); s.className = 'scrim'; s.id = 'pal-scrim'; s.style.zIndex = 80; s.onclick = closePalette;
  palEl = document.createElement('div'); palEl.className = 'palette'; palEl.setAttribute('role', 'dialog'); palEl.setAttribute('aria-label', 'פקודות');
  palEl.innerHTML = '<input placeholder="לאן? אוטומציה, מסך, פעולה…" aria-label="חיפוש פקודה"><ul role="listbox"></ul>';
  $('#layer').append(s, palEl);
  const inp = palEl.querySelector('input'), ul = palEl.querySelector('ul');
  let list = cmds, i = 0;
  const paint = () => { ul.innerHTML = list.slice(0, 40).map((c, k) => `<li role="option" data-i="${k}" class="${k === i ? 'act' : ''}" aria-selected="${k === i}">${esc(c.label)}<span class="k mono">${esc(c.hint)}</span></li>`).join('') || '<li class="muted">אין התאמה</li>'; };
  const go = (c) => { closePalette(); c && c.run(); };
  inp.addEventListener('input', () => { const q = inp.value.trim().toLowerCase(); list = cmds.filter((c) => (c.label + ' ' + c.hint).toLowerCase().includes(q)); i = 0; paint(); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { i = Math.min(list.length - 1, i + 1); paint(); e.preventDefault(); } else if (e.key === 'ArrowUp') { i = Math.max(0, i - 1); paint(); e.preventDefault(); } else if (e.key === 'Enter') go(list[i]); });
  ul.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) go(list[+li.dataset.i]); });
  paint(); inp.focus();
}

/* ── boot ── */
function boot() {
  uiInit();
  if (MOCK) document.body.insertAdjacentHTML('beforeend', '<div class="mode-mock">נתוני דמה · ?mock=1</div>');
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    const act = a.dataset.act;
    if (act === 'retry-route') { current = null; route(); }
    else if (act === 'theme') toggleTheme();
    else if (act === 'side') toggleSide();
    else if (act === 'help') helpDialog();
    else if (act === 'palette') palette();
  });
  $('#gate-go').addEventListener('click', () => { const v = $('#gate-in').value.trim(); if (!v) return; adminKey = v; try { localStorage.setItem('ishur_calls_key', v); } catch (e) {} $('#gate').hidden = true; current = null; route(); });
  $('#gate-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-go').click(); });
  window.addEventListener('hashchange', route);
  if (!MOCK && !adminKey) showGate();
  ensureLive();
  route();
  mountSide();
}
boot();
