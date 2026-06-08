/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v9';
const IMAGE_CACHE = 'pavia-product-images-v1';
const ASSETS = [
  './',
  './index.html',
  './js/config.js?v=9',
  './js/backend-config.js?v=9',
  './js/backend.js?v=9',
  './css/styles.css?v=9',
  './js/products.js?v=9',
  './js/app.js?v=9',
  './manifest.webmanifest',
  './assets/logo.svg',
  './assets/products/azure-coord-set.svg',
  './assets/products/beige-trench-coat.svg',
  './assets/products/black-satin-skirt.svg',
  './assets/products/blue-pearl-blouse.svg',
  './assets/products/chocolate-mini-dress.svg',
  './assets/products/cocoa-pleated-pants.svg',
  './assets/products/cream-wide-leg-pants.svg',
  './assets/products/denim-maxi-skirt.svg',
  './assets/products/ivory-oversized-shirt.svg',
  './assets/products/leather-belted-coat.svg',
  './assets/products/mocha-knit-set.svg',
  './assets/products/olive-longline-coat.svg',
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
