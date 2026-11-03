/* Live log: 3 s poll with a since-cursor, filters by kind / number / event, pauses on hover.
   feed() is reused by the side panel in the shell. */
import { esc, fmtTimeS, liveClock, Select, Button, Skeleton, icon, Toggle, Phone, EventLink } from '../ui.js';

export const KIND_HE = { run: 'ריצה', wa_out: 'נשלח', wa_status: 'סטטוס', wa_in: 'נכנס', call: 'שיחה', cron: 'ריצה', admin: 'אדמין', slack: 'סלאק', pay: 'תשלום', lead: 'ליד', event: 'אירוע', system: 'מערכת', brain: 'מוח' };
export const isAdminView = (x) => x.kind === 'admin' && /^דפדפן\s*·/.test(x.action || x.msg || '');
const ST_OK = (x) => (x.ok === false || x.level === 'error' ? '<span class="badge crit">✕ נכשל</span>' : x.level === 'warn' ? '<span class="badge warn">! חלקי</span>' : '');
export const row = (x, fresh = false) => {
  /* the preview comes from the adapter's msg (already masked; private kinds carry no detail) */
  const msg = x.msg || '', act = x.type === 'audit' && x.action ? x.action : '', head = act && msg.startsWith(act) ? act : msg;
  const pv = act && msg.startsWith(act + ' · ') ? (msg.slice(act.length + 3).split('\n').find((l) => l.trim()) || '') : '';
  return `<div class="feed-row${x.level === 'error' ? ' err' : x.level === 'warn' ? ' warn' : ''}${fresh ? ' new' : ''}" data-id="${esc(x.id)}"><time datetime="${esc(x.at)}" class="num">${esc(fmtTimeS(x.at))}</time><span class="fh"><span class="badge">${esc(KIND_HE[x.kind] || x.kind)}</span>${x.number ? `<span class="sub">${esc(x.number)}</span>` : ''}${x.phone ? Phone(x.phone, { icons: false }) : ''}${x.event ? ` <span class="sub">· ${EventLink(x.event_name || x.event, x.event)}</span>` : ''}${x.template ? ` <span class="sub mono" dir="ltr">${esc(x.template)}</span>` : ''}${x.cost != null ? ` <span class="sub num">₪${esc(x.cost)}</span>` : ''}${ST_OK(x)}</span><span class="m">${esc(head)}</span>${pv ? `<span class="pv">${esc(pv)}</span>` : ''}</div>`;
};
export const match = (x, f) => (f.admin || !isAdminView(x)) && (!f.kind || x.kind === f.kind) && (!f.number || x.number === f.number) && (!f.q || ((x.event || '') + ' ' + x.msg).includes(f.q));

/* never re-render the whole column on poll: new rows are inserted on top (200 ms, reduced-motion aware),
   scroll position is kept, the list is capped. Filters / pause-resume do a full paint. */
export function feed(el, { compact = false, filters = {}, onCount } = {}) {
  let items = [], cursor = null, timer = 0, paused = false, hover = false, dead = false, buffered = 0;
  const f = filters, CAP = compact ? 80 : 500;
  el.classList.add('feed');
  if (!compact) el.innerHTML = Skeleton.lines(8);
  const vis = () => items.filter((x) => match(x, f)).slice(0, CAP);
  const count = () => { if (onCount) onCount(el.querySelectorAll('.feed-row').length, buffered, paused || hover); };
  const paint = () => { const v = vis(); el.innerHTML = v.map((x) => row(x)).join('') || '<div class="empty">אין אירועים שמתאימים</div>'; count(); };
  const insert = (fresh) => {
    const add = fresh.filter((x) => match(x, f) && !el.querySelector(`[data-id="${CSS.escape(x.id)}"]`)).sort((a, b) => b.ts - a.ts);
    if (!add.length) return;
    if (el.querySelector('.empty,.sk')) return paint();
    const top = el.scrollTop, h0 = el.scrollHeight;
    el.insertAdjacentHTML('afterbegin', add.map((x) => row(x, true)).join(''));
    const rows = el.querySelectorAll('.feed-row'); for (let i = rows.length - 1; i >= CAP; i--) rows[i].remove();
    if (top > 0) el.scrollTop = top + (el.scrollHeight - h0);
    count();
  };
  const tick = async () => {
    if (dead) return;
    if (!document.hidden) {
      try {
        const r = await api('live', cursor != null ? { since: cursor } : {});
        cursor = r.cursor;
        if (r.items && r.items.length) {
          const seen = new Set(items.map((x) => x.id)), fresh = r.items.filter((x) => !seen.has(x.id));
          items = fresh.concat(items).sort((a, b) => b.ts - a.ts).slice(0, 1000);
          if (paused || hover) { buffered += fresh.length; if (onCount) onCount(null, buffered, true); } else if (!el.querySelector('.feed-row')) paint(); else insert(fresh);
        } else if (!el.children.length || el.querySelector('.sk')) paint();
      } catch (e) { if (!items.length) el.innerHTML = `<div class="errbox" style="margin:10px">${esc(e.message)}</div>`; }
    }
    if (!dead) timer = setTimeout(tick, 3000);
  };
  let api = null;
  el.addEventListener('pointerenter', () => { hover = true; el.classList.add('paused'); });
  el.addEventListener('pointerleave', () => { hover = false; el.classList.remove('paused'); if (!paused && buffered) { buffered = 0; paint(); } });
  return {
    start(apiImpl) { api = apiImpl; tick(); },
    stop() { dead = true; clearTimeout(timer); },
    setPaused(p) { paused = p; if (!p) { buffered = 0; paint(); } },
    get paused() { return paused; },
    refilter() { paint(); },
  };
}

export default {
  skeleton: () => Skeleton.table(12),
  async mount(el, ctx) {
    let adm = false; try { adm = localStorage.getItem('ops:live:admin') === '1'; } catch (e) { /* private mode */ }
    const f = { kind: '', number: '', q: '', admin: adm };
    el.innerHTML = `<div class="bar">${Select({ name: 'kind', value: '', options: [{ value: '', label: 'כל הסוגים' }, ...Object.entries(KIND_HE).map(([value, label]) => ({ value, label }))] })}
${Select({ name: 'number', value: '', options: [{ value: '', label: 'כל האזורים' }, { value: 'שיר', label: 'שיר · אורחים' }, { value: 'נועה', label: 'נועה · לקוחות' }, { value: 'שיחות', label: 'שיחות' }, { value: 'וורקר', label: 'וורקר' }, { value: 'אדמין', label: 'אדמין' }] })}
<div class="search">${icon('search')}<input class="in" data-search placeholder="אירוע או טקסט" aria-label="סינון לפי אירוע"></div>
${Button(icon('pause') + '<span>להשהות</span>', { act: 'live-pause', kbd: 'p' })}${Toggle({ id: 'lv-admin', on: adm, label: 'הצג פעילות אדמין', act: 'lv-admin' })}<span class="sp" style="flex:1"></span><span class="sub" id="lv-st" aria-live="polite"></span><span class="clock num mono" id="lv-clock" aria-label="שעון זמן אמת" style="margin-inline-start:12px;font-variant-numeric:tabular-nums"></span></div>
<div class="card flush"><div id="lv-feed" style="max-height:calc(100dvh - 190px);overflow-y:auto"></div></div>`;
    const st = el.querySelector('#lv-st');
    liveClock(el.querySelector('#lv-clock'));
    const fd = feed(el.querySelector('#lv-feed'), { filters: f, onCount: (n, buf, p) => { st.textContent = p ? (buf ? `מושהה · ${buf} חדשים מחכים` : 'מושהה') : `${n} שורות · מתעדכן כל 3 שניות`; } });
    fd.start((n, b) => ctx.api.get(n, b, { cache: false }));
    const btn = el.querySelector('[data-act=live-pause]');
    const setP = (p) => { fd.setPaused(p); btn.innerHTML = (p ? icon('play') + '<span>להמשיך</span>' : icon('pause') + '<span>להשהות</span>') + ' <span class="kbd">p</span>'; };
    ctx.on(el, 'click', (e) => { if (e.target.closest('[data-act=live-pause]')) setP(!fd.paused); const t = e.target.closest('[data-act=lv-admin]'); if (t) { f.admin = !f.admin; t.setAttribute('aria-checked', String(f.admin)); try { localStorage.setItem('ops:live:admin', f.admin ? '1' : '0'); } catch (x) { /* private mode */ } fd.refilter(); } });
    ctx.on(document, 'ops:pause-live', () => setP(!fd.paused));
    ctx.on(el, 'ops:change', (e) => { f[e.detail.name] = e.detail.value; fd.refilter(); });
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { f.q = e.target.value.trim(); fd.refilter(); } });
    ctx.onDispose(() => fd.stop());
  },
};
