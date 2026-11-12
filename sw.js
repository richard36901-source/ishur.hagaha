/* ishur client dashboard service worker (03/11, docs/DESIGN-FLOW-PWA-2026-11-03.md).
   Registered ONLY by dashboard.html, with scope "dashboard.html", so no other
   page on the site is ever controlled by it.
     · the shell (dashboard.html + the assets it loads + config.js) is precached
     · navigations and /api/* GETs: network first, cache as the fallback
     · other same-origin static GETs: cache first, refreshed in the background
     · POSTs and cross-origin requests are never touched */
const VERSION = 'ishur-dash-v7';
const SHELL = [
  'dashboard.html', 'config.js', 'manifest.webmanifest',
  'assets/ux.js', 'assets/tracking.js', 'assets/guard.js', 'assets/lead.js', 'assets/design-card.js', 'assets/pwa.js',
  'assets/datepicker.js', 'assets/select.js', 'assets/lux.css', 'assets/picker.css',
  'assets/favicon.png', 'assets/logo-gold.png', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('ishur-dash-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const c = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) c.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    if (req.mode === 'navigate') { const shell = await c.match('dashboard.html', { ignoreSearch: true }); if (shell) return shell; }
    throw err;
  }
}
async function cacheFirst(req) {
  const c = await caches.open(VERSION);
  const hit = await c.match(req) || await c.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then((res) => { if (res && res.ok && res.type === 'basic') c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  return hit || (await fresh) || fetch(req);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) { e.respondWith(networkFirst(req)); return; }
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
  e.respondWith(cacheFirst(req));
});
