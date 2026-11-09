/* ============================================================================
   ishur.io · templateguard.js · nothing falls between the chairs (Richard 08/11)
   ----------------------------------------------------------------------------
   Every guest-facing template the code may send is watched once an hour on the
   guests WABA. A template is BROKEN when Meta:
     · rejected / paused / disabled it, or
     · approved it but (re)classified it MARKETING (Meta does this on its own;
       marketing to a guest who did not answer is capped and dies on 131049), or
     · has no such template at all.
   For a broken template the guard submits a reworded copy <name>_r<n> — the
   SAME variables in the same order and the SAME buttons, only the wording
   moves toward Meta's utility rules (transactional, about the event the guest
   confirmed, no greetings / emojis / promotional tone). Three levels, each
   more factual than the last. Once a copy is APPROVED as UTILITY the guard
   writes tmplalt:<name> = <copy>; sendTemplate swaps to it and the resolvers
   treat <name> as usable. When the original is healthy again the alt is
   dropped. Every step is logged + Slack; after level 3 → P1 for a human.
   Media-header templates are watched but never resubmitted (needs an upload).
   KV: tmplalt:<name> (live copy) · tmplguard:<name> {level, name, at, status}
   ========================================================================== */

export const ALT_PREFIX = 'tmplalt:';
export const GUARD_PREFIX = 'tmplguard:';
export const MAX_LEVEL = 3;

/* ── §1 pure ─────────────────────────────────────────────────────────────── */
export function isBroken(t) {
  if (!t) return 'missing';
  const st = String(t.status || '').toUpperCase();
  if (['REJECTED', 'PAUSED', 'DISABLED'].includes(st)) return st.toLowerCase();
  if (st === 'APPROVED' && String(t.category || '').toUpperCase() === 'MARKETING') return 'marketing';
  return '';
}
export function isGood(t) {
  return !!t && String(t.status || '').toUpperCase() === 'APPROVED' && String(t.category || '').toUpperCase() === 'UTILITY';
}
export const placeholders = s => (String(s || '').match(/\{\{\d+\}\}/g) || []);
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
const tidy = s => s.split('\n').map(l => l.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim()).filter(Boolean).join('\n');
function giftLine(line) {
  const b = /ביט/.test(line), p = /פייבוקס/.test(line);
  const app = b && p ? 'ביט או פייבוקס' : b ? 'ביט' : p ? 'פייבוקס' : 'ביט או פייבוקס';
  return `קישור להעברת מתנה לבעלי השמחה ב${app} נמצא בכפתור למטה.`;
}
/* the body at level n (1..3). Placeholders never change. */
export function reword(text, level, { hasButtons = false } = {}) {
  let lines = String(text || '').split('\n');
  if (level >= 1) {
    lines = lines.map(l => l.replace(/מאחלים ערב מושלם,?\s*נתראה!?/g, 'נתראה באירוע.').replace(/\s*מחכים לראותכם!?/g, '').replace(/!/g, '.'));
  }
  if (level >= 2) {
    lines = lines.map(l => /מתנה/.test(l) ? giftLine(l)
      : l.replace(/תזכורת קטנה:\s*מחר חוגגים את/g, 'עדכון לקראת האירוע מחר,').replace(/מחכים לראותכם היום ב/g, 'עדכון ליום האירוע של ').replace(/חוגגים/g, 'מתקיים'));
  }
  if (level >= 3) {
    const vars = lines.filter(l => placeholders(l).length);
    const gift = lines.some(l => /מתנה/.test(l));
    lines = ['פרטי האירוע שאישרתם אליו הגעה:', ...vars];
    if (gift) lines.push(giftLine(lines.join(' ')));
    if (hasButtons) lines.push('הקישורים בכפתורים למטה.');
  }
  return tidy(lines.join('\n'));
}
/* the payload for copy n of template t (as Meta returned it), or null when it cannot be rebuilt */
export function copyPayload(t, level) {
  const comps = (t && t.components) || [];
  if (comps.some(c => c.type === 'HEADER' && c.format && c.format !== 'TEXT')) return null;   /* media header: needs an upload */
  const body = comps.find(c => c.type === 'BODY');
  if (!body) return null;
  const hasButtons = comps.some(c => c.type === 'BUTTONS');
  const text = reword(body.text, level, { hasButtons });
  if (placeholders(text).join() !== placeholders(body.text).join()) return null;   /* never lose or reorder a variable */
  if (text === tidy(body.text) && level < MAX_LEVEL) return null;
  const out = comps.map(c => {
    if (c.type === 'BODY') return { type: 'BODY', text, ...(c.example ? { example: c.example } : {}) };
    if (c.type === 'FOOTER') return { type: 'FOOTER', text: c.text };
    if (c.type === 'BUTTONS') return { type: 'BUTTONS', buttons: c.buttons.map(b => ({ ...b })) };
    if (c.type === 'HEADER') return { type: 'HEADER', format: 'TEXT', text: c.text, ...(c.example ? { example: c.example } : {}) };
    return null;
  }).filter(Boolean);
  return { name: `${t.name}_r${level}`, language: t.language || 'he', category: 'UTILITY', allow_category_change: false, components: out };
}

/* ── §2 the hourly run (I/O through deps) ────────────────────────────────────
   deps = { list(): [templates with name,status,category,language,components,rejected_reason],
            submit(payload) → {id,status} | {error}, kv: {get,put,delete}, notify(text, opts), log(rec) } */
export async function runGuard(watch, deps) {
  const all = await deps.list();
  const byName = new Map((all || []).map(t => [t.name, t]));
  const report = [];
  for (const name of watch) {
    const t = byName.get(name);
    const why = isBroken(t);
    const alt = await deps.kv.get(ALT_PREFIX + name);
    let st = null; try { st = JSON.parse((await deps.kv.get(GUARD_PREFIX + name)) || 'null'); } catch {}
    if (!why) {
      if (st && st.stuck && !alt) await deps.kv.delete(GUARD_PREFIX + name);   /* healthy again → a later break alerts again */
      if (alt && isGood(t)) {
        await deps.kv.delete(ALT_PREFIX + name); await deps.kv.delete(GUARD_PREFIX + name);
        await deps.notify(`✅ התבנית *${name}* תקינה שוב (UTILITY) — חוזרים אליה.`, { key: 'tg_back:' + name });
        report.push({ name, action: 'back-to-original' });
      }
      continue;
    }
    /* a live copy that is still good → nothing to do */
    if (alt && isGood(byName.get(alt))) { report.push({ name, why, action: 'alt-ok', alt }); continue; }
    /* the copy being tried */
    const cur = st && st.name ? byName.get(st.name) : null;
    if (cur && isGood(cur)) {
      await deps.kv.put(ALT_PREFIX + name, cur.name);
      await deps.notify(`✅ נוסח חלופי *${cur.name}* אושר כ-UTILITY — נשלח במקום *${name}* (${why}).`, { key: 'tg_ok:' + cur.name });
      await deps.log({ action: `תבנית חלופית אושרה: ${cur.name} במקום ${name}`, ok: true, ref: cur.name });
      report.push({ name, why, action: 'alt-approved', alt: cur.name }); continue;
    }
    if (cur && String(cur.status || '').toUpperCase() === 'PENDING') { report.push({ name, why, action: 'waiting', alt: cur.name }); continue; }
    /* next level (the first one, or the previous copy failed / went marketing) */
    let level = st && st.level ? st.level + 1 : 1;
    let payload = null;
    const source = t || (alt && byName.get(alt)) || null;
    /* skip levels that cannot be rebuilt, and copies Meta already has and broke */
    for (; level <= MAX_LEVEL && source; level++) {
      payload = copyPayload(source, level);
      if (!payload) continue;
      const have = byName.get(payload.name);
      if (have && isBroken(have)) { payload = null; continue; }
      break;
    }
    if (!payload || level > MAX_LEVEL) {
      /* 09/11: say it once per template and reason, not every hour (49 repeats in the notification center) */
      if (st && st.stuck === why) { report.push({ name, why, action: 'stuck' }); continue; }
      await deps.kv.put(GUARD_PREFIX + name, JSON.stringify({ ...(st || {}), stuck: why, at: new Date().toISOString() }));
      await deps.notify(`🚨 התבנית *${name}* לא תקינה (${why}) ואין נוסח חלופי שאפשר להגיש אוטומטית${source ? ' (נוסו ' + MAX_LEVEL + ' רמות)' : ''}. צריך טיפול ידני.`, { key: 'tg_stuck:' + name, sev: 'P1' });
      report.push({ name, why, action: 'stuck' }); continue;
    }
    if (byName.has(payload.name)) {   /* Meta already holds this copy (pending / approved): track it, never resubmit */
      await deps.kv.put(GUARD_PREFIX + name, JSON.stringify({ level, name: payload.name, at: new Date().toISOString() }));
      if (isGood(byName.get(payload.name))) { await deps.kv.put(ALT_PREFIX + name, payload.name); report.push({ name, why, action: 'alt-approved', alt: payload.name }); continue; }
      report.push({ name, why, action: 'existing-copy', alt: payload.name }); continue;
    }
    const res = await deps.submit(payload);
    await deps.kv.put(GUARD_PREFIX + name, JSON.stringify({ level, name: payload.name, at: new Date().toISOString(), status: res && res.status || '', error: res && res.error || '' }));
    await deps.log({ action: `תבנית ${name} (${why}) — הוגש נוסח חלופי ${payload.name}`, ok: !(res && res.error), review: !!(res && res.error), ref: payload.name, detail: (res && res.error) || '' });
    await deps.notify(`🔁 התבנית *${name}* ${why === 'marketing' ? 'סווגה מחדש כשיווקית' : 'לא תקינה (' + why + ')'} — הוגש למטא נוסח חלופי *${payload.name}* (רמה ${level}).${res && res.error ? ' ⚠️ ' + res.error : ''}`, { key: 'tg_sub:' + payload.name });
    report.push({ name, why, action: 'submitted', alt: payload.name, level });
  }
  return report;
}
