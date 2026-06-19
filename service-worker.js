/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v35';
const IMAGE_CACHE = 'pavia-product-images-v1';
const ASSETS = [
  './',
  './index.html',
  './js/config.js?v=15',
  './js/firebase-config.js?v=10',
  './js/backend-config.js?v=13',
  './js/image-catalog.js?v=11',
  './js/store-core.js?v=7',
  './js/catalog-cache.js?v=1',
  './js/backend.js?v=17',
  './js/backend-firebase.js?v=24',
  './css/styles.css?v=15',
  './js/products.js?v=11',
  './js/app.js?v=20',
  './manifest.webmanifest',
  './assets/logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => null),
  );
  // Do NOT skipWaiting() automatically — a freshly installed SW waits so the app
  // can surface an "update available -> reload" prompt. The page asks this SW to
  // activate via postMessage('SKIP_WAITING') only when the user accepts.
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('pavia-') && key !== CACHE && key !== IMAGE_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Don't cache the admin area — always fetch fresh
  if (req.url.includes('/admin')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE).then((cache) => cache.put(req, response.clone())).catch(() => null);
          }
          return response;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html'))),
    );
    return;
  }

  if (req.destination === 'image') {
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const response = await fetch(req);
        if (response.ok) {
          const url = new URL(req.url);
          const version = url.searchParams.get('pv');
          if (version) {
            const existing = await cache.keys();
            await Promise.all(existing.map((entry) => {
              const cachedUrl = new URL(entry.url);
              const isOlderVersion = cachedUrl.origin === url.origin
                && cachedUrl.pathname === url.pathname
                && cachedUrl.searchParams.get('pv') !== version;
              return isOlderVersion ? cache.delete(entry) : null;
            }));
          }
          await cache.put(req, response.clone());
        }
        return response;
      }),
    );
    return;
  }

  if (new URL(req.url).origin !== self.location.origin) return;

  // Network-first for same-origin app code (JS/CSS/etc). Always prefer fresh
  // bytes and refresh the cache, falling back to cache only when offline. A
  // cache-first strategy here previously pinned a stale backend-firebase.js
  // (one without signInAdmin) and broke the admin dashboard whenever a file's
  // contents changed without its ?v= query being bumped. Network-first makes
  // that class of stale-code bug impossible while online.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => null);
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html'))),
  );
});
