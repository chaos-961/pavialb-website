import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const projectId = process.env.GCLOUD_PROJECT || 'demo-pavia-local';
const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST;

function requireEmulator() {
  if (!emulatorHost) {
    throw new Error(
      'Refusing to seed without FIREBASE_DATABASE_EMULATOR_HOST. Start the Realtime Database emulator first.',
    );
  }
}

async function readBrowserData() {
  const sandbox = {
    window: {
      PaviaImages: {
        resolve: (value) => value,
      },
    },
  };
  vm.createContext(sandbox);

  const productsSource = await fs.readFile(path.join(projectRoot, 'js/products.js'), 'utf8');
  const configSource = await fs.readFile(path.join(projectRoot, 'js/config.js'), 'utf8');
  vm.runInContext(productsSource, sandbox, { filename: 'js/products.js' });
  vm.runInContext(configSource, sandbox, { filename: 'js/config.js' });

  return {
    products: sandbox.window.PAVIA_DEFAULT_PRODUCTS || [],
    promoCodes: sandbox.window.PAVIA_PROMO_CODES || {},
    settings: sandbox.window.PAVIA_CONFIG || {},
  };
}

function productRecord(product, index, seededAt) {
  const imageId = String(product.imageId || '').trim();
  const imageUrl = /^https?:\/\//i.test(String(product.image || ''))
    ? String(product.image)
    : '';

  return {
    id: product.id,
    slug: product.id,
    sku: product.sku || '',
    name: product.name,
    category: product.category || 'New Arrivals',
    badge: product.badge || '',
    description: product.description || '',
    price: Number(product.price) || 0,
    compareAt: Number(product.compareAt) || 0,
    currency: 'USD',
    stock: Math.max(0, Number(product.stock) || 0),
    sizes: Array.isArray(product.sizes) ? product.sizes : [],
    colors: Array.isArray(product.colors) ? product.colors : [],
    tags: Array.isArray(product.tags) ? product.tags : [],
    imageId,
    imageUrl,
    imageProvider: imageUrl ? 'external' : 'local_legacy',
    imageVersion: product.imageVersion || '',
    gallery: Array.isArray(product.gallery) ? product.gallery : [],
    material: product.material || '',
    fit: product.fit || '',
    care: product.care || '',
    active: product.active !== false,
    featured: Boolean(product.featured),
    rev: 1,
    sortOrder: index + 1,
    seoTitle: product.seoTitle || product.name,
    seoDescription: product.seoDescription || product.description || '',
    createdAt: seededAt,
    updatedAt: seededAt,
    createdBy: 'trusted-emulator-seed',
    updatedBy: 'trusted-emulator-seed',
  };
}

function publicProduct(record) {
  const {
    createdBy,
    updatedBy,
    ...publicFields
  } = record;
  return publicFields;
}

function promoRecord(code, promo, seededAt) {
  return {
    code,
    active: promo.active !== false,
    type: promo.type,
    value: Number(promo.value) || 0,
    label: promo.label || code,
    minSubtotal: Number(promo.minSubtotal) || 0,
    startsAt: promo.startsAt || '',
    endsAt: promo.endsAt || '',
    usageLimit: Number(promo.usageLimit) || 0,
    usageCount: Number(promo.usageCount) || 0,
    createdAt: seededAt,
    updatedAt: seededAt,
  };
}

function publicPromo(record) {
  return {
    code: record.code,
    active: record.active,
    type: record.type,
    value: record.value,
    label: record.label,
    minSubtotal: record.minSubtotal,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
  };
}

function storeSettings(settings, seededAt) {
  return {
    siteName: settings.siteName || 'Pavia',
    siteTitle: settings.siteTitle || 'Pavia Lebanon',
    location: settings.location || 'Beirut',
    deliveryArea: settings.deliveryArea || 'Lebanon',
    tagline: settings.tagline || 'Modern elegant fashion',
    description: settings.description || '',
    phoneDisplay: settings.phoneDisplay || '',
    phoneNumber: settings.phoneNumber || '',
    whatsappNumber: settings.whatsappNumber || '',
    instagramHandle: settings.instagramHandle || '',
    instagramUrl: settings.instagramUrl || '',
    currency: 'USD',
    freeDeliveryAt: 100,
    deliveryBeirut: 3,
    deliveryLebanon: 5,
    checkoutEnabled: true,
    whatsappCheckoutEnabled: true,
    paymentMethods: {
      cash_on_delivery: true,
      whish_money: true,
    },
    maintenanceMode: false,
    updatedAt: seededAt,
  };
}

function publicSettings(record) {
  return { ...record };
}

export async function seedRealtimeDatabase() {
  requireEmulator();
  const source = await readBrowserData();
  const seededAt = new Date().toISOString();
  const products = {};
  const publicProducts = {};
  const promoCodes = {};
  const publicPromoCodes = {};

  const publicCatalogManifest = { catalogRev: Date.parse(seededAt) || 0, products: {} };
  source.products.forEach((product, index) => {
    const record = productRecord(product, index, seededAt);
    products[record.id] = record;
    if (record.active) {
      publicProducts[record.id] = publicProduct(record);
      publicCatalogManifest.products[record.id] = Number(record.rev) || 1;
    }
  });

  Object.entries(source.promoCodes).forEach(([code, promo]) => {
    const record = promoRecord(code, promo, seededAt);
    promoCodes[code] = record;
    if (record.active) publicPromoCodes[code] = publicPromo(record);
  });

  const settings = storeSettings(source.settings, seededAt);
  const app = getApps()[0] || initializeApp({
    projectId,
    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
  });
  const database = getDatabase(app);

  await database.ref().update({
    products,
    publicProducts,
    publicCatalogManifest,
    promoCodes,
    publicPromoCodes,
    storeSettings: settings,
    publicStoreSettings: publicSettings(settings),
  });

  return {
    productCount: Object.keys(products).length,
    promoCodeCount: Object.keys(promoCodes).length,
    projectId,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await seedRealtimeDatabase();
  console.log(
    `Seeded ${result.productCount} products and ${result.promoCodeCount} promo codes into ${result.projectId}.`,
  );
  await Promise.all(getApps().map((app) => deleteApp(app)));
}
