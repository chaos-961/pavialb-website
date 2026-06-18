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

// Admin identity: Email/Password sign-in whose token carries the configured
// admin email claim. The database rules grant admin reads/writes only to this
// email, so admin operations below must use adminToken, while customer flows
// (orders, stock decrement, newsletter) keep using the anonymous identity.
const adminEmail = 'paviadata@gmail.com';
const adminSignInResponse = await fetch(
  'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-pavia-local',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'smoke-admin-password', returnSecureToken: true }),
  },
);
if (!adminSignInResponse.ok) {
  throw new Error(`Admin Email/Password emulator sign-in failed with HTTP ${adminSignInResponse.status}.`);
}
const adminIdentity = await adminSignInResponse.json();
const adminToken = adminIdentity.idToken;
if (!adminIdentity.localId || !adminToken) {
  throw new Error('Admin Email/Password sign-in did not return a UID and ID token.');
}
console.log(`Admin Email/Password issued test UID ${adminIdentity.localId} for ${adminEmail}.`);

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

// Admin-identity model: an anonymous (non-admin) signed-in session must NOT be
// able to read the private products node...
const anonPrivateRead = await fetch(databaseUrl('products', identity.idToken));
if (anonPrivateRead.status !== 401) {
  throw new Error(`Expected anonymous private product read denial; received ${anonPrivateRead.status}.`);
}
// ...but the admin Email/Password session can.
const privateRead = await fetch(databaseUrl('products', adminToken));
if (!privateRead.ok) {
  throw new Error(`Admin private product read failed with HTTP ${privateRead.status}.`);
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

// An anonymous (non-admin) signed-in session must NOT be able to author a full
// admin product projection; only the admin email may. (Stock-only decrements,
// tested later, remain allowed for the customer checkout flow.)
const anonAdminWrite = await fetch(databaseUrl('publicProducts/anon-admin-test', identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'anon-admin-test', name: 'Should be denied', price: 1, stock: 1, active: true, imageProvider: 'local_legacy' }),
});
if (anonAdminWrite.ok) {
  throw new Error('Expected anonymous (non-admin) full product write to be denied.');
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

// The admin (Email/Password) session can list and display the storefront order.
const adminOrdersRead = await fetch(databaseUrl('orders', adminToken));
if (!adminOrdersRead.ok) {
  throw new Error(`Admin session could not read orders: HTTP ${adminOrdersRead.status}.`);
}
const adminOrders = await adminOrdersRead.json();
if (adminOrders?.[phase07OrderId]?.orderNumber !== validStorefrontOrder.orderNumber) {
  throw new Error('The storefront order was not visible to the admin session.');
}
console.log(`Admin order list received test order ${validStorefrontOrder.orderNumber}.`);

// An anonymous (non-admin) session must NOT be able to read the private orders
// node under the admin-identity model.
const anonOrdersRead = await fetch(databaseUrl('orders', identity.idToken));
if (anonOrdersRead.status !== 401) {
  throw new Error(`Expected anonymous orders read denial; received ${anonOrdersRead.status}.`);
}

const app = getApps()[0];
const database = getDatabase(app);

// Admin cancellation restores (increases) stock — only the admin email may do
// this; the customer stock branch allows decrements only.
const adminCancelOrder = await fetch(databaseUrl('', adminToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    [`orders/${phase07OrderId}/status`]: 'cancelled',
    [`orders/${phase07OrderId}/cancelledAt`]: new Date().toISOString(),
    [`orders/${phase07OrderId}/stockRestored`]: true,
    [`orders/${phase07OrderId}/stockRestoredAt`]: new Date().toISOString(),
    [`orders/${phase07OrderId}/updatedAt`]: new Date().toISOString(),
    [`orders/${phase07OrderId}/updatedBy`]: adminIdentity.localId,
    'products/blue-pearl-blouse/stock': 9,
    'publicProducts/blue-pearl-blouse/stock': 9,
  }),
});
if (!adminCancelOrder.ok) {
  throw new Error(`Admin cancellation stock restore failed with HTTP ${adminCancelOrder.status}.`);
}
const restoredStock = await (await fetch(databaseUrl('publicProducts/blue-pearl-blouse/stock', identity.idToken))).json();
if (restoredStock !== 9) {
  throw new Error(`Expected cancellation to restore stock to 9, got ${restoredStock}.`);
}

const product = publicProducts['blue-pearl-blouse'];
const adminProduct = {
  ...product,
  name: 'Phase 04 Rules Smoke Blouse',
  createdBy: adminIdentity.localId,
  updatedBy: adminIdentity.localId,
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
const adminProductUpdate = await fetch(databaseUrl('', adminToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    'products/blue-pearl-blouse': adminProduct,
    'publicProducts/blue-pearl-blouse': publicProduct,
    [`auditLogs/${auditId}`]: {
      actorUid: adminIdentity.localId,
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
const driveImageUpdate = await fetch(databaseUrl('products/drive-image-product', adminToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(driveImageProduct),
});
if (!driveImageUpdate.ok) {
  throw new Error(`Expected Google Drive image product write to succeed, got HTTP ${driveImageUpdate.status}.`);
}

const settingsUpdate = await fetch(databaseUrl('', adminToken), {
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
const promoUpdate = await fetch(databaseUrl('', adminToken), {
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
const orderUpdate = await fetch(databaseUrl('', adminToken), {
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
const updatedOrder = await (await fetch(databaseUrl(`orders/${orderId}`, adminToken))).json();
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

// --- P14 revision-aware cache: manifest seeded, single-node fetch, rev/manifest bump ---
const seededManifest = await (await fetch(databaseUrl('publicCatalogManifest', identity.idToken))).json();
if (!seededManifest || typeof seededManifest.catalogRev !== 'number') {
  throw new Error('Expected publicCatalogManifest.catalogRev to be seeded as a number.');
}
if (Object.keys(seededManifest.products || {}).length !== 12) {
  throw new Error(`Expected 12 product revisions in the seeded manifest, got ${Object.keys(seededManifest.products || {}).length}.`);
}
if (seededManifest.products['blue-pearl-blouse'] !== 1) {
  throw new Error('Expected seeded rev 1 for blue-pearl-blouse in the manifest.');
}

// Differential sync fetches only changed ids, one node at a time.
const singleNode = await (await fetch(databaseUrl('publicProducts/blue-pearl-blouse', identity.idToken))).json();
if (!singleNode || singleNode.id !== 'blue-pearl-blouse') {
  throw new Error('Expected to fetch a single public product node by id.');
}

// An admin save bumps the product rev and the manifest so storefronts detect the delta.
const revBumpWrite = await fetch(databaseUrl('', adminToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    'products/blue-pearl-blouse/rev': 2,
    'publicProducts/blue-pearl-blouse/rev': 2,
    'publicCatalogManifest/products/blue-pearl-blouse': 2,
    'publicCatalogManifest/catalogRev': Date.now(),
  }),
});
if (!revBumpWrite.ok) {
  throw new Error(`Expected manifest/rev bump write to succeed, got HTTP ${revBumpWrite.status}.`);
}
const bumpedRev = await (await fetch(databaseUrl('publicCatalogManifest/products/blue-pearl-blouse', identity.idToken))).json();
if (bumpedRev !== 2) {
  throw new Error(`Expected bumped manifest rev 2, got ${bumpedRev}.`);
}
console.log('RTDB P14 cache: manifest seeded (12 revs), single-node fetch, and rev/manifest bump verified.');

// --- P13 storefront security hardening: hostile markup and forged totals rejected ---
// The clean control proves the only difference (angle brackets / discount bound)
// is what triggers each denial, not some unrelated validation failure.
const cleanPublicProduct = { ...publicProduct, id: 'p13-clean', slug: 'p13-clean', name: 'Clean P13 Product' };
const cleanProductWrite = await fetch(databaseUrl('publicProducts/p13-clean', adminToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(cleanPublicProduct),
});
if (!cleanProductWrite.ok) {
  throw new Error(`Expected clean P13 public product write to succeed, got HTTP ${cleanProductWrite.status}.`);
}

const xssPublicProduct = { ...publicProduct, id: 'p13-xss', slug: 'p13-xss', name: 'Hostile <img src=x onerror=alert(1)>' };
const xssProductWrite = await fetch(databaseUrl('publicProducts/p13-xss', adminToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(xssPublicProduct),
});
if (xssProductWrite.ok) {
  throw new Error('Expected publicProducts angle-bracket name to be rejected by .validate.');
}

const xssSettingsWrite = await fetch(databaseUrl('publicStoreSettings', adminToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...publicSettingsSmoke, siteName: 'Pavia <script>alert(1)</script>' }),
});
if (xssSettingsWrite.ok) {
  throw new Error('Expected publicStoreSettings angle-bracket siteName to be rejected by .validate.');
}

const xssPromoWrite = await fetch(databaseUrl('publicPromoCodes/P13XSS', adminToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    code: 'P13XSS', active: true, type: 'percent', value: 10,
    label: 'Bad <b>x</b>', minSubtotal: 0, startsAt: '', endsAt: '',
  }),
});
if (xssPromoWrite.ok) {
  throw new Error('Expected publicPromoCodes angle-bracket label to be rejected by .validate.');
}

const forgedOrderId = `p13-forged-${Date.now()}`;
const forgedOrderWrite = await fetch(databaseUrl(`orders/${forgedOrderId}`, adminToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ...validStorefrontOrder,
    id: forgedOrderId,
    requestId: `p13-forged-req-${Date.now()}`,
    subtotal: 42,
    discount: 100,
    total: -54,
  }),
});
if (forgedOrderWrite.ok) {
  throw new Error('Expected order with discount > subtotal to be rejected by .validate.');
}
console.log('RTDB P13 hardening: angle-bracket name/settings/promo writes and discount>subtotal orders are denied.');

// --- Visitor analytics: anonymous self-write to users/{uid}, admin-only read ---
const visitNow = Date.now();
const visitWrite = await fetch(databaseUrl(`users/${identity.localId}`, identity.idToken), {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    'profile/createdAt': visitNow,
    'activity/lastSeenAt': visitNow,
    'visits/count': 1,
    'visits/lastAt': visitNow,
    'sessionHistory/smoke-session/startedAt': visitNow,
    'events/product_view/count': 1,
    'events/product_view/lastAt': visitNow,
    'eventHistory/smoke-event/type': 'product_view',
    'eventHistory/smoke-event/at': visitNow,
  }),
});
if (!visitWrite.ok) {
  throw new Error(`Anonymous visitor analytics write failed with HTTP ${visitWrite.status}.`);
}

// A visitor cannot tamper with someone else's analytics node.
const foreignVisitWrite = await fetch(databaseUrl(`users/not-${identity.localId}/visits`, identity.idToken), {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ count: 1, lastAt: visitNow }),
});
if (foreignVisitWrite.ok) {
  throw new Error('Expected write to another visitor UID to be denied.');
}

// Visitors cannot read the analytics node; only the admin email can.
const anonUsersRead = await fetch(databaseUrl('users', identity.idToken));
if (anonUsersRead.status !== 401) {
  throw new Error(`Expected anonymous users read denial; received ${anonUsersRead.status}.`);
}
const adminUsersRead = await fetch(databaseUrl('users', adminToken));
if (!adminUsersRead.ok) {
  throw new Error(`Admin visitor analytics read failed with HTTP ${adminUsersRead.status}.`);
}
const usersData = await adminUsersRead.json();
if (Number(usersData?.[identity.localId]?.visits?.count) !== 1
  || Number(usersData?.[identity.localId]?.events?.product_view?.count) !== 1) {
  throw new Error('Admin could not see the recorded visitor visit/event counts.');
}
console.log('RTDB visitor analytics: anonymous self-write, foreign-write denial, and admin-only read verified.');

console.log('RTDB admin-identity model: admin email writes, anonymous customer flows, denials, and projections are active.');
await Promise.all(getApps().map((app) => deleteApp(app)));
