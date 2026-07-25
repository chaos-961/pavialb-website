/* Pavia Elegant Store — service worker */
const CACHE = 'pavia-v107';
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
  './js/config.js?v=60',
  './js/firebase-config.js?v=12',
  './js/backend-config.js?v=18',
  './js/image-catalog.js?v=12',
  './js/store-core.js?v=10',
  './js/catalog-cache.js?v=4',
  './js/backend.js?v=22',
  './js/backend-firebase.js?v=38',
  './css/styles.css?v=58',
  './js/products.js?v=12',
  './js/app.js?v=53',
  './js/hero-looks.js?v=4',
  './manifest.webmanifest',
  './assets/logo.svg',
  './assets/icon.svg',
];

self.addEventListener('install', (event) => {
  // Precache the fresh app shell, THEN take over immediately (skipWaiting), so a
  // newer version swaps its cache in during the current session instead of
  // lingering in "waiting" until every tab is closed. This is a background cache
  // refresh only: the new worker claims the page (clients.claim below) but the
  // page is NEVER reloaded and there is deliberately no "new version, reload"
  // prompt — the running page keeps its already-loaded code, and the next
  // navigation simply serves the new shell. App code is network-first anyway, so
  // an online session is already on fresh bytes; this just makes the *offline*
  // shell current in the background too. Cached product images are untouched —
  // IMAGE_CACHE is preserved across activations (see below) and never re-fetched.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          // Drop superseded app-shell caches, but keep IMAGE_CACHE: product images
          // are immutable per URL (a re-upload carries a fresh ?pv=), so they must
          // survive the update and never reload — that's the "not the images" part.
          keys
            .filter((key) => key.startsWith('pavia-') && key !== CACHE && key !== IMAGE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      // Control existing clients right away so the new shell serves this session's
      // next request — a smooth, silent handoff with no controllerchange reload.
      .then(() => self.clients.claim()),
  );
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
      // Offline, not cached → fail cleanly. Falling back to index.html here
      // (like the navigate branch does) would hand an HTML body to a JS/CSS
      // request, turning a network error into a script parse error.
      .catch(() => caches.match(req).then((cached) => cached || Response.error())),
  );
});
