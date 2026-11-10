/* ============================================================================
   ishur.io · wavenote.js · "נשלח לאורחים" — one Slack note per round per day
   ----------------------------------------------------------------------------
   Richard 10/11: "בכל יציאת סבב, לא משנה איזה אירוע, תשלח לסלאק את הנוסח המדויק
   יחד עם כותרת: נשלח לאורחים · גל 1/גל 2/תזכורת/תודה · שם אירוע — עם הטקסט
   המדויק שנשלח והתמונה, ללא כפתורים. פעם אחת ביום לכל סבב של כל אירוע."

   Hooked from whatsapp.js sendTemplate after the FIRST successful guest send:
   noteDailySend(env, { token, template, params, imageUrl, wave })
     → KV wnote:<token>:<kind>:<day> (TTL 2 days) makes it once a day per round
     → the template wording comes from Meta (cached tmpltext:<name>, 6h), the
       {{n}} slots are filled with the exact parameters the first guest got
     → Slack: a header line, the wording as a quote, the artwork as an image
       block (or a link for a video), buttons deliberately left out
   Pure parts (kindOf, fillBody, buildNote) are exported for the tests.
   ============================================================================ */
import { slackSend } from './slack.js';

const GUESTS_WABA = '1378764257421712';

/* the round's Hebrew label: what Richard reads first */
export function kindOf({ template, wave }) {
  const w = String(wave == null ? '' : wave);
  const t = String(template || '');
  if (w === '1') return { key: 'w1', he: 'גל 1' };
  if (w === '2') return { key: 'w2', he: 'גל 2 · תזכורת' };
  if (w === '3') return { key: 'w3', he: 'גל 3' };
  if (w === 'daybefore' || /^ishur_lifnei_|^ishur_yom_lifnei/.test(t)) return { key: 'daybefore', he: 'תזכורת יום לפני' };
  if (w === 'seating' || /^ishur_shulchan|^ishur_yom_(combo|plain)_t/.test(t)) return { key: 'table', he: 'מספרי שולחנות' };
  if (w === 'eventday' || /^ishur_yom_/.test(t)) return { key: 'eventday', he: 'יום האירוע' };
  if (w === 'gift' || /^ishur_matana/.test(t)) return { key: 'gift', he: 'קישור מתנה' };
  if (/^ishur_toda/.test(t)) return { key: 'thanks', he: 'תודה' };
  if (/^ishur_bitul/.test(t)) return { key: 'cancel', he: 'ביטול' };
  if (/hazmana/.test(t)) return { key: 'w1', he: 'גל 1' };
  return null;                                  /* OTPs, probes, unknown: no note */
}

/* {{1}}..{{n}} → the exact values the guest received */
export function fillBody(body, params) {
  return String(body || '').replace(/\{\{(\d+)\}\}/g, (_, n) => {
    const v = (params || [])[Number(n) - 1];
    return v == null || v === '' ? `{{${n}}}` : String(v);
  });
}

/* Meta's approved wording for a template (BODY + a TEXT header + footer; buttons ignored) */
export async function templateTextOf(env, name, deps = {}) {
  const ck = 'tmpltext:' + name;
  if (env.RATE) { try { const c = JSON.parse((await env.RATE.get(ck)) || 'null'); if (c && c.body != null) return c; } catch {} }
  const tok = env.WA_TOKEN_GUESTS; if (!tok) return null;
  const f = deps.fetch || fetch;
  try {
    const r = await f(`https://graph.facebook.com/v21.0/${GUESTS_WABA}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,components`, { headers: { Authorization: 'Bearer ' + tok } });
    const j = await r.json(); const x = (j.data || []).find(y => y.name === name);
    if (!x) return null;
    const comps = x.components || [];
    const head = comps.find(c => c.type === 'HEADER') || {};
    const t = {
      name, status: x.status || '', category: x.category || '',
      header: head.format === 'TEXT' ? head.text || '' : head.format ? '[' + head.format + ']' : '',
      body: (comps.find(c => c.type === 'BODY') || {}).text || '',
      footer: (comps.find(c => c.type === 'FOOTER') || {}).text || '',
      buttons: ((comps.find(c => c.type === 'BUTTONS') || {}).buttons || []).map(z => z.text),
    };
    if (env.RATE) await env.RATE.put(ck, JSON.stringify(t), { expirationTtl: 6 * 3600 }).catch(() => {});
    return t;
  } catch { return null; }
}

/* the Slack payload: text (fallback / notifications) + blocks. No buttons. */
export function buildNote({ kindHe, evName, tmpl, params, imageUrl, template }) {
  const title = `נשלח לאורחים · ${kindHe} · ${evName}`;
  const body = tmpl ? fillBody(tmpl.body, params) : `(הנוסח של ${template} לא נמצא במטא — המשתנים: ${(params || []).join(' · ')})`;
  const header = tmpl && tmpl.header && !/^\[/.test(tmpl.header) ? fillBody(tmpl.header, params) : '';
  const quote = [header, body, tmpl && tmpl.footer ? tmpl.footer : ''].filter(Boolean).join('\n\n');
  const isVideo = !!imageUrl && /\/vid\/|\.mp4(\?|$)/i.test(String(imageUrl));
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: quote.split('\n').map(l => '>' + l).join('\n').slice(0, 2900) } },
  ];
  if (imageUrl && !isVideo) blocks.push({ type: 'image', image_url: String(imageUrl), alt_text: 'ההזמנה שנשלחה' });
  else if (imageUrl) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🎬 סרטון: ${imageUrl}` }] });
  const text = `*${title}*\n\n${quote}` + (imageUrl ? `\n\n${isVideo ? '🎬' : '🖼'} ${imageUrl}` : '');
  return { title, text, blocks };
}

function ilDay(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now); }

/* the hook. Never throws; never blocks the send. */
export async function noteDailySend(env, { token, template, params, imageUrl, wave }, deps = {}) {
  try {
    if (!env || !env.RATE || !token || !env.SLACK_ALERT_HOOK) return { skipped: 'not-configured' };
    const kind = kindOf({ template, wave }); if (!kind) return { skipped: 'no-kind' };
    const day = ilDay(deps.now ? new Date(deps.now) : new Date());
    const key = `wnote:${token}:${kind.key}:${day}`;
    if (await env.RATE.get(key)) return { skipped: 'already' };
    await env.RATE.put(key, new Date().toISOString(), { expirationTtl: 2 * 86400 });
    const evName = deps.eventName ? await deps.eventName(env, token).catch(() => '') : '';
    const tmpl = await templateTextOf(env, template, deps);
    const note = buildNote({ kindHe: kind.he, evName: evName || ('אירוע ' + String(token).slice(0, 8)), tmpl, params, imageUrl, template });
    await (deps.slackSend || slackSend)(env, note.text, { blocks: note.blocks, important: true, oneoff: true, urgent: true, key: 'wavenote' });
    return { posted: true, key, title: note.title };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
