import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const core = require('../js/store-core.js');

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
