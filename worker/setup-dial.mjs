/* ============================================================================
   ishur.io · the dial bridge agent (02/11, noa-chase R7) — NOT RUN YET
   ----------------------------------------------------------------------------
   One tiny Retell agent whose only job: answer the call we place to the REP
   (שלו / ריצארד), say one sentence, and warm-transfer to the lead's number.
   No sales, no questions, no AI in the conversation with the lead.

     RETELL_KEY=key_xxx node setup-dial.mjs
     → prints agent_id; then:  npx wrangler secret put DIAL_BRIDGE_AGENT
       and set DIAL_ENABLED = "on" in wrangler.toml [vars] when Richard says so.

   Safe to re-run: creates fresh resources, deletes nothing. Field names per
   Retell v2 as of 11/2026; a wrong field name is printed verbatim below.
   dial.js sends per call:
     retell_llm_dynamic_variables { rep_name, lead_name, lead_phone (+972…),
                                    lead_phone_spoken }
     metadata { kind:'dial', who, item, phone, lead_name, agent }
   ========================================================================== */

const KEY = process.env.RETELL_KEY;
if (!KEY) { console.error('RETELL_KEY missing. Run: RETELL_KEY=key_xxx node setup-dial.mjs'); process.exit(1); }

const WORKER = 'https://ishur-webhooks.richardtomskiy.workers.dev';
const VOICE_ID = process.env.DIAL_VOICE || '11labs-Kate';   /* Noa's voice: the rep already knows it */
const MODEL = process.env.DIAL_MODEL || 'gpt-4.1';

/* The whole prompt. The sentence is the disclosure the spec requires
   ("השיחה מוקלטת לשיפור השירות") — said to the rep, before the lead joins. */
const PROMPT = `את גשר חיוג של "אישורי הגעה". את מדברת עם {{rep_name}} מהצוות, לא עם לקוח.
אמרי משפט אחד בלבד, מילה במילה: "מחברת אותך ל{{lead_name}}, השיחה מוקלטת לשיפור השירות."
ומיד קראי לכלי connect_lead. בלי שאלות, בלי להמתין לתשובה, בלי שום משפט נוסף.
אם הכלי נכשל (הליד לא ענה / תפוס): "{{lead_name}} לא ענה, מסיימת." ואז end_call.
עברית בלבד. את אישה.`;

/* warm transfer to the number carried in the call's own variables.
   'inferred' lets the destination come from the prompt, so one agent serves
   every lead. The private whisper is empty on purpose: the rep already heard
   the sentence above before the lead rang. */
const CONNECT = {
  type: 'transfer_call',
  name: 'connect_lead',
  description: 'מחבר את הנציג לליד. לקרוא מיד אחרי המשפט היחיד.',
  speak_during_execution: false,
  speak_after_execution: false,
  transfer_destination: { type: 'inferred', prompt: 'Transfer to the phone number {{lead_phone}} exactly as given, in E.164.' },
  transfer_option: {
    type: 'warm_transfer',
    agent_detection_timeout_ms: 30000,
    on_hold_music: 'none',
    opt_out_human_detection: true,          /* the lead is a person; do not wait for "hello" detection */
    show_transferee_as_caller: false,       /* the lead sees NOA_FROM (055-507-7733), per spec */
    private_handoff_option: { type: 'static_message', message: '' },
    enable_bridge_audio_cue: false,
  },
};

async function api(path, payload) {
  const r = await fetch('https://api.retellai.com' + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`✗ ${path} → ${r.status}\n${JSON.stringify(body, null, 2)}`); process.exit(1); }
  return body;
}

const llm = await api('/create-retell-llm', {
  model: MODEL,
  general_prompt: PROMPT,
  general_tools: [CONNECT, { type: 'end_call', name: 'end_call', description: 'לסיים אחרי "לא ענה".' }],
  /* the rep answers → the bridge speaks first, no waiting for "הלו" */
  begin_message: 'מחברת אותך ל{{lead_name}}, השיחה מוקלטת לשיפור השירות.',
});
console.log('✓ Retell LLM:', llm.llm_id);

const agent = await api('/create-agent', {
  agent_name: 'גשר חיוג · ishur.io',
  response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
  voice_id: VOICE_ID,
  language: 'he-IL',
  webhook_url: WORKER + '/api/shir-webhook',     /* same webhook: call_analyzed → audit.keepCall → /rec/<id> */
  enable_backchannel: false,
  interruption_sensitivity: 0.3,
  max_call_duration_ms: 45 * 60 * 1000,          /* a rep call may run long after the transfer */
  end_call_after_silence_ms: 60000,
});
console.log('✓ Agent:', agent.agent_id);

console.log(`
──────────────────────────────────────────────
  npx wrangler secret put DIAL_BRIDGE_AGENT   ← ${agent.agent_id}
  wrangler.toml [vars]: DIAL_ENABLED = "on"   ← only after P7 passes
  secrets: SHALEV_PHONE, SHALEV_PHONE_2, RICHARD_PHONE (E.164)
Test (R6/P7): open the link from dialLinkFor() for a test item whose phone
is Richard's; the rep phone rings, then the lead; /rec/<call_id> must hold
the part AFTER the transfer. If it does not, Retell drops the recording on
transfer and the Telnyx bridge is the next step — do not enable DIAL.
──────────────────────────────────────────────`);
