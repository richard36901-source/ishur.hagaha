/* Live log: 3 s poll with a since-cursor, filters by kind / number / event, pauses on hover.
   feed() is reused by the side panel in the shell. */
import { esc, fmtTime, Select, Button, Skeleton, icon } from '../ui.js';

export const KIND_HE = { run: 'ריצה', wa_out: 'נשלח', wa_status: 'סטטוס', wa_in: 'נכנס', call: 'שיחה', cron: 'ריצה', admin: 'אדמין', slack: 'סלאק', pay: 'תשלום', lead: 'ליד', event: 'אירוע', system: 'מערכת', brain: 'מוח' };
export const row = (x) => `<div class="feed-row${x.level === 'error' ? ' err' : x.level === 'warn' ? ' warn' : ''}" data-id="${esc(x.id)}"><time datetime="${esc(x.at)}">${esc(fmtTime(x.at))}</time><span><span class="badge">${esc(KIND_HE[x.kind] || x.kind)}</span>${x.number ? ` <span class="sub mono">${esc(x.number)}</span>` : ''}${x.event ? ` <span class="sub">${esc(x.event)}</span>` : ''}</span><span class="m">${esc(x.msg)}</span></div>`;
export const match = (x, f) => (!f.kind || x.kind === f.kind) && (!f.number || x.number === f.number) && (!f.q || ((x.event || '') + ' ' + x.msg).includes(f.q));

export function feed(el, { compact = false, filters = {}, onCount } = {}) {
  let items = [], cursor = null, timer = 0, paused = false, hover = false, dead = false, buffered = 0;
  const f = filters;
  el.classList.add('feed');
  if (!compact) el.innerHTML = Skeleton.lines(8);
  const paint = () => {
    const vis = items.filter((x) => match(x, f)).slice(0, compact ? 80 : 500);
    el.innerHTML = vis.map(row).join('') || '<div class="empty">אין אירועים שמתאימים</div>';
    if (onCount) onCount(vis.length, buffered, paused || hover);
  };
  const tick = async () => {
    if (dead) return;
    if (!document.hidden) {
      try {
        const r = await api('live', cursor != null ? { since: cursor } : {});
        cursor = r.cursor;
        if (r.items && r.items.length) {
          const seen = new Set(items.map((x) => x.id));
          items = r.items.filter((x) => !seen.has(x.id)).concat(items).sort((a, b) => b.ts - a.ts).slice(0, 1000);
          if (paused || hover) { buffered += r.items.length; if (onCount) onCount(null, buffered, true); } else paint();
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
    const f = { kind: '', number: '', q: '' };
    el.innerHTML = `<div class="bar">${Select({ name: 'kind', value: '', options: [{ value: '', label: 'כל הסוגים' }, ...Object.entries(KIND_HE).map(([value, label]) => ({ value, label }))] })}
${Select({ name: 'number', value: '', options: [{ value: '', label: 'כל האזורים' }, { value: 'שיר', label: 'שיר · אורחים' }, { value: 'נועה', label: 'נועה · לקוחות' }, { value: 'שיחות', label: 'שיחות' }, { value: 'וורקר', label: 'וורקר' }, { value: 'אדמין', label: 'אדמין' }] })}
<div class="search">${icon('search')}<input class="in" data-search placeholder="אירוע או טקסט" aria-label="סינון לפי אירוע"></div>
${Button(icon('pause') + '<span>להשהות</span>', { act: 'live-pause', kbd: 'p' })}<span class="sp" style="flex:1"></span><span class="sub" id="lv-st" aria-live="polite"></span></div>
<div class="card flush"><div id="lv-feed" style="max-height:calc(100dvh - 190px);overflow-y:auto"></div></div>`;
    const st = el.querySelector('#lv-st');
    const fd = feed(el.querySelector('#lv-feed'), { filters: f, onCount: (n, buf, p) => { st.textContent = p ? (buf ? `מושהה · ${buf} חדשים מחכים` : 'מושהה') : `${n} שורות · מתעדכן כל 3 שניות`; } });
    fd.start((n, b) => ctx.api.get(n, b, { cache: false }));
    const btn = el.querySelector('[data-act=live-pause]');
    const setP = (p) => { fd.setPaused(p); btn.innerHTML = (p ? icon('play') + '<span>להמשיך</span>' : icon('pause') + '<span>להשהות</span>') + ' <span class="kbd">p</span>'; };
    ctx.on(el, 'click', (e) => { if (e.target.closest('[data-act=live-pause]')) setP(!fd.paused); });
    ctx.on(document, 'ops:pause-live', () => setP(!fd.paused));
    ctx.on(el, 'ops:change', (e) => { f[e.detail.name] = e.detail.value; fd.refilter(); });
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { f.q = e.target.value.trim(); fd.refilter(); } });
    ctx.onDispose(() => fd.stop());
  },
};
