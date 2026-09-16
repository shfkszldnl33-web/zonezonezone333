// service-worker.js
//
// Minimal app-shell cache so the PWA install/update flow already wired up in index.html
// (initServiceWorker(), #app-update-banner, "SKIP_WAITING" message) has something real to talk
// to. Bump CACHE_NAME whenever the cached files below change so browsers pick up the new
// version - that's what makes the "새 버전이 준비됐어요" banner appear.
const CACHE_NAME = 'zone-align-ai-v2';
const APP_SHELL = [
  './',
  './index.html',
  './breathing-engine.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      // Do NOT self.skipWaiting() here - the app's own update banner asks the user first, then
      // sends the SKIP_WAITING message below. Activating immediately would swap the running app
      // out from under the user with no warning.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only GET requests are cacheable at all; POST (the /api/* calls this app makes) must always
  // go straight to the network - caching a Gemini/nutrition response would be both wrong (stale
  // food data) and unsupported (the Cache API rejects non-GET requests outright).
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache the serverless API routes themselves - always hit the network so results (and
  // their error handling) stay live, even if the app shell is served from cache.
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Only cache successful, same-origin responses - avoids caching opaque cross-origin
        // responses (e.g. a CDN script) whose success/failure this SW can't actually verify.
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    }),
  );
});
