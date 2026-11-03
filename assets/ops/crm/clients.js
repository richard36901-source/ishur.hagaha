/* ishur ops · לקוחות: table with status chips, guest counts, plan, date, paid, add-on icons;
   client drawer: links, add-ons (design flow state, hostesses, calls), timeline (sends, replies,
   payments, notes), notes, quick actions (hold / extra send / add hostess) behind typed confirm. */
import { esc, fmtN, Table, Tabs, Skeleton, Drawer, Button, icon, toast, confirmTyped } from '../ui.js';
import { crm, adaptCrm, CLIENT_ST } from './adapt.js';
import { money, dayHe, phoneHe, contactBtns, notesBlock, timeline, bindNotes, actionBar } from './kit.js';

export const chip = (c) => `<span class="badge ${c.status_tone}">${esc(c.status_he)}</span>`;
export const addonIcons = (a) => [a.design ? `<span class="ai" data-tip="עיצוב הזמנה · ${esc(a.design_he)}" aria-label="עיצוב הזמנה">🎨</span>` : '', a.hostesses ? `<span class="ai" data-tip="${a.hostesses} דיילות" aria-label="${a.hostesses} דיילות">👤${a.hostesses > 1 ? '<sub>' + a.hostesses + '</sub>' : ''}</span>` : '', a.calls ? '<span class="ai" data-tip="שיחות AI" aria-label="שיחות AI">📞</span>' : '', a.extra_wave ? '<span class="ai" data-tip="גל תזכורת נוסף" aria-label="גל תזכורת נוסף">➕</span>' : ''].join('') || '<span class="muted">—</span>';
const pct = (c) => (c.guests ? Math.round(((c.confirmed + c.declined) / c.guests) * 100) : 0);
export const COLS = [
  { label: 'לקוח', render: (c) => `<b dir="auto">${esc(c.name)}</b><div class="sub">${esc(c.occasion_he)}</div>` },
  { label: 'מצב', render: chip },
  { label: 'תאריך', render: (c) => `<span class="num">${esc(dayHe(c.event_date))}</span>` },
  { label: 'אישורים', render: (c) => `<span class="num">${fmtN(c.confirmed)}</span><span class="muted num"> / ${fmtN(c.guests)}</span><div class="meter" style="margin-top:4px" aria-hidden="true"><i style="width:${pct(c)}%"></i></div>` },
  { label: 'חבילה', hideM: true, render: (c) => esc(c.plan_he) + ` <span class="muted num">${fmtN(c.records)}</span>` },
  { label: 'שולם', num: true, hideM: true, render: (c) => money(c.paid) },
  { label: 'תוספות', hideM: true, render: (c) => addonIcons(c.addons) },
];
export const FILTERS = [{ value: 'open', label: 'פעילים' }, { value: 'upcoming', label: '14 יום קרובים' }, { value: 'hold', label: 'מוחזקים' }, { value: 'done', label: 'הסתיימו' }, { value: '', label: 'הכל' }];
export function pick(cs, st, q, now = Date.now()) {
  return cs.filter((c) => (!st || (st === 'open' ? !['done', 'cancelled'].includes(c.status) : st === 'upcoming' ? c.event_date && Date.parse(c.event_date) - now < 14 * 864e5 && Date.parse(c.event_date) >= now - 864e5 : c.status === st))
    && (!q || (c.name + ' ' + c.phone + ' ' + phoneHe(c.phone) + ' ' + c.tok8 + ' ' + c.venue).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
}
export const listView = (cs) => Table({ columns: COLS, rows: cs, rowKey: (c) => c.token, empty: 'אין לקוחות שמתאימים' });
export function summary(cs) {
  const open = cs.filter((c) => !['done', 'cancelled'].includes(c.status));
  return `<div class="grid g-tiles">${[['לקוחות פעילים', fmtN(open.length)], ['אורחים במעקב', fmtN(open.reduce((s, c) => s + c.guests, 0))], ['אישרו', fmtN(open.reduce((s, c) => s + c.confirmed, 0))], ['הכנסות (כל הרשימה)', money(cs.reduce((s, c) => s + c.paid, 0))]].map(([l, v]) => `<div class="tile"><span class="l">${esc(l)}</span><span class="v">${v}</span></div>`).join('')}</div>`;
}

export function drawerView(d) {
  const c = d.client, a = c.addons;
  const link = (h, label) => (h ? `<a class="btn" href="${esc(h)}" target="_blank" rel="noopener">${esc(label)} ${icon('ext')}</a>` : '');
  return `<header class="crm-head"><div><div class="bar">${chip(c)}<span class="chip">${esc(c.occasion_he)}</span><span class="sub mono" dir="ltr">${esc(c.tok8)}</span></div>
<p class="sub">${esc([dayHe(c.event_date) + (c.event_time ? ' ' + c.event_time : ''), c.venue, c.plan_he + ' עד ' + c.records + ' רשומות', 'שולם ' + money(c.paid)].filter(Boolean).join(' · '))}</p><p class="mono" dir="ltr" style="margin:0">${esc(phoneHe(c.phone))}</p></div><div class="bar">${contactBtns(c.phone)}</div></header>
<section class="grid g-tiles crm-counts">${[['אורחים', c.guests], ['אישרו', c.confirmed], ['לא מגיעים', c.declined], ['ממתינים', c.pending]].map(([l, v]) => `<div class="tile sm"><span class="l">${l}</span><span class="v num">${fmtN(v)}</span></div>`).join('')}</section>
<section class="crm-sec" aria-label="קישורים"><h3 class="h2">קישורים</h3><div class="bar">${link(c.links.dashboard, 'לוח הלקוח')}${link(c.links.upload, 'העלאת רשימה')}${link(c.links.feedback, 'משוב')}${c.lead_id ? `<a class="btn ghost" href="#/leads/${esc(c.lead_id)}">הליד המקורי</a>` : ''}</div></section>
<section class="crm-sec" aria-label="תוספות"><h3 class="h2">תוספות</h3><dl class="kv">
<dt>עיצוב הזמנה</dt><dd>${a.design ? `<span class="badge ${a.design === 'approved' ? 'good' : 'warn'}">${esc(a.design_he)}</span>` : '<span class="muted">לא נרכש</span>'}</dd>
<dt>דיילות</dt><dd>${a.hostesses ? fmtN(a.hostesses) + ` · <a href="#/hostesses">שיבוץ</a>` : '<span class="muted">אין</span>'}</dd>
<dt>שיחות AI</dt><dd>${a.calls ? 'כלול' : '<span class="muted">לא</span>'}</dd><dt>גל תזכורת נוסף</dt><dd>${a.extra_wave ? 'כן' : '<span class="muted">לא</span>'}</dd></dl></section>
<section class="crm-sec" aria-label="פעולות"><h3 class="h2">פעולות מהירות</h3><div class="bar">${Button(c.status === 'hold' ? 'שחרור מ-hold' : 'השהיית שליחות (hold)', { act: 'cl-hold', variant: c.status === 'hold' ? '' : 'danger' })}${Button('שליחה נוספת', { act: 'cl-extra' })}${Button('הוספת דיילת', { act: 'cl-host' })}</div></section>
<div id="cl-notes">${notesBlock(d.notes)}</div>
<section class="crm-sec" aria-label="ציר זמן"><h3 class="h2">ציר זמן</h3>${timeline([...d.timeline, ...d.notes.map((n) => ({ id: n.id, at: n.at, kind: 'note', dir: 'out', label: 'הערה · ' + n.by, text: n.text }))].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)))}</section>
${actionBar(`${contactBtns(c.phone, 'grow')}${c.links.dashboard ? `<a class="btn primary grow" href="${esc(c.links.dashboard)}" target="_blank" rel="noopener">לוח הלקוח</a>` : ''}`)}`;
}

const ACTIONS = {
  'cl-hold': { action: 'hold', word: 'hold', title: (c) => (c.status === 'hold' ? 'לשחרר את ' + c.name + ' מ-hold?' : 'לעצור את כל השליחות של ' + c.name + '?'), body: (c) => (c.status === 'hold' ? 'השליחות המתוכננות יחזרו לצאת בפעימה הבאה.' : 'אף הודעה ושיחה לאירוע הזה לא ייצאו עד שתשחררו. השאר ממשיך כרגיל.') },
  'cl-extra': { action: 'extra_send', word: 'שלח', title: (c) => 'שליחה נוספת לאורחים של ' + c.name + '?', body: (c) => fmtN(c.pending) + ' אורחים שעוד לא ענו יקבלו הודעת תזכורת בחלון השליחה הבא (לא בשעות השקטות).' },
  'cl-host': { action: 'add_hostess', word: 'דיילת', title: (c) => 'להוסיף דיילת לאירוע של ' + c.name + '?', body: () => 'נוספת דרישה לדיילת אחת. השיבוץ עצמו בלוח הדיילות. החיוב בנפרד (קישור תשלום).' },
};

export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.table(10),
  async mount(el, ctx) {
    const api = crm(ctx), cached = ctx.api.cached('crm/clients');
    let cs = cached ? adaptCrm('clients', cached.data).items : [], st = 'open', q = '';
    el.innerHTML = `<div id="cl-sum">${Skeleton.tiles(4)}</div><div class="bar"><div class="search">${icon('search')}<input class="in" data-search placeholder="חיפוש שם, טלפון, אולם" aria-label="חיפוש לקוחות"></div>${Tabs({ name: 'cl_st', value: st, items: FILTERS })}<span class="sp" style="flex:1"></span><span class="sub num" id="cl-count"></span></div><div class="card flush" id="cl-list">${Skeleton.table(10)}</div>`;
    const paint = () => { const xs = pick(cs, st, q); el.querySelector('#cl-sum').innerHTML = summary(cs); el.querySelector('#cl-list').innerHTML = listView(xs); el.querySelector('#cl-count').textContent = fmtN(xs.length) + ' לקוחות'; };
    const load = async () => { try { cs = (await api.clients()).items; paint(); } catch (e) { el.querySelector('#cl-list').innerHTML = ctx.errorBox(e, 'cl-retry'); } };
    this.reload = load;
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { q = e.target.value.trim(); paint(); } });
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'cl_st') { st = e.detail.value; paint(); } });
    ctx.on(el, 'click', (e) => { if (e.target.closest('[data-act=cl-retry]')) return load(); const r = e.target.closest('tr[data-row]'); if (r) ctx.nav('clients/' + r.dataset.row); });
    if (cs.length) paint();
    await load();
    ctx.poll(() => (Drawer.el ? null : load()), 60000);
  },
  async onArg(token, ctx) {
    if (!token) { Drawer.close(); return; }
    const api = crm(ctx), self = this;
    const b = Drawer.open('לקוח', Skeleton.lines(10), { onClose: () => { if (location.hash.startsWith('#/clients/')) history.replaceState(null, '', '#/clients'); self.reload && self.reload(); } });
    Drawer.el.classList.add('crm-drawer');
    let d;
    const paint = async () => { d = await api.client(token); if (Drawer.body() !== b) return; Drawer.el.querySelector('.drawer-h h2').textContent = d.client.name; b.innerHTML = drawerView(d); };
    bindNotes(b, api, 'client', token, paint);
    b.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-act]'); const A = x && ACTIONS[x.dataset.act]; if (!A) return;
      const c = d.client;
      if (!(await confirmTyped({ title: A.title(c), body: `<p>${esc(A.body(c))}</p>`, word: A.word, action: 'אישור', danger: A.action !== 'add_hostess' }))) return;
      try { const r = await api.clientAction(token, A.action, { confirm: A.word }); if (r && r.applied === false) throw new Error('השרת לא אישר'); toast('בוצע'); await paint(); } catch (er) { toast('לא בוצע' + (er.message ? ': ' + er.message : ''), 'crit'); }
    });
    try { await paint(); } catch (e) { b.innerHTML = ctx.errorBox(e, 'noop'); }
  },
};
