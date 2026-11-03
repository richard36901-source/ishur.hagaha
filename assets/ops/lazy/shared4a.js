/* Phase 4a helpers shared by lazy/messaging.js, lazy/inbox.js, lazy/control.js (lazy, not counted) */
import { esc, Badge } from '../ui.js';
if (typeof document !== 'undefined' && !document.getElementById('p4a-css')) document.head.insertAdjacentHTML('beforeend', '<link id="p4a-css" rel="stylesheet" href="assets/ops/p4a.css?v=2">');
export const ilDay = (d = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(d));
export const ilHour = (d = Date.now()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hourCycle: 'h23' }).format(new Date(d)));
export const shiftDay = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
/* Richard's rule: no WhatsApp to clients/leads 21:00–09:00 */
export const quietHours = (now = Date.now()) => { const h = ilHour(now); return h >= 21 || h < 9; };
export function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, ''); if (!d) return '';
  if (d.startsWith('972')) { const l = '0' + d.slice(3); return l.length === 10 ? l.slice(0, 3) + '-' + l.slice(3, 6) + '-' + l.slice(6) : l; }
  return '+' + d;
}
export const ROLE_HE = { client: ['info', 'לקוח'], lead: ['warn', 'ליד'], guest: ['', 'אורח'], unknown: ['', 'לא מזוהה'], sms: ['', 'SMS'] };
export const roleBadge = (r) => { const [t, h] = ROLE_HE[r] || ROLE_HE.unknown; return `<span class="badge ${t}">${esc(h)}</span>`; };
const ST = { sent: ['skipped', '✓ נשלח'], delivered: ['ok', '✓✓ נמסר'], read: ['ok', '✓✓ נקרא'], failed: ['failed', 'נכשל'] };
export const statusBadge = (s, code = '') => { const [b, h] = ST[s] || ['skipped', s || '—']; return Badge(b, h + (s === 'failed' && code ? ' ' + code : '')); };
export const ERR_HE = { 131042: 'בעיית תשלום בחשבון מטא של המספר השולח', 131047: 'עברו 24 שעות, אפשר רק תבנית', 131026: 'המספר לא בוואטסאפ או חסם אותנו', 131049: 'מטא הגבילה הודעות שיווקיות לאיש הקשר', 130472: 'איש הקשר בניסוי של מטא', 132001: 'התבנית לא קיימת או לא מאושרת', 132015: 'התבנית מושהית', 131056: 'יותר מדי הודעות לאותו מספר', 131000: 'תקלה זמנית אצל מטא', 131048: 'מטא האטה את המספר (ספאם)' };
export const errHe = (code, raw = '') => ERR_HE[code] || raw || 'סיבה לא ידועה';
