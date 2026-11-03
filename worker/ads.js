/* ============================================================================
   ishur.io · Meta ads: account health, CAPI events, ad reports
   ----------------------------------------------------------------------------
   Extracted from index.js on 20/10/2026, behaviour unchanged. runAdReview and
   callBoard stay in index.js for now (they lean on ops stats / Retell).
   Shalev's campaign (META_OTHER_CAMPAIGNS) is read-only here, always.
   ========================================================================== */
import { normPhone, seenOnce, sha256Hex, isAdmin, okJson, deny } from './lib.js';
import { slackPost, slackSend, alert } from './slack.js';
import { logEvent } from './evlog.js';
import { ilDate } from './shir.js';

/* ══ Meta ads: server-side purchases + the 4-day campaign review ═════════════
   META_ADS_TOKEN is a system-user token that never expires. It does three jobs:
   1) capiPurchase — every Grow payment is reported back to Meta server-side
      with event_id 'pur_<ref>'; the browser fires the same id from thanks.html
      so Meta dedups, and closed customers keep teaching the ads algorithm.
   2) runAdReview — every 4 days (worker cron, no chat session involved) pull
      campaign structure + insights, apply the stop-rules from the campaign
      doc, diff against the previous snapshot, refresh adspend:<month> so the
      CAC gauge feeds itself, and WhatsApp the report from Noa's number.
   3) /api/ad-review — the same review on demand, admin-gated.
   ─────────────────────────────────────────────────────────────────────────── */
export const META_PIXEL_ID = '1412366810814749';

export const META_AD_ACCOUNT = 'act_1944903292858482';

export const META_CAMPAIGN_ID = '120250009883070731';

/* campaigns somebody else runs on the same account (Shalev, 12/10): read for
   the comparison in the report, never written to — no budget, no status, no
   ad changes go through here for these ids */
export const META_OTHER_CAMPAIGNS = [{ id: '120250670197650731', who: 'שלו' }];

/* ── ads health ──────────────────────────────────────────────────────────
   Richard, 09/09: "next time I want you to know before me and tell me in
   Slack". Meta shows an error banner in Ads Manager; nobody looks there
   hourly. This asks the API the same question — account standing, every
   ad set and ad under the campaign, their effective status and Meta's own
   issues_info — and returns the list of things a human would call "an
   error". The pacer runs it once an hour inside Slack hours and pings
   (urgent) for anything not already pinged in the last 24h. */
export const AD_BAD = /DISAPPROVED|WITH_ISSUES|PENDING_REVIEW|ADSET_PAUSED|CAMPAIGN_PAUSED|DELETED|ARCHIVED/;

export async function adsHealth(env) {
  const out = { ok: true, checked_at: new Date().toISOString(), account: null, campaign: null, issues: [] };
  const acct = await metaAds(env, `/${META_AD_ACCOUNT}?fields=account_status,disable_reason,name,funding_source_details{display_string}`);
  if (acct && acct.ok && acct.data) {
    const a = acct.data;
    out.account = { status: a.account_status, disable_reason: a.disable_reason, funding: (a.funding_source_details || {}).display_string || '' };
    if (Number(a.account_status) !== 1) out.issues.push({ level: 'account', name: a.name || META_AD_ACCOUNT, status: String(a.account_status), why: 'חשבון המודעות לא פעיל (' + (a.disable_reason || '') + ')' });
  } else if (acct && !acct.ok) {
    out.ok = false; out.error = JSON.stringify(acct.data || acct).slice(0, 300); return out;
  }
  const camp = await metaAds(env, `/${META_CAMPAIGN_ID}?fields=name,status,effective_status,issues_info`);
  if (camp && camp.ok && camp.data) {
    out.campaign = { name: camp.data.name, status: camp.data.status, effective_status: camp.data.effective_status };
    for (const i of (camp.data.issues_info || [])) out.issues.push({ level: 'campaign', name: camp.data.name, status: camp.data.effective_status, why: i.error_summary || i.error_message || i.error_type || '' });
  }
  const ads = await metaAds(env, `/${META_CAMPAIGN_ID}/ads?fields=id,name,status,effective_status,configured_status,issues_info,adset{id,name,status,effective_status,issues_info}&limit=200`);
  const list = (ads && ads.ok && ads.data && ads.data.data) || [];
  out.ads = list.map(x => ({ id: x.id, name: x.name, status: x.status, effective: x.effective_status, adset: (x.adset || {}).name || '', adset_effective: (x.adset || {}).effective_status || '' }));
  const seenAdset = {};
  for (const x of list) {
    const set = x.adset || {};
    if (set.id && !seenAdset[set.id]) {
      seenAdset[set.id] = 1;
      for (const i of (set.issues_info || [])) out.issues.push({ level: 'adset', id: set.id, name: set.name, status: set.effective_status, why: i.error_summary || i.error_message || i.error_type || '' });
    }
    /* a paused ad is a choice; an ad the reviewer rejected or that Meta
       flags is the error Richard saw. never-launched leftovers count too. */
    /* 14/10: a paused ad (or an ad in a paused set) with a review flag is a
       leftover, not an outage — it spends nothing, so it stays off Slack */
    const running = !/PAUSED|ARCHIVED|DELETED/.test(String(x.effective_status || '')) && !/PAUSED|ARCHIVED|DELETED/.test(String(set.effective_status || ''));
    if (running) for (const i of (x.issues_info || [])) out.issues.push({ level: 'ad', id: x.id, name: x.name, status: x.effective_status, why: i.error_summary || i.error_message || i.error_type || '' });
    if (!(x.issues_info || []).length && x.status === 'ACTIVE' && AD_BAD.test(String(x.effective_status || '')) && !/PAUSED/.test(String(x.effective_status)))
      out.issues.push({ level: 'ad', id: x.id, name: x.name, status: x.effective_status, why: 'מודעה פעילה במצב ' + x.effective_status });
  }
  return out;
}

export async function adsHealthAlert(env) {
  if (!env.RATE || !env.META_ADS_TOKEN) return;
  const h = await adsHealth(env);
  if (!h.ok) { await slackSend(env, `⚠️ *מודעות*: לא הצלחתי לקרוא את מצב החשבון ממטא — ${h.error || ''}`, { urgent: true }); return; }
  const fresh = [];
  for (const i of h.issues) {
    const key = 'adsalert:' + (i.id || i.level) + ':' + String(i.why || i.status).slice(0, 40).replace(/\s+/g, '_');
    if (await env.RATE.get(key)) continue;
    await env.RATE.put(key, '1', { expirationTtl: 86400 }).catch(() => {});
    fresh.push(i);
  }
  if (!fresh.length) return;
  const lines = fresh.map(i => `• ${i.level === 'account' ? 'חשבון' : i.level === 'campaign' ? 'קמפיין' : i.level === 'adset' ? 'סט' : 'מודעה'} *${i.name}* — ${i.status}${i.why ? ' · ' + i.why : ''}`);
  await slackSend(env, `🚨 *שגיאה במודעות* (${fresh.length})\n${lines.join('\n')}\nלטיפול: business.facebook.com/adsmanager`, { urgent: true });
}

/* ── ads account watchdog (Richard 04/10/26) ───────────────────────────────
   Every 10 minutes, hourly on the wire: is the ad account allowed to spend,
   and is anything that should run actually running? A changed verdict posts
   to Slack once (not every tick) with what is wrong and what I can or cannot
   do about it. Payment problems are his: a card can only be fixed by him. */
export const ADS_STATUS = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 8: 'PENDING_SETTLEMENT', 9: 'IN_GRACE_PERIOD', 100: 'PENDING_CLOSURE', 101: 'CLOSED', 201: 'ANY_ACTIVE', 202: 'ANY_CLOSED' };

export async function adsHealthWatch(env) {
  if (!env.RATE || !env.META_ADS_TOKEN) return { skipped: true };
  const hourKey = 'adswatch:' + new Date().toISOString().slice(0, 13);
  if (await env.RATE.get(hourKey)) return { skipped: 'hour' };
  await env.RATE.put(hourKey, '1', { expirationTtl: 2 * 3600 }).catch(() => {});
  const acct = await metaAds(env, '/act_1944903292858482?fields=account_status,disable_reason,balance,amount_spent', 'GET');
  const a = (acct && acct.data) || {};
  const ads = await metaAds(env, '/act_1944903292858482/ads?fields=name,status,effective_status,issues_info{error_summary}&limit=50', 'GET');
  const rows = ((ads && ads.data && ads.data.data) || []).filter(x => x.status === 'ACTIVE');
  const broken = rows.filter(x => !['ACTIVE', 'IN_PROCESS', 'PENDING_REVIEW'].includes(x.effective_status));
  const statusName = ADS_STATUS[a.account_status] || String(a.account_status || '?');
  const verdict = `${statusName}|${broken.length}`;
  const last = await env.RATE.get('adswatch:last');
  if (last === verdict) return { same: true, verdict };
  await env.RATE.put('adswatch:last', verdict).catch(() => {});
  const billing = 'https://business.facebook.com/latest/billing_hub/accounts/details/?payment_account_id=1944903292858482&business_id=1888051741895896';
  if (a.account_status === 1 && !broken.length) {
    if (last) await slackPost(env, `✅ פרסום | חשבון המודעות חזר לפעול. ${rows.length} מודעות פעילות, אין שגיאות.`);
    return { ok: true, verdict };
  }
  const lines = [];
  if (a.account_status !== 1) {
    const why = a.account_status === 3 ? 'תשלום לא עבר: צריך לאמת כרטיס ולשלם את היתרה' : a.account_status === 2 ? 'החשבון הושבת ע"י מטא (disable_reason ' + a.disable_reason + ')' : 'סטטוס ' + statusName;
    lines.push(`🚨 פרסום | חשבון המודעות לא מציג: ${why}. יתרה ₪${(Number(a.balance || 0) / 100).toFixed(2)}.`);
    lines.push(`זה כרטיס אשראי, רק אתה יכול: ${billing}`);
  }
  if (broken.length) {
    lines.push(`⚠️ ${broken.length} מודעות פעילות לא מוצגות: ` + broken.map(x => `${x.name.replace(/[‎‏]/g, '').slice(0, 30)} (${(x.issues_info || []).map(i => i.error_summary).join(', ') || x.effective_status})`).join(' · '));
  }
  await slackPost(env, lines.join('\n'), { urgent: true });
  await logEvent(env, { area: 'פרסום', action: 'חשבון מודעות: ' + verdict, ok: false, review: true, detail: lines.join(' ').slice(0, 300) }).catch(() => {});
  return { ok: false, verdict };
}

export async function metaAds(env, path, method, payload) {
  if (!env.META_ADS_TOKEN) return null;
  const init = { method: method || 'GET', headers: { Authorization: 'Bearer ' + env.META_ADS_TOKEN } };
  if (payload && init.method !== 'GET') {
    const b = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) b.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    init.body = b;
  }
  const r = await fetch('https://graph.facebook.com/v21.0' + path, init).catch(() => null);
  if (!r) return null;
  let j = null;
  try { j = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data: j };
}

/* 10.9: Lead and InitiateCheckout from the server, same event_id the pixel
   used in the browser ('lead_<session>' / 'ic_<session>'), so Meta dedups and
   a blocked pixel still leaves the event. */
export async function capiEvent(env, name, { phone, email, eventId, value, fbp, fbc, ua, ip }) {
  if (!env.META_ADS_TOKEN || !eventId) return;
  if (env.RATE && await seenOnce(env, 'capi:' + eventId)) return;
  const user_data = {};
  const ph = normPhone(phone);
  if (ph) user_data.ph = [await sha256Hex(ph)];
  const em = String(email || '').trim().toLowerCase();
  if (em) user_data.em = [await sha256Hex(em)];
  if (!user_data.ph && !user_data.em) return;
  /* Meta match-quality (06/10 recommendation, +7): browser id, click id,
     external id, UA and IP lift how many leads Meta can tie back to an ad */
  if (ph) user_data.external_id = [await sha256Hex(ph)];
  if (fbp) user_data.fbp = String(fbp);
  if (fbc) user_data.fbc = String(fbc);
  if (ua) user_data.client_user_agent = String(ua).slice(0, 400);
  if (ip) user_data.client_ip_address = String(ip);
  const ev = {
    event_name: name, event_time: Math.floor(Date.now() / 1000), event_id: String(eventId),
    action_source: 'website', event_source_url: 'https://ishur.io/', user_data,
    ...(value ? { custom_data: { value: Number(value) || 0, currency: 'ILS' } } : {}),
  };
  const r = await metaAds(env, `/${META_PIXEL_ID}/events`, 'POST', { data: [ev] });
  if (!r || !r.ok) await logEvent(env, { area: 'מטא', action: `CAPI ${name} לא דווח`, ok: false, phone: ph, detail: JSON.stringify((r && r.data && r.data.error) || 'no-response').slice(0, 200) }).catch(() => {});
}

export async function capiPurchase(env, { phone, email, value, ref }) {
  if (!env.META_ADS_TOKEN || !ref) return;
  const user_data = {};
  const ph = normPhone(phone);
  if (ph) user_data.ph = [await sha256Hex(ph)];
  const em = String(email || '').trim().toLowerCase();
  if (em) user_data.em = [await sha256Hex(em)];
  const ev = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: 'pur_' + String(ref),
    action_source: 'website',
    event_source_url: 'https://ishur.io/thanks.html',
    user_data,
    custom_data: { value: Number(value) || 0, currency: 'ILS' },
  };
  const r = await metaAds(env, `/${META_PIXEL_ID}/events`, 'POST', { data: [ev] });
  if (!r || !r.ok) {
    await slackPost(env, `⚠️ CAPI: רכישה ${ref} לא דווחה למטא — ` +
      JSON.stringify((r && r.data && r.data.error) || 'no-response').slice(0, 220)).catch(() => {});
  }
}

/* POST /api/ad-reports {admin_key, date?} — the archive behind ad-report.html.
   Without a date: every stored report date, newest first. With one: that
   report. Entries written before the structured snapshot are plain text and
   come back as { legacy: true, text } so the page can still show them. */
export async function handleAdReports(request, env, origin) {
  let b = {};
  try { b = await request.json(); } catch { return deny(400, 'bad-json', origin); }
  if (!isAdmin(env, b.admin_key)) return deny(403, 'bad-admin-key', origin);
  if (!env.RATE) return deny(500, 'no-kv', origin);

  const dates = [];
  let cursor;
  do {
    const page = await env.RATE.list({ prefix: 'adlog:', cursor });
    for (const k of page.keys || []) dates.push(k.name.slice('adlog:'.length));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  dates.sort().reverse();

  const date = String(b.date || '').trim();
  if (!date) return okJson({ ok: true, dates }, origin);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return deny(400, 'bad-date', origin);
  const raw = await env.RATE.get('adlog:' + date);
  if (raw == null) return deny(404, 'no-report', origin);
  let report;
  try { report = JSON.parse(raw); } catch { report = null; }
  if (!report || typeof report !== 'object') report = { legacy: true, date, text: raw };
  return okJson({ ok: true, dates, date, report }, origin);
}
