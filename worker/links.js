/* ============================================================================
   ishur.io · links a client types that end up in a guest's WhatsApp
   ----------------------------------------------------------------------------
   02/11 audit. Both checks used to be a prefix regex on the raw string:
     navlink  /^https?:\/\/(www\.)?(waze\.com|…)/ — no end anchor, so
              https://waze.com.evil.example/x and https://waze.com@evil.example
              both passed, and went to every confirmed guest in the
              day-before reminder.
     gifts    required a "/" after the host (better), but took http:// and
              any text after it, spaces and newlines included.
   Now: parsed with URL, https only, no user:password@, the HOSTNAME must be
   on the list (exactly, or a subdomain of a listed apex), no whitespace.
   ========================================================================== */

const NAV_HOSTS = ['waze.com', 'ul.waze.com', 'maps.app.goo.gl', 'goo.gl', 'maps.google.com', 'google.com', 'google.co.il'];
const GIFT_HOSTS = ['bit.co.il', 'bitpay.co.il', 'paybox.co.il', 'payboxapp.com'];

function hostOk(host, list) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return list.some(d => h === d || h.endsWith('.' + d));
}

function parse(u) {
  const s = String(u || '').trim();
  if (!s || /\s/.test(s) || s.length > 300) return null;
  let url; try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url;
}

/* Waze / Google Maps. goo.gl only as a maps short link (/maps/…); google.*
   only under /maps. */
export function navLinkOk(u) {
  const url = parse(u);
  if (!url || !hostOk(url.hostname, NAV_HOSTS)) return false;
  const h = url.hostname.toLowerCase();
  if ((h === 'goo.gl' || h === 'www.goo.gl') && !url.pathname.startsWith('/maps')) return false;
  if (/(^|\.)google\.(com|co\.il)$/.test(h) && !/^maps\./.test(h) && !url.pathname.startsWith('/maps')) return false;
  return true;
}

export function giftLinkOk(u) {
  const url = parse(u);
  return !!url && hostOk(url.hostname, GIFT_HOSTS);
}
