/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v43';
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
  './js/splash.js?v=1',
  './js/config.js?v=22',
  './js/firebase-config.js?v=10',
  './js/backend-config.js?v=14',
  './js/image-catalog.js?v=11',
  './js/store-core.js?v=7',
  './js/catalog-cache.js?v=3',
  './js/backend.js?v=17',
  './js/backend-firebase.js?v=26',
  './css/styles.css?v=17',
  './js/products.js?v=11',
  './js/app.js?v=23',
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
    // Stale-while-revalidate: serve the cached image instantly for speed/offline,
    // but ALWAYS re-fetch in the background and overwrite the cache with fresh
    // bytes. This means an updated image can never stay pinned — the next view
    // shows the new image with no manual cache reset. Product images additionally
    // carry a ?pv=<imageVersion> buster, so a re-uploaded image is a fresh URL
    // (cache miss) and shows immediately on the very first view.
    event.respondWith(
      caches.open(IMAGE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const networked = fetch(req)
          .then((response) => {
            // Only same-origin / CORS responses are cacheable. Cross-origin Drive
            // thumbnails come back opaque (ok === false); those are left to the
            // browser HTTP cache, which busts on the ?pv= image version.
            if (response && response.ok) {
              cache.put(req, response.clone())
                .then(() => trimImageCache(cache))
                .catch(() => null);
            }
            return response;
          })
          .catch(() => null);
        // Serve cache instantly; otherwise wait for the network. If both miss
        // (offline, uncached image) return a network-error response rather than
        // firing a second doomed fetch — the page's <img> error handler then
        // shows the branded placeholder.
        return cached || (await networked) || Response.error();
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
