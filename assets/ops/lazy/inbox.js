/* אינבוקס (Phase 4a, port of inbox.html): conversations from Noa 4499 + both Shir numbers, grouped by phone,
   unread first, lead/client/guest badge + event. Thread: bubbles with time + status, media download, the
   per-chat takeover switch (/api/human), links to the lead/client card. Reply: free text inside the 24 h
   window (/api/wa-send), outside it a template chooser. EVERY send needs the typed word "שלח" (Richard's rule);
   nothing here sends on its own. Quiet hours 21:00–09:00 block sends to clients/leads. */
import { esc, fmtTime, fmtDT, Tabs, Skeleton, Button, Toggle, Select, confirmTyped, toast, busy } from '../ui.js';
import { fmtPhone, roleBadge, quietHours, errHe, ilDay } from './shared4a.js';

export const SEND_WORD = 'שלח';
const KIND = { document: 'קובץ', image: 'תמונה', video: 'סרטון', audio: 'הקלטה', sticker: 'סטיקר' };
const relDay = (ts) => { const d = ilDay(ts), t = ilDay(); return d === t ? fmtTime(new Date(ts).toISOString()) : d.split('-').reverse().slice(0, 2).join('/'); };

export function listView(items, { sel = '', q = '' } = {}) {
  const qq = q.trim().toLowerCase();
  const rows = qq ? items.filter((c) => (c.name + ' ' + c.phone + ' ' + fmtPhone(c.phone) + ' ' + c.event).toLowerCase().includes(qq)) : items;
  if (!rows.length) return `<div class="empty">${qq ? 'אין התאמה' : 'אין שיחות'}</div>`;
  return rows.map((c) => `<button type="button" class="conv${c.unread ? ' unread' : ''}" data-act="ibx-open" data-phone="${esc(c.phone)}" aria-current="${c.phone === sel}">
<span class="nm">${c.unread ? '<i class="ud" aria-label="לא נענה"></i>' : ''}<span dir="auto">${esc(c.name || fmtPhone(c.phone))}</span>${roleBadge(c.role)}${c.human ? '<span class="badge warn" title="אדם בשיחה">✋</span>' : ''}</span>
<time class="sub num">${esc(relDay(c.last_ts))}</time>
<span class="pv">${c.event ? esc(c.event) + ' · ' : ''}${esc(c.numbers.join('/'))} · ${c.last_dir === 'out' ? '↩ ' : ''}${esc(c.last_text || '')}</span></button>`).join('');
}

export function bubbles(msgs) {
  if (!msgs.length) return '<div class="empty">אין הודעות בשיחה הזאת עדיין.</div>';
  let last = '';
  return msgs.map((m) => {
    const day = ilDay(m.ts); const chip = day !== last ? `<div class="daychip">${day === ilDay() ? 'היום' : esc(day.split('-').reverse().join('/'))}</div>` : ''; last = day;
    let media = '';
    if (m.media && m.media.url && m.media.kind === 'image') media = `<img src="${esc(m.media.url)}" alt="" loading="lazy" style="max-width:220px;border-radius:8px;display:block">`;
    else if (m.media && m.media.url) media = `<a href="${esc(m.media.url)}" target="_blank" rel="noopener">📎 ${esc(KIND[m.media.kind] || 'קובץ')}</a>`;
    else if (m.media && m.media.id) media = `<span>📎 ${esc(m.media.name || KIND[m.type] || 'קובץ')}</span> ${Button('הורדה', { size: 'sm', act: 'ibx-dl', attr: { 'data-id': m.media.id, 'data-ch': m.ch || 'client', 'data-name': m.media.name || m.type + '-' + m.ts } })}`;
    else if (KIND[m.type]) media = `<span class="sub">📎 ${KIND[m.type]} (לא נשמר להורדה)</span>`;
    const text = m.text || (m.type === 'template' ? 'תבנית' + (m.tmpl ? ' · ' + m.tmpl : '') : media ? '' : m.type);
    const tk = m.dir === 'out' ? ({ sent: '✓', delivered: '✓✓', read: '✓✓', failed: '✕' }[m.status] || '') : '';
    return chip + `<div class="bub ${m.dir}" data-msg="${esc(m.id || m.ts)}">${media}${text ? `<span dir="auto">${esc(text)}</span>` : ''}${m.status === 'failed' ? `<span class="fl">ⓘ לא נמסרה: ${esc(errHe((String(m.error).match(/\d{6}/) || [''])[0], m.error))}</span>` : ''}<span class="mt num">${m.tmpl && m.text ? esc(m.tmpl) + ' · ' : ''}${esc(fmtTime(m.at))}${tk ? ` <span class="tk ${esc(m.status)}" title="${esc({ sent: 'נשלחה', delivered: 'נמסרה', read: 'נקראה', failed: 'לא נמסרה' }[m.status] || '')}">${tk}</span>` : ''}</span></div>`;
  }).join('');
}

/* the composer: free text in the window, a template outside it, nothing in quiet hours (clients/leads) */
export function composer(t, { now = Date.now(), tpl = '' } = {}) {
  const quiet = t.channel !== 'guests' && quietHours(now);
  if (quiet) return `<div class="compose"><p class="warnbox" role="note">שעות שקט (21:00–09:00): לא שולחים ללקוחות וללידים עכשיו. אפשר לכתוב בבוקר.</p></div>`;
  if (t.window.open) return `<div class="compose"><label class="sub" for="ibx-txt">תשובה חופשית · החלון פתוח עד ${esc(fmtDT(t.window.closes_at))}</label><textarea id="ibx-txt" class="in" dir="auto" placeholder="כתבו תשובה…"></textarea>
<div class="row">${Button('שליחה…', { variant: 'primary', act: 'ibx-send' })}<span class="sub">שליחה רק אחרי הקלדת "${SEND_WORD}"</span></div></div>`;
  const list = (t.templates || []).filter((x) => !x.ch || x.ch === t.channel);
  const cur = list.find((x) => x.name === tpl) || list[0];
  if (!cur) return '<div class="compose"><p class="sub">החלון סגור ואין תבניות למספר הזה.</p></div>';
  return `<div class="compose"><p class="sub">עברו יותר מ-24 שעות מההודעה האחרונה שלהם: אפשר לשלוח רק תבנית מאושרת.</p>
${Select({ name: 'ibx-tpl', value: cur.name, label: 'תבנית', options: list.map((x) => ({ value: x.name, label: x.label + ' · ' + x.name })) })}
<div class="tp-params">${cur.params.map((p, i) => `<input class="in" data-param="${i}" placeholder="${i + 1} · ${esc(p)}" aria-label="${esc(p)}">`).join('')}</div>
<div class="row">${Button('שליחת תבנית…', { variant: 'primary', act: 'ibx-send-tpl', attr: { 'data-tpl': cur.name } })}<span class="sub">שליחה רק אחרי הקלדת "${SEND_WORD}"</span></div></div>`;
}

export function threadView(t, opts = {}) {
  const link = t.role === 'client' && t.token ? `<a class="btn sm ghost" href="#/clients/${esc(t.token)}">כרטיס לקוח</a>` : t.role === 'lead' ? `<a class="btn sm ghost" href="#/leads/L${esc(t.phone)}">כרטיס ליד</a>` : '';
  const ai = !!(t.takeover && t.takeover.ai) && !(t.takeover && t.takeover.ai_off);
  return `<div class="head"><button type="button" class="btn sm ghost ibx-back" data-act="ibx-back">→ שיחות</button><h2 dir="auto">${esc(t.name || fmtPhone(t.phone))}</h2>${roleBadge(t.role)}<span class="sub mono" dir="ltr">${esc(fmtPhone(t.phone))}</span>${t.event ? `<span class="sub">◆ ${esc(t.event)}</span>` : ''}
<span class="sp" style="flex:1"></span>${link}${t.channel === 'client' ? Toggle({ id: t.phone, on: ai, label: ai ? 'נועה עונה' : 'אדם בשיחה (נועה לא עונה)', act: 'ibx-ai' }) : '<span class="sub">שיר · מספר אורחים</span>'}
<span class="badge ${t.window.open ? 'good' : ''}">${t.window.open ? 'חלון 24ש פתוח' : 'חלון סגור · רק תבנית'}</span></div>
<div class="bubbles" id="ibx-bub">${bubbles(t.messages || [])}</div>${composer(t, opts)}`;
}

export function view(s) {
  return `<div class="ibx${s.sel ? ' open' : ''}"><section class="ibx-list" aria-label="שיחות"><div class="head">${Tabs({ name: 'ibx-ch', value: s.ch, items: [{ value: '', label: 'הכל', count: s.list ? s.list.counts.all : null }, { value: 'client', label: 'נועה', count: s.list ? s.list.counts.client : null }, { value: 'guests', label: 'שיר', count: s.list ? s.list.counts.guests : null }] })}
<input class="in" data-search placeholder="חיפוש: שם, טלפון, אירוע" aria-label="חיפוש שיחה" value="${esc(s.q)}"></div>
<div class="ibx-convs" id="ibx-convs">${s.list ? listView(s.list.items, s) : Skeleton.lines(8)}</div></section>
<section class="ibx-th" aria-label="שיחה" id="ibx-th">${s.thread ? threadView(s.thread, { tpl: s.tpl }) : s.sel ? Skeleton.lines(6) : '<div class="empty">בחרו שיחה מהרשימה</div>'}</section></div>`;
}

/* media from Meta through /api/media-dl (a binary response, so not through api.post) */
async function download(ctx, b) {
  const key = (() => { try { return localStorage.getItem('ishur_calls_key') || ''; } catch (e) { return ''; } })();
  if (ctx.MOCK) { toast('בדמה אין קבצים להורדה'); return; }
  const base = (window.ISHUR_CONFIG && window.ISHUR_CONFIG.endpoint) ? window.ISHUR_CONFIG.endpoint('mediadl') : 'https://go.ishur.io/api/media-dl';
  const body = { admin_key: key, id: b.dataset.id, ch: b.dataset.ch };
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(window.IshurGuard ? window.IshurGuard.stamp(body) : body) });
  if (!r.ok) throw new Error('media ' + r.status);
  const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = /\.[a-z0-9]{2,5}$/i.test(b.dataset.name) ? b.dataset.name : b.dataset.name + '.' + ((blob.type.split('/')[1] || 'bin').slice(0, 5));
  document.body.appendChild(a); a.click(); a.remove();
}

export default {
  skeleton: () => `<div class="ibx">${Skeleton.card(8)}${Skeleton.card(6)}</div>`,
  async mount(el, ctx) {
    const s = { ch: '', q: '', list: ctx.api.cached('inbox', { channel: '' })?.data || null, sel: ctx.arg || '', thread: null, tpl: '' };
    const paintList = () => { const c = el.querySelector('#ibx-convs'); if (c && s.list) c.innerHTML = listView(s.list.items, s); };
    const paintThread = (scroll = true) => { const th = el.querySelector('#ibx-th'); if (!th) return; const draft = th.querySelector('#ibx-txt')?.value || ''; th.innerHTML = s.thread ? threadView(s.thread, { tpl: s.tpl }) : s.sel ? Skeleton.lines(6) : '<div class="empty">בחרו שיחה מהרשימה</div>'; const ta = th.querySelector('#ibx-txt'); if (ta && draft) ta.value = draft; const b = th.querySelector('#ibx-bub'); if (b && scroll) b.scrollTop = b.scrollHeight; el.querySelector('.ibx')?.classList.toggle('open', !!s.sel); };
    const paint = () => { el.innerHTML = view(s); paintThread(); };
    const loadList = async () => { s.list = await ctx.api.get('inbox', { channel: s.ch }); paintList(); ctx.setBadge && ctx.setBadge('inbox', s.list.counts.unread || 0); };
    const loadThread = async () => { if (!s.sel) return; const want = s.sel; const t = await ctx.api.get('thread', { phone: want }, { cache: false }); if (s.sel === want) { s.thread = t; paintThread(); } };
    this._open = (phone) => { s.sel = phone || ''; s.thread = null; s.tpl = ''; paintList(); paintThread(); if (s.sel) loadThread().catch((e) => { const th = el.querySelector('#ibx-th'); if (th) th.innerHTML = ctx.errorBox(e); }); };
    paint();
    ctx.on(el, 'ops:change', (e) => {
      if (e.detail.name === 'ibx-ch') { s.ch = e.detail.value; loadList().catch(() => {}); }
      if (e.detail.name === 'ibx-tpl') { s.tpl = e.detail.value; paintThread(false); }
    });
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-search]')) { s.q = e.target.value; paintList(); } });
    const send = async (payload, preview) => {
      const t = s.thread; if (!t) return;
      if (t.channel !== 'guests' && quietHours()) { toast('שעות שקט: לא שולחים עכשיו', 'crit'); return; }
      const okd = await confirmTyped({ title: 'שליחת הודעה בוואטסאפ', word: SEND_WORD, action: 'שליחה', danger: false,
        body: `<p>אל <b>${esc(t.name || '')}</b> <span class="mono" dir="ltr">${esc(fmtPhone(t.phone))}</span> · מהמספר <b>${t.channel === 'guests' ? 'שיר (אורחים)' : 'נועה 4499'}</b></p><div class="msg-txt">${esc(preview)}</div><p class="sub">ההודעה יוצאת מיד ללקוח האמיתי. אין ביטול אחרי השליחה.</p>` });
      if (!okd) return null;
      const r = await ctx.api.post('/wa-send', { to: t.phone, channel: t.channel, who: 'Richard (מרכז שליטה)', ...payload }, { soft: true });
      if (!r || r.ok === false) { toast('השליחה נכשלה' + (r && r.error ? ': ' + errHe((String(r.error).match(/\d{6}/) || [''])[0], r.error) : ''), 'crit'); return r; }
      toast('נשלח'); await loadThread(); loadList().catch(() => {}); return r;
    };
    ctx.on(el, 'click', async (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      if (act === 'ibx-open') { history.replaceState(null, '', '#/inbox/' + a.dataset.phone); this._open(a.dataset.phone); }
      else if (act === 'ibx-back') { history.replaceState(null, '', '#/inbox'); this._open(''); }
      else if (act === 'ibx-send') { const ta = el.querySelector('#ibx-txt'); const text = (ta && ta.value.trim()) || ''; if (!text) { ta && ta.focus(); return; } const r = await send({ mode: 'text', text }, text); if (r && r.ok !== false && ta) ta.value = ''; }
      else if (act === 'ibx-send-tpl') {
        const ps = [...el.querySelectorAll('[data-param]')].map((i) => i.value.trim());
        if (ps.some((p) => !p)) { toast('צריך למלא את כל השדות של התבנית', 'crit'); return; }
        await send({ mode: 'template', template: a.dataset.tpl, params: ps }, a.dataset.tpl + '\n' + ps.map((p, i) => `{{${i + 1}}} ${p}`).join('\n'));
      } else if (act === 'ibx-ai') {
        const t = s.thread; if (!t) return; const turnOn = a.getAttribute('aria-checked') !== 'true';
        if (turnOn && !(await confirmTyped({ title: 'להחזיר את נועה לשיחה?', word: 'נועה', action: 'נועה עונה', danger: false, body: '<p>נועה (AI) תתחיל לענות אוטומטית בשיחה הזאת. לפי ההחלטה שלך המענה האוטומטי כבוי ברוב השיחות.</p>' }))) return;
        await busy(a, async () => { const r = await ctx.api.post('/human', { phone: t.phone, ai: turnOn }); t.takeover = { human: !r.ai, ai: !!r.ai, ai_off: !r.ai }; paintThread(false); loadList().catch(() => {}); }).catch(() => toast('לא הצלחנו לשנות', 'crit'));
      } else if (act === 'ibx-dl') busy(a, () => download(ctx, a)).catch(() => toast('הקובץ לא זמין יותר אצל מטא', 'crit'));
    });
    await loadList();
    if (s.sel) this._open(s.sel);
    ctx.poll(loadList, 30000);
    ctx.poll(() => (s.sel && !el.querySelector('#ibx-txt')?.value ? loadThread() : Promise.resolve()), 10000);
  },
  onArg(arg) { if (this._open) this._open(arg || ''); },
};
