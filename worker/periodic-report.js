/* ============================================================================
   The short report every three days (16/11/2026, Richard: "כל שלושה ימים…
   לסלאק ולמייל של החודש"). Sent by the Worker itself, so it does not depend on
   anybody's session. It carries only the numbers that come from the verified
   income (the same `income` the money screen reads): what came in this month,
   the VAT inside it, Grow's fees and the number of payments. Costs and profit
   stay on the full report page, which is linked, until that calculation is
   shared between the screen and the Worker — two different profit numbers
   would be worse than none.
   §1 pure (unit-tested in test/periodic-report.test.mjs) · §2 I/O
   ============================================================================ */
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const nis = n => '₪' + r2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const HE_MON = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
export const REPORT_URL = 'https://ishur.io/next/report.html';
export const ilDay = (ts = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
/* every third day, counted from a fixed date so the rhythm does not restart each month */
export function isReportDay(dayIso) { const t = Date.parse(String(dayIso) + 'T12:00:00Z'); return Number.isFinite(t) && Math.round(t / 86400e3) % 3 === 0; }
export function monthIncome(income, month, upToDay) {
  const out = { revenue: 0, vat: 0, fees: 0, payments: 0, days_with_income: 0, last3: 0, fee_estimated: false };
  const from3 = new Date(Date.parse(upToDay + 'T12:00:00Z') - 2 * 86400e3).toISOString().slice(0, 10);
  for (const [day, d] of Object.entries(income || {})) {
    if (!day.startsWith(month) || day > upToDay) continue;
    out.revenue = r2(out.revenue + (Number(d.revenue) || 0)); out.vat = r2(out.vat + (Number(d.vat) || 0)); out.fees = r2(out.fees + (Number(d.fees) || 0)); out.payments += Number(d.payments) || 0;
    if (Number(d.revenue) > 0) out.days_with_income++; if (d.fee_estimated) out.fee_estimated = true;
    if (day >= from3) out.last3 = r2(out.last3 + (Number(d.revenue) || 0));
  }
  out.after_vat = r2(out.revenue - out.vat); return out;
}
export function reportText(m, month, day, { truncated = false } = {}) {
  const title = `📊 *הדוח התקופתי · ${HE_MON[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}* (עד ${day.slice(8, 10)}/${day.slice(5, 7)})`;
  return [title, '', `• הכנסות החודש: ${nis(m.revenue)} · ${m.payments} תשלומים`, `• בשלושת הימים האחרונים: ${nis(m.last3)}`, `• אחרי מע״מ: ${nis(m.after_vat)} (מע״מ לתשלום ${nis(m.vat)})`,
    `• עמלות סליקה: ${nis(m.fees)}${m.fee_estimated ? ' (חלקן הערכה)' : ''}`, truncated ? '• שים לב: ' + (typeof truncated === 'string' ? truncated : 'יומן התשלומים נקרא חלקית, ייתכן שחסר תשלום') : '', '', 'מה לעשות: הוצאות ורווח בדוח המלא', REPORT_URL].filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}
export const reportHtml = text => '<div dir="rtl" style="font-family:Heebo,Arial,sans-serif;font-size:16px;line-height:1.7;color:#1B2620">' + String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\*([^*]+)\*/g, '<b>$1</b>').replace(/(https:\/\/ishur\.io\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';

/* the payment log is read newest first; a cut read matters to this month only if it stopped before reaching the 1st */
export function monthCut(inc, month) {
  if (!inc) return false;
  const gaps = (inc.gaps || []).filter(d => String(d).startsWith(month)).sort();
  if (gaps.length) return 'יומן התשלומים של ' + gaps.map(d => d.slice(8, 10) + '/' + d.slice(5, 7)).join(', ') + ' נקרא חלקית, ייתכן שחסר שם תשלום';
  if (!inc.truncated) return false; const t = Number(inc.oldest) || Date.parse(inc.oldest || '');
  return !Number.isFinite(t) || !t || ilDay(t) > month + '-01' ? 'יומן התשלומים עוד לא נקרא עד תחילת החודש, ייתכן שחסר תשלום' : false;
}

/* ── §2 I/O ─────────────────────────────────────────────────────────────── */
export async function periodicReport(env, { now = Date.now(), income, post, mail, to, force = false } = {}) {
  const day = ilDay(now), hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date(now))) % 24;
  if (!force && (!isReportDay(day) || hour < 9 || hour >= 21)) return { sent: false, why: 'not-due' };
  if (!env.RATE || typeof income !== 'function') return { sent: false, why: 'not-configured' };
  const mk = 'rep3:' + day; if (!force && await env.RATE.get(mk).catch(() => '1')) return { sent: false, why: 'already-sent' };
  const inc = await income(); if (!inc || !inc.income) return { sent: false, why: 'no-income-data' };
  await env.RATE.put(mk, new Date(now).toISOString(), { expirationTtl: 10 * 86400 });
  const month = day.slice(0, 7), text = reportText(monthIncome(inc.income, month, day), month, day, { truncated: monthCut(inc, month) });
  const out = { sent: true, slack: false, email: false };
  if (post) { try { await post(text, { key: 'report3', important: true, oneoff: true, urgent: true }); out.slack = true; } catch { out.slack = false; } }
  if (mail && to) { try { const r = await mail({ to, from: { email: 'info@ishur.io', name: 'ishur.io' }, subject: text.split('\n')[0].replace(/[*📊]/g, '').trim(), text: text.replace(/\*/g, ''), html: reportHtml(text) }); out.email = !!(r && r.ok); out.email_error = r && !r.ok ? r.error : undefined; } catch (e) { out.email = false; } }
  return out;
}
