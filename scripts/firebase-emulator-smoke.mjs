import net from 'node:net';
import { deleteApp, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { seedRealtimeDatabase } from './seed-rtdb.mjs';

const projectId = process.env.GCLOUD_PROJECT || 'demo-pavia-local';
const databaseNamespace = `${projectId}-default-rtdb`;
const services = [
  { name: 'Authentication', host: '127.0.0.1', port: 9099 },
  { name: 'Realtime Database', host: '127.0.0.1', port: 9000 },
];

function assertReachable({ name, host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${name} emulator timed out on ${host}:${port}.`));
    }, 5000);

    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`${name} emulator is unavailable: ${error.message}`));
    });
  });
}

for (const service of services) {
  await assertReachable(service);
  console.log(`${service.name} emulator reachable at ${service.host}:${service.port}.`);
}

const seedResult = await seedRealtimeDatabase();
console.log(`Trusted seed wrote ${seedResult.productCount} products.`);

const signInResponse = await fetch(
  'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-pavia-local',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  },
);
if (!signInResponse.ok) {
  throw new Error(`Anonymous Auth emulator sign-in failed with HTTP ${signInResponse.status}.`);
}
const identity = await signInResponse.json();
if (!identity.localId || !identity.idToken) {
  throw new Error('Anonymous Auth emulator did not return a UID and ID token.');
}
console.log(`Anonymous Auth issued test UID ${identity.localId}.`);

function databaseUrl(path, token = '') {
  const query = new URLSearchParams({ ns: databaseNamespace });
  if (token) query.set('auth', token);
  return `http://127.0.0.1:9000/${path}.json?${query}`;
}

const publicRead = await fetch(databaseUrl('publicProducts', identity.idToken));
if (!publicRead.ok) {
  throw new Error(`Authenticated public product read failed with HTTP ${publicRead.status}.`);
}
const publicProducts = await publicRead.json();
if (Object.keys(publicProducts || {}).length !== 12) {
  throw new Error('Expected 12 seeded public products.');
}

const settingsRead = await fetch(databaseUrl('publicStoreSettings', identity.idToken));
const promosRead = await fetch(databaseUrl('publicPromoCodes', identity.idToken));
if (!settingsRead.ok || !promosRead.ok) {
  throw new Error('Authenticated public settings or promo read failed.');
}

const anonymousPublicRead = await fetch(databaseUrl('publicProducts'));
if (anonymousPublicRead.status !== 401) {
  throw new Error(`Expected unauthenticated public read denial; received ${anonymousPublicRead.status}.`);
}

const privateRead = await fetch(databaseUrl('products', identity.idToken));
if (privateRead.status !== 401) {
  throw new Error(`Expected private product read denial; received ${privateRead.status}.`);
}

const publicWrite = await fetch(databaseUrl('publicProducts/phase-03-write', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'phase-03-write' }),
});
if (publicWrite.status !== 401) {
  throw new Error(`Expected public product write denial; received ${publicWrite.status}.`);
}

const selfAllowlistWrite = await fetch(databaseUrl(`adminUids/${identity.localId}`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(true),
});
if (selfAllowlistWrite.status !== 401) {
  throw new Error(`Expected /adminUids self-write denial; received ${selfAllowlistWrite.status}.`);
}

const phase07RequestId = `phase07-${Date.now()}`;
const phase07OrderId = `order-${phase07RequestId}`;
const phase07Now = new Date().toISOString();
const orderRequestWrite = await fetch(databaseUrl(`orderRequests/${phase07RequestId}`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    uid: identity.localId,
    orderId: phase07OrderId,
    status: 'creating',
    createdAt: phase07Now,
  }),
});
if (!orderRequestWrite.ok) {
  throw new Error(`Authenticated order request write failed with HTTP ${orderRequestWrite.status}.`);
}

const duplicateRequestWrite = await fetch(databaseUrl(`orderRequests/${phase07RequestId}`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    uid: identity.localId,
    orderId: `${phase07OrderId}-other`,
    status: 'creating',
    createdAt: phase07Now,
  }),
});
if (duplicateRequestWrite.ok) {
  throw new Error('Expected duplicate order request repoint denial, but the write succeeded.');
}

const productStockDecrement = await fetch(databaseUrl('products/blue-pearl-blouse/stock', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(8),
});
const publicStockDecrement = await fetch(databaseUrl('publicProducts/blue-pearl-blouse/stock', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(8),
});
if (!productStockDecrement.ok || !publicStockDecrement.ok) {
  throw new Error(`Authenticated stock decrement failed: private ${productStockDecrement.status}, public ${publicStockDecrement.status}.`);
}

const stockIncrease = await fetch(databaseUrl('publicProducts/blue-pearl-blouse/stock', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(9),
});
if (stockIncrease.ok) {
  throw new Error('Expected non-admin stock increase denial, but the write succeeded.');
}

const validStorefrontOrder = {
  id: phase07OrderId,
  requestId: phase07RequestId,
  orderNumber: 'PAV-007',
  status: 'new',
  paymentStatus: 'awaiting_confirmation',
  paymentMethod: 'cash_on_delivery',
  items: [{
    id: 'blue-pearl-blouse',
    name: 'Blue Pearl Ruffle Blouse',
    qty: 1,
    price: 42,
    size: 'S',
    color: 'Sky Blue',
  }],
  customer: {
    name: 'Smoke Customer',
    phone: '+96170000000',
    city: 'Beirut',
    deliveryArea: 'beirut',
    address: 'Test address',
    notes: '',
    payment: 'Cash on delivery',
  },
  subtotal: 42,
  discount: 0,
  delivery: 4,
  total: 46,
  promoCode: '',
  notes: '',
  source: 'web',
  whatsappText: 'Smoke order text',
  pricingReview: {
    status: 'client_recalculated_from_public_rtdb',
    expectedSubtotal: 42,
    expectedDiscount: 0,
    expectedDelivery: 4,
    expectedTotal: 46,
    checkedAt: phase07Now,
  },
  stockReserved: true,
  stockRestored: false,
  createdAt: phase07Now,
  updatedAt: phase07Now,
  createdBy: identity.localId,
  updatedBy: identity.localId,
};
const storefrontOrderWrite = await fetch(databaseUrl(`orders/${phase07OrderId}`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(validStorefrontOrder),
});
if (!storefrontOrderWrite.ok) {
  throw new Error(`Valid storefront order write failed with HTTP ${storefrontOrderWrite.status}.`);
}

const nonAdminStatusEscalation = await fetch(databaseUrl(`orders/${phase07OrderId}/paymentStatus`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify('paid'),
});
if (nonAdminStatusEscalation.ok) {
  throw new Error('Expected non-admin paymentStatus escalation denial, but it succeeded.');
}

async function expectInvalidStorefrontOrderDenied(suffix, mutator) {
  const requestId = `${phase07RequestId}-${suffix}`;
  const orderId = `order-${requestId}`;
  const request = await fetch(databaseUrl(`orderRequests/${requestId}`, identity.idToken), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      uid: identity.localId,
      orderId,
      status: 'creating',
      createdAt: phase07Now,
    }),
  });
  if (!request.ok) throw new Error(`Could not create invalid-order request fixture ${suffix}.`);
  const candidate = JSON.parse(JSON.stringify({
    ...validStorefrontOrder,
    id: orderId,
    requestId,
    orderNumber: `PAV-007-${suffix}`,
  }));
  mutator(candidate);
  const response = await fetch(databaseUrl(`orders/${orderId}`, identity.idToken), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(candidate),
  });
  if (response.ok) throw new Error(`Expected invalid storefront order ${suffix} to be denied.`);
}

await expectInvalidStorefrontOrderDenied('negative-qty', (candidate) => {
  candidate.items[0].qty = -1;
});
await expectInvalidStorefrontOrderDenied('fake-price', (candidate) => {
  candidate.items[0].price = 1;
  candidate.subtotal = 1;
  candidate.total = 5;
});
await expectInvalidStorefrontOrderDenied('fake-total', (candidate) => {
  candidate.total = 1;
});

const app = getApps()[0];
const database = getDatabase(app);
await database.ref(`adminUids/${identity.localId}`).set(true);

const adminPrivateRead = await fetch(databaseUrl('products', identity.idToken));
if (!adminPrivateRead.ok) {
  throw new Error(`Allowlisted admin private product read failed with HTTP ${adminPrivateRead.status}.`);
}

const adminCancelOrder = await fetch(databaseUrl('', identity.idToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    [`orders/${phase07OrderId}/status`]: 'cancelled',
    [`orders/${phase07OrderId}/cancelledAt`]: new Date().toISOString(),
    [`orders/${phase07OrderId}/stockRestored`]: true,
    [`orders/${phase07OrderId}/stockRestoredAt`]: new Date().toISOString(),
    [`orders/${phase07OrderId}/updatedAt`]: new Date().toISOString(),
    [`orders/${phase07OrderId}/updatedBy`]: identity.localId,
    'products/blue-pearl-blouse/stock': 9,
    'publicProducts/blue-pearl-blouse/stock': 9,
  }),
});
if (!adminCancelOrder.ok) {
  throw new Error(`Allowlisted admin cancellation stock restore failed with HTTP ${adminCancelOrder.status}.`);
}
const restoredStock = await (await fetch(databaseUrl('publicProducts/blue-pearl-blouse/stock', identity.idToken))).json();
if (restoredStock !== 9) {
  throw new Error(`Expected cancellation to restore stock to 9, got ${restoredStock}.`);
}

const product = publicProducts['blue-pearl-blouse'];
const adminProduct = {
  ...product,
  name: 'Phase 04 Rules Smoke Blouse',
  createdBy: identity.localId,
  updatedBy: identity.localId,
  updatedAt: new Date().toISOString(),
};
const publicProduct = {
  ...product,
  name: 'Phase 04 Rules Smoke Blouse',
  updatedAt: adminProduct.updatedAt,
};
delete publicProduct.createdBy;
delete publicProduct.updatedBy;
const auditId = `phase04-${Date.now()}`;
const adminProductUpdate = await fetch(databaseUrl('', identity.idToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    'products/blue-pearl-blouse': adminProduct,
    'publicProducts/blue-pearl-blouse': publicProduct,
    [`auditLogs/${auditId}`]: {
      actorUid: identity.localId,
      action: 'product.upsert',
      targetType: 'product',
      targetId: 'blue-pearl-blouse',
      createdAt: new Date().toISOString(),
    },
  }),
});
if (!adminProductUpdate.ok) {
  throw new Error(`Allowlisted admin product update failed with HTTP ${adminProductUpdate.status}.`);
}

const invalidImageUpdate = await fetch(databaseUrl('products/invalid-image-product', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...adminProduct,
    id: 'invalid-image-product',
    slug: 'invalid-image-product',
    imageProvider: 'local',
    imageId: 'not-a-pavia-image',
  }),
});
if (invalidImageUpdate.ok) {
  throw new Error('Expected invalid image validation denial, but the write succeeded.');
}
const invalidImageRead = await fetch(databaseUrl('products/invalid-image-product', identity.idToken));
const invalidImageRecord = await invalidImageRead.json();
if (invalidImageRecord !== null) {
  throw new Error('Invalid image product was created despite validation denial.');
}

const settingsUpdate = await fetch(databaseUrl('', identity.idToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    storeSettings: {
      siteName: 'Pavia',
      siteTitle: 'Pavia Phase 05 Smoke',
      location: 'Beirut',
      deliveryArea: 'Lebanon',
      tagline: 'Modern elegant fashion',
      description: 'Smoke settings',
      phoneDisplay: '+961 70 000 000',
      phoneNumber: '+96170000000',
      whatsappNumber: '+96170000000',
      instagramHandle: '@pavialb',
      instagramUrl: 'https://instagram.com/pavialb',
      currency: 'USD',
      freeDeliveryAt: 125,
      deliveryBeirut: 4,
      deliveryLebanon: 6,
      checkoutEnabled: true,
      whatsappCheckoutEnabled: true,
      paymentMethods: {
        cash_on_delivery: true,
        whish_money: true,
      },
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
      updatedBy: identity.localId,
    },
    publicStoreSettings: {
      siteName: 'Pavia',
      siteTitle: 'Pavia Phase 05 Smoke',
      location: 'Beirut',
      deliveryArea: 'Lebanon',
      tagline: 'Modern elegant fashion',
      description: 'Smoke settings',
      phoneDisplay: '+961 70 000 000',
      phoneNumber: '+96170000000',
      whatsappNumber: '+96170000000',
      instagramHandle: '@pavialb',
      instagramUrl: 'https://instagram.com/pavialb',
      currency: 'USD',
      freeDeliveryAt: 125,
      deliveryBeirut: 4,
      deliveryLebanon: 6,
      checkoutEnabled: true,
      whatsappCheckoutEnabled: true,
      paymentMethods: {
        cash_on_delivery: true,
        whish_money: true,
      },
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    },
  }),
});
if (!settingsUpdate.ok) {
  throw new Error(`Allowlisted admin settings sync failed with HTTP ${settingsUpdate.status}.`);
}
const publicSettingsSmoke = await (await fetch(databaseUrl('publicStoreSettings', identity.idToken))).json();
if (publicSettingsSmoke.siteTitle !== 'Pavia Phase 05 Smoke' || publicSettingsSmoke.deliveryBeirut !== 4) {
  throw new Error('Public store settings projection was not updated.');
}

const promoSmoke = {
  code: 'PHASE05',
  active: true,
  type: 'percent',
  value: 15,
  label: 'Phase 05 Smoke',
  minSubtotal: 25,
  startsAt: '',
  endsAt: '',
  usageLimit: 10,
  usageCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  updatedBy: identity.localId,
};
const promoUpdate = await fetch(databaseUrl('', identity.idToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    'promoCodes/PHASE05': promoSmoke,
    'publicPromoCodes/PHASE05': {
      code: promoSmoke.code,
      active: promoSmoke.active,
      type: promoSmoke.type,
      value: promoSmoke.value,
      label: promoSmoke.label,
      minSubtotal: promoSmoke.minSubtotal,
      startsAt: promoSmoke.startsAt,
      endsAt: promoSmoke.endsAt,
    },
  }),
});
if (!promoUpdate.ok) {
  throw new Error(`Allowlisted admin promo sync failed with HTTP ${promoUpdate.status}.`);
}
const publicPromoSmoke = await (await fetch(databaseUrl('publicPromoCodes/PHASE05', identity.idToken))).json();
if (publicPromoSmoke?.label !== 'Phase 05 Smoke' || publicPromoSmoke?.usageLimit !== undefined) {
  throw new Error('Public promo projection was not updated or exposed private fields.');
}

const orderId = 'phase05-order';
await database.ref(`orders/${orderId}`).set({
  id: orderId,
  orderNumber: 'PAV-005',
  status: 'new',
  paymentStatus: 'awaiting_confirmation',
  paymentMethod: 'whish_money',
  items: [{
    id: 'blue-pearl-blouse',
    name: 'Phase 04 Rules Smoke Blouse',
    qty: 1,
    price: 42,
  }],
  customer: {
    name: 'Smoke Customer',
    phone: '+96170000000',
    city: 'Beirut',
    address: 'Test address',
  },
  subtotal: 42,
  discount: 0,
  delivery: 4,
  total: 46,
  source: 'web',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  createdBy: identity.localId,
});
const orderUpdate = await fetch(databaseUrl('', identity.idToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    [`orders/${orderId}/status`]: 'confirmed',
    [`orders/${orderId}/paymentStatus`]: 'paid',
    [`orders/${orderId}/adminNotes`]: 'Confirmed during Phase 05 smoke.',
    [`orders/${orderId}/updatedAt`]: new Date().toISOString(),
    [`orders/${orderId}/updatedBy`]: identity.localId,
  }),
});
if (!orderUpdate.ok) {
  throw new Error(`Allowlisted admin order workflow update failed with HTTP ${orderUpdate.status}.`);
}
const updatedOrder = await (await fetch(databaseUrl(`orders/${orderId}`, identity.idToken))).json();
if (updatedOrder.status !== 'confirmed' || updatedOrder.paymentStatus !== 'paid') {
  throw new Error('Order workflow update was not persisted.');
}

const subscriberId = `phase06-${Date.now()}`;
const subscriberWrite = await fetch(databaseUrl(`subscribers/${subscriberId}`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: subscriberId,
    email: 'phase06@example.com',
    consent: true,
    source: 'storefront',
    createdAt: new Date().toISOString(),
    createdBy: identity.localId,
  }),
});
if (!subscriberWrite.ok) {
  throw new Error(`Authenticated newsletter subscriber write failed with HTTP ${subscriberWrite.status}.`);
}

const invalidSubscriberWrite = await fetch(databaseUrl(`subscribers/${subscriberId}-invalid`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    id: `${subscriberId}-invalid`,
    email: 'phase06@example.com',
    consent: false,
    source: 'storefront',
    createdAt: new Date().toISOString(),
    createdBy: identity.localId,
  }),
});
if (invalidSubscriberWrite.ok) {
  throw new Error('Expected subscriber write without consent to be denied.');
}

console.log('RTDB Phase 07 storefront order, stock, idempotency, subscriber, and admin rules are active.');
await Promise.all(getApps().map((app) => deleteApp(app)));
