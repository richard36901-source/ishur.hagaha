/* Notifications (Phase 5, §10): the header bell + dropdown, the "התראות" screen (list + settings tab).
   Backend: worker/notify.js · GET /api/ops/notifications, POST /api/ops/notifications/mark,
   GET|POST /api/ops/notify-settings. Every settings change is written to the change log server side.
   Lazy module: app.js imports it on #/notify and, once at boot, for the bell (mountBell).
   ?mock=1: fixtures/ops/notifications.json + notify-settings.json; marks and settings stay in memory. */
import { esc, fmtN, fmtDT, timeTag, Skeleton, Toggle, Tabs, toast, busy, Drawer } from '../ui.js';

export const SEV = { P0: ['crit', 'דחוף עכשיו'], P1: ['serious', 'חשוב'], P2: ['warn', 'לשים לב'], P3: ['', 'לידיעה'] };
export const CH_HE = { app: 'באפליקציה', slack: 'סלאק', push: 'פוש', whatsapp: 'וואטסאפ אליי' };
const SNOOZE = [{ h: 1, he: 'שעה' }, { h: 3, he: '3 שעות' }, { h: 24, he: 'מחר' }];
export const sevChip = (s) => { const [tone, he] = SEV[s] || SEV.P3; return `<span class="badge ${tone} ntf-sev" title="${esc(s)}"><span aria-hidden="true">${s === 'P0' ? '▲▲' : '▲'}</span>${esc(he)}</span>`; };

const CSS = `
.ntf-bell{position:relative}
.ntf-bell .cnt{position:absolute;top:2px;inset-inline-end:2px;min-width:18px;height:18px;padding:0 4px;border-radius:var(--radius-xs);background:var(--crit);color:#fff;font:600 10.5px/17px var(--font-num);text-align:center}
.ntf-pop{position:fixed;top:calc(var(--top-h) + 6px);inset-inline-end:12px;width:min(400px,calc(100vw - 24px));max-height:min(70vh,560px);display:flex;flex-direction:column;background:var(--raise);border:1px solid var(--line);border-radius:var(--r-l);box-shadow:var(--shadow);z-index:60;overflow:hidden;transform-origin:top left;animation:ntf-in .16s var(--ease)}
@keyframes ntf-in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.ntf-pop{animation:none}}
.ntf-pop header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
.ntf-pop header b{flex:1;font-size:15px}
.ntf-pop .ntf-list{overflow:auto;flex:1}
.ntf-pop footer{padding:8px 14px;border-top:1px solid var(--line);display:flex;justify-content:center}
.ntf-row{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:start;padding:12px 14px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.ntf-row:last-child{border-bottom:0}
.ntf-row.unread{background:var(--green-wash)}.ntf-row:hover{background:var(--hover)}
.ntf-row .t{font-size:14px;line-height:1.45;font-weight:500;color:var(--ink)}
.ntf-row.unread .t{font-weight:650}
.ntf-row .m{grid-column:2;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--ink-3)}
.ntf-row .b{grid-column:2;font-size:13px;color:var(--ink-2);white-space:pre-line}
.ntf-row .acts{grid-column:3;grid-row:1/span 3;display:flex;flex-direction:column;gap:6px}
.ntf-row .sd{width:9px;height:9px;border-radius:50%;margin-top:6px;background:var(--ink-3)}
.ntf-row .sd.crit{background:var(--crit)}.ntf-row .sd.serious{background:var(--serious)}.ntf-row .sd.warn{background:var(--warn)}
.ntf-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.ntf-tools .sp{flex:1}
.chipb{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 12px;border-radius:var(--radius-sm);border:var(--border-w) solid var(--line);background:var(--surface);color:var(--ink-2);font:inherit;font-size:13px;cursor:pointer}
.chipb[aria-pressed=true]{background:var(--green-wash);border-color:var(--border-brand);color:var(--green-deep);font-weight:600}
.ntf-set{display:flex;flex-direction:column}
.ntf-rule{display:grid;grid-template-columns:1fr auto;gap:10px 14px;padding:14px 0;border-bottom:1px solid var(--line);align-items:center}
.ntf-rule:last-child{border-bottom:0}
.ntf-rule .nm{font-weight:600;font-size:14.5px}
.ntf-rule .ds{font-size:12.5px;color:var(--ink-3)}
.ntf-rule .ctl{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.ntf-rule .ctl .lb{font-size:12px;color:var(--ink-3)}
.ntf-rule.off .ctl{opacity:.45;pointer-events:none}
.ntf-step{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
.ntf-step button{border:0;background:var(--surface);width:34px;height:32px;font-size:16px;cursor:pointer;color:var(--ink-2)}
.ntf-step span{min-width:52px;text-align:center;font:600 13px var(--font-num)}
@media (max-width:760px){.chipb,.ntf-step button{height:40px;min-width:40px}.ntf-row .acts .btn{min-height:40px}}
`;
export function css() { if (typeof document === 'undefined' || document.getElementById('ntf-css')) return; const s = document.createElement('style'); s.id = 'ntf-css'; s.textContent = CSS; document.head.appendChild(s); }

/* ── views (pure: data → HTML) ── */
const isUnread = (n, now = Date.now()) => !n.read && (!n.snoozed_until || Date.parse(n.snoozed_until) <= now);
export function row(n, { compact = false, rules = {} } = {}) {
  const [tone] = SEV[n.severity] || SEV.P3, un = isUnread(n);
  const sn = n.snoozed_until && Date.parse(n.snoozed_until) > Date.now();
  return `<div class="ntf-row${un ? ' unread' : ''}" data-id="${esc(n.id)}"><span class="sd ${tone}" aria-hidden="true"></span>
<a class="t" href="${esc(n.deep_link || '#/overview')}" data-act="ntf-open" data-id="${esc(n.id)}">${esc(n.title_he)}</a>
<span class="acts">${un ? `<button type="button" class="btn ghost sm" data-act="ntf-read" data-id="${esc(n.id)}" aria-label="סמן כנקרא" title="סמן כנקרא">✓</button>` : ''}${compact ? '' : `<button type="button" class="btn ghost sm" data-act="ntf-snooze" data-id="${esc(n.id)}" title="להזכיר אחר כך">⏰</button>`}</span>
<span class="m">${sevChip(n.severity)}${timeTag(n.at)}${compact ? '' : `<span>${esc(rules[n.rule] || n.rule)}</span>`}${sn ? `<span>נדחה עד ${esc(fmtDT(n.snoozed_until))}</span>` : ''}${!compact && n.channels && n.channels.length > 1 ? `<span>נשלח: ${n.channels.map((c) => esc(CH_HE[c] || c)).join(' · ')}</span>` : ''}</span>
${!compact && n.body_he ? `<span class="b">${esc(n.body_he)}</span>` : ''}</div>`;
}
export function dropdown(data) {
  const items = (data && data.items) || [];
  return `<header><b>התראות</b>${data && data.unread ? `<span class="badge">${fmtN(data.unread)} חדשות</span>` : ''}${items.some((n) => isUnread(n)) ? '<button type="button" class="btn ghost sm" data-act="ntf-all-read">סמן הכל כנקרא</button>' : ''}</header>
<div class="ntf-list">${!data ? '<div style="padding:14px">' + Skeleton.lines(4) + '</div>' : items.length ? items.slice(0, 10).map((n) => row(n, { compact: true })).join('') : '<div class="empty">אין התראות. הכל שקט.</div>'}</div>
<footer><a class="btn ghost sm" href="#/notify" data-act="ntf-close">כל ההתראות וההגדרות</a></footer>`;
}
export function match(n, st) {
  if (st.unread && !isUnread(n)) return false;
  if (st.sev && st.sev.size && !st.sev.has(n.severity)) return false;
  if (st.rule && n.rule !== st.rule) return false;
  return true;
}
export function listView(data, st) {
  const items = ((data && data.items) || []).filter((n) => match(n, st)), rules = (data && data.rules) || {};
  const present = [...new Set(((data && data.items) || []).map((n) => n.rule))];
  return `<div class="ntf-tools" role="toolbar" aria-label="סינון">
<button type="button" class="chipb" data-act="ntf-f-unread" aria-pressed="${!!st.unread}">רק חדשות${data ? ` <span class="num">${fmtN(data.unread)}</span>` : ''}</button>
${Object.keys(SEV).map((s) => `<button type="button" class="chipb" data-act="ntf-f-sev" data-v="${s}" aria-pressed="${st.sev.has(s)}">${esc(SEV[s][1])}</button>`).join('')}
<span class="sp"></span>${data && data.unread ? '<button type="button" class="btn ghost sm" data-act="ntf-all-read">סמן הכל כנקרא</button>' : ''}</div>
${present.length > 1 ? `<div class="ntf-tools">${present.map((r) => `<button type="button" class="chipb" data-act="ntf-f-rule" data-v="${esc(r)}" aria-pressed="${st.rule === r}">${esc(rules[r] || r)}</button>`).join('')}</div>` : ''}
<section class="card" style="padding:0">${!data ? '<div style="padding:16px">' + Skeleton.lines(6) + '</div>' : items.length ? items.map((n) => row(n, { rules })).join('') : '<div class="empty">אין התראות שמתאימות לסינון.</div>'}</section>
${data && data.next_cursor ? '<div style="text-align:center;margin-top:12px"><button type="button" class="btn" data-act="ntf-more">עוד</button></div>' : ''}`;
}
export function ruleRow(r, sevs = Object.keys(SEV), chans = Object.keys(CH_HE)) {
  const chips = chans.map((c) => `<button type="button" class="chipb" data-act="ntf-set-ch" data-rule="${esc(r.id)}" data-v="${c}" aria-pressed="${r.channels.includes(c)}"${c === 'app' ? ' aria-disabled="true" title="תמיד באפליקציה"' : ''}>${esc(CH_HE[c])}</button>`).join('');
  const sev = `<div class="seg" role="radiogroup" aria-label="מאיזו חומרה לשלוח החוצה">${sevs.map((s) => `<button type="button" role="radio" data-act="ntf-set-sev" data-rule="${esc(r.id)}" data-v="${s}" aria-selected="${r.min_severity === s}" aria-checked="${r.min_severity === s}">${s}+</button>`).join('')}</div>`;
  return `<div class="ntf-rule${r.on ? '' : ' off'}" data-rule="${esc(r.id)}"><div><div class="nm">${esc(r.he)}</div><div class="ds">חומרה רגילה ${esc(r.default_severity)} · לא חוזר על אותו דבר ${r.dedupe_min >= 1440 ? Math.round(r.dedupe_min / 1440) + ' ימים' : r.dedupe_min >= 60 ? Math.round(r.dedupe_min / 60) + ' שעות' : r.dedupe_min + ' דק׳'}</div></div>
${Toggle({ id: r.id, on: r.on, act: 'ntf-set-on' })}
<div class="ctl"><span class="lb">ערוצים</span><div class="chips">${chips}</div><span class="lb">שולח החוצה מ-</span>${sev}
<button type="button" class="chipb" data-act="ntf-set-quiet" data-rule="${esc(r.id)}" aria-pressed="${!!r.quiet}">🌙 שקט 21:00–09:00</button>
${r.digest_hour != null ? `<span class="lb">שעת הסיכום</span><span class="ntf-step"><button type="button" data-act="ntf-set-hour" data-rule="${esc(r.id)}" data-d="-1" aria-label="מוקדם יותר">−</button><span class="num">${String(r.digest_hour).padStart(2, '0')}:00</span><button type="button" data-act="ntf-set-hour" data-rule="${esc(r.id)}" data-d="1" aria-label="מאוחר יותר">+</button></span>` : ''}</div></div>`;
}
export function settingsView(s) {
  if (!s) return `<section class="card">${Skeleton.lines(8)}</section>`;
  return `<p class="sub" style="margin:0 0 10px">באפליקציה תמיד מופיע הכל. כאן קובעים מה יוצא החוצה (סלאק, פוש, וואטסאפ), מאיזו חומרה, ומה שותק בלילה. וואטסאפ אליי רק לדחוף-עכשיו, רק 09:00–21:00. כל שינוי נרשם ביומן השינויים.</p>
<section class="card ntf-set">${s.rules.map((r) => ruleRow(r, s.severities, s.channels)).join('')}</section>`;
}
export function view(st) {
  return `${Tabs({ name: 'ntf-tab', value: st.tab, items: [{ value: 'list', label: 'התראות', count: st.data ? st.data.unread : null }, { value: 'settings', label: 'הגדרות' }] })}<div style="height:12px"></div>
<div id="ntf-body">${st.tab === 'settings' ? settingsView(st.settings) : listView(st.data, st)}</div>`;
}

/* ── data (live, or in-memory in ?mock=1) ── */
const mock = { read: {}, snooze: {}, set: {} };
function applyMock(d) {
  if (!d || !d.items) return d;
  const items = d.items.map((n) => ({ ...n, read: mock.read[n.id] ?? n.read, snoozed_until: mock.snooze[n.id] ?? n.snoozed_until }));
  return { ...d, items, unread: items.filter((n) => isUnread(n)).length };
}
export async function fetchList(app, unread = false) { const d = await app.api.get('notifications', {}, { qs: unread ? '?unread=1&limit=10' : '?limit=100', cache: false }); return app.MOCK ? applyMock(d) : d; }
export async function mark(app, ids, patch) {
  if (app.MOCK) { ids.forEach((id) => { if ('read' in patch) mock.read[id] = patch.read; if ('snooze_until' in patch) mock.snooze[id] = patch.snooze_until; }); return { ok: true, updated: ids.length }; }
  return app.api.post('ops/notifications/mark', { ids, ...patch });
}
async function fetchSettings(app) {
  const s = await app.api.get('notify-settings', {}, { qs: '', cache: false });
  if (app.MOCK) s.rules = s.rules.map((r) => ({ ...r, ...(mock.set[r.id] || {}) }));
  return s;
}
async function saveRule(app, rule, patch) {
  if (app.MOCK) { mock.set[rule] = { ...(mock.set[rule] || {}), ...patch }; return { ok: true, applied: true }; }
  return app.api.post('notify-settings', { rule, patch });
}

/* ── the bell (header) ── */
let bell = null;
export function mountBell(app) {
  if (typeof document === 'undefined' || bell) return bell;
  css();
  const top = document.querySelector('header.top'); if (!top) return null;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn ghost icon ntf-bell'; b.id = 'ntf-bell'; b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'התראות'); b.title = 'התראות';
  b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="cnt" hidden></span>';
  const theme = top.querySelector('[data-act=theme]'); top.insertBefore(b, theme || null);
  let pop = null, last = null;
  const paintCount = (n) => { const c = b.querySelector('.cnt'); c.textContent = n > 99 ? '99+' : String(n); c.hidden = !n; b.setAttribute('aria-label', n ? `התראות, ${n} חדשות` : 'התראות'); };
  const refresh = async () => { try { last = await fetchList(app, false); paintCount(last.unread || 0); if (pop) pop.innerHTML = dropdown({ ...last, items: last.items.slice(0, 10) }); } catch (e) { /* keep the old count */ } return last; };
  const onEsc = (e) => { if (e.key === 'Escape' && pop) { e.stopPropagation(); close(); b.focus(); } };
  const close = () => { if (!pop) return; pop.remove(); pop = null; b.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onEsc, true); };
  const outside = (e) => { if (pop && !pop.contains(e.target) && !b.contains(e.target)) close(); };
  const open = () => {
    pop = document.createElement('div'); pop.className = 'ntf-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'התראות');
    pop.innerHTML = dropdown(last ? { ...last, items: last.items.slice(0, 10) } : null);
    document.body.appendChild(pop); b.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onEsc, true);
    pop.addEventListener('click', onPop); pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); b.focus(); } });
    refresh();
  };
  async function onPop(e) {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'ntf-close') close();
    if (a.dataset.act === 'ntf-open') { mark(app, [a.dataset.id], { read: true }).then(refresh).catch(() => {}); close(); }
    if (a.dataset.act === 'ntf-read') { e.preventDefault(); await mark(app, [a.dataset.id], { read: true }).catch(() => toast('לא הצלחנו לסמן', 'err')); refresh(); }
    if (a.dataset.act === 'ntf-all-read' && last) { await mark(app, last.items.filter((n) => isUnread(n)).map((n) => n.id), { read: true }).catch(() => {}); refresh(); }
  }
  b.addEventListener('click', () => (pop ? close() : open()));
  window.addEventListener('ops:ntf-changed', refresh);
  setTimeout(refresh, 400);
  const iv = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  bell = { el: b, refresh, open, close, stop: () => clearInterval(iv) };
  return bell;
}

/* ── the screen ── */
export default {
  skeleton: () => view({ tab: 'list', data: null, sev: new Set(), unread: false, rule: '' }),
  async mount(el, ctx) {
    css();
    const app = { api: ctx.api, MOCK: ctx.MOCK };
    const st = { tab: /tab=settings/.test(location.hash) ? 'settings' : 'list', data: null, settings: null, sev: new Set(), unread: false, rule: '' };
    const paint = () => { el.innerHTML = view(st); };
    const paintBody = () => { const b = el.querySelector('#ntf-body'); if (b) b.innerHTML = st.tab === 'settings' ? settingsView(st.settings) : listView(st.data, st); else paint(); };
    const changed = () => window.dispatchEvent(new CustomEvent('ops:ntf-changed'));
    paint();
    const load = async () => { st.data = await fetchList(app, false); paintBody(); };
    const loadS = async () => { st.settings = await fetchSettings(app); paintBody(); };
    try { await (st.tab === 'settings' ? loadS() : load()); } catch (e) { el.insertAdjacentHTML('afterbegin', ctx.errorBox(e)); }
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name !== 'ntf-tab') return; st.tab = e.detail.value; paintBody(); if (st.tab === 'settings' && !st.settings) loadS().catch((x) => toast(x.message, 'err')); if (st.tab === 'list' && !st.data) load(); });
    const rule = (id) => st.settings.rules.find((r) => r.id === id);
    const save = async (btn, id, patch, ok) => {
      const r = rule(id), before = { ...r };
      Object.assign(r, patch); paintBody();   /* optimistic */
      try { const res = await saveRule(app, id, patch); if (res && res.ok === false) throw new Error(res.why || res.error); toast(ok + ' · נרשם ביומן השינויים'); }
      catch (e) { Object.assign(r, before); paintBody(); toast('לא נשמר: ' + (e.message || ''), 'err'); }
    };
    ctx.on(el, 'click', async (e) => {
      const a = e.target.closest('[data-act]'); if (!a || a.getAttribute('aria-disabled') === 'true') return;
      const act = a.dataset.act, id = a.dataset.id, rid = a.dataset.rule || id;
      if (act === 'ntf-f-unread') { st.unread = !st.unread; paintBody(); }
      else if (act === 'ntf-f-sev') { st.sev.has(a.dataset.v) ? st.sev.delete(a.dataset.v) : st.sev.add(a.dataset.v); paintBody(); }
      else if (act === 'ntf-f-rule') { st.rule = st.rule === a.dataset.v ? '' : a.dataset.v; paintBody(); }
      else if (act === 'ntf-open') { mark(app, [id], { read: true }).then(changed).catch(() => {}); }
      else if (act === 'ntf-read') { e.preventDefault(); await busy(a, () => mark(app, [id], { read: true })).catch(() => {}); await load(); changed(); }
      else if (act === 'ntf-all-read') { const ids = st.data.items.filter((n) => isUnread(n)).map((n) => n.id); await busy(a, () => mark(app, ids, { read: true })).catch(() => {}); await load(); changed(); toast(ids.length + ' סומנו כנקראו'); }
      else if (act === 'ntf-snooze') {
        Drawer.open('להזכיר לי בעוד', `<div class="chips" style="gap:10px">${SNOOZE.map((s) => `<button type="button" class="btn" data-act="ntf-snooze-go" data-h="${s.h}">${esc(s.he)}</button>`).join('')}</div>`);
        const body = Drawer.body();
        body.addEventListener('click', async (ev) => { const b = ev.target.closest('[data-act=ntf-snooze-go]'); if (!b) return; const until = new Date(Date.now() + Number(b.dataset.h) * 3600e3).toISOString(); await mark(app, [id], { snooze_until: until }).catch(() => {}); Drawer.close(); await load(); changed(); toast('נדחה עד ' + fmtDT(until)); }, { once: false });
      }
      else if (act === 'ntf-more') { const more = await app.api.get('notifications', {}, { qs: '?limit=100&cursor=' + encodeURIComponent(st.data.next_cursor), cache: false }); st.data = { ...st.data, items: st.data.items.concat(more.items), next_cursor: more.next_cursor }; paintBody(); }
      else if (act === 'ntf-set-on') { const r = rule(rid); await save(a, rid, { on: !r.on }, r.on ? 'כובה' : 'הופעל'); }
      else if (act === 'ntf-set-ch') { const r = rule(rid), v = a.dataset.v; const ch = r.channels.includes(v) ? r.channels.filter((c) => c !== v) : [...r.channels, v]; await save(a, rid, { channels: ch }, CH_HE[v] + (r.channels.includes(v) ? ' הוסר' : ' נוסף')); }
      else if (act === 'ntf-set-sev') await save(a, rid, { min_severity: a.dataset.v }, 'החומרה עודכנה');
      else if (act === 'ntf-set-quiet') { const r = rule(rid); await save(a, rid, { quiet: !r.quiet }, r.quiet ? 'שולח גם בלילה' : 'שקט בלילה'); }
      else if (act === 'ntf-set-hour') { const r = rule(rid); await save(a, rid, { digest_hour: (r.digest_hour + Number(a.dataset.d) + 24) % 24 }, 'שעת הסיכום עודכנה'); }
    });
    ctx.poll(async () => { if (st.tab === 'list') await load(); }, 30000);
  },
};
