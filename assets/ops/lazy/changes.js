/* Change log (/api/ops/changes): one timeline of everything that changed how the business behaves —
   deploys (with their commits), registry diffs, settings edits, kill switches, the global pause,
   template status, brain decisions, sub-events and manual sends. Grouped by Israel day, filtered by
   kind / actor / date, every entry opens a drawer with its details and, where the server says the
   change can be undone, a "שחזר" button behind a typed confirm (POST /api/ops/revert).
   Lazy module: app.js imports it only on #/changes (outside the counted JS budget). */
import { esc, fmtN, fmtDate, fmtTime, fmtDT, Skeleton, Button, Drawer, confirmTyped, toast, busy, DatePicker } from '../ui.js';

export const KIND_HE = { deploy: 'גרסה', registry: 'אוטומציות', edit: 'עריכה', hold: 'החזקה', toggle: 'מתג', pause: 'עצירה כללית', template: 'תבנית', brain: 'מוח', subevent: 'אירוע-בן', blast: 'שליחה ידנית', revert: 'שחזור' };
export const KIND_TONE = { deploy: 'info', registry: 'info', edit: 'warn', hold: 'serious', toggle: 'serious', pause: 'crit', template: '', brain: '', subevent: '', blast: 'warn', revert: 'good' };
export const ACTOR_HE = { Richard: 'ריצ׳רד', Claude: 'Claude', brain: 'המוח', system: 'מערכת' };
const HOW_HE = { toggle: 'החזרת המתג', edit: 'החזרת הערך הקודם', rollback: 'חזרה לגרסה הקודמת' };
const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const LS = 'ops:chg';
let opener = null;   /* the mounted screen's "open entry" (onArg runs on hash changes) */
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } };
const save = (s) => { try { localStorage.setItem(LS, JSON.stringify({ kinds: [...s.kinds], actor: s.actor })); } catch (e) { /* private mode */ } };
export const ilDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(iso));

/* client-side filter (the server filters too; this keeps chips instant on cached data) */
export function match(it, st) {
  if (st.kinds && st.kinds.size && !st.kinds.has(it.kind)) return false;
  if (st.actor && it.actor !== st.actor) return false;
  const d = ilDay(it.at);
  if (st.from && d < st.from) return false;
  if (st.to && d > st.to) return false;
  if (st.q && !(it.summary_he + ' ' + it.kind + ' ' + JSON.stringify(it.details || '')).toLowerCase().includes(st.q.toLowerCase())) return false;
  return true;
}
export function groupByDay(items) {
  const out = [];
  for (const it of items) { const d = ilDay(it.at); let g = out[out.length - 1]; if (!g || g.day !== d) out.push((g = { day: d, items: [] })); g.items.push(it); }
  return out;
}
const dayHe = (d, today) => (d === today ? 'היום' : 'יום ' + DOW[new Date(d + 'T12:00:00Z').getUTCDay()]) + ' · ' + fmtDate(d + 'T12:00:00Z');
const chip = (k) => `<span class="badge ${KIND_TONE[k] || ''}">${esc(KIND_HE[k] || k)}</span>`;

export function row(it) {
  const commits = it.kind === 'deploy' && it.details && Array.isArray(it.details.commits) ? it.details.commits : [];
  const sub = commits.length ? `<ul class="chg-commits">${commits.slice(0, 3).map((c) => `<li><span class="mono" dir="ltr">${esc(c.hash)}</span> ${esc(c.subject)}</li>`).join('')}${commits.length > 3 ? `<li class="muted">ועוד ${fmtN(commits.length - 3)}</li>` : ''}</ul>` : '';
  const state = it.reverted_at ? '<span class="badge">שוחזר</span>' : it.revert && it.revert.possible ? '<span class="sub">ניתן לשחזר</span>' : '';
  return `<li class="chg-row${it.reverted_at ? ' reverted' : ''}" data-chg="${esc(it.id)}" tabindex="0" role="button" aria-label="${esc(it.summary_he)}">
<time class="num" datetime="${esc(it.at)}" title="${esc(fmtDT(it.at))}">${esc(fmtTime(it.at))}</time><span class="chg-dot k-${esc(it.kind)}" aria-hidden="true"></span>
<div class="chg-m"><div class="chg-t">${chip(it.kind)}<span class="chg-s">${esc(it.summary_he)}</span></div><div class="sub">${esc(ACTOR_HE[it.actor] || it.actor)}${state ? ' · ' : ''}${state}</div>${sub}</div></li>`;
}
export function timeline(items, st, today = ilDay(new Date().toISOString())) {
  const shown = items.filter((x) => match(x, st));
  if (!shown.length) return `<div class="card empty">${items.length ? 'אין שינוי שמתאים לסינון' : 'עוד לא נרשם אף שינוי. כל עריכה, מתג, גרסה ושליחה ידנית מעכשיו יופיעו כאן.'}</div>`;
  return groupByDay(shown).map((g) => `<section class="card chg-day"><h2 class="h2">${esc(dayHe(g.day, today))} <span class="muted num">${fmtN(g.items.length)}</span></h2><ol class="chg-list">${g.items.map(row).join('')}</ol></section>`).join('');
}
export function toolbar(st, kinds = KIND_HE, counts = {}) {
  const actors = ['', 'Richard', 'Claude', 'brain', 'system'];
  return `<div class="card"><div class="sec-h" style="flex-wrap:wrap"><h2 class="h2">יומן שינויים</h2><span class="sub">כל מה ששינה את התנהגות המערכת: גרסאות, עריכות, מתגים, תבניות, החלטות מוח ושליחות ידניות</span></div>
<div class="cal-filters"><div class="chips" role="group" aria-label="סוג">${Object.keys(kinds).map((k) => `<button type="button" class="fchip" data-act="chg-k" data-k="${esc(k)}" aria-pressed="${st.kinds.has(k)}">${esc(kinds[k])}${counts[k] ? ` <span class="muted num">${fmtN(counts[k])}</span>` : ''}</button>`).join('')}</div></div>
<div class="cal-filters"><div class="seg" role="tablist" aria-label="מי">${actors.map((a) => `<button type="button" role="tab" data-act="chg-a" data-v="${esc(a)}" aria-selected="${(st.actor || '') === a}">${esc(a ? ACTOR_HE[a] : 'כולם')}</button>`).join('')}</div>
<span class="sub chg-date">מ-${DatePicker({ value: st.from || '', label: 'מתאריך', attr: { 'data-chg-date': 'from' } })}</span><span class="sub chg-date">עד${DatePicker({ value: st.to || '', label: 'עד תאריך', attr: { 'data-chg-date': 'to' } })}</span>
<input class="in" data-search placeholder="חיפוש: שם, הגדרה, קומיט" aria-label="חיפוש ביומן" value="${esc(st.q || '')}">${st.kinds.size || st.actor || st.from || st.to || st.q ? Button('ניקוי', { size: 'sm', variant: 'ghost', act: 'chg-clear' }) : ''}</div></div>`;
}
const val = (v) => (v == null ? '—' : typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : Object.values(v).join('–')) : String(v));
function kv(pairs) { return `<dl class="kv">${pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`; }
export function detail(it) {
  const d = it.details || {};
  let body = kv([['מתי', esc(fmtDT(it.at))], ['מי', esc(ACTOR_HE[it.actor] || it.actor)], ['סוג', chip(it.kind)], ['מזהה', `<span class="mono" dir="ltr">${esc(it.id)}</span>`]]);
  if (it.kind === 'deploy') {
    body += kv([['גרסה', `<span class="mono" dir="ltr">${esc(d.version_id)}</span>`], ['קומיט', `<span class="mono" dir="ltr">${esc(d.commit || '—')}</span>`], ['ענף', esc(d.branch || '—')], ['נבנה', esc(d.built_at ? fmtDT(d.built_at) : '—')], ['הערה', esc(d.note || '')], ['גרסה קודמת', d.previous_version_id ? `<span class="mono" dir="ltr">${esc(d.previous_version_id)}</span>` : '']]);
    const cs = Array.isArray(d.commits) ? d.commits : [];
    body += `<div><h3 class="h2">קומיטים מאז הגרסה הקודמת <span class="muted num">${fmtN(cs.length)}</span></h3>${cs.length ? `<ul class="chg-commits full">${cs.map((c) => `<li><span class="mono" dir="ltr">${esc(c.hash)}</span> ${esc(c.subject)}</li>`).join('')}</ul>` : '<p class="sub">לא נמסרה רשימת קומיטים (build-info.json ריק)</p>'}${d.commits_truncated ? '<p class="sub">הרשימה נחתכה ב-60</p>' : ''}</div>`;
    if (d.rollback_command) body += `<div><h3 class="h2">חזרה ידנית</h3><pre class="code" dir="ltr">${esc(d.rollback_command)}</pre></div>`;
  } else if (it.kind === 'registry') {
    const list = (t, xs, f = (x) => esc(x.name_he) + ` <span class="mono sub" dir="ltr">${esc(x.id)}</span>`) => (xs && xs.length ? `<div><h3 class="h2">${t} <span class="muted num">${fmtN(xs.length)}</span></h3><ul class="chg-commits full">${xs.map((x) => `<li><a href="#/automations/${esc(x.id)}">${f(x)}</a></li>`).join('')}</ul></div>` : '');
    body += d.baseline ? `<p class="sub">תמונת הבסיס הראשונה של הרישום (${fmtN(d.count)} אוטומציות). מכאן כל גרסה מושווית אליה.</p>` : list('נוספו', d.added) + list('הוסרו', d.removed) + list('שונו', d.changed, (x) => esc(x.name_he) + ` <span class="sub">(${esc((x.fields || []).join(', '))})</span>`);
  } else if ('from' in d || 'to' in d) {
    body += kv([['הגדרה', esc(d.setting || d.name || '')], ['שדה', esc(d.field ? String(d.field).slice(0, 8) : '')], ['לפני', `<b>${esc(val(d.from))}</b>`], ['אחרי', `<b>${esc(val(d.to))}</b>`], ['סיבה', esc(d.reason || '')], ['שחזור של', d.reverts ? `<span class="mono" dir="ltr">${esc(d.reverts)}</span>` : '']]);
  } else {
    body += `<pre class="code" dir="ltr">${esc(JSON.stringify(d, null, 1))}</pre>`;
  }
  if (it.reverted_at) body += `<p class="sub">שוחזר ${esc(fmtDT(it.reverted_at))}${it.reverted_by ? ` · <a href="#/changes/${esc(it.reverted_by)}" class="mono" dir="ltr">${esc(it.reverted_by)}</a>` : ''}</p>`;
  else if (it.revert && it.revert.possible) body += `<div class="acts">${Button('שחזר', { variant: 'danger', act: 'chg-revert', attr: { 'data-id': it.id } })}<span class="sub">${esc(HOW_HE[it.revert.how] || '')} · דורש הקלדת <span class="mono" dir="ltr">${esc(it.revert.confirm || '')}</span></span></div>`;
  return body;
}

export default {
  skeleton: () => Skeleton.card(4) + Skeleton.table(8),
  async mount(el, ctx) {
    const saved = load();
    const st = { kinds: new Set(Array.isArray(saved.kinds) ? saved.kinds : []), actor: saved.actor || '', from: '', to: '', q: '' };
    let data = null, items = [], pendingArg = null;
    const paint = () => {
      if (!data) return;
      const focus = document.activeElement && document.activeElement.matches('[data-search]');
      const counts = items.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {});
      el.innerHTML = toolbar(st, data.kinds || KIND_HE, counts) + timeline(items, st) + (data.next_cursor ? `<div style="text-align:center">${Button('עוד שינויים', { act: 'chg-more' })}</div>` : '');
      if (focus) { const s = el.querySelector('[data-search]'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    };
    const body = () => { const b = {}; if (st.from) b.from = st.from + 'T00:00:00+02:00'; if (st.to) b.to = st.to + 'T23:59:59+03:00'; return b; };
    const fetchAll = async () => {
      const key = body(), c = ctx.api.cached('changes', key);
      if (c && !data) { data = c.data; items = data.items || []; paint(); }
      try { data = await ctx.api.get('changes', key); items = data.items || []; } catch (e) { if (!data) { el.innerHTML = ctx.errorBox(e); return; } }
      paint();
      if (pendingArg) { const a = pendingArg; pendingArg = null; openEntry(a); }
    };
    const openEntry = (id) => {
      const it = items.find((x) => x.id === id);
      if (!it) { if (!data) pendingArg = id; return; }
      Drawer.open(it.summary_he.slice(0, 60), detail(it), { onClose: () => { if (location.hash.startsWith('#/changes/')) history.replaceState(null, '', '#/changes'); } });
    };
    opener = openEntry; ctx.onDispose(() => { opener = null; });
    const doRevert = async (id, btn) => {
      const it = items.find((x) => x.id === id); if (!it || !it.revert || !it.revert.possible) return;
      const pre = await ctx.api.post('revert', { id }).catch((e) => { toast('השרת סירב: ' + e.message, 'crit'); return null; });
      if (!pre) return;
      const word = pre.confirm_required || it.revert.confirm;
      const p = pre.preview || {};
      const what = it.revert.how === 'rollback' ? `הוורקר יחזור לגרסה <b class="mono" dir="ltr">${esc(String(p.version_id || '').slice(0, 8))}</b>.${p.api ? '' : ' אין CF_API_TOKEN בוורקר: יוצג הפקודה להרצה במחשב.'}`
        : it.revert.how === 'edit' ? `${esc(p.setting || '')} יחזור ל-<b>${esc(val(p.back_to))}</b>.` : p.pause !== undefined ? (p.pause ? 'כל השליחות יושהו שוב.' : 'העצירה הכללית תבוטל.') : `${esc(p.switch || '')} ${p.enabled ? 'יופעל' : 'יכובה'} שוב.`;
      const ok = await confirmTyped({ title: 'שחזור שינוי', body: `<p>${esc(it.summary_he)}</p><p>${what}</p>`, word, action: 'שחזר' });
      if (!ok) return;
      await busy(btn, async () => {
        const r = await ctx.api.post('revert', { id, confirm: word, who: 'richard' });
        if (r.applied) { toast('שוחזר', 'good'); Drawer.close(); await fetchAll(); }
        else if (r.manual) { const b = Drawer.body(); if (b) b.insertAdjacentHTML('beforeend', `<div class="errbox" role="status"><span style="flex:1">${esc(r.he || 'להריץ במחשב:')}</span></div><pre class="code" dir="ltr">${esc(r.command || '')}</pre>`); }
        else toast(r.he || 'לא שוחזר', 'warn');
        return r;
      }).catch(() => {});
    };
    ctx.on(el, 'click', (e) => {
      const a = e.target.closest('[data-act]');
      if (a) {
        const act = a.dataset.act;
        if (act === 'chg-k') { const k = a.dataset.k; if (st.kinds.has(k)) st.kinds.delete(k); else st.kinds.add(k); save(st); paint(); return; }
        if (act === 'chg-a') { st.actor = a.dataset.v; save(st); paint(); return; }
        if (act === 'chg-clear') { st.kinds.clear(); st.actor = ''; st.from = ''; st.to = ''; st.q = ''; save(st); fetchAll(); return; }
        if (act === 'chg-more' && data && data.next_cursor) { busy(a, async () => { const more = await ctx.api.get('changes', { ...body(), cursor: data.next_cursor }, { cache: false }); items = items.concat(more.items || []); data = { ...data, next_cursor: more.next_cursor }; paint(); }).catch(() => {}); return; }
        return;
      }
      const r = e.target.closest('[data-chg]'); if (r) { ctx.nav('changes/' + r.dataset.chg); }
    });
    ctx.on(el, 'keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-chg]')) { e.preventDefault(); e.target.click(); } });
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { st.q = e.target.value; paint(); } });
    ctx.on(el, 'change', (e) => { const k = e.target.dataset && e.target.dataset.chgDate; if (k) { st[k] = e.target.value; fetchAll(); } });
    const onDrawer = (e) => { const b = e.target.closest('.drawer [data-act=chg-revert]'); if (b) doRevert(b.dataset.id, b); };
    document.addEventListener('click', onDrawer); ctx.onDispose(() => document.removeEventListener('click', onDrawer));
    await fetchAll();
    ctx.poll(fetchAll, 60000);
  },
  onArg(arg) { if (!arg) { Drawer.close(); return; } if (opener) opener(arg); },
};
