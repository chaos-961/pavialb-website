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

// P12 password-only model: any signed-in user may read/write admin data; rules
// only require auth != null. The private product read is therefore allowed.
const privateRead = await fetch(databaseUrl('products', identity.idToken));
if (!privateRead.ok) {
  throw new Error(`Authenticated private product read failed with HTTP ${privateRead.status}.`);
}

// Unauthenticated writes must still be denied (auth != null is required).
const anonymousWrite = await fetch(databaseUrl('publicProducts/anon-write-test'), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'anon-write-test' }),
});
if (anonymousWrite.status !== 401) {
  throw new Error(`Expected unauthenticated public write denial; received ${anonymousWrite.status}.`);
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

// NOTE: under the P12 password-only model, RTDB rules no longer reject tampered
// order totals, fake prices, payment-status escalation, or credential-shaped
// fields from a signed-in client. That server-side tamper protection was
// intentionally removed when the UID allowlist was dropped; the encrypted admin
// password only gates the admin UI, not the database.

const app = getApps()[0];
const database = getDatabase(app);

const adminPrivateRead = await fetch(databaseUrl('products', identity.idToken));
if (!adminPrivateRead.ok) {
  throw new Error(`Authenticated private product read failed with HTTP ${adminPrivateRead.status}.`);
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
  throw new Error(`Authenticated admin cancellation stock restore failed with HTTP ${adminCancelOrder.status}.`);
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
  throw new Error(`Authenticated admin product update failed with HTTP ${adminProductUpdate.status}.`);
}

const driveImageProduct = {
  ...adminProduct,
  id: 'drive-image-product',
  slug: 'drive-image-product',
  name: 'Drive Image Product',
  imageProvider: 'google_drive',
  imageId: '',
  imageUrl: 'https://drive.google.com/thumbnail?id=test-drive-file&sz=w1600',
  driveFileId: 'test-drive-file',
  imageVersion: '20260617120000',
  imageMeta: {
    provider: 'google_drive',
    mimeType: 'image/webp',
    width: 1400,
    height: 1800,
    byteSize: 280000,
    driveFileId: 'test-drive-file',
    updatedAt: new Date().toISOString(),
  },
};
const driveImageUpdate = await fetch(databaseUrl('products/drive-image-product', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(driveImageProduct),
});
if (!driveImageUpdate.ok) {
  throw new Error(`Expected Google Drive image product write to succeed, got HTTP ${driveImageUpdate.status}.`);
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
  throw new Error(`Authenticated admin settings sync failed with HTTP ${settingsUpdate.status}.`);
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
  throw new Error(`Authenticated admin promo sync failed with HTTP ${promoUpdate.status}.`);
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
  throw new Error(`Authenticated admin order workflow update failed with HTTP ${orderUpdate.status}.`);
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

console.log('RTDB P12 password-only model: authed reads/writes, order/subscriber paths, and projections are active.');
await Promise.all(getApps().map((app) => deleteApp(app)));
