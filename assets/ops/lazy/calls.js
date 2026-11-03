/* שיחות · the call center (Phase 4b). Lazy: screens/calls.js imports this only on #/calls.
   Tabs (#/calls/<tab>): ציר (timeline + player + transcript + summary) · סבבים (per-event round cards,
   why-not-dialing, stop/start behind a typed confirm) · ידני (the "נדרשת שיחה" queue: notes, mark done) ·
   שיר (prompt version, begin_message, voice — read-only; edit/rollback through /api/voice-prompt) ·
   עלויות (₪ per day / per event, Retell + Telnyx estimate).
   Endpoints: /api/ops/calls, /call, /call-rounds, /call-round, /manual-calls, /shir; /api/voice-prompt. */
import { esc, fmtN, fmtTime, fmtDate, fmtDT, Skeleton, Button, Badge, StatTile, Drawer, confirmTyped, toast, busy } from '../ui.js';
import { tiles } from '../screens/calls.js';

export const TABS = [['timeline', 'ציר שיחות'], ['rounds', 'סבבים'], ['manual', 'שיחות ידניות'], ['shir', 'שיר'], ['costs', 'עלויות']];
export const OUT_TONE = { coming: 'good', not_coming: 'crit', maybe: 'warn', callback: 'info', voicemail: '', no_answer: '', answered: 'info', failed: 'crit', do_not_call: 'serious' };
const OUT_HE = { coming: 'מגיע', not_coming: 'לא מגיע', maybe: 'מתלבט', callback: 'לחזור אליו', voicemail: 'תא קולי', no_answer: 'לא ענה', answered: 'נענתה בלי תשובה', failed: 'נכשלה', do_not_call: 'ביקש לא להתקשר' };
const LS = 'ops:calls';
const loadSt = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } };
const saveSt = (s) => { try { localStorage.setItem(LS, JSON.stringify({ tab: s.tab, range: s.range })); } catch (e) { /* private mode */ } };
const ils = (n) => (n == null ? '—' : '₪' + (Math.round(n * 100) / 100).toFixed(2));
const dur = (s) => (!s ? '—' : s < 60 ? s + ' שנ׳' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
const phone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d ? (d.startsWith('972') ? '0' + d.slice(3) : d).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3') : ''; };
const chip = (k) => `<span class="badge ${OUT_TONE[k] || ''}">${esc(OUT_HE[k] || k)}</span>`;
let tabSetter = null;

/* screen-local CSS (kept out of ops.css, which is in the counted budget) */
const STYLE = `.cc-tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.cc-tabs .seg{overflow-x:auto;max-width:100%}
.cc-list{list-style:none;margin:0;padding:0}.cc-row{border-top:1px solid var(--line)}.cc-row:first-child{border-top:0}
.cc-h{display:grid;grid-template-columns:52px 1fr auto;gap:10px;align-items:center;padding:10px 14px;cursor:pointer;min-height:44px}
.cc-h:hover,.cc-h:focus-visible{background:var(--bg-2);outline:0}.cc-h time{color:var(--ink-2);font-size:12.5px}
.cc-m{min-width:0}.cc-t{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.cc-n{font-weight:600}.cc-s{color:var(--ink-3);font-size:12.5px;display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:2px}
.cc-r{text-align:end;font-size:12.5px;color:var(--ink-2);white-space:nowrap}.cc-x{padding:4px 14px 14px 14px;display:grid;gap:10px}
.cc-x audio{width:100%;max-width:520px}.cc-x details summary{cursor:pointer;font-weight:600;font-size:13px;min-height:32px;display:flex;align-items:center}
.cc-tr{display:grid;gap:6px;margin-top:6px;max-height:420px;overflow:auto}.cc-tr p{margin:0;padding:6px 10px;border-radius:10px;background:var(--bg-2);font-size:13px;line-height:1.5;max-width:86%}
.cc-tr p.ag{background:color-mix(in srgb,var(--s1) 12%,transparent);margin-inline-start:auto}.cc-tr b{font-size:11px;color:var(--ink-3);display:block}
.cc-sum{background:var(--bg-2);border-radius:10px;padding:8px 12px;font-size:13px}
.cc-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr))}.cc-card{display:grid;gap:8px;align-content:start}
.cc-nums{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.cc-nums div{background:var(--bg-2);border-radius:8px;padding:6px 8px}.cc-nums b{display:block;font-size:17px}.cc-nums span{font-size:11.5px;color:var(--ink-3)}
.cc-why{display:flex;flex-wrap:wrap;gap:6px}.cc-acts{display:flex;flex-wrap:wrap;gap:8px}.cc-acts .btn{min-height:36px}
.cc-mc .btns{display:flex;flex-wrap:wrap;gap:6px}.cc-mc .btns .btn{min-height:40px}.cc-note{display:flex;gap:6px}.cc-note .in{flex:1;min-width:0}
.cc-pre{white-space:pre-wrap;max-height:260px;overflow:auto;font-size:12.5px}.cc-ta{width:100%;min-height:300px;font:inherit;font-size:13px;line-height:1.5;padding:10px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface);color:var(--ink);box-sizing:border-box}
.cc-tbl{width:100%;border-collapse:collapse;font-size:13px}.cc-tbl th,.cc-tbl td{padding:7px 8px;border-top:1px solid var(--line);text-align:start}.cc-tbl td.n,.cc-tbl th.n{text-align:end;font-variant-numeric:tabular-nums}
.cc-scroll{overflow-x:auto}[data-cc=body]{grid-template-columns:minmax(0,1fr)}[data-cc=body]>*{min-width:0}[data-cc=body] .kv dd{min-width:0;overflow-wrap:anywhere}
@media (max-width:640px){.cc-h{grid-template-columns:44px 1fr;padding:10px 12px}.cc-r{grid-column:2;text-align:start}.cc-x{padding:4px 12px 12px}.cc-nums b{font-size:15px}}`;
function ensureCss() { if (typeof document === 'undefined' || document.getElementById('cc-css')) return; const s = document.createElement('style'); s.id = 'cc-css'; s.textContent = STYLE; document.head.appendChild(s); }

/* ── views (pure: data → HTML; the smoke test renders them from fixtures) ── */
export function tabsBar(tab, counts = {}) {
  return `<div class="cc-tabs"><div class="seg" role="tablist" aria-label="מסכי שיחות">${TABS.map(([v, he]) => `<button type="button" role="tab" data-act="cc-tab" data-v="${v}" aria-selected="${tab === v}">${esc(he)}${counts[v] ? ` <span class="muted num">${fmtN(counts[v])}</span>` : ''}</button>`).join('')}</div></div>`;
}
export function filters(st, data) {
  const ev = (data && data.events) || [];
  const counts = (data && data.counts) || {};
  return `<div class="card"><div class="cal-filters" style="margin-top:0"><div class="seg" role="tablist" aria-label="טווח">${[['today', 'היום'], ['week', 'השבוע']].map(([v, he]) => `<button type="button" role="tab" data-act="cc-range" data-v="${v}" aria-selected="${st.range === v}">${he}</button>`).join('')}</div>
<div class="seg" role="tablist" aria-label="סוכנת">${[['', 'כולן'], ['שיר', 'שיר · אורחים'], ['נועה', 'נועה · לידים']].map(([v, he]) => `<button type="button" role="tab" data-act="cc-agent" data-v="${esc(v)}" aria-selected="${(st.agent || '') === v}">${he}</button>`).join('')}</div>
<input class="in" data-search data-cc-num placeholder="מספר טלפון" inputmode="tel" aria-label="סינון לפי מספר" value="${esc(st.number || '')}" style="max-width:160px"></div>
<div class="cal-filters"><div class="chips" role="group" aria-label="תוצאה">${Object.keys(OUT_HE).map((k) => `<button type="button" class="fchip" data-act="cc-out" data-k="${k}" aria-pressed="${st.outcomes.has(k)}">${esc(OUT_HE[k])}${counts[k] ? ` <span class="muted num">${fmtN(counts[k])}</span>` : ''}</button>`).join('')}</div></div>
${ev.length > 1 || st.event ? `<div class="cal-filters"><div class="chips" role="group" aria-label="אירוע"><button type="button" class="fchip" data-act="cc-ev" data-v="" aria-pressed="${!st.event}">כל האירועים</button>${ev.map((e) => `<button type="button" class="fchip" data-act="cc-ev" data-v="${esc(e.tok8)}" aria-pressed="${st.event === e.tok8}">${esc(e.name || e.tok8)}</button>`).join('')}</div></div>` : ''}</div>`;
}
export function callRow(r, open = false) {
  const who = r.name || phone(r.phone) || (r.kind === 'inbound' ? 'שיחה נכנסת' : '—');
  return `<li class="cc-row" data-call="${esc(r.id)}"><div class="cc-h" tabindex="0" role="button" aria-expanded="${open}" data-act="cc-open" data-id="${esc(r.id)}" data-day="${esc(r.day)}">
<time class="num" datetime="${esc(r.at)}" title="${esc(fmtDT(r.at))}">${esc(fmtTime(r.at))}</time>
<div class="cc-m"><div class="cc-t"><span class="cc-n">${esc(who)}</span>${chip(r.outcome)}${r.review ? '<span class="badge warn">לבדיקה</span>' : ''}</div>
<div class="cc-s"><span>${esc(r.agent)}${r.kind === 'lead' ? ' · ליד' : r.kind === 'inbound' ? ' · נכנסת' : ''}</span>${r.event ? `<span>${esc(r.event)}</span>` : ''}${r.phone && r.name ? `<span class="mono" dir="ltr">${esc(phone(r.phone))}</span>` : ''}${r.attempt ? `<span>ניסיון ${fmtN(r.attempt)}</span>` : ''}</div></div>
<div class="cc-r"><div class="num">${esc(dur(r.duration_s))}</div><div class="num">${esc(ils(r.cost && r.cost.total))}</div><div>${r.has_recording ? '▶︎ הקלטה' : ''}${r.has_transcript ? (r.has_recording ? ' · ' : '') + 'תמליל' : ''}</div></div></div>
${open ? `<div class="cc-x" data-cc-x="${esc(r.id)}">${Skeleton.lines(3)}</div>` : ''}</li>`;
}
export function callDetail(j) {
  if (!j || j.ok === false) return `<div class="errbox" role="alert"><span>✕</span><span>${esc((j && j.error) || 'השיחה לא נמצאה')}</span></div>`;
  const a = j.analysis || {}, c = j.call || {};
  const rec = j.recording && j.recording.url ? `<audio controls preload="none" src="${esc(j.recording.url)}" aria-label="הקלטת השיחה"></audio><div class="sub">${esc(j.recording.name || '')} · הקישור בתוקף עד ${esc(fmtDT(j.recording.expires_at))}</div>`
    : `<div class="sub">${j.recording_missing === 'not-kept' ? 'ההקלטה לא נשמרה אצלנו' : 'אין הקלטה שמורה לשיחה הזו'}</div>`;
  const meta = [a.party_size != null ? `${fmtN(a.party_size)} מגיעים` : '', j.sentiment ? 'טון: ' + esc(j.sentiment) : '', a.agent_quality != null ? 'איכות סוכנת: ' + esc(a.agent_quality) : '', a.needs_review ? 'Retell סימן לבדיקה' : '', c.disconnection ? `<span class="mono" dir="ltr">${esc(c.disconnection)}</span>` : ''].filter(Boolean).join(' · ');
  const tr = (j.transcript || []).length ? `<details${(j.transcript || []).length <= 6 ? ' open' : ''}><summary>תמליל · ${fmtN(j.transcript.length)} תורות</summary><div class="cc-tr">${j.transcript.map((t) => `<p class="${t.role === 'agent' ? 'ag' : ''}"><b>${t.role === 'agent' ? esc(c.agent || 'הסוכנת') : 'הצד השני'}</b>${esc(t.text)}</p>`).join('')}</div></details>` : '<div class="sub">אין תמליל</div>';
  return `${rec}${j.summary ? `<div class="cc-sum"><b>סיכום AI:</b> ${esc(j.summary)}</div>` : ''}${meta ? `<div class="sub">${meta}</div>` : ''}${a.quality_note ? `<div class="sub">${esc(a.quality_note)}</div>` : ''}${tr}`;
}
export function timeline(data, st, openId = null) {
  if (!data) return Skeleton.table(6);
  const items = data.items || [];
  const head = `<div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">${st.range === 'week' ? 'שבעת הימים האחרונים' : 'היום'} <span class="muted num">${fmtN(items.length)}${data.cursor ? '+' : ''}</span></h2><span class="sp"></span><span class="sub">${esc(ils(data.costs && data.costs.total && data.costs.total.total))} · ${fmtN(data.costs && data.costs.total && data.costs.total.minutes)} דק׳</span></div>`;
  if (!items.length) return `<section class="card flush">${head}<div class="empty" style="padding:16px">${st.outcomes.size || st.event || st.number || st.agent ? 'אין שיחה שמתאימה לסינון' : 'עוד אין שיחות בטווח הזה'}</div></section>`;
  const days = []; for (const r of items) { const g = days[days.length - 1]; if (!g || g.day !== r.day) days.push({ day: r.day, rows: [r] }); else g.rows.push(r); }
  return `<section class="card flush">${head}${days.map((g) => `${days.length > 1 ? `<h3 class="sub" style="padding:8px 16px 0;margin:0">${esc(fmtDate(g.day + 'T12:00:00Z'))}</h3>` : ''}<ol class="cc-list">${g.rows.map((r) => callRow(r, r.id === openId)).join('')}</ol>`).join('')}
${data.cursor ? `<div style="text-align:center;padding:10px">${Button('עוד שיחות', { act: 'cc-more' })}</div>` : ''}</section>`;
}
export function rounds(d) {
  if (!d) return Skeleton.table(4);
  const g = (d.global_why || []).length ? `<div class="errbox" role="status"><span>▲</span><span style="flex:1">לא מחייגים עכשיו לאף אירוע: ${d.global_why.map((w) => esc(w.he)).join(' · ')}</span></div>` : '';
  const sum = `<div class="card"><div class="sec-h"><h2 class="h2">סבבי שיחות</h2><span class="sp"></span><span class="sub">חלון ${d.window && d.window.open ? 'פתוח' : 'סגור'} · ${fmtN(d.capacity_left_today)} חיוגים אפשריים היום (${fmtN(d.ticks_left)} פעימות × ${fmtN(d.pace_per_tick)})${d.daily_cap && d.daily_cap.daily ? ` · תקרה ${fmtN(d.daily_cap.dialed_counted)}/${fmtN(d.daily_cap.daily)}` : ''}</span></div>
<div class="sub">${fmtN(d.totals.queued)} בתור · ${fmtN(d.totals.remaining_today)} נשארו להיום · ${fmtN(d.totals.dialed_today)} חויגו היום · ${fmtN(d.totals.lead_calls_today)} שיחות לידים</div></div>`;
  const cards = (d.events || []).map((e) => `<section class="card cc-card" data-round="${esc(e.token)}"><div class="sec-h" style="flex-wrap:wrap"><h3 class="h2" style="margin:0">${esc(e.name || e.tok8)}</h3><span class="sp"></span>${Badge(e.will_dial ? 'running' : e.stopped ? 'off' : 'skipped', e.will_dial ? 'מחייגים' : e.stopped ? 'נעצר' : 'לא מחייגים')}</div>
<div class="sub">${e.date ? esc(fmtDate(e.date + 'T12:00:00Z')) + ' · ' : ''}<span class="mono" dir="ltr">${esc(e.tok8)}</span>${e.plan ? ' · ' + esc(e.plan) : ''}${e.max_tries != null ? ` · עד ${fmtN(e.max_tries)} נסיונות` : ''}</div>
<div class="cc-nums"><div><b class="num">${fmtN(e.queued)}</b><span>בתור</span></div><div><b class="num">${fmtN(e.remaining_today)}</b><span>נשארו היום</span></div><div><b class="num">${fmtN(e.capped)}</b><span>מיצו נסיונות</span></div>
<div><b class="num">${fmtN(e.dialed_today)}</b><span>חויגו היום</span></div><div><b class="num">${fmtN(e.answered_today)}</b><span>נענו</span></div><div><b class="num">${esc(ils(e.cost_today))}</b><span>עלות היום</span></div></div>
${(e.why || []).length ? `<div class="cc-why">${e.why.map((w) => `<span class="badge ${['paused', 'stopped', 'hold', 'off:shir_dispatch', 'not-configured'].includes(w.code) ? 'serious' : ''}" title="${esc(w.code)}">${esc(w.he)}</span>`).join('')}</div>` : '<div class="sub">ייכנס לפעימה הבאה (עד 10 דק׳)</div>'}
${e.extra_round ? `<div class="sub">סבב נוסף: ${esc(e.extra_round.at)} · ${fmtN((e.extra_round.guest_ids || []).length)} אורחים${e.extra_round.done ? ' · בוצע' : ''}</div>` : ''}
${e.stopped ? `<div class="sub">נעצר ${esc(fmtDT(e.stopped.at))}${e.stopped.by ? ' ע״י ' + esc(e.stopped.by) : ''}${e.stopped.reason ? ' · ' + esc(e.stopped.reason) : ''}</div>` : ''}
${e.plan_no_calls ? '' : `<div class="cc-acts">${e.stopped ? Button('הפעלת הסבב', { variant: 'primary', size: 'sm', act: 'cc-round', attr: { 'data-tok': e.token, 'data-a': 'start' } }) : Button('עצירת הסבב', { variant: 'danger', size: 'sm', act: 'cc-round', attr: { 'data-tok': e.token, 'data-a': 'stop' } })}${Button('סבב נוסף היום', { size: 'sm', act: 'cc-round', attr: { 'data-tok': e.token, 'data-a': 'start', 'data-extra': '1' } })}</div>`}</section>`).join('');
  return `${g}${sum}${cards ? `<div class="cc-grid">${cards}</div>` : '<div class="card empty">אין אירוע עם אורחים שממתינים לשיחה</div>'}`;
}
export function manual(d, view = 'open') {
  if (!d) return Skeleton.table(5);
  const rows = (d.items || []).filter((x) => (view === 'open' ? !x.capped && !x.past : x.capped || x.past));
  const seg = `<div class="card"><div class="sec-h" style="flex-wrap:wrap"><h2 class="h2">ממתינים לשיחה ידנית</h2><span class="sp"></span><div class="seg" role="tablist" aria-label="מצב">${[['open', 'פתוחים', d.open], ['done', 'מוצו / עברו', (d.items || []).length - d.open]].map(([v, he, n]) => `<button type="button" role="tab" data-act="cc-mview" data-v="${v}" aria-selected="${view === v}">${he} <span class="muted num">${fmtN(n)}</span></button>`).join('')}</div></div><div class="sub">אורחים שסומנו "נדרשת שיחה". סימון כאן כותב לגיליון האורחים כמו דף השיחות הישן; שיר מחייגת לאותו תור בחלון השיחות.</div></div>`;
  if (!rows.length) return seg + `<div class="card empty">${view === 'open' ? 'אין שיחות ממתינות' : 'אין כאן אף אחד'}</div>`;
  let last = null;
  return seg + rows.map((g) => { const h = g.token !== last ? `<h3 class="h2" style="margin:8px 4px 0">${esc(g.event || g.tok8)} <span class="sub">${esc(g.event_date ? fmtDate(g.event_date + 'T12:00:00Z') : '')}${g.venue ? ' · ' + esc(g.venue) : ''}</span></h3>` : ''; last = g.token;
    return `${h}<section class="card cc-mc" data-mc="${esc(g.guest_id)}"><div class="cc-t"><span class="cc-n">${esc(g.name)}</span>${g.party ? `<span class="badge">${esc(g.party)} מוזמנים</span>` : ''}<span class="badge ${g.tries >= (g.max_tries || 3) - 1 ? 'warn' : ''}">ניסיון ${fmtN((g.tries || 0) + 1)} מתוך ${fmtN(g.max_tries || 3)}</span></div>
<a class="btn sm" href="tel:+${esc(g.phone)}" dir="ltr" style="justify-self:start;min-height:40px">${esc(phone(g.phone))}</a>${g.last_answer ? `<div class="sub">פעם קודמת: ${esc(g.last_answer)}</div>` : ''}
<div class="cc-note"><input class="in" data-mc-note="${esc(g.guest_id)}" value="${esc((g.note && g.note.text) || '')}" placeholder="הערה" aria-label="הערה ל${esc(g.name)}">${Button('שמירה', { size: 'sm', act: 'cc-note', attr: { 'data-gid': g.guest_id } })}</div>${g.note ? `<div class="sub">${esc(fmtDT(g.note.at))}${g.note.by ? ' · ' + esc(g.note.by) : ''}</div>` : ''}
${view === 'open' ? `<div class="btns">${(d.outcomes || []).map((o) => Button(o, { size: 'sm', variant: o === 'מגיע' ? 'primary' : '', act: 'cc-done', attr: { 'data-gid': g.guest_id, 'data-o': o, 'data-tries': g.tries || 0 } })).join('')}</div>` : ''}</section>`; }).join('');
}
export function shir(d) {
  if (!d) return Skeleton.table(4);
  if (d.ok === false) return `<div class="errbox" role="alert"><span>✕</span><span>${esc(d.error || 'לא נטען')}</span></div>`;
  const v = d.voice || {};
  const kv = (pairs) => `<dl class="kv">${pairs.filter(([, x]) => x != null && x !== '').map(([k, x]) => `<dt>${esc(k)}</dt><dd>${x}</dd>`).join('')}</dl>`;
  const head = `<section class="card"><div class="sec-h" style="flex-wrap:wrap"><h2 class="h2">${esc(d.name || 'שיר')}</h2><span class="sp"></span>${Button('עריכת הפרומפט', { variant: 'primary', size: 'sm', act: 'cc-shir-edit' })}</div>
${d.retell === false ? '<div class="errbox" role="alert"><span>▲</span><span>אין RETELL_KEY: מוצגת רק היסטוריית הגרסאות</span></div>' : ''}
${kv([['גרסה', d.head ? `<b class="num">${fmtN(d.head)}</b>${d.live_matches_head === false ? ' <span class="badge warn">החי שונה מהגרסה האחרונה</span>' : d.live_matches_head ? ' <span class="badge good">החי = הגרסה האחרונה</span>' : ''}` : 'עוד לא נשמרה גרסה'], ['משפט פתיחה', d.begin_message == null ? '—' : d.begin_message === '' ? '<span class="sub">ריק: מחכה ל"הלו" ואז הפרומפט פותח</span>' : esc(d.begin_message)], ['מודל', d.model ? `<span class="mono" dir="ltr">${esc(d.model)}</span>` : ''],
    ['אורך הפרומפט', d.prompt_chars != null ? fmtN(d.prompt_chars) + ' תווים' : ''], ['סוכן', `<span class="mono" dir="ltr">${esc(d.agent_id || '')}</span>`]])}</section>`;
  const voice = `<section class="card"><h2 class="h2">קול והתנהגות (לקריאה בלבד)</h2>${kv([['קול', v.voice_id ? `<span class="mono" dir="ltr">${esc(v.voice_id)}</span>` : ''], ['מודל קול', v.voice_model ? `<span class="mono" dir="ltr">${esc(v.voice_model)}</span>` : ''], ['שפה', esc(v.language || '')], ['מהירות', v.voice_speed != null ? esc(v.voice_speed) : ''], ['טמפרטורה', v.voice_temperature != null ? esc(v.voice_temperature) : ''], ['עוצמה', v.volume != null ? esc(v.volume) : ''],
    ['רגישות להפרעה', v.interruption_sensitivity != null ? esc(v.interruption_sensitivity) : ''], ['תגובתיות', v.responsiveness != null ? esc(v.responsiveness) : ''], ['"אהה/כן" ברקע', v.enable_backchannel != null ? (v.enable_backchannel ? 'כן' : 'לא') : ''], ['צליל רקע', esc(v.ambient_sound || '')], ['שיחה מקסימלית', v.max_call_duration_ms ? fmtN(Math.round(v.max_call_duration_ms / 60000)) + ' דק׳' : ''], ['ניתוק אחרי שקט', v.end_call_after_silence_ms ? fmtN(Math.round(v.end_call_after_silence_ms / 1000)) + ' שנ׳' : '']])}
${(d.analysis_fields || []).length ? `<div class="sub">שדות ניתוח אחרי שיחה: ${d.analysis_fields.map((x) => `<span class="mono" dir="ltr">${esc(x)}</span>`).join(', ')}</div>` : ''}</section>`;
  const hist = `<section class="card"><h2 class="h2">היסטוריית גרסאות</h2>${(d.history || []).length ? `<ol class="cc-list">${d.history.map((h) => `<li class="cc-row" style="padding:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b class="num">#${fmtN(h.n)}</b><span style="flex:1;min-width:140px">${esc(h.note || '')}</span><span class="sub">${esc(fmtDT(h.at))} · ${fmtN(h.chars)} תווים</span>${Button('צפייה', { size: 'sm', variant: 'ghost', act: 'cc-shir-view', attr: { 'data-n': h.n } })}${h.n !== d.head ? Button('שחזור', { size: 'sm', act: 'cc-shir-rb', attr: { 'data-n': h.n } }) : '<span class="badge good">נוכחית</span>'}</li>`).join('')}</ol>` : '<div class="sub">אין עדיין גרסאות. השמירה הראשונה תשמור את הפרומפט החי כגרסה 1.</div>'}</section>`;
  return head + voice + hist;
}
export function costs(c, range) {
  if (!c) return Skeleton.table(4);
  const t = c.total || {};
  const tel = (x) => (x == null ? '<span class="sub">לא ידוע</span>' : esc(ils(x)));
  const tbl = (rows, first, key) => `<div class="cc-scroll"><table class="cc-tbl"><thead><tr><th>${first}</th><th class="n">שיחות</th><th class="n">נענו</th><th class="n">דקות</th><th class="n">Retell</th><th class="n">Telnyx</th><th class="n">סה״כ</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${key(r)}</td><td class="n">${fmtN(r.calls)}</td><td class="n">${fmtN(r.connected)}</td><td class="n">${fmtN(r.minutes)}</td><td class="n">${esc(ils(r.retell))}</td><td class="n">${tel(r.telnyx)}</td><td class="n"><b>${esc(ils(r.total))}</b></td></tr>`).join('') || '<tr><td colspan="7" class="sub">אין שיחות</td></tr>'}</tbody></table></div>`;
  return `<div class="grid g-tiles">${StatTile({ label: 'סה״כ ' + (range === 'week' ? 'בשבוע' : 'היום'), value: ils(t.total) })}${StatTile({ label: 'Retell', value: ils(t.retell) })}${StatTile({ label: 'Telnyx', value: t.telnyx == null ? '—' : ils(t.telnyx), sub: c.telnyx_basis === 'estimate' ? 'הערכה: ' + ils(c.telnyx_rate_per_min) + ' לדקה' : 'אין תעריף (TELNYX_ILS_PER_MIN)' })}${StatTile({ label: 'שיחות · דקות', value: fmtN(t.calls) + ' · ' + fmtN(t.minutes) })}</div>
<section class="card"><h2 class="h2">לפי יום</h2>${tbl(c.by_day || [], 'יום', (r) => esc(fmtDate(r.day + 'T12:00:00Z')))}</section>
<section class="card"><h2 class="h2">לפי אירוע</h2>${tbl(c.by_event || [], 'אירוע', (r) => `${esc(r.event || r.key)} <span class="sub mono" dir="ltr">${esc(r.key)}</span>`)}</section>
<p class="sub">Retell = מה ש-Retell חייב (combined_cost × 3.7). Telnyx לא נרשם לכל שיחה: מוצג רק כהערכה לפי דקות מחויבות, כשמוגדר תעריף.</p>`;
}

/* ── the screen ── */
export default {
  skeleton: () => Skeleton.tiles(4) + Skeleton.table(6),
  async mount(el, ctx) {
    ensureCss();
    const saved = loadSt();
    const st = { tab: TABS.some(([v]) => v === ctx.arg) ? ctx.arg : TABS.some(([v]) => v === saved.tab) ? saved.tab : 'timeline', range: saved.range === 'week' ? 'week' : 'today', agent: '', number: '', event: '', outcomes: new Set(), mview: 'open', open: null };
    let rt = ctx.api.cached('realtime')?.data || null, calls = null, rnd = null, man = null, sh = null;
    const details = new Map();
    el.innerHTML = '<div data-cc="top"></div><div data-cc="tabs"></div><div data-cc="body" style="display:grid;gap:14px"></div>';
    const $ = (k) => el.querySelector(`[data-cc="${k}"]`);
    const callsBody = () => { const b = st.range === 'week' ? { week: 1 } : {}; if (st.agent) b.agent = st.agent; if (st.number) b.number = st.number; if (st.event) b.event = st.event; if (st.outcomes.size) b.outcome = [...st.outcomes].join(','); return b; };
    const paintTop = () => { $('top').innerHTML = rt ? tiles(rt) : Skeleton.tiles(4); };
    const paint = () => {
      $('tabs').innerHTML = tabsBar(st.tab, { manual: man && man.open, rounds: rnd && rnd.events && rnd.events.filter((e) => e.will_dial).length });
      const b = $('body');
      const keepFocus = document.activeElement && document.activeElement.matches('[data-cc-num]');
      if (st.tab === 'timeline') { b.innerHTML = filters(st, calls) + timeline(calls, st, st.open); if (st.open) fillDetail(st.open); }
      else if (st.tab === 'rounds') b.innerHTML = rounds(rnd);
      else if (st.tab === 'manual') b.innerHTML = manual(man, st.mview);
      else if (st.tab === 'shir') b.innerHTML = shir(sh);
      else b.innerHTML = `<div class="card"><div class="seg" role="tablist" aria-label="טווח">${[['today', 'היום'], ['week', 'השבוע']].map(([v, he]) => `<button type="button" role="tab" data-act="cc-range" data-v="${v}" aria-selected="${st.range === v}">${he}</button>`).join('')}</div></div>` + costs(calls && calls.costs, st.range);
      if (keepFocus) { const s = el.querySelector('[data-cc-num]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
    };
    const fail = (e) => { $('body').innerHTML = ctx.errorBox(e); };
    const fetchCalls = async () => { const k = callsBody(); const c = ctx.api.cached('calls', k); if (c && !calls) { calls = c.data; paint(); } calls = await ctx.api.get('calls', k); };
    const fetchTab = async (force = false) => {
      try {
        if (st.tab === 'timeline' || st.tab === 'costs') await fetchCalls();
        else if (st.tab === 'rounds' && (force || !rnd)) rnd = await ctx.api.get('call-rounds');
        else if (st.tab === 'manual' && (force || !man)) man = await ctx.api.get('manual-calls');
        else if (st.tab === 'shir' && (force || !sh)) sh = await ctx.api.get('shir').catch((e) => ({ ok: false, error: e.message }));
        paint();
      } catch (e) { fail(e); }
    };
    async function fillDetail(id) {
      const box = el.querySelector(`[data-cc-x="${CSS.escape ? CSS.escape(id) : id}"]`); if (!box) return;
      if (details.has(id)) { box.innerHTML = callDetail(details.get(id)); return; }
      const row = (calls && calls.items || []).find((r) => r.id === id);
      try { const j = await ctx.api.get('call', { id, day: row ? row.day : '' }, { cache: false }); details.set(id, j); } catch (e) { details.set(id, { ok: false, error: e.message }); }
      const again = el.querySelector(`[data-cc-x="${CSS.escape ? CSS.escape(id) : id}"]`); if (again) again.innerHTML = callDetail(details.get(id));
    }
    const setTab = (t) => { if (!TABS.some(([v]) => v === t)) t = 'timeline'; st.tab = t; saveSt(st); paint(); fetchTab(); };
    tabSetter = setTab; ctx.onDispose(() => { tabSetter = null; });
    const doRound = async (btn) => {
      const token = btn.dataset.tok, action = btn.dataset.a, extra = btn.dataset.extra === '1';
      const pre = await ctx.api.post('call-round', { token, action, extra }).catch((e) => { toast('השרת סירב: ' + e.message, 'crit'); return null; });
      if (!pre) return;
      const card = (rnd.events || []).find((e) => e.token === token) || {};
      const ok = await confirmTyped({ title: action === 'stop' ? 'עצירת סבב שיחות' : extra ? 'סבב שיחות נוסף' : 'הפעלת סבב שיחות', body: `<p><b>${esc(card.name || token.slice(0, 8))}</b></p><p>${esc(pre.he || '')}</p>`, word: pre.confirm_required, action: action === 'stop' ? 'לעצור' : 'להפעיל', danger: action === 'stop' });
      if (!ok) return;
      await busy(btn, async () => { const r = await ctx.api.post('call-round', { token, action, extra, confirm: pre.confirm_required, who: 'richard' }); toast(r.applied ? (action === 'stop' ? 'הסבב נעצר' : 'הסבב הופעל') : 'לא בוצע', r.applied ? 'good' : 'warn'); rnd = await ctx.api.get('call-rounds', {}, { cache: false }); paint(); }).catch(() => {});
    };
    const doDone = async (btn) => {
      const gid = btn.dataset.gid, o = btn.dataset.o;
      await busy(btn, async () => { const r = await ctx.api.post('manual-calls', { action: 'done', guest_id: gid, outcome: o, tries: +btn.dataset.tries || 0, who: 'richard' }); toast('נשמר: ' + o, 'good');
        const it = man.items.find((x) => x.guest_id === gid); if (it) { it.tries = r.tries; it.last_answer = r.answer; if (r.call_status !== 'נדרשת שיחה') { man.items = man.items.filter((x) => x !== it); man.open = Math.max(0, man.open - 1); } } paint(); }).catch(() => toast('לא נשמר — נסו שוב', 'crit'));
    };
    const doNote = async (btn) => {
      const gid = btn.dataset.gid, inp = el.querySelector(`[data-mc-note="${gid}"]`);
      await busy(btn, async () => { const r = await ctx.api.post('manual-calls', { action: 'note', guest_id: gid, note: inp ? inp.value : '', who: 'richard' }); const it = man.items.find((x) => x.guest_id === gid); if (it) it.note = r.note; toast(r.note ? 'ההערה נשמרה' : 'ההערה נמחקה', 'good'); }).catch(() => toast('לא נשמר', 'crit'));
    };
    const shirEdit = async () => {
      const cur = await ctx.api.post('/voice-prompt', { agent: 'shir_out', action: 'get' }).catch((e) => { toast('לא נטען: ' + e.message, 'crit'); return null; });
      if (!cur) return;
      const body = Drawer.open('עריכת הפרומפט של שיר', `<p class="sub">כל שמירה היא גרסה חדשה (${fmtN((cur.head || 0) + 1)}). אפשר לחזור לכל גרסה קודמת מהרשימה.</p>
<label class="sub" for="cc-bm">משפט פתיחה (ריק = מחכה ל"הלו")</label><input id="cc-bm" class="in" value="${esc(sh && sh.begin_message != null ? sh.begin_message : '')}">
<label class="sub" for="cc-pr">פרומפט</label><textarea id="cc-pr" class="cc-ta" dir="rtl">${esc(cur.prompt || '')}</textarea>
<label class="sub" for="cc-nt">מה השתנה</label><input id="cc-nt" class="in" placeholder="למשל: פתיחה קצרה יותר">
<div class="acts">${Button('שמירה כגרסה חדשה', { variant: 'primary', act: 'cc-shir-save' })}</div>`);
      body.querySelector('[data-act=cc-shir-save]').addEventListener('click', async (e) => {
        const prompt = body.querySelector('#cc-pr').value, note = body.querySelector('#cc-nt').value, bm = body.querySelector('#cc-bm').value;
        if (!prompt.trim()) { toast('הפרומפט ריק', 'warn'); return; }
        const ok = await confirmTyped({ title: 'החלת גרסה חדשה לשיר', body: `<p>הפרומפט החדש (${fmtN(prompt.length)} תווים) יחול מיד על כל שיחה חדשה של שיר.</p>`, word: 'shir_out', action: 'להחיל' });
        if (!ok) return;
        await busy(e.currentTarget, async () => { const r = await ctx.api.post('/voice-prompt', { agent: 'shir_out', action: 'save', prompt, note, begin_message: bm }); toast('גרסה ' + r.version + ' הוחלה', 'good'); Drawer.close(); sh = null; await fetchTab(true); }).catch((er) => toast('לא נשמר: ' + er.message, 'crit'));
      });
    };
    const shirView = async (n) => { const v = await ctx.api.post('/voice-prompt', { agent: 'shir_out', action: 'version', n }).catch(() => null); Drawer.open('גרסה ' + n, v ? `<p class="sub">${esc(fmtDT(v.at))} · ${esc(v.note || '')}</p>${v.begin_message != null ? `<p><b>משפט פתיחה:</b> ${esc(v.begin_message || '(ריק)')}</p>` : ''}<pre class="code cc-pre" dir="rtl">${esc(v.prompt || '')}</pre>` : '<div class="errbox"><span>✕</span><span>הגרסה לא נמצאה</span></div>'); };
    const shirRollback = async (n, btn) => {
      const ok = await confirmTyped({ title: 'שחזור גרסה ' + n, body: `<p>הפרומפט של גרסה ${fmtN(n)} יוחל מחדש כגרסה חדשה. ההיסטוריה נשמרת.</p>`, word: 'shir_out', action: 'לשחזר' });
      if (!ok) return;
      await busy(btn, async () => { const r = await ctx.api.post('/voice-prompt', { agent: 'shir_out', action: 'rollback', n }); toast('שוחזר כגרסה ' + r.version, 'good'); sh = null; await fetchTab(true); }).catch((e) => toast('לא שוחזר: ' + e.message, 'crit'));
    };
    ctx.on(el, 'click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      if (act === 'cc-tab') { ctx.nav('calls/' + a.dataset.v); return; }
      if (act === 'cc-range') { st.range = a.dataset.v; saveSt(st); calls = null; paint(); fetchTab(); return; }
      if (act === 'cc-agent') { st.agent = a.dataset.v; calls = null; paint(); fetchTab(); return; }
      if (act === 'cc-ev') { st.event = a.dataset.v; fetchTab(); return; }
      if (act === 'cc-out') { const k = a.dataset.k; if (st.outcomes.has(k)) st.outcomes.delete(k); else st.outcomes.add(k); fetchTab(); return; }
      if (act === 'cc-open') { st.open = st.open === a.dataset.id ? null : a.dataset.id; paint(); return; }
      if (act === 'cc-more' && calls && calls.cursor) { busy(a, async () => { const more = await ctx.api.get('calls', { ...callsBody(), cursor: calls.cursor }, { cache: false }); calls = { ...calls, items: calls.items.concat(more.items || []), cursor: more.cursor }; paint(); }).catch(() => {}); return; }
      if (act === 'cc-round') { doRound(a); return; }
      if (act === 'cc-mview') { st.mview = a.dataset.v; paint(); return; }
      if (act === 'cc-done') { doDone(a); return; }
      if (act === 'cc-note') { doNote(a); return; }
      if (act === 'cc-shir-edit') { shirEdit(); return; }
      if (act === 'cc-shir-view') { shirView(+a.dataset.n); return; }
      if (act === 'cc-shir-rb') { shirRollback(+a.dataset.n, a); }
    });
    ctx.on(el, 'keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.cc-h')) { e.preventDefault(); e.target.click(); } });
    let numT = 0;
    ctx.on(el, 'input', (e) => { if (e.target.matches('[data-cc-num]')) { st.number = e.target.value.replace(/[^\d-]/g, ''); clearTimeout(numT); numT = setTimeout(fetchTab, 350); } });
    paintTop(); paint();
    ctx.api.get('realtime').then((r) => { rt = r; paintTop(); }).catch(() => {});
    await fetchTab();
    ctx.poll(async () => { rt = await ctx.api.get('realtime'); paintTop(); if (st.tab === 'timeline' && !st.open) { await fetchCalls(); paint(); } }, 30000);
  },
  onArg(arg) { if (tabSetter) tabSetter(arg || 'timeline'); },
};
