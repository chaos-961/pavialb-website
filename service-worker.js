/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v27';
const IMAGE_CACHE = 'pavia-product-images-v1';
const ASSETS = [
  './',
  './index.html',
  './js/config.js?v=10',
  './js/firebase-config.js?v=10',
  './js/backend-config.js?v=10',
  './js/image-catalog.js?v=10',
  './js/store-core.js?v=5',
  './js/catalog-cache.js?v=1',
  './js/backend.js?v=16',
  './js/backend-firebase.js?v=20',
  './css/styles.css?v=11',
  './js/products.js?v=10',
  './js/app.js?v=16',
  './manifest.webmanifest',
  './assets/logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => null),
  );
  self.skipWaiting();
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

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => null);
          return res;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});
