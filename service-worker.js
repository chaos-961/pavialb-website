/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v2';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/products.js',
  './js/app.js',
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
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Don't cache the admin area — always fetch fresh
  if (req.url.includes('/admin')) return;

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
