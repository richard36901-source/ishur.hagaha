/* ishur ops · לקוחות: table with status chips, guest counts, plan, date, paid, add-on icons;
   client drawer: in-place edit, links, add-ons, timeline, notes; actions → crm/clients/:token/action, typed confirm. */
import { esc, fmtN, Table, Tabs, Skeleton, Drawer, Button, icon, toast, confirmTyped, Phone, DatePicker, Select } from '../ui.js';
import { crm, adaptCrm, CLIENT_ST, OCC_HE } from './adapt.js';
import { money, dayHe, phoneHe, contactBtns, notesBlock, timeline, bindNotes, actionBar } from './kit.js';

export const chip = (c) => `<span class="badge ${c.status_tone}">${esc(c.status_he)}</span>`;
export const addonIcons = (a) => [a.design ? `<span class="ai" data-tip="עיצוב הזמנה · ${esc(a.design_he)}" aria-label="עיצוב הזמנה">🎨</span>` : '', a.hostesses ? `<span class="ai" data-tip="${a.hostesses} דיילות" aria-label="${a.hostesses} דיילות">👤${a.hostesses > 1 ? '<sub>' + a.hostesses + '</sub>' : ''}</span>` : '', a.calls ? '<span class="ai" data-tip="שיחות AI" aria-label="שיחות AI">📞</span>' : '', a.extra_wave ? '<span class="ai" data-tip="גל תזכורת נוסף" aria-label="גל תזכורת נוסף">➕</span>' : ''].join('') || '<span class="muted">—</span>';
const pct = (c) => (c.guests ? Math.round(((c.confirmed + c.declined) / c.guests) * 100) : 0);
export const COLS = [
  { label: 'לקוח', sort: (c) => c.name, render: (c) => `<b dir="auto">${esc(c.name)}</b><div class="sub">${esc(c.occasion_he)}</div>` },
  { label: 'טלפון', hideM: true, sort: (c) => c.phone, render: (c) => Phone(c.phone, { name: c.name }) },
  { label: 'מצב', sort: (c) => c.status_he, render: chip },
  { label: 'תאריך', sort: (c) => c.event_date || '9999', render: (c) => `<span class="num">${esc(dayHe(c.event_date))}</span>` },
  { label: 'אישורים', sort: (c) => pct(c), render: (c) => `<span class="num">${fmtN(c.confirmed)}</span><span class="muted num"> / ${fmtN(c.guests)}</span><div class="meter" style="margin-top:4px" aria-hidden="true"><i style="width:${pct(c)}%"></i></div>` },
  { label: 'חבילה', hideM: true, sort: (c) => c.records, render: (c) => esc(c.plan_he) + ` <span class="muted num">${fmtN(c.records)}</span>` },
  { label: 'שולם', num: true, hideM: true, sort: (c) => c.paid, render: (c) => money(c.paid) },
  { label: 'תוספות', hideM: true, sort: (c) => Object.values(c.addons || {}).filter(Boolean).length, render: (c) => addonIcons(c.addons) },
];
export const FILTERS = [{ value: 'open', label: 'פעילים' }, { value: 'upcoming', label: '14 יום קרובים' }, { value: 'hold', label: 'מוחזקים' }, { value: 'done', label: 'הסתיימו' }, { value: '', label: 'הכל' }];
export function pick(cs, st, q, now = Date.now()) {
  return cs.filter((c) => (!st || (st === 'open' ? !['done', 'cancelled'].includes(c.status) : st === 'upcoming' ? c.event_date && Date.parse(c.event_date) - now < 14 * 864e5 && Date.parse(c.event_date) >= now - 864e5 : c.status === st))
    && (!q || (c.name + ' ' + c.phone + ' ' + phoneHe(c.phone) + ' ' + c.tok8 + ' ' + c.venue).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => String(a.event_date).localeCompare(String(b.event_date)));
}
export const listView = (cs) => Table({ id: 'clients', columns: COLS, rows: cs, rowKey: (c) => c.token, empty: 'אין לקוחות שמתאימים' });
export function summary(cs) {
  const open = cs.filter((c) => !['done', 'cancelled'].includes(c.status));
  return `<div class="grid g-tiles">${[['לקוחות פעילים', fmtN(open.length)], ['אורחים במעקב', fmtN(open.reduce((s, c) => s + c.guests, 0))], ['אישרו', fmtN(open.reduce((s, c) => s + c.confirmed, 0))], ['הכנסות (כל הרשימה)', money(cs.reduce((s, c) => s + c.paid, 0))]].map(([l, v]) => `<div class="tile"><span class="l">${esc(l)}</span><span class="v">${v}</span></div>`).join('')}</div>`;
}

/* phone in, IL mobile out (972…); null when it is not a valid Israeli number */
export const normPhone = (p) => { let d = String(p || '').replace(/\D/g, ''); if (/^0\d{9}$/.test(d)) d = '972' + d.slice(1); return /^9725\d{8}$|^972[2-9]\d{7,8}$/.test(d) ? d : null; };
const OCC_OPTS = Object.entries(OCC_HE).map(([value, label]) => ({ value, label }));
export function editBlock(c) {
  return `<section class="crm-sec" aria-label="פרטי האירוע" id="cl-edit"><div class="sec-h"><h3 class="h2">פרטי האירוע</h3><span class="sp"></span><span class="sub">נשמר ונרשם ביומן השינויים</span></div>
<div class="grid2"><div class="f-row"><label class="f-l" for="cl-n1">שם המארח/ת</label><input id="cl-n1" class="in" data-ce="name1" dir="auto" value="${esc(c.name1 || c.name)}"></div>
<div class="f-row"><label class="f-l" for="cl-n2">שם נוסף (בן/בת הזוג)</label><input id="cl-n2" class="in" data-ce="name2" dir="auto" value="${esc(c.name2 || '')}"></div>
<div class="f-row"><label class="f-l" for="cl-ph">טלפון</label><input id="cl-ph" class="in num" data-ce="phone" dir="ltr" inputmode="tel" value="${esc(c.phone ? '0' + String(c.phone).replace(/\D/g, '').replace(/^972/, '') : '')}"><span class="sub" data-ce-err="phone"></span></div>
<div class="f-row"><span class="f-l">סוג האירוע</span><div class="f-v">${Select({ name: 'cl_occ', value: c.occasion || OCC_OPTS[0].value, options: OCC_OPTS })}</div></div>
<div class="f-row"><span class="f-l">תאריך האירוע</span><div class="f-v">${DatePicker({ value: c.event_date || '', label: 'תאריך האירוע', attr: { 'data-ce': 'date' } })}</div></div>
<div class="f-row" style="justify-content:flex-end"><span class="f-l">&nbsp;</span>${Button('שמירת הפרטים', { variant: 'tint', act: 'cl-save' })}</div></div></section>`;
}
export function drawerView(d) {
  const c = d.client, a = c.addons;
  const link = (h, label) => (h ? `<span class="link-box"><a href="${esc(h)}" target="_blank" rel="noopener">${esc(label)} ${icon('ext')}</a><span class="sp" style="flex:1"></span>${Button(icon('copy') + '<span>העתקה</span>', { size: 'sm', variant: 'ghost', act: 'cl-copy', attr: { 'data-url': h } })}</span>` : '');
  const A = (act, label, v = '') => Button(label, { act, variant: v });
  return `<header class="crm-head"><div><div class="bar">${chip(c)}<span class="chip">${esc(c.occasion_he)}</span><span class="sub mono" dir="ltr">${esc(c.tok8)}</span></div>
<p class="sub">${esc([dayHe(c.event_date) + (c.event_time ? ' ' + c.event_time : ''), c.venue, c.plan_he + ' עד ' + c.records + ' רשומות', 'שולם ' + money(c.paid)].filter(Boolean).join(' · '))}</p><p style="margin:6px 0 0">${Phone(c.phone, { name: c.name, icons: false })}</p></div><div class="bar">${contactBtns(c.phone)}</div></header>
<section class="grid g-tiles crm-counts">${[['אורחים', c.guests], ['אישרו', c.confirmed], ['לא מגיעים', c.declined], ['ממתינים', c.pending]].map(([l, v]) => `<div class="tile sm"><span class="l">${l}</span><span class="v num">${fmtN(v)}</span></div>`).join('')}</section>
${editBlock(c)}
<section class="crm-sec" aria-label="קישורים"><h3 class="h2">קישורים</h3><div style="display:grid;gap:6px">${link(c.links.dashboard, 'לוח הלקוח')}${link(c.links.upload, 'העלאת רשימה')}${link(c.links.feedback, 'משוב')}</div><div class="bar">${A('cl-send-dash', 'שליחת לוח הלקוח בוואטסאפ')}${A('cl-send-upload', 'שליחת קישור העלאה')}${c.lead_id ? `<a class="btn ghost" href="#/leads/${esc(c.lead_id)}">הליד המקורי</a>` : ''}</div></section>
<section class="crm-sec" aria-label="תוספות"><h3 class="h2">תוספות</h3><dl class="kv">
<dt>עיצוב הזמנה</dt><dd>${a.design ? `<span class="badge ${a.design === 'approved' ? 'good' : 'warn'}">${esc(a.design_he)}</span>` : '<span class="muted">לא נרכש</span>'}</dd>
<dt>דיילות</dt><dd>${a.hostesses ? fmtN(a.hostesses) + ` · <a href="#/hostesses">שיבוץ</a>` : '<span class="muted">אין</span>'}</dd>
<dt>שיחות AI</dt><dd>${a.calls ? 'כלול' : '<span class="muted">לא</span>'}</dd><dt>גל תזכורת נוסף</dt><dd>${a.extra_wave ? 'כן' : '<span class="muted">לא</span>'}</dd></dl></section>
<section class="crm-sec" aria-label="פעולות"><h3 class="h2">פעולות</h3>
<p class="acts-h">שליחות</p><div class="acts-g">${A('cl-hold', c.flags.hold ? 'שחרור מ-hold' : 'השהיית שליחות (hold)', c.flags.hold ? '' : 'danger')}${A('cl-extra', 'שליחה נוספת')}${A('cl-cancel', 'ביטול האירוע', 'danger')}</div>
<p class="acts-h">תוספות וחבילה</p><div class="acts-g">${A('cl-host', 'הוספת דיילת')}${Button('הענקת עיצוב', { act: 'cl-addon', attr: { 'data-kind': 'design' } })}${Button('הענקת שיחות AI', { act: 'cl-addon', attr: { 'data-kind': 'calls' } })}${Button('הענקת גל נוסף', { act: 'cl-addon', attr: { 'data-kind': 'extrasend' } })}${A('cl-design', 'העלאת גרסת עיצוב')}</div>
<p class="acts-h">חשבון</p><div class="acts-g">${A('cl-paid', c.flags.paid ? 'הסרת סימון שולם' : 'סימון כשולם')}${A('cl-active', c.flags.active ? 'סימון לא פעיל' : 'סימון פעיל')}${c.invoice ? `<a class="btn" data-act="cl-invoice-view" href="${esc(c.invoice)}" target="_blank" rel="noopener">צפייה בחשבונית ${icon('ext')}</a>${A('cl-invoice', 'שליחת החשבונית שוב')}` : '<span class="sub">אין חשבונית</span>'}</div>
<div class="danger-zone" style="margin-top:6px"><div class="bar"><span style="flex:1"><b>איפוס רשימת האורחים</b><br><span class="sub">מוחק את הרשימה שהועלתה כדי שהלקוח יעלה מחדש</span></span>${A('cl-reset', 'איפוס אורחים', 'danger')}</div></div></section>
<div id="cl-notes">${notesBlock(d.notes)}</div>
<section class="crm-sec" aria-label="ציר זמן"><h3 class="h2">ציר זמן</h3>${timeline([...d.timeline, ...d.notes.map((n) => ({ id: n.id, at: n.at, kind: 'note', dir: 'out', label: 'הערה · ' + n.by, text: n.text }))].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)))}</section>
${actionBar(`${contactBtns(c.phone, 'grow')}${c.links.dashboard ? `<a class="btn primary grow" href="${esc(c.links.dashboard)}" target="_blank" rel="noopener">לוח הלקוח</a>` : ''}`)}`;
}

/* button → [action, extra]. The server owns the confirm copy + word (call without confirm = preview), see crm.js CLIENT_ACTIONS */
export const ACTIONS = {
  'cl-send-dash': ['send_dashboard'], 'cl-send-upload': ['send_upload'], 'cl-hold': ['hold', (c) => ({ on: !c.flags.hold })],
  'cl-cancel': ['cancel', () => ({ on: true })], 'cl-extra': ['extra_send', () => ({ on: true })], 'cl-host': ['add_hostess', () => ({ n: 1 })],
  'cl-addon': ['grant_addon', (c, x) => ({ kind: x.dataset.kind })], 'cl-paid': ['mark_paid', (c) => ({ on: !c.flags.paid })],
  'cl-active': ['toggle_active', (c) => ({ on: !c.flags.active })], 'cl-invoice': ['invoice_resend'], 'cl-reset': ['reset_guests'], 'cl-design': ['design_upload'],
};
const pickFile = () => new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*,application/pdf'; i.addEventListener('change', () => res(i.files && i.files[0] ? i.files[0] : null), { once: true }); i.click(); });

export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.table(10),
  async mount(el, ctx) {
    const api = crm(ctx), cached = api.cachedView('clients');
    let cs = cached ? cached.items : [], st = 'open', q = '';
    el.innerHTML = `<div id="cl-sum">${Skeleton.tiles(4)}</div><div class="bar"><div class="search">${icon('search')}<input class="in" data-search placeholder="חיפוש שם, טלפון, אולם" aria-label="חיפוש לקוחות"></div>${Tabs({ name: 'cl_st', value: st, items: FILTERS })}<span class="sp" style="flex:1"></span><span class="sub num" id="cl-count"></span></div><div class="card flush" id="cl-list">${Skeleton.table(10)}</div>`;
    const paint = () => { const xs = pick(cs, st, q); el.querySelector('#cl-sum').innerHTML = summary(cs); el.querySelector('#cl-list').innerHTML = listView(xs); el.querySelector('#cl-count').textContent = fmtN(xs.length) + ' לקוחות'; };
    const load = async () => { try { cs = (await api.clients()).items; paint(); } catch (e) { el.querySelector('#cl-list').innerHTML = ctx.errorBox(e, 'cl-retry'); } };
    this.reload = load;
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { q = e.target.value.trim(); paint(); } });
    ctx.on(el, 'ops:change', (e) => { if (e.detail.name === 'cl_st') { st = e.detail.value; paint(); } });
    ctx.on(el, 'click', (e) => { if (e.target.closest('[data-act=cl-retry]')) return load(); const r = e.target.closest('tr[data-row]'); if (r && !e.target.closest('.ph')) ctx.nav('clients/' + r.dataset.row); });
    if (cs.length) paint();
    await load();
    ctx.poll(() => (Drawer.el ? null : load()), 60000);
  },
  async onArg(token, ctx) {
    token = String(token || '');
    if (!token) { Drawer.close(); return; }
    const api = crm(ctx), self = this;
    if (/^[0-9a-f]{8}$/i.test(token)) { try { const hit = (await api.clients()).items.find((c) => c.tok8 === token || String(c.token).startsWith(token)); if (hit) token = hit.token; } catch (e) { /* the card still tries the short token */ } }
    const b = Drawer.open('לקוח', Skeleton.lines(10), { modal: true, onClose: () => { if (location.hash.startsWith('#/clients/')) history.replaceState(null, '', '#/clients'); self.reload && self.reload(); } });
    Drawer.el.classList.add('crm-drawer');
    let d;
    const paint = async () => { d = await api.client(token); if (Drawer.body() !== b) return; Drawer.el.querySelector('.drawer-h h2').textContent = d.client.name; b.innerHTML = drawerView(d); };
    bindNotes(b, api, 'client', token, paint);
    let occ = null;
    b.addEventListener('ops:change', (e) => { if (e.detail.name === 'cl_occ') occ = e.detail.value; });
    b.addEventListener('click', async (e) => {
      const x = e.target.closest('[data-act]');
      if (x && x.dataset.act === 'cl-copy') { try { await navigator.clipboard.writeText(x.dataset.url); toast('הקישור הועתק'); } catch (er) { toast('ההעתקה נחסמה בדפדפן', 'crit'); } return; }
      if (x && x.dataset.act === 'cl-save') {
        const v = (k) => (b.querySelector(`[data-ce="${k}"]`) || {}).value || '', c = d.client, ph = v('phone').trim(), n = normPhone(ph);
        const err = b.querySelector('[data-ce-err=phone]'); err.textContent = ph && !n ? 'מספר לא תקין (לדוגמה 050-1234567)' : '';
        if (ph && !n) return;
        const patch = { name1: v('name1').trim(), name2: v('name2').trim(), phone: n || undefined, occasion: occ || c.occasion || undefined, date: v('date').slice(0, 10) || undefined };
        const save = async (p) => { const r = await api.clientUpdate(token, p); toast(r.unchanged ? 'לא השתנה כלום' : 'נשמר: ' + (r.changed || []).length + ' שדות, נרשם ביומן השינויים'); await paint(); };
        try { await save(patch); } catch (er) {
          /* a past date needs an explicit admin override */
          if (er.code === 'date-in-past' && (await confirmTyped({ title: 'התאריך כבר עבר. לשמור בכל זאת?', body: '<p>לתיקון רישום של אירוע שעבר.</p>', word: 'עבר', action: 'שמירה', danger: true }))) { try { await save({ ...patch, override_past: true }); } catch (e2) { toast('לא נשמר: ' + e2.message, 'crit'); } return; }
          toast('לא נשמר' + (er.message ? ': ' + er.message : ''), 'crit');
        }
        return;
      }
      const A = x && ACTIONS[x.dataset.act]; if (!A) return;
      const [action, ex] = A, extra = ex ? ex(d.client, x) : {};
      try {
        const file = action === 'design_upload' ? await pickFile() : null;
        if (action === 'design_upload' && !file) return;
        const p = await api.clientPreview(token, action, extra);
        if (!(await confirmTyped({ title: p.title, body: `<p>${esc(p.body)}</p>${file ? `<p class="sub" dir="auto">${esc(file.name)}</p>` : ''}`, word: p.confirm_required, action: 'אישור', danger: p.danger !== false }))) return;
        if (file) extra.media = await api.uploadDesign(token, file);
        const r = await api.clientAction(token, action, { ...extra, confirm: p.confirm_required });
        toast(r.summary || 'בוצע'); await paint();
      } catch (er) { toast('לא בוצע' + (er.message ? ': ' + er.message : ''), 'crit'); }
    });
    try { await paint(); } catch (e) { b.innerHTML = ctx.errorBox(e, 'noop'); }
  },
};
