/* ============================================================================
   ishur.io · inbound.js · small, pure rules for the client/lead side (02/11)
   ----------------------------------------------------------------------------
   Pulled out of index.js so they can be tested without a Worker:
     · isAppAutoReply()   — the WhatsApp Business app's away/greeting message
                            comes back as an echo, exactly like Richard typing.
     · chaseStopReason()  — whether the "לא סיימת" sequence must stop for a lead.
     · leadAlertHeader()  — the Slack title for a lead that may already exist.
   ========================================================================== */

/* The away message configured in the WhatsApp Business app on 4499. Meta
   delivers it as an smb_message_echoes echo, ~0.5 s BEFORE the inbound that
   triggered it (02/11 15:38:26 / 16:42:35), with nothing in the payload that
   tells it apart from a human reply. Matched by its fixed opening; if the
   text in the app changes, WA_APP_AUTOREPLY (a regex source) overrides it. */
export const APP_AUTOREPLY_DEFAULT = '^\\s*היי 🙂 הגעתם לאישורי הגעה';
export function isAppAutoReply(text, env) {
  const t = String(text || '');
  if (!t) return false;
  let re;
  try { re = new RegExp((env && env.WA_APP_AUTOREPLY) || APP_AUTOREPLY_DEFAULT, 'u'); } catch { re = new RegExp(APP_AUTOREPLY_DEFAULT, 'u'); }
  return re.test(t);
}

/* Inbound counts as "they are talking to us" from a little BEFORE the lead
   record's own clock: a WhatsApp-first lead's message is logged ~1 s before
   noteLead stamps rec.at (Maya 02/11: inbound 10:24:06.939, rec.at
   10:24:07.953), and the old strict ">" let the chase fire 41 minutes later. */
export const REPLY_GRACE_MS = 10 * 60 * 1000;

/* conv:<phone> as touchConversation keeps it. last_in_ts exists since 02/11;
   older records only know the LAST message, which an echo (Richard, or the
   app's away message) overwrites with dir 'out'. */
export function lastInboundTs(conv) {
  if (!conv || typeof conv !== 'object') return 0;
  if (Number(conv.last_in_ts)) return Number(conv.last_in_ts);
  return conv.last_dir === 'in' ? Number(conv.last_ts) || 0 : 0;
}

/* '' = keep chasing; anything else = settle the lead with that reason.
   rec: the lead:<phone> record; conv: conv:<phone>; human: the human:/aioff:
   marker value (truthy when somebody took the chat from the phone/inbox). */
export function chaseStopReason({ rec, conv, human }) {
  if (!rec) return '';
  /* they wrote to us first on WhatsApp: "ראינו שהתחלתם להזמין … ולא סיימתם"
     is simply false for them, and a person is already in the conversation */
  if ((rec.types || []).includes('whatsapp_in') || rec.page === 'whatsapp') return 'whatsapp-first';
  if (human) return 'human';
  const since = Date.parse(rec.at || '1970-01-01') - REPLY_GRACE_MS;
  const inTs = lastInboundTs(conv);
  if (inTs && inTs > since) return 'answered';
  return '';
}

/* Slack title for a lead event, honest about whether we already knew them */
export function leadAlertHeader(source, known) {
  const src = source === 'meta' ? 'מטופס מטא' : source === 'whatsapp' ? 'מוואטסאפ (נועה 4499)' : '';
  if (known === 'client') return `🔁 *לקוח קיים ${source === 'meta' ? 'מילא טופס מטא' : 'כתב'}*`;
  if (known === 'lead') return `🔁 *ליד קיים ${source === 'meta' ? 'מילא טופס מטא' : 'חזר'}* (כבר במערכת)`;
  if (known === 'monday') return `🆕 *ליד ${src}* (כבר היה במאנדיי, עודכן)`;
  return `🆕 *ליד חדש ${src}*`;
}
