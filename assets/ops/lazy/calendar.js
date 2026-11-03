/* Calendar (/api/ops/calendar?month=YYYY-MM): a month grid in Israel time — events, every send chip
   (done / partial / planned / held / rolled + the ghost it leaves on the original day), Shir's call
   rounds, closed purchases, used vs capacity per day. Week view for phones.
   Lazy module: app.js imports it only on #/calendar, so it sits outside the counted JS budget
   (scripts/ops-ui-smoke.mjs A2), the same way mock.js does. */
import { esc, fmtN, fmtDate, fmtDT, Skeleton, Button, Select, Drawer, icon } from '../ui.js';
if (typeof document !== 'undefined' && !document.getElementById('cal-css')) document.head.insertAdjacentHTML('beforeend', '<link id="cal-css" rel="stylesheet" href="assets/ops/cal.css?v=1">');

export const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const DOW1 = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export const FILTERS = [
  { id: 'events', he: 'אירועים' }, { id: 'sends', he: 'שליחות' }, { id: 'calls', he: 'שיחות' },
  { id: 'closed', he: 'סגירות' }, { id: 'completions', he: 'השלמות' }, { id: 'held', he: 'החזקות' },
];
const STATE_HE = { done: 'בוצע', partial: 'חלקי', planned: 'מתוכנן', held: 'מוחזק', rolled: 'נדחה לכאן', ghost: 'עבר ליום אחר' };
const LS = 'ops:cal';
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } };
const save = (s) => { try { localStorage.setItem(LS, JSON.stringify({ f: [...s.f], view: s.view })); } catch (e) { /* private mode */ } };
const ilToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const addMonth = (m, n) => { const [y, mo] = m.split('-').map(Number), d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthHe = (m) => new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(m + '-15T12:00:00Z'));

/* which filter categories an item belongs to (an item shows when any of its categories is on) */
export function cats(it) {
  if (it.kind === 'closed') return ['closed'];
  if (it.kind === 'call') return ['calls'];
  const c = ['sends'];
  if (['partial', 'rolled', 'ghost'].includes(it.state)) c.push('completions');
  if (it.state === 'held') c.push('held');
  return c;
}
export function visible(day, st) {
  const q = (st.q || '').trim().toLowerCase();
  const hit = (x) => (!st.ev || x.tok8 === st.ev) && (!q || [x.event, x.name, x.type_he, x.type, x.package, x.template].join(' ').toLowerCase().includes(q));
  return {
    events: st.f.has('events') ? day.events.filter(hit) : [],
    items: day.items.filter((it) => cats(it).some((c) => st.f.has(c)) && hit(it)),
  };
}

export function chip(it, { full = false } = {}) {
  const n = fmtN(it.n);
  /* count first: the cell truncates from the end, the number must survive */
  let txt, extra = '';
  if (it.kind === 'closed') txt = `₪${it.sum ? fmtN(it.sum) : ''} · ${esc(it.event)}`;
  else if (it.kind === 'call') txt = `<b class="num">${n}</b>${it.state === 'done' ? ` (${fmtN(it.answered)} ענו) ✓` : ''} · ${esc(it.event)}`;
  else {
    const pre = it.state === 'done' ? `✓ ${n}` : it.state === 'partial' ? `${n}${it.of ? '/' + fmtN(it.of) : ''}` : it.state === 'rolled' ? `${n} <span class="cc-tag">↪ מ-${esc(fmtDate(it.from_day))}</span>` : it.state === 'ghost' ? `${n} →` : it.state === 'held' ? `⏸ ${n}` : n;
    txt = `<b class="num">${pre}</b> ${esc(it.type_he)} · ${esc(it.event)}`;
    if (it.state === 'ghost') extra = ` <span class="cc-tag">→ ${esc(fmtDate(it.to_day))}</span>`;
  }
  const sub = full && it.kind === 'send' && it.state === 'done' ? ` <span class="muted">נמסרו ${fmtN(it.delivered)} · נכשלו ${fmtN(it.failed)}</span>` : '';
  const comp = it.state === 'partial' && it.completion_day ? ` <span class="cc-tag">השלמה מתוכננת ${esc(fmtDate(it.completion_day))}</span>` : '';
  return `<button type="button" class="cc s-${esc(it.state)} k-${esc(it.kind)}" data-chip="${esc(it.id)}" title="${esc(STATE_HE[it.state] || '')}">${it.kind === 'closed' ? '' : icon(it.kind === 'call' ? 'call' : 'msg', 'cc-ic')}${txt}${extra}${full ? comp + sub : ''}</button>`;
}

function bar(d) {
  if (!d.capacity && !d.used) return '';
  const pct = d.capacity ? Math.min(100, Math.round((d.used / d.capacity) * 100)) : 100;
  return `<div class="cal-bar" data-tip="${esc(`${fmtN(d.used)} מתוך ${fmtN(d.capacity)} הודעות`)}"><i style="width:${pct}%"${d.used > d.capacity ? ' class="over"' : ''}></i></div><div class="cal-cap num">${fmtN(d.used)}/${fmtN(d.capacity)}</div>`;
}
const closedTag = (d) => (d.closed_reason === 'shabbat' ? '<span class="cal-x">שבת · אין שליחה</span>' : d.closed_reason ? '<span class="cal-x">יום ללא פנייה</span>' : d.limited ? '<span class="cal-x lim">עד 13:00</span>' : '');

export function cellHtml(d, st, { max = 4 } = {}) {
  const v = visible(d, st), n = Number(d.date.slice(8));
  const evs = v.events.map((e) => `<div class="cal-ev" title="${esc(e.type)}">${esc(e.name)}${e.time ? ` <span class="muted num">${esc(e.time)}</span>` : ''}${e.type ? ` <span class="muted">${esc(e.type)}</span>` : ''}</div>`).join('');
  const chips = v.items.slice(0, max).map((it) => chip(it)).join('') + (v.items.length > max ? `<span class="cal-more">+${v.items.length - max}</span>` : '');
  return `<div class="cal-d${d.today ? ' today' : ''}${d.open ? '' : ' closed'}${d.limited ? ' limited' : ''}${d.past ? ' past' : ''}" role="gridcell" tabindex="0" data-day="${esc(d.date)}" aria-label="${esc(DOW[d.dow] + ' ' + fmtDate(d.date))}"><div class="cal-h"><b class="num">${n}</b><span class="cal-dow">${esc(DOW1[d.dow])}</span>${closedTag(d)}</div>${evs}<div class="cal-chips">${chips}</div><div class="cal-f">${bar(d)}</div></div>`;
}

export function gridHtml(data, st) {
  const days = data.days;
  if (st.view === 'week') {
    const start = st.week && days.some((d) => d.date === st.week) ? st.week : weekStartOf(data, st);
    const i0 = days.findIndex((d) => d.date === start), wk = days.slice(i0, i0 + 7);
    return `<div class="cal-week" role="grid" aria-label="שבוע">${wk.map((d) => `<div class="cal-wrow"><div class="cal-wl"><b>${esc(DOW[d.dow])}</b><span class="num">${esc(fmtDate(d.date))}</span></div>${cellHtml(d, st, { max: 12 })}</div>`).join('')}</div>`;
  }
  const lead = days.length ? days[0].dow : 0;
  return `<div class="cal-grid" role="grid" aria-label="${esc(monthHe(data.month))}"><div class="cal-hd" role="row">${DOW.map((x, i) => `<div role="columnheader"${i >= 5 ? ' class="we"' : ''}>${x}</div>`).join('')}</div><div class="cal-body">${'<div class="cal-d pad" aria-hidden="true"></div>'.repeat(lead)}${days.map((d) => cellHtml(d, st)).join('')}</div></div>`;
}
function weekStartOf(data, st) {
  const days = data.days, ref = days.find((d) => d.today) || days[0];
  const i = days.indexOf(ref), j = Math.max(0, i - ref.dow);
  return st.week && days.some((d) => d.date === st.week) ? st.week : days[j].date;
}

export function toolbar(data, st) {
  const evOpts = [{ value: '', label: 'כל האירועים' }].concat((data.events || []).map((e) => ({ value: e.tok8, label: e.name })));
  return `<div class="card cal-tb"><div class="sec-h" style="flex-wrap:wrap;gap:8px"><div class="cal-nav">${Button('›', { size: 'sm', variant: 'ghost', act: 'cal-prev', title: 'החודש הקודם' })}<h2 class="h2" style="min-width:9em;text-align:center">${esc(monthHe(data.month))}</h2>${Button('‹', { size: 'sm', variant: 'ghost', act: 'cal-next', title: 'החודש הבא' })}${Button('היום', { size: 'sm', act: 'cal-today' })}</div><span class="sp"></span>
<div class="seg" role="tablist" aria-label="תצוגה"><button type="button" role="tab" data-act="cal-view" data-v="month" aria-selected="${st.view !== 'week'}">חודש</button><button type="button" role="tab" data-act="cal-view" data-v="week" aria-selected="${st.view === 'week'}">שבוע</button></div></div>
<div class="cal-filters"><div class="chips" role="group" aria-label="סינון">${FILTERS.map((f) => `<button type="button" class="fchip" data-act="cal-f" data-f="${f.id}" aria-pressed="${st.f.has(f.id)}">${esc(f.he)}</button>`).join('')}</div>
${Select({ name: 'cal-ev', value: st.ev || '', options: evOpts, label: 'אירוע' })}<input class="in" data-search placeholder="חיפוש: שם, סוג, תבנית" aria-label="חיפוש בלוח" value="${esc(st.q || '')}"></div>
${legend()}${data.source && /locally/.test(data.source) ? '<p class="sub" style="margin:6px 0 0">דמה: נבנה מהמתכנן ולוח השליחות — בלי ספירות לוג, סגירות ושיחות שבוצעו</p>' : ''}${data.audit_truncated ? '<p class="sub" style="margin:6px 0 0">הלוג נחתך (תקציב קריאה) — ייתכן שחסרות ספירות ישנות</p>' : ''}</div>`;
}
const legend = () => `<div class="legend cal-lg">${['done', 'partial', 'planned', 'rolled', 'ghost', 'held'].map((s) => `<span><i class="cc-i s-${s}"></i>${STATE_HE[s]}</span>`).join('')}<span><i class="cc-i k-call"></i>שיחות</span><span><i class="cc-i k-closed"></i>סגירה</span></div>`;

export function view(data, st) { return toolbar(data, st) + `<div class="card flush cal-wrap">${gridHtml(data, st)}</div>`; }

const tokOf = (data, tok8) => ((data.events || []).find((e) => e.tok8 === tok8) || {}).token || '';
export function dayDrawer(d, data, st) {
  const v = visible(d, st), all = { events: d.events, items: d.items };
  const list = v.items.length ? v.items : all.items;
  const evs = (v.events.length ? v.events : all.events).map((e) => `<li>◆ <b>${esc(e.name)}</b> ${esc(e.type)} ${e.time ? `<span class="num">${esc(e.time)}</span>` : ''}${link(data, e.tok8)}</li>`).join('');
  const groups = {};
  for (const it of list) (groups[it.tok8 + '|' + it.event] = groups[it.tok8 + '|' + it.event] || []).push(it);
  const body = Object.entries(groups).map(([k, xs]) => `<div class="cal-g"><div class="sec-h"><b>${esc(xs[0].event)}</b><span class="sp"></span>${link(data, xs[0].tok8)}</div><div class="cal-chips col">${xs.map((it) => chip(it, { full: true })).join('')}</div></div>`).join('');
  return `<p class="sub" style="margin:0 0 8px">${esc(DOW[d.dow])} ${esc(fmtDate(d.date))} · ${d.open ? `${fmtN(d.used)} מתוך ${fmtN(d.capacity)} הודעות${d.limited ? ' · שישי: חלון עד 13:00' : ''}` : d.closed_reason === 'shabbat' ? 'שבת · אין שליחה ושיחות' : 'יום ללא פנייה'}</p>
${evs ? `<ul class="cal-evl">${evs}</ul>` : ''}${body || '<div class="empty">אין שליחות ביום הזה</div>'}${v.items.length < all.items.length ? `<p class="sub">מוצג לפי הסינון (${v.items.length} מתוך ${all.items.length})</p>` : ''}
<div class="row" style="display:flex;gap:8px;margin-top:12px"><a class="btn sm" href="admin.html#hqsendboard">לוח השליחות</a><a class="btn sm ghost" href="#/capacity">קיבולת</a></div>`;
}
const link = (data, tok8) => { const t = tokOf(data, tok8); return t ? ` <a class="btn ghost sm" href="dashboard.html?t=${esc(t)}" target="_blank" rel="noopener">לוח האירוע</a>` : ''; };

export function chipDetail(it) {
  const row = (k, v) => (v == null || v === '' ? '' : `<dt>${esc(k)}</dt><dd>${v}</dd>`);
  if (it.kind === 'closed') return `<dl class="kv">${row('לקוח / אירוע', esc(it.event))}${row('חבילה', esc(it.package))}${row('רשומות', fmtN(it.records))}${row('סכום', fmtN(it.sum) + ' ₪')}${row('שולם', esc(fmtDT(it.at)))}</dl>`;
  return `<dl class="kv">${row('אירוע', esc(it.event))}${row('סוג', esc(it.type_he))}${row('מצב', esc(STATE_HE[it.state] || it.state))}${row('תבנית', it.template ? `<span class="mono">${esc(it.template)}</span>` : '')}
${row('קהל', it.of != null ? fmtN(it.of) + ' אורחים' : '')}${row(it.kind === 'call' ? 'שיחות' : 'הודעות', fmtN(it.n))}${it.state === 'done' || it.state === 'partial' ? row('נשלחו / נמסרו / נכשלו', `${fmtN(it.sent)} / ${fmtN(it.delivered)} / ${fmtN(it.failed)}`) : ''}${it.total_sent != null && it.state === 'partial' ? row('סה״כ נשלחו', fmtN(it.total_sent)) : ''}${it.kind === 'call' && it.state === 'done' ? row('ענו', fmtN(it.answered)) : ''}
${row('מועד מקורי', it.due ? esc(fmtDate(it.due)) : '')}${row('יוצא בפועל', it.state === 'rolled' ? esc(fmtDate(it.from_day)) + ' → היום הזה' : it.state === 'ghost' ? esc((it.to_days || [it.to_day]).map(fmtDate).join(', ')) : '')}${row('השלמה מתוכננת', it.completion_day ? esc(fmtDate(it.completion_day)) : '')}${row('למה', esc(it.reason))}</dl>`;
}

/* an empty month (no data for it) still renders as a grid */
export function emptyMonth(month) {
  const [y, m] = month.split('-').map(Number), n = new Date(Date.UTC(y, m, 0)).getUTCDate(), t = ilToday();
  return { month, today: t, events: [], days: Array.from({ length: n }, (_, i) => { const date = `${month}-${String(i + 1).padStart(2, '0')}`, dow = new Date(date + 'T12:00:00Z').getUTCDay(); return { date, dow, open: dow !== 6, closed_reason: dow === 6 ? 'shabbat' : null, limited: dow === 5 ? 'friday' : null, past: date < t, today: date === t, used: 0, capacity: 0, events: [], items: [] }; }) };
}

export default {
  skeleton: () => Skeleton.card(3) + Skeleton.table(8),
  async mount(el, ctx) {
    const saved = load();
    const st = { month: ilToday().slice(0, 7), view: saved.view || (matchMedia('(max-width:700px)').matches ? 'week' : 'month'), f: new Set(Array.isArray(saved.f) ? saved.f : FILTERS.map((f) => f.id)), ev: '', q: '', week: null };
    let data = null;
    const paint = () => {
      if (!data) return;
      const focus = document.activeElement && document.activeElement.matches('[data-search]');
      el.innerHTML = view(data, st);
      if (focus) { const s = el.querySelector('[data-search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    };
    const fetchMonth = async () => {
      const key = { month: st.month }, c = ctx.api.cached('calendar', key);
      if (c) { data = c.data; paint(); }
      try { const d = await ctx.api.get('calendar', key); data = d && d.days && d.days.length ? d : emptyMonth(st.month); }
      catch (e) { if (!data) { el.innerHTML = ctx.errorBox(e); return; } }
      paint();
    };
    const findDay = (date) => data && data.days.find((d) => d.date === date);
    ctx.on(el, 'click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) {
        const act = a.dataset.act;
        if (act === 'cal-prev' || act === 'cal-next') {
          const dir = act === 'cal-next' ? 1 : -1;
          if (st.view === 'week' && data) {
            const nx = addDays(weekStartOf(data, st), 7 * dir), aligned = addDays(nx, -new Date(nx + 'T12:00:00Z').getUTCDay());
            st.week = aligned.slice(0, 7) === nx.slice(0, 7) ? aligned : nx.slice(0, 7) + '-01';
            if (nx.slice(0, 7) === st.month) { paint(); return; }
            st.month = nx.slice(0, 7);
          } else { st.month = addMonth(st.month, dir); st.week = null; }
          data = null; el.innerHTML = Skeleton.card(3) + Skeleton.table(8); fetchMonth(); return;
        }
        if (act === 'cal-today') { const t = ilToday(); st.week = null; if (st.month !== t.slice(0, 7)) { st.month = t.slice(0, 7); data = null; fetchMonth(); } else paint(); return; }
        if (act === 'cal-view') { st.view = a.dataset.v; save(st); paint(); return; }
        if (act === 'cal-f') { const f = a.dataset.f; if (st.f.has(f)) st.f.delete(f); else st.f.add(f); save(st); paint(); return; }
        return;
      }
      const c = e.target.closest('[data-chip]');
      if (c && data) { const it = data.days.flatMap((d) => d.items).find((x) => x.id === c.dataset.chip); if (it) Drawer.open(`${it.type_he} · ${it.event}`, chipDetail(it)); return; }
      const d = e.target.closest('[data-day]');
      if (d && data) { const day = findDay(d.dataset.day); if (day) Drawer.open('יום ' + DOW[day.dow] + ' ' + fmtDate(day.date), dayDrawer(day, data, st)); }
    });
    ctx.on(el, 'keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-day]')) { e.preventDefault(); e.target.click(); } });
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { st.q = e.target.value; paint(); } });
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'cal-ev') { st.ev = e.detail.value; paint(); } });
    /* chips inside a Drawer open their detail too */
    const onDrawer = (e) => { const c = e.target.closest('.drawer [data-chip]'); if (!c || !data) return; const it = data.days.flatMap((d) => d.items).find((x) => x.id === c.dataset.chip); if (it) Drawer.open(`${it.type_he} · ${it.event}`, chipDetail(it)); };
    document.addEventListener('click', onDrawer); ctx.onDispose(() => document.removeEventListener('click', onDrawer));
    await fetchMonth();
    ctx.poll(fetchMonth, 120000);
  },
};
