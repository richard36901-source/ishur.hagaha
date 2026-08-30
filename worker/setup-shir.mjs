/* ============================================================================
   ishur.io · הקמת שיר ב-Retell בפקודה אחת
   ----------------------------------------------------------------------------
   Run on demo day, once Richard's API key exists:

     RETELL_KEY=key_xxx node setup-shir.mjs

   Creates the Retell LLM (Hebrew prompt + the record_rsvp_outcome tool wired
   to our Worker) and the agent (Hebrew ElevenLabs voice), then prints the
   agent id and how to open a browser test call. Safe to re-run: it always
   creates fresh resources and prints their ids — nothing is deleted.

   Field names follow Retell's v2 API as researched 08/2026; if the API has
   drifted, the error body printed below says exactly which field to rename.
   ========================================================================== */

const KEY = process.env.RETELL_KEY;
if (!KEY) { console.error('RETELL_KEY missing. Run: RETELL_KEY=key_xxx node setup-shir.mjs'); process.exit(1); }

const WORKER = 'https://ishur-webhooks.richardtomskiy.workers.dev';
const VOICE_ID = process.env.SHIR_VOICE || '11labs-Dorothy'; // placeholder — pick the Hebrew female voice in the dashboard voice gallery and rerun with SHIR_VOICE=
const MODEL = process.env.SHIR_MODEL || 'gpt-5-mini';

const PROMPT = `את שיר, נציגה של שירות "אישורי הגעה" המתקשרת מטעם בעלי אירוע.
את מדברת עברית בלבד, בטון חם, טבעי וקליל — כמו נציגה אנושית צעירה ונעימה. משפטים קצרים.

חוקי ברזל:
- את אישה — הקפידי על הטיות נקבה ("אני מתקשרת", "אני רושמת").
- פני למי שענה בלשון רבים כשלא ברור ("תגיעו?").
- אל תמציאי פרטים. יש לך רק את מה שבמשתנים.
- אם שואלים אם את בוט: "כן, אני עוזרת דיגיטלית של אישורי הגעה, אבל אני פה בשביל לעזור באמת" — בלי להתנצל שוב.
- מבקשים לא להתקשר יותר → אשרי מיד וקראי לכלי עם outcome="לא להתקשר".
- ילד/מבולבל → סיימי בנימוס, outcome="לחייג שוב".
- כעס או שיחה תקועה → "אין בעיה, נציג אנושי יחזור אליכם", outcome="לחייג שוב".
- חובה לקרוא לכלי record_rsvp_outcome בדיוק פעם אחת לפני סיום.
- יעד: עד דקה וחצי.

פתיחה (אחרי "הלו"):
"היי, מדברת שיר מאישורי הגעה, מתקשרת בשם {{host_name}} לגבי {{occasion}} של {{event_name}} ב-{{event_date_spoken}}. שלחנו הזמנה בוואטסאפ ולא ראינו תשובה, אז רציתי לבדוק — תוכלו להגיע?"

מהלך:
- "כן" → "מעולה! כמה תהיו?" → כלי: outcome="מגיע", party_size=המספר → "רשמתי, נתראה בשמחות!"
- "לא" → "חבל, אבל תודה שעדכנתם!" → outcome="לא מגיע"
- מתלבטים → "אין לחץ, אפשר לעדכן בוואטסאפ שקיבלתם" → outcome="מתלבט"
- שאלות (שעה/מקום): עני רק ממה שיש — "{{reception_time}} ב{{venue_name}}, {{venue_city}}".`;

const TOOL = {
  type: 'custom',
  name: 'record_rsvp_outcome',
  description: 'רישום תוצאת השיחה ברגע שהיא ברורה. חובה לקרוא בדיוק פעם אחת לפני סיום.',
  url: WORKER + '/api/shir-webhook',
  speak_during_execution: false,
  speak_after_execution: true,
  parameters: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['מגיע', 'לא מגיע', 'מתלבט', 'לחייג שוב', 'לא להתקשר'] },
      party_size: { type: 'integer', description: 'כמה מגיעים, רק כש-outcome=מגיע' },
      note: { type: 'string', description: 'הקשר קצר אם היה משהו חריג' },
    },
    required: ['outcome'],
  },
};

async function api(path, payload) {
  const r = await fetch('https://api.retellai.com' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`✗ ${path} → ${r.status}\n${JSON.stringify(body, null, 2)}`);
    process.exit(1);
  }
  return body;
}

const llm = await api('/create-retell-llm', {
  model: MODEL,
  general_prompt: PROMPT,
  general_tools: [TOOL],
  begin_message: '', // Shir waits for "הלו" and then opens
});
console.log('✓ Retell LLM:', llm.llm_id);

const agent = await api('/create-agent', {
  agent_name: 'שיר · ishur.io',
  response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
  voice_id: VOICE_ID,
  language: 'multi', // Hebrew rides on the multilingual pipeline
  webhook_url: WORKER + '/api/shir-webhook',
  enable_backchannel: true,
  interruption_sensitivity: 0.9,
});
console.log('✓ Agent:', agent.agent_id);

console.log(`
──────────────────────────────────────────────
הדמו: Retell Dashboard → Agents → "שיר · ishur.io" → Test (שיחת דפדפן).
אחרי אישור הקול:
  npx wrangler secret put RETELL_KEY     ← אותו מפתח
  npx wrangler secret put SHIR_FROM      ← מספר ה-055 אחרי הניוד
ולחבר את המספר לסוכנת ב-Dashboard → Phone Numbers.
agent_id: ${agent.agent_id}
──────────────────────────────────────────────`);
