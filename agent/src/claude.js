/* ishur-agent · Claude Messages API tool-use loop (raw fetch, no SDK: the
   ishur workers have no SDK dependency and call every API with fetch) */
import { claudeToolDefs } from './tools.js';
import { gateTool } from './gate.js';

export const MODEL = 'claude-opus-5-5';
export const MAX_ITERATIONS = 6;
const RESULT_MAX_CHARS = 12000;

export const SYSTEM_PROMPT = `אתה קלוד, העובד של ishur.io (אישורי הגעה בוואטסאפ), בערוץ הסלאק #ishur-hagaa.
ריצארד הוא הבעלים. שלו היא שותפה (נקבה: פנה אליה בלשון נקבה).

סגנון תשובה (חובה):
- עברית, 2 עד 4 שורות, התוצאה בשורה הראשונה.
- דווח רק מה שבדקת בכלים ומה יצא בפועל. בלי "אמור לעבוד". אם משהו לא נבדק, אמור זאת.
- אל תשתמש במילה "הנחה"; אומרים "מבצע חורף".

כלים: כל כלי מסומן [green] / [yellow] / [red]. ההרשאות נאכפות בקוד, לא על ידך:
- red לא מתבצע אף פעם מיד: נוצרת בקשת אישור עם כפתור "אשר" שרק ריצארד יכול ללחוץ. אם קיבלת pending_approval, כתוב שהבקשה ממתינה לאישור ריצארד.
- אם קיבלת blocked, הסבר בקצרה שהפעולה חסומה ולמה.
- לשאלה "מה יוצא מחר?" השתמש קודם ב-automations; אם הוא לא זמין (404) השתמש ב-daily_run_dry עם today של מחר וציין זאת.
- לעולם אל תשלח הודעה לאורח/לקוח/ליד בלי כלי red מאושר.`;

function truncate(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > RESULT_MAX_CHARS ? s.slice(0, RESULT_MAX_CHARS) + '…[truncated]' : s;
}

export async function callMessages(env, body, f = fetch) {
  const r = await f('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': String(env.ANTHROPIC_API_KEY || ''),
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error('anthropic ' + r.status + ' ' + JSON.stringify(j || {}).slice(0, 300));
  return j;
}

/* messages: Anthropic-format conversation ending with a user turn.
   ctx is passed to the gate (requester, channel, thread_ts, actions, approvals, fetch). */
export async function runAgent(env, messages, ctx) {
  const f = ctx.fetch || fetch;
  const tools = claudeToolDefs();
  const convo = messages.slice();
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await callMessages(env, {
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: 'auto' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      messages: convo,
    }, f);
    if (resp.stop_reason === 'refusal') return { text: 'לא יכולתי לענות על זה. נסו לנסח אחרת.', iterations: i + 1, stop: 'refusal' };
    /* keep the assistant content unchanged (thinking blocks must be passed back as-is) */
    convo.push({ role: 'assistant', content: resp.content });
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (resp.stop_reason !== 'tool_use') return { text, iterations: i + 1, stop: resp.stop_reason };
    const results = [];
    for (const b of resp.content.filter(x => x.type === 'tool_use')) {
      let out, isErr = false;
      try { out = await gateTool(env, ctx, b.name, b.input || {}); }
      catch (e) { out = { error: String(e && e.message) }; isErr = true; }
      if (out && (out.error || out.blocked)) isErr = true;
      results.push({ type: 'tool_result', tool_use_id: b.id, content: truncate(out), ...(isErr ? { is_error: true } : {}) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { text: 'עצרתי אחרי מספר הצעדים המרבי בלי תשובה סופית. נסו שאלה ממוקדת יותר.', iterations: MAX_ITERATIONS, stop: 'max_iterations' };
}

/* 2–4 lines, result first; the yellow footer is appended by code, not the model */
export function formatReply(text, actions = []) {
  const lines = String(text || '').split('\n').map(s => s.trimEnd()).filter(s => s.trim());
  const body = lines.slice(0, 4).join('\n') || 'אין תשובה.';
  const foot = actions.map(a => `🟡 בוצע: \`${a.tool}\` ${JSON.stringify(a.args).slice(0, 150)} · ${a.ok ? 'הצליח' : 'נכשל'} (HTTP ${a.http_status ?? '?'})`);
  return [body, ...foot].join('\n');
}
