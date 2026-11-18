/* ============================================================================
   ishur.io · בקרת איכות אחרי כל שיחה (noa-chase R8 + R11) — 02/11/2026
   ----------------------------------------------------------------------------
   reviewCall(env, call)  → what the guest actually said vs. what was recorded.
     Rules first — deterministic, no model, the only thing allowed to auto-fix:
       · "לא יודע / לא בטוח / עדיין לא"            → מתלבט
       · "לא" and nothing else                      → לא מגיע
       · "כן"                                       → מגיע (count_unclear unless a
                                                      number was said) — never auto
       · ≤9s and nothing beyond הלו/שלום            → לא ענה (ניתק בפתיח), retry
     Then a model pass (Claude when ANTHROPIC_API_KEY exists, else Workers AI)
     for Hebrew issues, ≤3 lessons and ≤2 memory updates. The model never
     decides an RSVP.
   applyReview(env, call, review) → the fix through the same call_result path
     the webhook uses, a journal line, memory updates through memoryGuard,
     and one quiet Slack line for a mismatch.

   QA baseline: the 28 Shir calls of 01/11 (worker/test/fixtures/
   shir-calls-2026-11-01.json) — 16 gaps found, 12 non-gaps left alone.
   ========================================================================== */

import { callOutcome } from './dashboard.js';
import { stream, logEvent } from './evlog.js';
import { slackPost } from './slack.js';
import { addMemory } from './noa.js';
import { makeWriterBody } from './lib.js';   /* 12/11 security: no formulas into the sheet */

export const HANGUP_S = 9;
export const HANGUP_LABEL = 'לא ענה (ניתק בפתיח)';

/* greetings and STT noise — a call with nothing beyond these is a hangup in
   the opener. Anything else the guest said ("וואלה הלאה", "אני רוצה לבדוק")
   means they were listening, and a human decides. */
const GREETING = new Set(['הלו', 'שלום', 'היי', 'אהלן', 'אה', 'אהה', 'אמ', 'אממ', 'נו']);
/* closings that ride along with a real answer ("לא לא, תודה, יום טוב") */
const CLOSING = new Set(['תודה', 'רבה', 'יום', 'טוב', 'ביי', 'להתראות', 'אוקיי', 'אוקי', 'בסדר', 'סליחה']);
/* short tokens that DO mean something and must survive the fragment filter */
const KEEP = new Set(['לא', 'כן', 'אולי', 'תלוי']);
const NUM_WORDS = /^(אחד|אחת|שניים|שתיים|שני|שתי|שלוש|שלושה|ארבע|ארבעה|חמש|חמישה|שש|שישה|שבע|שבעה|שמונה|תשע|תשעה|עשר|עשרה|\d+)$/;

/* "User: ..." lines of a Retell transcript → the words the guest said */
export function userTokens(transcript) {
  const lines = String(transcript || '').split('\n');
  const said = [];
  for (const l of lines) {
    const m = /^\s*User:\s*(.*)$/.exec(l);
    if (m) said.push(m[1]);
  }
  const text = said.join(' ').replace(/\([^)]*\)/g, ' ');     // "(unintelligible audio)"
  return text.split(/\s+/).map(w => w.replace(/[^א-ת\d"']/g, '')).filter(Boolean);
}
export function userText(transcript) { return userTokens(transcript).join(' '); }

/* tokens that are more than a greeting: no greetings, no ≤3-letter STT shards */
export function substantive(tokens) {
  return tokens.filter(w => !GREETING.has(w) && (KEEP.has(w) || w.length > 3 || /^\d+$/.test(w)));
}
/* the answer itself: substantive tokens minus the polite closings */
export function answerTokens(tokens) {
  return substantive(tokens).filter(w => !CLOSING.has(w));
}

/* what the sheet says this call recorded, in the same vocabulary as suggestions */
export function recordedOf(call) {
  const o = String((call && call.outcome) || '').trim();
  if (o === 'מגיע' || o === 'לא מגיע' || o === 'מתלבט') return o;
  const a = String((call && call.answer) || '').trim();
  if (/^לא ענה/.test(a)) return 'לא ענה';
  if (/^ביקש לא להתקשר/.test(a)) return 'לא להתקשר';
  return '';
}

/* ── the rules ────────────────────────────────────────────────────────────── */
export function rulesVerdict(call) {
  const c = call || {};
  const tokens = userTokens(c.transcript);
  const text = tokens.join(' ');
  const subst = substantive(tokens);
  const ans = answerTokens(tokens);
  const dur = Number(c.duration_s);
  const recorded = recordedOf(c);
  const r = { recorded, suggested: '', auto_fix: false, retry: false, count_unclear: false, rule: '', said: text };

  if (/(^|\s)(לא|עדיין לא|עוד לא)\s+(יודע|יודעת|יודעים|יודעות|בטוח|בטוחה|בטוחים|סגור|סגורה|החלטנו|החלטתי)|(^|\s)(עדיין|עוד)\s+לא(\s|$)|(^|\s)(אולי|תלוי|נראה|נעדכן|נחשוב|נבדוק)(\s|$)/.test(text)) {
    r.suggested = 'מתלבט'; r.rule = 'undecided'; r.auto_fix = true;
  } else if (Number.isFinite(dur) && dur <= HANGUP_S && subst.length === 0) {
    r.suggested = HANGUP_LABEL; r.rule = 'hangup'; r.retry = true; r.auto_fix = true;
  } else if (ans.length && ans.every(w => w === 'לא')) {
    r.suggested = 'לא מגיע'; r.rule = 'no-only'; r.auto_fix = true;
  } else if (ans.includes('כן') && !ans.includes('לא')) {
    r.suggested = 'מגיע'; r.rule = 'yes';
    const nums = ans.filter(w => NUM_WORDS.test(w));
    r.count_unclear = nums.length !== 1 || /(^|\s)או(\s|$)/.test(text);
  }
  /* the mid-call tool wrote the outcome and the end-of-call report does not
     carry it: the tool is the source of truth, nothing to compare against */
  if (!recorded && c.tool_recorded) { r.recorded = 'נרשם בכלי'; r.verdict = 'ok'; r.auto_fix = false; return r; }
  const same = r.suggested && (r.suggested === recorded || (r.rule === 'hangup' && recorded === 'לא ענה'));
  if (!r.suggested) r.verdict = recorded ? 'ok' : 'review';
  else if (same) r.verdict = 'ok';
  else if (r.auto_fix) r.verdict = 'mismatch';
  else r.verdict = 'review';
  /* an auto-fix that changes nothing is not a fix */
  if (r.verdict !== 'mismatch') r.auto_fix = false;
  return r;
}

/* deterministic Hebrew/tone checks that need no model */
export function hebrewRules(transcript) {
  const issues = [];
  const agent = String(transcript || '').split('\n').filter(l => /^\s*Agent:/.test(l)).map(l => l.replace(/^\s*Agent:\s*/, '').trim());
  const openers = agent.filter(l => /^(היי|שלום)[, ]+(מדברת|זו|זאת)/.test(l));
  if (openers.length > 1) issues.push('חזרה על הפתיח ' + openers.length + ' פעמים');
  if (agent.some(l => /\{\{|\}\}/.test(l))) issues.push('משתנה לא מולא (סוגריים מסולסלים בדיבור)');
  if (agent.some(l => /[a-zA-Z]{4,}/.test(l))) issues.push('מילים באנגלית בדיבור של הסוכנת');
  return issues;
}

/* ── the model pass ───────────────────────────────────────────────────────── */
const SYSTEM = `את מבקרת איכות של סוכנת קולית בעברית (שירות אישורי הגעה לאירועים). את מקבלת תמליל שיחה (Agent = הסוכנת, User = מי שענה) ואת התוצאה שנרשמה.
החזירי JSON בלבד, בלי טקסט מסביב, במבנה:
{"hebrew_issues":["..."],"lessons":["..."],"memory_updates":["..."]}
- hebrew_issues: ניסוח שבור או לא טבעי, חזרה על הפתיח, קטיעה של האורח, טון גבוה מדי. עד 3, קצר.
- lessons: עד 3 לקחים לשיחה הבאה, עברית, עד 120 תווים כל אחד, בלי שמות ובלי טלפונים.
- memory_updates: עד 2 משפטים קצרים שכדאי שהסוכנת תזכור תמיד (כלל התנהגות, לא עובדה על אדם). בלי שמות, בלי טלפונים, בלי מחירים, בלי "הנחה", בלי הבטחות. אם אין — מערך ריק.
אל תמציאי. אם השיחה קצרה מדי לשפוט, החזירי מערכים ריקים.`;

function parseModel(raw) {
  const s = String(raw || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const clean = (arr, n, len) => (Array.isArray(arr) ? arr : []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).map(x => x.slice(0, len)).slice(0, n);

export async function modelReview(env, call, opts = {}) {
  const c = call || {};
  const empty = { hebrew_issues: [], lessons: [], memory_updates: [], model: '' };
  const transcript = String(c.transcript || '').slice(0, 6000);
  if (!transcript.trim() || !env) return empty;
  const user = `סוכנת: ${c.agent || 'שיר'}\nמשך: ${c.duration_s != null ? c.duration_s + ' שניות' : '?'}\nתוצאה שנרשמה: ${c.outcome || c.answer || '—'}\n${c.event ? 'אירוע: ' + c.event + '\n' : ''}\nתמליל:\n${transcript}`;
  const doFetch = opts.fetch || fetch;
  let raw = '', model = '';
  try {
    if (env.ANTHROPIC_API_KEY) {
      model = 'claude-opus-5-5';
      const r = await doFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 600, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
      });
      const j = r && r.ok ? await r.json().catch(() => null) : null;
      raw = j && Array.isArray(j.content) ? j.content.map(b => b.text || '').join('') : '';
    }
    if (!raw && env.AI && env.AI.run) {
      model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
      const r = await env.AI.run(model, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], max_tokens: 500 });
      raw = String((r && r.response) || '');
    }
  } catch { raw = ''; }
  const j = parseModel(raw);
  if (!j) return { ...empty, model };
  return {
    model,
    hebrew_issues: clean(j.hebrew_issues, 3, 160),
    lessons: clean(j.lessons, 3, 120),
    memory_updates: clean(j.memory_updates, 2, 160),
  };
}

/* ── reviewCall ───────────────────────────────────────────────────────────── */
/* call = { agent:'שיר'|'נועה', transcript, outcome, answer, duration_s, guest_name, event,
            call_id?, guest_id?, tries?, max_tries?, phone? }
   opts.model === false skips the model pass (tests, bulk re-runs). */
export async function reviewCall(env, call, opts = {}) {
  const c = call || {};
  const rules = rulesVerdict(c);
  const base = {
    verdict: rules.verdict, recorded: rules.recorded, suggested: rules.suggested,
    auto_fix: rules.auto_fix, retry: rules.retry, count_unclear: rules.count_unclear, rule: rules.rule, said: rules.said,
    hebrew_issues: hebrewRules(c.transcript), lessons: [], memory_updates: [], model: '',
  };
  if (opts.model === false) return base;
  /* a dial nobody answered has nothing to critique */
  if (!String(c.transcript || '').trim() || rules.rule === 'hangup') return base;
  const m = await modelReview(env, c, opts);
  return {
    ...base,
    hebrew_issues: [...base.hebrew_issues, ...m.hebrew_issues].slice(0, 5),
    lessons: m.lessons, memory_updates: m.memory_updates, model: m.model,
  };
}

/* the outcome vocabulary the sheet understands */
const FIX_OUTCOME = { 'מתלבט': 'מתלבט', 'לא מגיע': 'לא מגיע', [HANGUP_LABEL]: 'לא ענה' };

/* deps.writeCallResult(guestId, result, party) — index.js passes its own;
   without it the same HOOK_EVENTS post is made here. */
export async function applyReview(env, call, review, deps = {}) {
  const c = call || {}, r = review || {};
  const out = { applied: false, memory: null, slack: false };
  /* 08/11: guest calls fix themselves (CALL_QA, default on); lead calls still follow NOA_CHASE */
  const live = c.kind === 'lead' ? String((env && env.NOA_CHASE) || '') === 'on' : String((env && env.CALL_QA) || 'on') !== 'off';
  const who = `${c.agent || 'שיר'} → ${c.guest_name || c.phone || '?'}${c.event ? ' · ' + c.event : ''}`;

  if (r.verdict === 'mismatch' && r.auto_fix && FIX_OUTCOME[r.suggested]) {
    if (live && c.guest_id) {
      const base = Number(c.tries) || 0, cap = Number(c.max_tries) || 3;
      const o = FIX_OUTCOME[r.suggested];
      const result = callOutcome(o, base, cap);
      if (result) {
        /* the dial consumed an attempt (callOutcome only adds one for לא ענה) */
        if (o !== 'לא ענה') result.tries = base + 1;
        if (result.call_status === 'נדרשת שיחה' && result.tries >= cap) result.call_status = '';
        const write = deps.writeCallResult || (async (gid, res) => {
          if (!env.HOOK_EVENTS) return false;
          const x = await fetch(env.HOOK_EVENTS, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: makeWriterBody(env, env.HOOK_EVENTS, JSON.stringify({ event_type: 'call_result', guest_id: gid, rsvp: res.rsvp || '__keep__', call_status: res.call_status, answer: res.answer, tries: String(res.tries), party: '__keep__', ts: new Date().toISOString() })) }).catch(() => null);
          return !!x && x.status === 200;
        });
        out.applied = !!(await write(c.guest_id, result).catch(() => false));
        await stream(env, { kind: 'call', area: 'בקרה', action: 'תוקן אוטומטית מהתמליל', ok: out.applied, review: !out.applied,
          phone: c.phone || '', token: c.token || '',
          detail: `${who} · נרשם: ${r.recorded || 'ללא תוצאה'} → ${r.suggested} · "${String(r.said || '').slice(0, 120)}"`,
          data: { call_id: c.call_id || '', guest_id: c.guest_id, recorded: r.recorded, suggested: r.suggested, rule: r.rule, result, agent: c.agent || 'שיר' } }).catch(() => {});
      }
    } else {
      await stream(env, { kind: 'call', area: 'בקרה', action: 'פער בין התמליל לתוצאה (לא תוקן)', ok: false, review: true,
        phone: c.phone || '', token: c.token || '',
        detail: `${who} · נרשם: ${r.recorded || 'ללא תוצאה'} → מוצע: ${r.suggested} · "${String(r.said || '').slice(0, 120)}"${live ? '' : ' · תיקון אוטומטי כבוי'}`,
        data: { call_id: c.call_id || '', guest_id: c.guest_id || '', recorded: r.recorded, suggested: r.suggested, rule: r.rule, agent: c.agent || 'שיר' } }).catch(() => {});
    }
    await slackPost(env, `🔎 *בקרת שיחה · ${c.agent || 'שיר'}* — ${who}\nנרשם: ${r.recorded || 'ללא תוצאה'} · לפי התמליל: ${r.suggested}${out.applied ? ' · תוקן אוטומטית' : ' · לבדיקה'}`, { quiet: true, oneoff: true }).catch(() => {});   /* oneoff: one call reviewed (quiet: dropped unless SLACK_VERBOSE) */
    out.slack = true;
  } else if (r.verdict === 'review' && r.suggested) {
    await logEvent(env, { area: 'בקרה', action: 'שיחה לבדיקה ידנית', ok: true, review: true, phone: c.phone || '', token: c.token || '',
      detail: `${who} · נרשם: ${r.recorded || 'ללא תוצאה'} · מוצע: ${r.suggested}${r.count_unclear ? ' (כמות לא ברורה)' : ''}` }).catch(() => {});
  }

  if (Array.isArray(r.memory_updates) && r.memory_updates.length) {
    out.memory = await addMemory(env, c.agent || 'שיר', r.memory_updates, { source: 'call:' + (c.call_id || ''), by: 'בקרה', names: [c.guest_name, c.event].filter(Boolean) });
  }
  if ((r.lessons && r.lessons.length) || (r.hebrew_issues && r.hebrew_issues.length)) {
    await stream(env, { kind: 'event', area: 'בקרה', action: `לקחים משיחה · ${c.agent || 'שיר'}`, ok: true, phone: c.phone || '', token: c.token || '',
      detail: [...(r.hebrew_issues || []).map(x => 'עברית: ' + x), ...(r.lessons || []).map(x => 'לקח: ' + x)].join(' | ').slice(0, 1200),
      data: { call_id: c.call_id || '', agent: c.agent || 'שיר', verdict: r.verdict, lessons: r.lessons, hebrew_issues: r.hebrew_issues, memory: out.memory, model: r.model || '' } }).catch(() => {});
  }
  return out;
}

/* the webhook's call → the shape reviewCall wants. Pure. */
export function callFromRetell(call, action, opts = {}) {
  const c = call || {}, meta = c.metadata || {}, dv = c.retell_llm_dynamic_variables || {};
  const isNoa = meta.line === 'noa' || meta.kind === 'lead';
  return {
    agent: isNoa ? 'נועה' : 'שיר',
    kind: String(meta.kind || ''),
    call_id: String(c.call_id || ''),
    transcript: String(c.transcript || ''),
    outcome: action && action.result ? String(action.result.rsvp || '') : '',
    answer: action && action.result ? String(action.result.answer || '') : '',
    duration_s: c.start_timestamp && c.end_timestamp ? Math.round((c.end_timestamp - c.start_timestamp) / 1000) : null,
    guest_name: String(dv.guest_name || dv.lead_name || dv.caller_name || '').trim(),
    event: String(opts.event || dv.event_name || dv.host_name || '').trim(),
    guest_id: String(meta.guest_id || ''), token: String(meta.token || ''),
    tries: Number(meta.tries) || 0, max_tries: Number(meta.max_tries) || 3,
    phone: String(c.to_number || c.from_number || '').replace('+', ''),
    kind: String(meta.kind || 'guest'),
  };
}
