/* ishur ops · דיילות: conflicts + short-staffed warnings, week assignment grid (hostess × day),
   pay summary, roster; hostess drawer (contact, shifts, notes) and assignment drawer (status,
   reassign, paid). Replaces the Monday hostess board. */
import { esc, fmtN, Table, Select, Skeleton, Drawer, Button, toast, Toggle } from '../ui.js';
import { crm, adaptCrm, ASSIGN_ST, conflicts } from './adapt.js';
import { money, dayHe, phoneHe, contactBtns, notesBlock, bindNotes, actionBar } from './kit.js';

const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const ymd = (d) => d.toISOString().slice(0, 10);
export function weekDays(offset = 0, now = Date.now()) {
  const t = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(now)) + 'T12:00:00Z');
  const sun = new Date(t - t.getUTCDay() * 864e5 + offset * 7 * 864e5);
  return Array.from({ length: 7 }, (_, i) => ymd(new Date(+sun + i * 864e5)));
}
const stBadge = (s) => { const [tone, he] = ASSIGN_ST[s] || ['', s]; return `<span class="badge ${tone}">${esc(he)}</span>`; };
const inConflict = (cf, id) => cf.some((p) => p.includes(id));

export function warnings(d, hs) {
  const name = (id) => (hs.find((h) => h.id === id) || {}).name || id, A = (id) => d.assignments.find((a) => a.id === id);
  const cf = d.conflicts.map(([x, y]) => { const a = A(x), b = A(y); return `<li><b>${esc(name(a.hostess_id))}</b> משובצת פעמיים ב-${esc(dayHe(a.date))}: ${esc(a.event_name)} ${esc(a.start)}–${esc(a.end)} ו-${esc(b.event_name)} ${esc(b.start)}–${esc(b.end)}</li>`; });
  const short = (d.events || []).filter((e) => e.have < e.need).map((e) => `<li><b>${esc(e.name)}</b> · ${esc(dayHe(e.date))}: ${fmtN(e.have)} מתוך ${fmtN(e.need)} דיילות ${Button('שיבוץ', { size: 'sm', act: 'as-new', attr: { 'data-token': e.client_token, 'data-date': e.date, 'data-name': e.name } })}</li>`);
  return (cf.length ? `<div class="errbox" role="alert"><span aria-hidden="true">!</span><div><b>התנגשויות בשיבוץ (${cf.length})</b><ul class="warn-l">${cf.join('')}</ul></div></div>` : '')
    + (short.length ? `<div class="warnbox" role="status"><span aria-hidden="true">◐</span><div><b>אירועים שחסרה בהם דיילת (${short.length})</b><ul class="warn-l">${short.join('')}</ul></div></div>` : '');
}

export function grid(d, hs, days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const head = `<div class="wk-h wk-name">דיילת</div>${days.map((x) => `<div class="wk-h${x === today ? ' today' : ''}"><span>${DOW[new Date(x + 'T12:00:00Z').getUTCDay()]}</span><b class="num">${esc(dayHe(x))}</b></div>`).join('')}`;
  const rows = hs.filter((h) => h.active || d.assignments.some((a) => a.hostess_id === h.id && days.includes(a.date))).map((h) => `<div class="wk-name"><a href="#/hostesses/${esc(h.id)}">${esc(h.name)}</a><span class="sub">${esc(h.city)}</span></div>${days.map((x) => { const as = d.assignments.filter((a) => a.hostess_id === h.id && a.date === x); return `<div class="wk-c${x === today ? ' today' : ''}">${as.map((a) => `<button type="button" class="shift st-${esc(a.status)}${inConflict(d.conflicts, a.id) ? ' conflict' : ''}" data-act="as-open" data-id="${esc(a.id)}" aria-label="${esc(a.event_name + ' ' + a.start + ' ' + (ASSIGN_ST[a.status] || [, a.status])[1] + (inConflict(d.conflicts, a.id) ? ' · התנגשות' : ''))}"><b dir="auto">${esc(a.event_name)}</b><span class="num">${esc(a.start)}–${esc(a.end)}</span><span class="g" aria-hidden="true">${{ proposed: '?', confirmed: '✓', declined: '✕', done: '●' }[a.status] || ''}${inConflict(d.conflicts, a.id) ? ' !' : ''}</span></button>`).join('')}</div>`; }).join('')}`).join('');
  return `<div class="wk-wrap" tabindex="0" aria-label="שיבוצים לשבוע"><div class="wk" style="--days:${days.length}">${head}${rows}</div></div>`;
}

export function pay(d, hs, days) {
  const by = (h) => d.assignments.filter((a) => a.hostess_id === h.id && a.status !== 'declined');
  const owed = (h) => by(h).filter((a) => !a.paid && a.status === 'done').reduce((s, a) => s + a.pay, 0);
  const upcoming = (h) => by(h).filter((a) => ['proposed', 'confirmed'].includes(a.status)).reduce((s, a) => s + a.pay, 0);
  const tiles = [['משמרות השבוע', fmtN(d.assignments.filter((a) => days.includes(a.date) && a.status !== 'declined').length)], ['לתשלום (בוצע, לא שולם)', money(hs.reduce((s, h) => s + owed(h), 0))], ['מתוכנן (אישרו + הוצע)', money(hs.reduce((s, h) => s + upcoming(h), 0))], ['שולם', money(d.assignments.filter((a) => a.paid).reduce((s, a) => s + a.pay, 0))]];
  return { tiles: `<div class="grid g-tiles">${tiles.map(([l, v]) => `<div class="tile"><span class="l">${esc(l)}</span><span class="v">${v}</span></div>`).join('')}</div>`,
    table: Table({ rows: hs, rowKey: (h) => h.id, columns: [
      { label: 'דיילת', render: (h) => `<b>${esc(h.name)}</b>${h.active ? '' : ' <span class="badge">לא פעילה</span>'}` },
      { label: 'עיר', hideM: true, render: (h) => esc(h.city) },
      { label: 'תעריף', num: true, hideM: true, render: (h) => money(h.rate) },
      { label: 'משמרות', num: true, render: (h) => fmtN(by(h).length) },
      { label: 'לתשלום', num: true, render: (h) => (owed(h) ? `<b>${money(owed(h))}</b>` : '<span class="muted">—</span>') },
      { label: 'מתוכנן', num: true, hideM: true, render: (h) => money(upcoming(h)) },
    ] }) };
}

export function view(d, hs, days, off) {
  const p = pay(d, hs, days);
  return `${warnings(d, hs)}<section aria-label="תשלום">${p.tiles}</section>
<section class="card"><div class="sec-h"><h2 class="h2">שיבוצים</h2><span class="sp"></span><div class="bar">${Button('‹ שבוע קודם', { size: 'sm', act: 'wk-prev' })}${off ? Button('השבוע', { size: 'sm', variant: 'ghost', act: 'wk-now' }) : ''}${Button('שבוע הבא ›', { size: 'sm', act: 'wk-next' })}</div></div>
<div class="legend">${Object.entries(ASSIGN_ST).map(([k, [, he]]) => `<span><i class="lg-${k}"></i>${esc(he)}</span>`).join('')}<span><i class="lg-conflict"></i>התנגשות</span></div>${grid(d, hs, days)}</section>
<section class="card flush"><div class="sec-h" style="padding:14px 16px 0"><h2 class="h2">צוות ותשלום</h2></div>${p.table}</section>`;
}

function assignView(a, d, hs) {
  const cf = d.conflicts.filter((p) => p.includes(a.id));
  return `${cf.length ? '<div class="errbox" role="alert"><span>!</span>הדיילת משובצת לאירוע אחר באותן שעות</div>' : ''}
<dl class="kv"><dt>אירוע</dt><dd>${a.client_token ? `<a href="#/clients/${esc(a.client_token)}">${esc(a.event_name)}</a>` : esc(a.event_name)}</dd><dt>תאריך</dt><dd class="num">${esc(dayHe(a.date))} · ${esc(a.start)}–${esc(a.end)}</dd><dt>תשלום</dt><dd class="num">${money(a.pay)}</dd><dt>מצב</dt><dd>${stBadge(a.status)}</dd></dl>
<div class="form"><div class="f-row"><span class="f-l">דיילת</span><div class="f-v">${Select({ name: 'as_h', value: a.hostess_id, options: hs.filter((h) => h.active || h.id === a.hostess_id).map((h) => ({ value: h.id, label: h.name + ' · ' + h.city })) })}</div></div>
<div class="f-row"><span class="f-l">מצב</span><div class="f-v">${Select({ name: 'as_st', value: a.status, options: Object.entries(ASSIGN_ST).map(([k, [, he]]) => ({ value: k, label: he })) })}</div></div>
<div class="f-row"><span class="f-l">שולם</span><div class="f-v">${Toggle({ id: a.id, on: a.paid, act: 'as-paid', label: a.paid ? 'שולם' : 'לא שולם' })}</div></div></div>`;
}

export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.table(8),
  async mount(el, ctx) {
    const api = crm(ctx), cached = api.cachedView('hostesses');
    let d = cached || null, off = 0;
    const paint = () => { if (!d) return; el.innerHTML = view(d, d.hostesses, weekDays(off), off); ctx.setBadge('hostesses', d.conflicts.length + (d.events || []).filter((e) => e.have < e.need).length); };
    const load = async () => { try { d = await api.hostesses(); paint(); } catch (e) { el.innerHTML = ctx.errorBox(e, 'hs-retry'); } };
    this.reload = load; this.data = () => d;
    const openAssign = (a) => {
      const b = Drawer.open('שיבוץ · ' + a.event_name, assignView(a, d, d.hostesses)); Drawer.el.classList.add('crm-drawer');
      const save = async (patch) => { const next = { ...a, ...patch }; try { await api.saveAssignment(next); Object.assign(a, patch); d.conflicts = conflicts(d.assignments); b.innerHTML = assignView(a, d, d.hostesses); paint(); toast('השיבוץ נשמר'); } catch (e) { toast('לא נשמר', 'crit'); } };
      b.addEventListener('ops:change', (e) => { if (e.detail.name === 'as_h') save({ hostess_id: e.detail.value }); if (e.detail.name === 'as_st') save({ status: e.detail.value }); });
      b.addEventListener('click', (e) => { if (e.target.closest('[data-act=as-paid]')) save({ paid: !a.paid }); });
    };
    ctx.on(el, 'click', async (e) => {
      const x = e.target.closest('[data-act]');
      if (x) {
        const act = x.dataset.act;
        if (act === 'wk-prev') { off--; paint(); } else if (act === 'wk-next') { off++; paint(); } else if (act === 'wk-now') { off = 0; paint(); } else if (act === 'hs-retry') load();
        else if (act === 'as-open') openAssign(d.assignments.find((a) => a.id === x.dataset.id));
        else if (act === 'as-new') {
          const free = d.hostesses.filter((h) => h.active && !d.assignments.some((a) => a.hostess_id === h.id && a.date === x.dataset.date && a.status !== 'declined'));
          const h = free[0] || d.hostesses.find((y) => y.active);
          const a = { id: null, hostess_id: h.id, client_token: x.dataset.token, event_name: x.dataset.name, date: x.dataset.date, start: '18:30', end: '23:30', status: 'proposed', pay: h.rate, paid: false };
          try { const r = await api.saveAssignment(a); a.id = (r && r.assignment && r.assignment.id) || 'as_new_' + Date.now(); await load(); openAssign(d.assignments.find((y) => y.id === a.id) || a); toast('הוצע ל' + h.name + (free.length ? '' : ' (אין דיילת פנויה, בדקו התנגשות)')); } catch (er) { toast('לא נשמר', 'crit'); }
        }
        return;
      }
      const r = e.target.closest('tr[data-row]'); if (r) ctx.nav('hostesses/' + r.dataset.row);
    });
    if (d) paint();
    await load();
    ctx.poll(() => (Drawer.el ? null : load()), 60000);
  },
  async onArg(id, ctx) {
    if (!id) { Drawer.close(); return; }
    const api = crm(ctx), d = (this.data && this.data()) || (await api.hostesses()), h = d.hostesses.find((x) => x.id === id);
    if (!h) return;
    const b = Drawer.open(h.name, Skeleton.lines(6), { onClose: () => { if (location.hash.startsWith('#/hostesses/')) history.replaceState(null, '', '#/hostesses'); } });
    Drawer.el.classList.add('crm-drawer');
    const paint = async () => {
      const notes = (await api.notes('hostess', id).catch(() => ({ items: [] }))).items;
      const mine = d.assignments.filter((a) => a.hostess_id === id).sort((a, b) => a.date.localeCompare(b.date));
      b.innerHTML = `<header class="crm-head"><div><p class="sub">${esc(h.city)} · ${money(h.rate)} למשמרת${h.active ? '' : ' · לא פעילה'}</p><p class="mono" dir="ltr" style="margin:0">${esc(phoneHe(h.phone))}</p></div><div class="bar">${contactBtns(h.phone)}</div></header>
<section class="crm-sec"><h3 class="h2">משמרות</h3>${Table({ rows: mine, rowKey: (a) => a.id, empty: 'אין משמרות', columns: [{ label: 'תאריך', render: (a) => `<span class="num">${esc(dayHe(a.date))} ${esc(a.start)}</span>` }, { label: 'אירוע', render: (a) => esc(a.event_name) }, { label: 'מצב', render: (a) => stBadge(a.status) }, { label: 'תשלום', num: true, render: (a) => money(a.pay) + (a.paid ? ' ✓' : '') }] })}</section>
<div id="hs-notes">${notesBlock(notes)}</div>${actionBar(contactBtns(h.phone, 'grow'))}`;
    };
    bindNotes(b, api, 'hostess', id, paint);
    await paint();
  },
};
