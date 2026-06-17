import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../js/store-core.js');
const driveImages = require('../js/drive-images.js');

test('normalizes Lebanese phone numbers', () => {
  assert.equal(core.normalizeLebanonPhone('70 123 456'), '+96170123456');
  assert.equal(core.normalizeLebanonPhone('03 017 725'), '+9613017725');
  assert.equal(core.normalizeLebanonPhone('+961 70 123 456'), '+96170123456');
  assert.equal(core.normalizeLebanonPhone('12345'), '');
});

test('formats prices and normalizes fallback product fields', () => {
  assert.equal(core.formatMoney(42.4), '$42');
  const product = core.normalizeProduct({
    id: 'test-dress',
    price: '55',
    comparePrice: '68',
    tags: ['Featured'],
    colors: ['Sky Blue'],
    stock: '4',
  });
  assert.equal(product.name, 'Untitled product');
  assert.equal(product.price, 55);
  assert.equal(product.compareAt, 68);
  assert.equal(product.featured, true);
  assert.deepEqual(product.colors[0], { name: 'Sky Blue', hex: '#9ec1de' });
});

test('calculates percent, fixed, expired, future, and minimum-subtotal promos', () => {
  assert.equal(core.calculatePromoDiscount({ active: true, type: 'percent', value: 15 }, 100, '2026-06-16'), 15);
  assert.equal(core.calculatePromoDiscount({ active: true, type: 'fixed', value: 80 }, 50, '2026-06-16'), 50);
  assert.equal(core.calculatePromoDiscount({ active: true, type: 'percent', value: 20, minSubtotal: 200 }, 100, '2026-06-16'), 0);
  assert.equal(core.calculatePromoDiscount({ active: true, type: 'percent', value: 20, startsAt: '2026-07-01' }, 100, '2026-06-16'), 0);
  assert.equal(core.calculatePromoDiscount({ active: true, type: 'percent', value: 20, endsAt: '2026-06-01' }, 100, '2026-06-16'), 0);
  assert.equal(core.calculatePromoDiscount({ active: false, type: 'percent', value: 20 }, 100, '2026-06-16'), 0);
});

test('calculates delivery and order totals', () => {
  const settings = { freeDeliveryAt: 100, deliveryBeirut: 4, deliveryLebanon: 6 };
  assert.equal(core.calculateDelivery(settings, 42, null, 'beirut'), 4);
  assert.equal(core.calculateDelivery(settings, 42, null, 'lebanon'), 6);
  assert.equal(core.calculateDelivery(settings, 100, null, 'lebanon'), 0);
  assert.equal(core.calculateDelivery(settings, 42, { active: true, type: 'freeship' }, 'lebanon'), 0);

  assert.deepEqual(core.calculateOrderTotals({
    items: [{ price: 42, qty: 2 }],
    promo: { active: true, type: 'percent', value: 10 },
    settings,
    deliveryArea: 'beirut',
  }), {
    subtotal: 84,
    discount: 8,
    delivery: 4,
    total: 80,
  });
});

test('normalizes order items with quantity caps and safe keys', () => {
  const items = core.normalizeOrderItems({
    one: { id: 'Blue Pearl Blouse!', name: 'Blue Pearl Ruffle Blouse', qty: 99, price: '42', size: 'S', color: 'Sky Blue' },
  }, {
    maxQty: 20,
    safeKey: (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-'),
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'Blue-Pearl-Blouse-');
  assert.equal(items[0].qty, 20);
  assert.equal(items[0].price, 42);
});

test('escapes HTML and renders untrusted values inert via the safe template (P13)', () => {
  assert.equal(core.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(core.escapeHtml("a & b < c > d ' \""), 'a &amp; b &lt; c &gt; d &#39; &quot;');
  assert.equal(core.escapeHtml(null), '');

  // Interpolations are escaped; static markup stays raw.
  assert.equal(String(core.html`<h2>${'<script>steal()</script>'}</h2>`), '<h2>&lt;script&gt;steal()&lt;/script&gt;</h2>');
  // Attribute context: a quote-breakout payload cannot escape the attribute.
  assert.equal(
    String(core.html`<img alt="${'" onerror="alert(1)'}">`),
    '<img alt="&quot; onerror=&quot;alert(1)">',
  );
  // Nested html`` fragments and arrays of fragments are inserted raw.
  assert.equal(String(core.html`<ul>${['<b>a</b>', '<b>b</b>'].map((v) => core.html`<li>${v}</li>`)}</ul>`), '<ul><li>&lt;b&gt;a&lt;/b&gt;</li><li>&lt;b&gt;b&lt;/b&gt;</li></ul>');
  assert.equal(String(core.html`${core.html.raw('<hr>')}`), '<hr>');
  assert.equal(String(core.html`${null}${false}${undefined}x`), 'x');
});

test('sanitizes attribute values for image src, css color, and external url (P13)', () => {
  assert.equal(core.safeImageSrc('https://drive.google.com/thumbnail?id=abc'), 'https://drive.google.com/thumbnail?id=abc');
  assert.equal(core.safeImageSrc('assets/logo.svg'), 'assets/logo.svg');
  assert.equal(core.safeImageSrc('javascript:alert(1)'), 'assets/logo.svg');
  assert.equal(core.safeImageSrc(''), 'assets/logo.svg');

  assert.equal(core.safeCssColor('#9ec1de'), '#9ec1de');
  assert.equal(core.safeCssColor('orange'), 'orange');
  assert.equal(core.safeCssColor('red;background:url(x)'), '#a78970');
  assert.equal(core.safeCssColor('"><script>'), '#a78970');

  assert.equal(core.safeExternalUrl('https://instagram.com/pavia.leb'), 'https://instagram.com/pavia.leb');
  assert.equal(core.safeExternalUrl('javascript:alert(1)'), '');
  assert.equal(core.safeExternalUrl('data:text/html,<script>'), '');
});

test('diffs the catalog manifest and builds cache keys (P14)', () => {
  const manifest = { catalogRev: 42, products: { a: 1, b: 2, c: 3 } };
  assert.deepEqual(core.manifestProductRevs(manifest), { a: 1, b: 2, c: 3 });
  assert.deepEqual(core.manifestProductRevs(null), {});

  // Only changed/new ids are reported for fetch; removed ids are dropped.
  const diff = core.diffManifest({ a: 1, b: 2, x: 9 }, { a: 1, b: 3, c: 1 });
  assert.deepEqual(diff.changed.sort(), ['b', 'c']);
  assert.deepEqual(diff.removed, ['x']);

  // Cold start (nothing known) treats everything as changed.
  assert.deepEqual(core.diffManifest({}, { a: 1, b: 1 }).changed.sort(), ['a', 'b']);

  const built = core.buildCatalogManifest([
    { id: 'a', rev: 5, active: true },
    { id: 'b', active: true },
    { id: 'c', active: false },
  ], 100);
  assert.equal(built.catalogRev, 100);
  assert.deepEqual(built.products, { a: 5, b: 1 });
});

test('builds image cache keys, stability checks, and LRU pruning (P14)', () => {
  assert.equal(core.imageCacheKey({ driveFileId: 'abc', imageVersion: 'v9' }), 'abc::v9');
  assert.equal(core.imageCacheKey({ imageId: 'pavia-look-01' }), 'pavia-look-01::');
  assert.equal(core.imageCacheKey({}), '');

  assert.equal(core.isStableImageUrl('https://drive.google.com/x?pv=9'), true);
  assert.equal(core.isStableImageUrl('assets/logo.svg'), true);
  assert.equal(core.isStableImageUrl('blob:http://x/123'), false);
  assert.equal(core.isStableImageUrl(''), false);

  const entries = [
    { key: 'old', lastUsed: 1 },
    { key: 'mid', lastUsed: 5 },
    { key: 'new', lastUsed: 9 },
  ];
  assert.deepEqual(core.pruneLruKeys(entries, 2), ['old']);
  assert.deepEqual(core.pruneLruKeys(entries, 3), []);
});

test('sorts products and decides image dedup (P15)', () => {
  const items = [
    { id: 'a', name: 'Beta', price: 30, stock: 2, sortOrder: 20 },
    { id: 'b', name: 'Alpha', price: 10, stock: 9, sortOrder: 10 },
    { id: 'c', name: 'Gamma', price: 20, stock: 0, sortOrder: 30 },
  ];
  const ids = (key) => [...items].sort(core.compareProducts(key)).map((p) => p.id);
  assert.deepEqual(ids('sortOrder'), ['b', 'a', 'c']);
  assert.deepEqual(ids('name'), ['b', 'a', 'c']);
  assert.deepEqual(ids('price'), ['b', 'c', 'a']);
  assert.deepEqual(ids('price-desc'), ['a', 'c', 'b']);
  assert.deepEqual(ids('stock'), ['c', 'a', 'b']);
  assert.deepEqual(ids('stock-desc'), ['b', 'a', 'c']);

  assert.equal(core.shouldReuseImage('abc123', 'abc123'), true);
  assert.equal(core.shouldReuseImage('abc123', 'def456'), false);
  assert.equal(core.shouldReuseImage('', ''), false);
  assert.equal(core.shouldReuseImage('', 'abc'), false);
});

test('builds absolute image URLs and product ItemList JSON-LD (P16)', () => {
  assert.equal(core.absoluteImageUrl('assets/x.svg', 'https://site.test/app/'), 'https://site.test/app/assets/x.svg');
  assert.equal(core.absoluteImageUrl('./assets/x.svg', 'https://site.test'), 'https://site.test/assets/x.svg');
  assert.equal(core.absoluteImageUrl('https://drive/x', 'https://site.test'), 'https://drive/x');
  assert.equal(core.absoluteImageUrl('blob:xyz', 'https://site.test'), '');
  assert.equal(core.absoluteImageUrl('', 'https://site.test'), '');

  const jsonLd = core.buildProductListJsonLd([
    { id: 'a', name: 'Alpha', price: 30, stock: 2, image: 'https://img/a.webp', sku: 'A1', category: 'Tops', description: 'nice', active: true },
    { id: 'b', name: 'Beta', price: 0, stock: 0, image: 'assets/b.svg', active: true },
    { id: 'c', name: 'Hidden', active: false },
  ], { siteUrl: 'https://site.test', siteName: 'Pavia', currency: 'USD' });
  assert.equal(jsonLd['@type'], 'ItemList');
  assert.equal(jsonLd.numberOfItems, 2); // inactive product excluded
  assert.equal(jsonLd.itemListElement[0].item.name, 'Alpha');
  assert.equal(jsonLd.itemListElement[0].item.image, 'https://img/a.webp');
  assert.equal(jsonLd.itemListElement[0].item.offers.availability, 'https://schema.org/InStock');
  assert.equal(jsonLd.itemListElement[0].item.offers.url, 'https://site.test/#a');
  assert.equal(jsonLd.itemListElement[1].item.image, 'https://site.test/assets/b.svg');
  assert.equal(jsonLd.itemListElement[1].item.offers.availability, 'https://schema.org/OutOfStock');
});

test('builds Google Drive image helpers', () => {
  assert.equal(typeof driveImages.configured(), 'boolean');
  assert.equal(driveImages.sanitizeFilename('Ivory Dress FINAL!!.JPG'), 'ivory-dress-final');
  assert.equal(
    driveImages.driveImageUrl('1AbC_dEf-123'),
    'https://drive.google.com/thumbnail?id=1AbC_dEf-123&sz=w1600',
  );
  assert.equal(driveImages.driveImageUrl('1AbC_dEf-123', 800).includes('sz=w800'), true);
  assert.equal(driveImages.driveImageUrl(''), '');
});
