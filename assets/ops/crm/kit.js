/* ishur ops · CRM kit: small pieces shared by the leads / clients / hostesses screens.
   String renderers (testable in node) + a few delegated behaviours. Uses the ops kit (../ui.js). */
import { esc, fmtDate, fmtTime, fmtDT, relTime, Button } from '../ui.js';

export const money = (n) => (n == null ? '—' : '₪' + Number(n).toLocaleString('he-IL'));
export const dayHe = (d) => (d ? fmtDate(d.length === 10 ? d + 'T12:00:00Z' : d) : '—');
export const waDigits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (/^0/.test(d)) d = '972' + d.slice(1); return d; };
export const phoneHe = (p) => { const d = waDigits(p); return /^972\d{9}$/.test(d) ? '0' + d.slice(3, 5) + '-' + d.slice(5) : p || '—'; };
export const waHref = (p, text = '') => 'https://wa.me/' + waDigits(p) + (text ? '?text=' + encodeURIComponent(text) : '');
export const telHref = (p) => 'tel:+' + waDigits(p);
const WA = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1.3-4A8 8 0 1 1 8 18.7z"/></svg>';
const TEL = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';
export const contactBtns = (p, cls = '') => p ? `<a class="btn ${cls}" href="${esc(waHref(p))}" target="_blank" rel="noopener" aria-label="וואטסאפ">${WA}<span>וואטסאפ</span></a><a class="btn ${cls}" href="${esc(telHref(p))}" aria-label="חיוג">${TEL}<span>חיוג</span></a>` : '';

/* custom checkbox (no native checkboxes in the ops center) */
export const Check = ({ on, act = 'check', id = '', label = '' }) =>
  `<button type="button" class="ck" role="checkbox" aria-checked="${on ? 'true' : 'false'}" data-act="${esc(act)}"${id ? ` data-id="${esc(id)}"` : ''}${label ? ` aria-label="${esc(label)}"` : ''}><span aria-hidden="true">${on ? '✓' : ''}</span></button>`;

export const tagChips = (tags, removable = false) => (tags || []).map((t) => `<span class="chip">${esc(t)}${removable ? `<button type="button" data-act="tag-rm" data-tag="${esc(t)}" aria-label="הסרת תגית ${esc(t)}">×</button>` : ''}</span>`).join('');

export function dueBadge(l) {
  if (!l.next_at) return '';
  if (l.due_today) return `<span class="badge info" title="${esc(l.next_text)}"><span aria-hidden="true">●</span>היום ${esc(fmtTime(l.next_at))}</span>`;
  if (l.overdue) return `<span class="badge crit" title="${esc(l.next_text)}"><span aria-hidden="true">!</span>באיחור · ${esc(dayHe(l.next_at))}</span>`;
  return `<span class="badge" title="${esc(l.next_text)}">${esc(dayHe(l.next_at))}</span>`;
}

/* notes timeline: pinned first, then newest; add box on top */
export function notesBlock(notes, { placeholder = 'הערה חדשה…' } = {}) {
  const list = [...notes].sort((a, b) => (b.pinned - a.pinned) || Date.parse(b.at) - Date.parse(a.at));
  return `<section class="crm-sec" aria-label="הערות"><h3 class="h2">הערות <span class="muted num">${list.length}</span></h3>
<div class="note-add"><textarea class="in ta" data-note-text rows="2" placeholder="${esc(placeholder)}" aria-label="הערה חדשה"></textarea><div class="bar">${Button('שמירת הערה', { variant: 'primary', act: 'note-add' })}<button type="button" class="ck-l" role="checkbox" aria-checked="false" data-act="note-pin-new"><span class="ck" aria-hidden="true"><span></span></span>נעיצה למעלה</button></div></div>
<ul class="notes">${list.map((n) => `<li class="${n.pinned ? 'pinned' : ''}" data-note="${esc(n.id)}"><div class="note-h"><b>${esc(n.by || '—')}</b><span class="muted">${timeTagLong(n.at)}</span><button type="button" class="btn ghost sm" data-act="note-pin" data-id="${esc(n.id)}" data-pinned="${n.pinned ? 1 : 0}" aria-pressed="${n.pinned}">${n.pinned ? '📌 נעוץ' : 'נעיצה'}</button></div><p dir="auto">${esc(n.text)}</p></li>`).join('') || '<li class="empty">אין הערות עדיין</li>'}</ul></section>`;
}
const timeTagLong = (d) => `<time class="num" datetime="${esc(d || '')}" title="${esc(fmtDT(d))}">${esc(relTime(d))}</time>`;

/* activity / client timeline */
const KIND_ICON = { wa: '💬', call: '📞', form: '📝', payment: '₪', send: '📤', replies: '↩', note: '•' };
export function timeline(items, empty = 'אין פעילות') {
  if (!items.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<ul class="tl act">${items.map((a) => `<li class="${a.dir === 'in' ? 'in' : 'out'}"><time class="num" title="${esc(fmtDT(a.at))}">${esc(dayHe(a.at))}<br>${esc(fmtTime(a.at))}</time><span class="ax k-${esc(a.kind)}" aria-hidden="true">${KIND_ICON[a.kind] || '•'}</span><span><b>${esc(a.label)}</b>${a.text ? `<br><span class="ink2" dir="auto">${esc(a.text)}</span>` : ''}</span></li>`).join('')}</ul>`;
}

/* wire the notes block inside `root` for (entity, id); onChange() repaints */
export function bindNotes(root, api, entity, id, onChange) {
  let pinNew = false;
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !root.contains(b)) return;
    if (b.dataset.act === 'note-pin-new') { pinNew = !pinNew; b.setAttribute('aria-checked', String(pinNew)); b.querySelector('.ck span').textContent = pinNew ? '✓' : ''; }
    if (b.dataset.act === 'note-add') {
      const ta = root.querySelector('[data-note-text]'), text = ta.value.trim(); if (!text || b.dataset.busy) return;
      b.dataset.busy = '1';
      try { await api.addNote(entity, id, text, pinNew); ta.value = ''; pinNew = false; await onChange(); } catch (x) { root.ownerDocument && (await import('../ui.js')).toast('ההערה לא נשמרה', 'crit'); } finally { delete b.dataset.busy; }
    }
    if (b.dataset.act === 'note-pin') { try { await api.pinNote(b.dataset.id, b.dataset.pinned !== '1', entity, id); await onChange(); } catch (x) { (await import('../ui.js')).toast('לא נשמר', 'crit'); } }
  });
}

/* sticky bottom action bar for drawers (always visible; on phones it is the thumb zone) */
export const actionBar = (html) => `<div class="drawer-acts">${html}</div>`;
