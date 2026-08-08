// sw.js — offline support for the games compendium.
//
// Strategy:
//   • Navigations (HTML pages) → NETWORK-FIRST, cache fallback. A new deploy is always picked up the moment
//     you're online; offline you still get the last-seen page. Never stuck on a stale shell.
//   • Static same-origin assets (the ES-module graph, three.js, textures, engines, game views) → CACHE-FIRST,
//     populated on first fetch. So a game you've opened online once then works fully offline.
//   • The cache name carries the build VERSION. A new service worker deletes older caches on activate, so
//     every asset moves forward together — no half-old/half-new mixes after a deploy.
//   • Never intercepted: /auth (Keycloak login), non-GET, cross-origin, Range requests, and /sw.js itself.
//
// IMPORTANT: bump VERSION here in lockstep with web/version.js on every deploy — that's what makes returning
// visitors pull the fresh build (the SW script is re-checked each navigation; changed bytes → update → new
// cache → old caches purged).
const VERSION = '1.56';
const CACHE = `games-${VERSION}`;

// App shell — precached atomically on install so the landing and game pages OPEN offline right after install.
// (Each game's JS/assets are cached on first online visit by the runtime cache-first path below.)
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/web/icons/icon-192.png', '/web/icons/icon-512.png', '/web/icons/icon-180.png',
  '/web/version.js',
  '/web/board.html', '/web/render3d.html', '/web/index.html', '/web/lobby.html',
  '/web/games/petanque/index.html', '/web/games/sidoku/index.html',
  '/web/games/klondike/index.html', '/web/games/pegsolitaire/index.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is all-or-nothing: if any shell URL fails, install fails and the old SW / plain site is untouched.
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // no cross-origin
  if (url.pathname === '/sw.js') return;                          // let the browser manage the SW script
  if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) return; // never cache Keycloak
  if (req.headers.has('range')) return;                          // don't cache partial media

  const isNavigation = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        (await caches.open(CACHE)).put(req, net.clone());
        return net;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || (await cache.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Static asset: serve from cache if we have it, else fetch and cache for next time.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net.ok && net.type === 'basic') cache.put(req, net.clone());
      return net;
    } catch {
      return hit || Response.error();
    }
  })());
});
