const CACHE_NAME = 'pavia-store-v1';
const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './css/styles.css',
  './js/products.js',
  './js/app.js',
  './js/admin.js',
  './assets/logo.svg',
  './assets/products/blue-pearl-blouse.svg',
  './assets/products/denim-maxi-skirt.svg',
  './assets/products/azure-coord-set.svg',
  './assets/products/cocoa-pleated-pants.svg',
  './assets/products/ivory-oversized-shirt.svg',
  './assets/products/cream-wide-leg-pants.svg',
  './assets/products/chocolate-mini-dress.svg',
  './assets/products/beige-trench-coat.svg',
  './assets/products/black-satin-skirt.svg',
  './assets/products/olive-longline-coat.svg',
  './assets/products/mocha-knit-set.svg',
  './assets/products/leather-belted-coat.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
});

self.addEventListener('fetch', event => {
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
