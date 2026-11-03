/* ishur ops · app: router, data layer (fetch + cache + poll), auth, shortcuts, palette.
   ?mock=1 → fixtures/ops/*.json through mock adapters; otherwise POST go.ishur.io/api/ops/*
   with admin_key + IshurGuard.stamp, the same way live.html / admin.html authenticate. */
import { esc, icon, Button, Skeleton, KeyHints, toast, Drawer, Tabs, init as uiInit, relTime, liveClock } from './ui.js';
import { adapt } from './adapt.js';
import { hooks } from './ui.js';

const Q = new URLSearchParams(location.search);
export const MOCK = Q.get('mock') === '1';
const VER = '2';
const $ = (s, r = document) => r.querySelector(s);

/* ── auth (same key + stamp as admin pages) ── */
let adminKey = '';
try { /* ?key= is stored then stripped from the URL, exactly as admin.html does */ if (Q.get('key')) { localStorage.setItem('ishur_calls_key', Q.get('key')); Q.delete('key'); history.replaceState(null, '', location.pathname + (Q.toString() ? '?' + Q : '') + location.hash); } adminKey = localStorage.getItem('ishur_calls_key') || ''; } catch (e) { /* private mode */ }
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
let reqCount = 0;
export const stats = () => ({ requests: reqCount });

/* automation_id → name_he (cached registry) */
function names() { const r = cacheGet('registry'); return r && r.data && r.data.nodes ? Object.fromEntries(r.data.nodes.map((n) => [n.id, n.name_he])) : {}; }
async function raw(name, body = {}, opts = {}) {
  reqCount++;
  let j;
  if (MOCK) { await new Promise((r) => setTimeout(r, 60 + Math.random() * 90)); /* pretend network */ j = await (await import('./mock.js')).mockApi(name, body, VER, opts.qs); }
  else {
    await ensureLive();
    const payload = Object.assign({ admin_key: adminKey }, body);
    const r = await fetch(BASE + '/api/' + (name.includes('/') ? name.replace(/^\//, '') : 'ops/' + name) + (opts.qs || ''), opts.qs != null ? { headers: { 'X-Admin-Key': adminKey } } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.IshurGuard ? window.IshurGuard.stamp(payload) : payload) });
    if (r.status === 403 || r.status === 401) { showGate('המפתח לא התקבל'); throw new HttpError(r.status, 'אין הרשאה'); }
    if (r.status === 404) { const e = await r.json().catch(() => ({})); throw new HttpError(404, e.error === 'unknown-ops-route' || !e.error ? 'נקודת הקצה ' + name + ' עוד לא קיימת בשרת' : e.error); }
    if (!r.ok) { const e = await r.json().catch(() => ({})); if (opts.soft && e.ok === false) return e; throw new HttpError(r.status, e.error || e.why || ''); }
    j = await r.json();
  }
  if (j && j.ok === false) { if (opts.soft) return j; throw new HttpError(200, j.error || 'השרת החזיר שגיאה'); }
  return adapt(name, j, { names: names() });
}
const keyOf = (name, body) => name + (body && Object.keys(body).length ? ':' + JSON.stringify(body) : '');
const inflight = new Map();
export const api = {
  cached: (name, body) => cacheGet(keyOf(name, body)),
  async get(name, body = {}, { cache = true, qs } = {}) {
    const k = keyOf(name, body);
    if (inflight.has(k)) return inflight.get(k);
    const p = raw(name, body, { qs }).then((d) => { if (cache) cachePut(k, d); asOf(Date.now()); return d; }).finally(() => inflight.delete(k));
    inflight.set(k, p); return p;
  },
  post: (name, body, opts) => raw(name, body, opts),
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

/* ── routes: 7 sections + מערכת; former screens live on as tabs (old hashes + shortcuts are aliases) ── */
export const ROUTES = [
  { id: 'overview', he: 'סקירה', key: 'o' }, { id: 'leads', he: 'לידים', key: 'e', dir: 'crm' },
  { id: 'clients', he: 'לקוחות', key: 's', dir: 'crm' }, { id: 'hostesses', he: 'דיילות', key: 't', dir: 'crm' }, { id: 'feedback', he: 'פידבקים', key: 'v' },
  { id: 'inbox', he: 'אינבוקס', key: 'i' }, { id: 'messaging', he: 'שליחות אוטומטיות', key: 'm' }, { id: 'capacity', he: 'קיבולת', key: 'k' }, { id: 'templates', he: 'תבניות', key: 'n' },
  { id: 'calls', he: 'שיחות', key: 'c' }, { id: 'calendar', he: 'לוח שנה', key: 'd' },
  { id: 'finance', he: 'כספים', key: 'f' }, { id: 'ads', he: 'פרסום', key: 'p' }, { id: 'balances', he: 'יתרות', key: 'y' },
  { id: 'automations', he: 'אוטומציות', key: 'a' }, { id: 'runs', he: 'ריצות', key: 'r' }, { id: 'live', he: 'לוג חי', key: 'l' }, { id: 'brain', he: 'מוח', key: 'b' },
  { id: 'changes', he: 'שינויים', key: 'h' }, { id: 'control', he: 'שליטה ידנית', key: 'x' }, { id: 'notify', he: 'הגדרות התראות', key: 'z' },
];
/* tab = [tab id in ?tab=, label, screen module id] */
export const SECTIONS = [
  { id: 'overview', he: 'סקירה', tabs: [['overview', 'סקירה', 'overview']] },
  { id: 'leads', he: 'לידים', tabs: [['leads', 'לידים', 'leads']] },
  { id: 'clients', he: 'לקוחות', tabs: [['clients', 'לקוחות ואירועים', 'clients'], ['hostesses', 'דיילות', 'hostesses'], ['feedback', 'פידבקים', 'feedback']] },
  { id: 'messages', he: 'הודעות', tabs: [['inbox', 'אינבוקס', 'inbox'], ['sends', 'שליחות אוטומטיות', 'messaging'], ['capacity', 'קיבולת', 'capacity'], ['templates', 'תבניות', 'templates']] },
  { id: 'calls', he: 'שיחות', tabs: [['calls', 'שיחות', 'calls']] },
  { id: 'calendar', he: 'לוח שנה', tabs: [['calendar', 'לוח', 'calendar'], ['capacity', 'תוכנית קיבולת', 'capacity']] },
  { id: 'finance', he: 'כספים', tabs: [['finance', 'רווח והפסד', 'finance'], ['ads', 'פרסום', 'ads'], ['balances', 'יתרות', 'balances']] },
  { id: 'system', he: 'מערכת', tabs: [['automations', 'אוטומציות', 'automations'], ['runs', 'ריצות', 'runs'], ['live', 'לוג חי', 'live'], ['brain', 'מוח', 'brain'], ['changes', 'שינויים', 'changes'], ['control', 'שליטה ידנית', 'control'], ['notify', 'התראות', 'notify']] },
];
const SEC = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
/* old screen id → its home [section, tab] (the first section that holds it) */
export const HOME = {};
for (const s of SECTIONS) for (const [t, , scr] of s.tabs) if (!HOME[scr]) HOME[scr] = [s.id, t];
export const tabHref = (sec, tab) => '#/' + sec + (tab && tab !== SEC[sec].tabs[0][0] ? '?tab=' + tab : '');
export const routeHref = (screenId) => { const h = HOME[screenId]; return h ? tabHref(h[0], h[1]) : '#/' + screenId; };
const screens = {};
/* lazy/ + crm/ modules sit outside the counted JS budget */
const LAZY = new Set(['calendar', 'changes', 'messaging', 'inbox', 'control', 'finance', 'ads', 'templates', 'feedback', 'notify']);
const loadModule = (id) => (screens[id] = screens[id] || import(LAZY.has(id) ? `./lazy/${id}.js` : `./${(ROUTES.find((r) => r.id === id) || {}).dir || 'screens'}/${id}.js`));
const SOON = { skeleton: () => Skeleton.card(3), mount(el) { el.innerHTML = '<div class="card"><div class="empty">הגדרות ההתראות עוד לא הותקנו בגרסה הזו.<br>כשהמודול יעלה הוא יופיע כאן.</div></div>'; } };
const loadScreen = (id) => loadModule(id).then((m) => (m.default && m.default.mount ? m.default : SOON)).catch((e) => { if (id === 'notify') { delete screens[id]; return SOON; } throw e; });
export const href = (path) => '#/' + path;

let current = null;
export function parseHash(h = location.hash) {
  const raw = h.replace(/^#\/?/, ''), [path, query = ''] = raw.split('?'), q = new URLSearchParams(query);
  const [id0, ...rest] = (path || 'overview').split('/'), arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
  if (SEC[id0]) {
    const s = SEC[id0], tabs = s.tabs, want = q.get('tab');
    /* שיחות keeps its own tabs (timeline / rounds / manual / shir / costs): ?tab= becomes the screen arg */
    if (s.id === 'calls') return { sec: 'calls', tab: 'calls', id: 'calls', arg: arg || want || null };
    const t = tabs.find((x) => x[0] === want) || tabs[0];
    return { sec: s.id, tab: t[0], id: t[2], arg };
  }
  if (HOME[id0]) return { sec: HOME[id0][0], tab: HOME[id0][1], id: id0, arg };
  return { sec: 'overview', tab: 'overview', id: 'overview', arg: null };
}
const badges = {};
function paintNav(sec, tab, id) {
  document.querySelectorAll('.nav a[data-r],.tabbar a[data-r]').forEach((a) => { const r = a.dataset.r, on = a.classList.contains('sub') ? r === id : r === sec; if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
function tabsBar(sec, tab) {
  const s = SEC[sec]; if (s.tabs.length < 2) return '';
  return Tabs({ name: 'page', value: tab, label: s.he, items: s.tabs.map(([t, he, scr]) => ({ value: t, label: he, href: tabHref(sec, t), count: badges[scr] || null })) });
}

async function route() {
  const { sec, tab, id, arg } = parseHash();
  const main = $('#main'), key = sec + ':' + tab;
  if (current && current.key === key && current.screen && current.screen.onArg) { current.arg = arg; current.screen.onArg(arg, current.ctx); return; }
  if (current) { current.ctx.dispose(); }
  const s = SEC[sec], t = s.tabs.find((x) => x[0] === tab) || [tab, s.he];
  paintNav(sec, tab, id);
  $('#title').textContent = s.he;
  document.title = (t[1] !== s.he && s.tabs.length > 1 ? t[1] + ' · ' : '') + s.he + ' · מרכז שליטה · ishur.io';
  const page = document.createElement('div'); page.className = 'page';
  page.innerHTML = tabsBar(sec, tab) + `<div class="page-body">${Skeleton.tiles(4)}${Skeleton.table(6)}</div>`;
  main.innerHTML = ''; main.appendChild(page);
  const body = page.querySelector('.page-body');
  const disposers = [];
  const ctx = {
    id, arg, sec, tab, api, poll: (fn, ms) => { const p = poll(fn, ms); disposers.push(() => p.stop()); return p; },
    on: (el, ev, fn) => { el.addEventListener(ev, fn); disposers.push(() => el.removeEventListener(ev, fn)); },
    onDispose: (fn) => disposers.push(fn),
    dispose: () => { disposers.splice(0).forEach((f) => f()); Drawer.close(true); },
    nav: (p) => { location.hash = '#/' + p; }, toast, page: body, MOCK,
    errorBox, setBadge, href: routeHref,
  };
  current = { key, id, arg, ctx, screen: null };
  try {
    const screen = await loadScreen(id);
    if (current.ctx !== ctx) return;
    current.screen = screen;
    body.innerHTML = screen.skeleton ? screen.skeleton() : `${Skeleton.tiles(4)}${Skeleton.table(6)}`;
    main.scrollTop = 0;
    await screen.mount(body, ctx);
    if (arg && screen.onArg) screen.onArg(arg, ctx);
  } catch (e) {
    body.innerHTML = errorBox(e, 'retry-route');
  }
}
export function errorBox(e, act = 'retry-route') {
  const msg = e && e.status === 404 ? e.message : e && e.status === 403 ? 'אין הרשאה. היכנסו מחדש.' : 'לא הצלחנו לטעון' + (e && e.message ? ': ' + e.message : '');
  return `<div class="errbox" role="alert"><span aria-hidden="true">✕</span><span style="flex:1">${esc(msg)}</span>${Button('לנסות שוב', { size: 'sm', act })}</div>`;
}
function setBadge(routeId, n) {
  badges[routeId] = n || 0;
  const put = (r, v) => document.querySelectorAll(`.nav a[data-r="${r}"] .cnt`).forEach((a) => { a.textContent = v > 99 ? '99+' : v; a.hidden = !v; });
  put(routeId, badges[routeId]);
  for (const s of SECTIONS) put(s.id, s.tabs.reduce((t, [, , scr]) => t + (scr === 'overview' && s.id === 'overview' ? badges.overview || 0 : s.id === 'overview' ? 0 : badges[scr] || 0), 0));
}

/* ── gate ── */
function showGate(msg = '') {
  if (MOCK) return;
  $('#gate').hidden = false; $('#gate-err').textContent = msg; $('#gate-in').focus();
}

/* ── side live panel (reuses the live screen's feed) ── */
let sideFeed = null;
async function mountSide() {
  const shell = $('.shell');
  liveClock($('#side-clock'));
  let off = false; try { off = localStorage.getItem('ops:side') === 'off'; } catch (e) {}
  shell.classList.toggle('side-off', off);
  if (off || matchMedia('(max-width:1180px)').matches) return;
  if (sideFeed) return;
  const m = await loadModule('live');
  $('#side-feed').innerHTML = '<div style="padding:8px 14px">' + Skeleton.lines(10) + '</div>';
  sideFeed = m.feed($('#side-feed'), { compact: true });
  /* first live fetch waits for the page's own data (≤3 requests) */
  setTimeout(() => sideFeed && sideFeed.start((n, b) => api.get(n, b, { cache: false })), 1500);
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
  ...ROUTES.map((r) => ['g ' + r.key, r.he]),
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
  if (gPending && Date.now() - gPending < 1200) { gPending = 0; const r = ROUTES.find((x) => x.key === e.key.toLowerCase()); if (r) { location.hash = routeHref(r.id); e.preventDefault(); } return; }
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
  const cmds = ROUTES.map((r) => { const h = HOME[r.id], sh = h && SEC[h[0]].he; return { label: (sh && sh !== r.he ? sh + ' › ' : '') + r.he, hint: 'g ' + r.key, run: () => (location.hash = routeHref(r.id)) }; });
  cmds.push({ label: 'בהיר / כהה', hint: 't', run: toggleTheme }, { label: 'פאנל לוג חי', hint: '\\', run: toggleSide }, { label: 'שליטה ידנית (העמוד הישן)', hint: '', run: () => (location.href = 'ops-manual.html') });
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
  hooks.api = api; hooks.nav = (p) => { location.hash = '#/' + p; };
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
