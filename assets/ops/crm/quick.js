/* ishur ops · quick close (lead drawer): package / records / date / add-ons → live total → pay link →
   editable WhatsApp message → "שלח דרך נועה" (or a template outside the 24h window) / copy.
   Prices come ONLY from IshurPayLinkGen.price() over config.js (the same tables the admin generator
   and the Worker use); per-add-on prices are differences of that same function. The server's sum is
   the one on the link. Layout follows Richard's 03/11 form rule: one field per row, label above,
   order name → phone → occasion → date → package → records → add-ons → total → action. */
import { esc, Select, Button, busy, toast, confirmTyped, DatePicker } from '../ui.js';
import { money, phoneHe } from './kit.js';
import { PLAN_HE } from './adapt.js';

const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
export async function ensurePricing() {
  if (!globalThis.ISHUR_CONFIG) await loadScript('config.js?v=72');
  if (!globalThis.IshurPayLinkGen) await loadScript('assets/paylink-gen.js?v=2');
  return { cfg: globalThis.ISHUR_CONFIG, G: globalThis.IshurPayLinkGen };
}
const ilHour = (now = Date.now()) => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now));
export const quietHours = (now) => { const h = ilHour(now); return h >= 21 || h < 9; };
const tiers = (cfg) => Object.keys(cfg.PRICE_TABLE || {}).map(Number).sort((a, b) => a - b);

export function qcState(lead, cfg) {
  const ts = tiers(cfg), rec = ts.find((t) => t >= (lead.records || 0)) || ts[ts.length - 1] || 100;
  const occ = (cfg.OCCASIONS || []).find((o) => o.value === lead.occasion);
  return { plan: (occ && occ.rec) || 'basic', records: rec, event_date: lead.event_date || '', hostesses: 0, design: false, calls: false, extra_wave: false, url: '', quote_id: null, sum: null, msg: '', needs_template: false, templates: [], tpl: '', sent: false };
}
const priceOf = (q, cfg, G) => G.price({ plan: q.plan, records: q.records, hostesses: q.hostesses, design: q.design, calls: q.calls, extra_wave: q.extra_wave, travel: false }, cfg);
export const qcTotal = (q, cfg, G) => priceOf(q, cfg, G).total;
/* the price a single add-on adds on top of the bare package (0 = included in this plan) */
const addPrice = (q, cfg, G, patch) => priceOf({ ...q, hostesses: 0, design: false, calls: false, extra_wave: false, ...patch }, cfg, G).total - priceOf({ ...q, hostesses: 0, design: false, calls: false, extra_wave: false }, cfg, G).total;
export function suggested(lead, q, url) {
  const first = (lead.name || '').split(' ')[0];
  const extras = [q.hostesses ? (q.hostesses === 1 ? 'דיילת' : q.hostesses + ' דיילות') : '', q.design ? 'עיצוב הזמנה' : '', q.extra_wave ? 'גל תזכורת נוסף' : ''].filter(Boolean);
  return `היי${first ? ' ' + first : ''}, בהמשך לשיחה שלנו, זה הקישור לתשלום על ${PLAN_HE[q.plan] || q.plan} עד ${q.records} רשומות${extras.length ? ' + ' + extras.join(' + ') : ''}:\n${url}\nמיד אחרי התשלום מגיע קישור להעלאת הרשימה.`;
}

const row = (label, field, id = '') => `<div class="f-row"><label class="f-l"${id ? ` for="${id}"` : ''}>${esc(label)}</label><div class="f-v">${field}</div></div>`;
const ro = (v) => `<div class="f-ro" dir="auto">${esc(v || '—')}</div>`;
const tg = (k, label, on, price, disabled = false) => `<button type="button" class="ck-row" role="checkbox" aria-checked="${on && !disabled ? 'true' : 'false'}" data-act="qc-tg" data-k="${k}"${disabled ? ' aria-disabled="true"' : ''}><span class="ck" aria-hidden="true"><span>${on && !disabled ? '✓' : ''}</span></span><span class="lbl">${esc(label)}</span><span class="price num">${price}</span></button>`;

export function qcView(q, lead, cfg, G, { now = Date.now() } = {}) {
  const ts = tiers(cfg), hp = {}; ((cfg.HOSTESS && cfg.HOSTESS.tiers) || []).forEach((t) => (hp[t.count] = t.price));
  const callsP = addPrice(q, cfg, G, { calls: true }), total = qcTotal(q, cfg, G), quiet = quietHours(now);
  const hostSeg = `<div class="seg qc-host" role="radiogroup" aria-label="דיילות">${[0, 1, 2].map((n) => `<button type="button" role="radio" data-act="qc-host" data-n="${n}" aria-checked="${q.hostesses === n}" aria-selected="${q.hostesses === n}"${n && !hp[n] ? ' aria-disabled="true"' : ''}>${n === 0 ? 'בלי' : n === 1 ? 'דיילת' : '2 דיילות'}</button>`).join('')}</div>`;
  let out = `<section class="crm-sec qc" id="qc" aria-label="סגירה מהירה"><div class="sec-h"><h3 class="h2">סגירה מהירה</h3><span class="sp"></span>${lead.window_open ? '<span class="badge good"><span aria-hidden="true">●</span>בחלון 24 שעות</span>' : '<span class="badge warn" title="אין הודעה נכנסת ב-24 השעות האחרונות"><span aria-hidden="true">◐</span>מחוץ לחלון · תבנית</span>'}</div>
<div class="form">
${row('שם הלקוח', ro(lead.name))}${row('טלפון', `<div class="f-ro mono" dir="ltr">${esc(phoneHe(lead.phone))}</div>`)}${row('סוג אירוע', ro(lead.occasion_he))}
${row('תאריך האירוע', DatePicker({ id: 'qc-date', value: q.event_date || '', label: 'תאריך האירוע', attr: { 'data-q': 'event_date' } }), 'qc-date')}
${row('חבילה', Select({ name: 'q_plan', value: q.plan, options: ['basic', 'pro', 'premium'].map((k) => ({ value: k, label: PLAN_HE[k] + ' · ' + money(((cfg.PRICE_TABLE || {})[q.records] || {})[k]) })) }))}
${row('רשומות', Select({ name: 'q_records', value: q.records, options: ts.map((n) => ({ value: n, label: 'עד ' + n + ' רשומות' })) }))}
<div class="f-row"><span class="f-l" id="qc-add-l">תוספות</span><div class="f-v checklist" role="group" aria-labelledby="qc-add-l">
<div class="ck-row static"><span class="lbl">דיילות באירוע</span>${hostSeg}<span class="price num">${q.hostesses ? money(hp[q.hostesses]) : '—'}</span></div>
${tg('design', 'עיצוב הזמנה', q.design, money(addPrice(q, cfg, G, { design: true })))}
${tg('calls', 'סבב שיחות AI למי שלא ענה', q.calls, callsP ? money(callsP) : 'כלול בחבילה', !callsP)}
${tg('extra_wave', 'גל תזכורת שלישי', q.extra_wave, money(addPrice(q, cfg, G, { extra_wave: true })))}
</div></div>
<div class="qc-total"><span>סה״כ</span><b class="num" data-qc-total>${money(total)}</b></div>
<div class="sub">הסכום על הקישור מחושב בשרת מאותן טבלאות${q.sum != null && q.sum !== total ? ` · <b style="color:var(--crit-ink)">השרת: ${money(q.sum)}</b>` : ''}</div>
${q.url ? '' : `<div class="f-act">${Button('צור קישור', { variant: 'primary', size: 'lg', act: 'qc-make', disabled: !total })}</div>`}
</div>`;
  if (q.url) {
    out += `<div class="qc-out"><div class="f-row"><span class="f-l">קישור לתשלום</span><div class="f-v"><div class="link-box"><span class="mono" dir="ltr">${esc(q.url)}</span>${Button('העתקה', { size: 'sm', act: 'qc-copy-url' })}</div></div></div>
<div class="f-row"><label class="f-l" for="qc-msg">הודעה מוצעת (אפשר לערוך)</label><div class="f-v"><textarea id="qc-msg" class="in ta" rows="5" dir="auto" data-q="msg">${esc(q.msg)}</textarea></div></div>`;
    if (q.sent) out += `<div class="okbox" role="status"><span aria-hidden="true">✓</span>נשלח דרך נועה · הסטטוס עודכן ל"הצעה נשלחה"</div>`;
    else if (q.needs_template) {
      out += `<div class="f-row"><span class="f-l" id="qc-tpl-l">מחוץ לחלון 24 השעות. בחרו תבנית מאושרת</span><div class="f-v tpl-list" role="radiogroup" aria-labelledby="qc-tpl-l">${q.templates.map((t) => `<button type="button" role="radio" class="tpl" data-act="qc-tpl" data-name="${esc(t.name)}" aria-checked="${q.tpl === t.name}"><b>${esc(t.label)}</b><span class="ink2" dir="auto">${esc(t.preview)}</span></button>`).join('') || '<div class="empty">אין תבניות מאושרות</div>'}</div></div>`;
    }
    out += quiet && !q.sent ? '<div class="sub warnline">שעות שקטות (21:00–09:00): לא שולחים ללידים עכשיו. אפשר להעתיק ולשלוח בבוקר.</div>' : '';
    out += `<div class="f-act">${q.sent ? '' : Button(q.needs_template ? 'שלח תבנית דרך נועה' : 'שלח דרך נועה', { variant: 'primary', size: 'lg', act: 'qc-send', disabled: quiet || (q.needs_template && !q.tpl) })}${Button('העתקת הודעה', { size: 'lg', act: 'qc-copy-msg' })}${Button('קישור חדש', { variant: 'ghost', size: 'lg', act: 'qc-reset' })}</div></div>`;
  }
  return out + '</section>';
}

/* mount into `host`; api = crm(ctx); onStatus(status) after a send */
export async function mountQuick(host, { lead, api, onStatus }) {
  const { cfg, G } = await ensurePricing();
  let q = qcState(lead, cfg);
  const paint = () => { host.innerHTML = qcView(q, lead, cfg, G); };
  const stale = () => { if (q.url && !q.sent) { q.url = ''; q.quote_id = null; q.sum = null; q.needs_template = false; } };
  const copy = async (txt, btn) => { try { await navigator.clipboard.writeText(txt); const h = btn.innerHTML; btn.innerHTML = '✓ הועתק'; setTimeout(() => { btn.innerHTML = h; }, 1400); } catch (e) { toast('ההעתקה לא עבדה, סמנו והעתיקו ידנית', 'crit'); } };
  host.addEventListener('ops:change', (e) => { if (e.detail.name === 'q_plan') q.plan = e.detail.value; else if (e.detail.name === 'q_records') q.records = Number(e.detail.value); else return; stale(); paint(); });
  host.addEventListener('input', (e) => { const k = e.target.dataset && e.target.dataset.q; if (k === 'msg') q.msg = e.target.value; else if (k === 'event_date') { q.event_date = e.target.value; if (q.url && !q.sent) { stale(); paint(); } } });
  host.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !host.contains(b) || b.getAttribute('aria-disabled') === 'true') return;
    const a = b.dataset.act;
    if (a === 'qc-tg') { q[b.dataset.k] = !q[b.dataset.k]; stale(); paint(); }
    else if (a === 'qc-host') { q.hostesses = Number(b.dataset.n); stale(); paint(); }
    else if (a === 'qc-tpl') { q.tpl = b.dataset.name; paint(); }
    else if (a === 'qc-reset') { stale(); q.sent = false; paint(); }
    else if (a === 'qc-copy-url') copy(q.url, b);
    else if (a === 'qc-copy-msg') copy(q.msg, b);
    else if (a === 'qc-make') {
      await busy(b, async () => { const r = await api.quote(lead, q); if (!r || !r.url) throw new Error('no-url'); q.url = r.url; q.quote_id = r.quote_id; q.sum = r.sum; q.msg = r.suggested_text || suggested(lead, q, r.url); }).then(paint, (x) => toast('לא נוצר קישור' + (x && x.message ? ': ' + x.message : ''), 'crit'));
    } else if (a === 'qc-send') {
      await busy(b, async () => {
        const msg = q.needs_template ? { template: q.tpl } : { text: q.msg };
        let r = await api.send(lead.id, msg);
        if (r.needs_template) { q.needs_template = true; q.templates = r.templates.length ? r.templates : (await api.templates()).items; return; }
        /* server preview first (nothing sent), then Richard's explicit "שלח" (memory rule), then the real send */
        if (r.preview) {
          const ok = await confirmTyped({ title: 'לשלוח דרך נועה ל-' + (r.to || lead.name) + '?', body: `<p class="sub">ההודעה תצא עכשיו כטקסט חופשי (בתוך חלון 24 השעות).</p><pre class="in ta" dir="auto" style="white-space:pre-wrap">${esc(r.text)}</pre>`, word: 'שלח', action: 'שליחה', danger: false });
          if (!ok) return;
          r = await api.send(lead.id, { ...msg, confirm: true });
        }
        if (!r.sent) throw new Error(r.why || 'לא נשלח');
        q.sent = true; onStatus && onStatus(r.status || 'quoted');
      }).then(paint, (x) => toast('לא נשלח' + (x && x.message ? ': ' + x.message : ''), 'crit'));
    }
  });
  paint();
  return { state: () => q };
}
