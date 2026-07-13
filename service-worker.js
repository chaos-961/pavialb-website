/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v87';
const IMAGE_CACHE = 'pavia-product-images-v1';
const IMAGE_CACHE_MAX = 120;

// Drop the oldest cached images once the store grows past the cap. cache.keys()
// preserves insertion order, so the head of the list is the least-recently put.
async function trimImageCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= IMAGE_CACHE_MAX) return;
  await Promise.all(
    keys.slice(0, keys.length - IMAGE_CACHE_MAX).map((key) => cache.delete(key)),
  );
}
const ASSETS = [
  './',
  './index.html',
  './favicon.ico',
  './js/splash.js?v=1',
  './js/construction-gate.js?v=3',
  './js/config.js?v=55',
  './js/firebase-config.js?v=12',
  './js/backend-config.js?v=18',
  './js/image-catalog.js?v=12',
  './js/store-core.js?v=10',
  './js/catalog-cache.js?v=4',
  './js/backend.js?v=21',
  './js/backend-firebase.js?v=37',
  './css/styles.css?v=43',
  './js/products.js?v=12',
  './js/app.js?v=46',
  './manifest.webmanifest',
  './assets/logo.svg',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => null),
  );
  // Do NOT skipWaiting() — a freshly installed SW waits and activates on its own
  // the next time the app is opened without an older tab holding the previous
  // worker. Updates apply silently that way; there is deliberately no in-page
  // "new version, reload" prompt and the page is never force-reloaded.
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
    // Cache-first: once an image is cached, serve it straight from the cache and
    // do NOT re-fetch it in the background. A given image URL is immutable — a
    // re-uploaded product image carries a fresh ?pv=<imageVersion> (so it's a new
    // URL / cache miss and shows on the first view), and versioned site assets
    // bust via ?v=. Skipping the background revalidate is the whole point: an
    // image that already loaded once never loads a second time, which keeps
    // scrolling smooth and spares mobile data.
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        // First view of this URL: fetch, cache same-origin/CORS-OK bytes, serve.
        // Cross-origin R2 images can come back opaque (ok === false); those are
        // left to the browser HTTP cache and simply passed through here.
        return fetch(req)
          .then((response) => {
            if (response && response.ok) {
              cache.put(req, response.clone())
                .then(() => trimImageCache(cache))
                .catch(() => null);
            }
            return response;
          })
          .catch(() => Response.error());
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
