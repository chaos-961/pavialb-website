(() => {
  'use strict';

  const localBackend = window.PaviaBackend;
  const backendConfig = window.PAVIA_BACKEND_CONFIG || {};
  const firebaseConfig = window.PAVIA_FIREBASE_CONFIG || {};
  const sdkVersion = '12.14.0';
  const sdkBase = `https://www.gstatic.com/firebasejs/${sdkVersion}`;
  const localhostNames = new Set(['localhost', '127.0.0.1', '::1']);
  const localHost = localhostNames.has(window.location.hostname);
  const requestedByQuery = localHost
    ? new URLSearchParams(window.location.search).get('backend')
    : '';
  const requestedProvider = requestedByQuery || backendConfig.provider || 'local';
  const fallbackEnabled = backendConfig.fallbackToLocal !== false;
  const firebaseState = {
    auth: null,
    authApi: null,
    database: null,
    databaseApi: null,
    initialized: false,
    subscriptions: new Set(),
    authListeners: new Set(),
  };
  let activeProvider = 'local';
  let initializationError = null;
  let adminUnlocked = false;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function values(record) {
    return Object.values(record || {});
  }

  function orderedProducts(record) {
    return values(record).sort((left, right) => {
      const order = (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0);
      return order || String(left.name || left.id).localeCompare(String(right.name || right.id));
    });
  }

  function normalizePublicProduct(product) {
    const imageId = String(product.imageId || '').trim();
    const imageUrl = String(product.imageUrl || '').trim();
    return {
      ...product,
      image: imageUrl || imageId,
      imageId,
      imageUrl,
    };
  }

  function firebaseAppConfig() {
    const app = firebaseConfig.app || {};
    if (!app.apiKey || !app.projectId || !app.databaseURL) {
      throw new Error('Firebase web configuration is incomplete.');
    }
    return app;
  }

  async function initializeFirebase() {
    if (firebaseState.initialized) return;

    const [appApi, authApi, databaseApi] = await Promise.all([
      import(`${sdkBase}/firebase-app.js`),
      import(`${sdkBase}/firebase-auth.js`),
      import(`${sdkBase}/firebase-database.js`),
    ]);
    const app = appApi.getApps().length
      ? appApi.getApp()
      : appApi.initializeApp(firebaseAppConfig());
    const auth = authApi.getAuth(app);
    const database = databaseApi.getDatabase(app);

    if (firebaseConfig.useEmulators) {
      if (!localHost) {
        throw new Error('Firebase emulators may only be selected from localhost.');
      }
      const emulators = firebaseConfig.emulators || {};
      authApi.connectAuthEmulator(
        auth,
        `http://${emulators.authHost || '127.0.0.1'}:${emulators.authPort || 9099}`,
        { disableWarnings: true },
      );
      databaseApi.connectDatabaseEmulator(
        database,
        emulators.databaseHost || '127.0.0.1',
        Number(emulators.databasePort) || 9000,
      );
    }

    if (!auth.currentUser) {
      await authApi.signInAnonymously(auth);
    }

    firebaseState.auth = auth;
    firebaseState.authApi = authApi;
    firebaseState.database = database;
    firebaseState.databaseApi = databaseApi;
    firebaseState.initialized = true;
    authApi.onAuthStateChanged(auth, () => {
      firebaseState.authListeners.forEach((listener) => listener());
    });
  }

  function databaseReference(path) {
    return firebaseState.databaseApi.ref(firebaseState.database, path);
  }

  async function readPath(path) {
    const snapshot = await firebaseState.databaseApi.get(databaseReference(path));
    return snapshot.exists() ? snapshot.val() : null;
  }

  function subscribePath(path, listener) {
    if (!firebaseState.initialized) return () => {};
    const unsubscribe = firebaseState.databaseApi.onValue(
      databaseReference(path),
      () => listener(),
      (error) => console.warn(`Pavia Firebase subscription failed for ${path}.`, error),
    );
    firebaseState.subscriptions.add(unsubscribe);
    return () => {
      firebaseState.subscriptions.delete(unsubscribe);
      unsubscribe();
    };
  }

  function mutationDisabled() {
    throw new Error('This Firebase write path is not enabled for browser clients yet.');
  }

  function safeKey(value, fallback = '') {
    return String(value || fallback || '')
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 120);
  }

  function normalizeOrderItems(items) {
    return (Array.isArray(items) ? items : values(items)).map((item) => ({
      id: safeKey(item.id),
      name: String(item.name || '').trim().slice(0, 120),
      qty: Math.max(1, Math.min(20, Number(item.qty) || 1)),
      price: Math.max(0, Number(item.price) || 0),
      size: String(item.size || '').trim().slice(0, 40),
      color: String(item.color || '').trim().slice(0, 60),
    })).filter((item) => item.id && item.qty > 0);
  }

  function calculatePromoDiscount(promo, subtotal) {
    if (!promo || promo.active === false) return 0;
    if (Number(promo.minSubtotal || 0) > subtotal) return 0;
    const today = new Date().toISOString().slice(0, 10);
    if (promo.startsAt && promo.startsAt > today) return 0;
    if (promo.endsAt && promo.endsAt < today) return 0;
    if (promo.type === 'percent') return Math.round(subtotal * (Math.max(0, Number(promo.value) || 0) / 100));
    if (promo.type === 'fixed') return Math.min(subtotal, Math.max(0, Number(promo.value) || 0));
    return 0;
  }

  function calculateDelivery(settings, subtotalAfterDiscount, promo, deliveryArea) {
    if (promo?.type === 'freeship') return 0;
    if (subtotalAfterDiscount >= Number(settings.freeDeliveryAt || 0)) return 0;
    return deliveryArea === 'beirut'
      ? Math.max(0, Number(settings.deliveryBeirut) || 0)
      : Math.max(0, Number(settings.deliveryLebanon) || 0);
  }

  async function transactStock(path, delta) {
    const result = await firebaseState.databaseApi.runTransaction(databaseReference(path), (current) => {
      const stock = Number(current);
      if (!Number.isFinite(stock) || stock + delta < 0) return;
      return stock + delta;
    });
    if (!result.committed) throw new Error('Stock is no longer available.');
    return result;
  }

  async function isCurrentUidAllowlisted() {
    if (activeProvider !== 'firebase') return true;
    const uid = firebaseState.auth?.currentUser?.uid;
    if (!uid) return false;
    const snapshot = await firebaseState.databaseApi.get(databaseReference(`adminUids/${uid}`));
    return snapshot.val() === true;
  }

  async function assertAdminReady() {
    if (activeProvider === 'local') return;
    if (!adminUnlocked) throw new Error('Admin unlock is required before this operation.');
    if (!(await isCurrentUidAllowlisted())) {
      throw new Error('This anonymous UID is not allowlisted for admin operations.');
    }
  }

  function normalizeProductRecord(product) {
    const now = new Date().toISOString();
    const id = String(product.id || product.slug || '').trim();
    if (!id) throw new Error('Product ID is required.');
    const imageId = String(product.imageId || window.PaviaImages?.idFor?.(product.image) || '').trim();
    const imageUrl = /^https?:\/\//i.test(String(product.imageUrl || product.image || ''))
      ? String(product.imageUrl || product.image)
      : '';
    return {
      id,
      slug: product.slug || id,
      sku: product.sku || '',
      name: product.name || 'Untitled product',
      category: product.category || 'New Arrivals',
      badge: product.badge || '',
      description: product.description || '',
      price: Number(product.price) || 0,
      compareAt: Number(product.compareAt) || 0,
      currency: product.currency || 'USD',
      stock: Math.max(0, Number(product.stock) || 0),
      sizes: Array.isArray(product.sizes) ? product.sizes : [],
      colors: Array.isArray(product.colors) ? product.colors : [],
      tags: Array.isArray(product.tags) ? product.tags : [],
      imageId,
      imageUrl,
      imageProvider: imageUrl ? 'external' : 'local',
      imageVersion: product.imageVersion || '',
      gallery: Array.isArray(product.gallery) ? product.gallery : [],
      material: product.material || '',
      fit: product.fit || '',
      care: product.care || '',
      active: product.active !== false,
      featured: Boolean(product.featured),
      sortOrder: Number(product.sortOrder || product.createdAt) || Date.now(),
      seoTitle: product.seoTitle || product.name || 'Pavia product',
      seoDescription: product.seoDescription || product.description || '',
      createdAt: product.createdAt || now,
      updatedAt: now,
      createdBy: product.createdBy || firebaseState.auth?.currentUser?.uid || 'admin',
      updatedBy: firebaseState.auth?.currentUser?.uid || 'admin',
    };
  }

  function publicProduct(record) {
    const { createdBy, updatedBy, ...publicFields } = record;
    return publicFields;
  }

  function normalizeSettingsRecord(settings) {
    const paymentMethods = settings.paymentMethods || {};
    return {
      siteName: settings.siteName || 'Pavia',
      siteTitle: settings.siteTitle || 'Pavia Lebanon',
      location: settings.location || 'Beirut',
      deliveryArea: settings.deliveryArea || 'Lebanon',
      tagline: settings.tagline || '',
      description: settings.description || '',
      phoneDisplay: settings.phoneDisplay || '',
      phoneNumber: settings.phoneNumber || '',
      whatsappNumber: settings.whatsappNumber || '',
      instagramHandle: settings.instagramHandle || '',
      instagramUrl: settings.instagramUrl || '',
      currency: settings.currency || 'USD',
      freeDeliveryAt: Math.max(0, Number(settings.freeDeliveryAt) || 0),
      deliveryBeirut: Math.max(0, Number(settings.deliveryBeirut) || 0),
      deliveryLebanon: Math.max(0, Number(settings.deliveryLebanon) || 0),
      checkoutEnabled: settings.checkoutEnabled !== false,
      whatsappCheckoutEnabled: settings.whatsappCheckoutEnabled !== false,
      paymentMethods: {
        cash_on_delivery: paymentMethods.cash_on_delivery !== false,
        whish_money: paymentMethods.whish_money !== false,
      },
      maintenanceMode: Boolean(settings.maintenanceMode),
      updatedAt: new Date().toISOString(),
      updatedBy: firebaseState.auth?.currentUser?.uid || 'admin',
    };
  }

  function publicSettings(record) {
    const { updatedBy, ...publicFields } = record;
    return publicFields;
  }

  function normalizePromoRecord(code, promo) {
    const normalizedCode = String(code || promo?.code || '').trim().toUpperCase();
    if (!normalizedCode) throw new Error('Promo code is required.');
    const now = new Date().toISOString();
    return {
      code: normalizedCode,
      active: promo.active !== false,
      type: ['percent', 'fixed', 'freeship'].includes(promo.type) ? promo.type : 'percent',
      value: Math.max(0, Number(promo.value) || 0),
      label: promo.label || normalizedCode,
      minSubtotal: Math.max(0, Number(promo.minSubtotal) || 0),
      startsAt: promo.startsAt || '',
      endsAt: promo.endsAt || '',
      usageLimit: Math.max(0, Number(promo.usageLimit) || 0),
      usageCount: Math.max(0, Number(promo.usageCount) || 0),
      createdAt: promo.createdAt || now,
      updatedAt: now,
      updatedBy: firebaseState.auth?.currentUser?.uid || 'admin',
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

  async function writeProduct(product) {
    await assertAdminReady();
    const record = normalizeProductRecord(product);
    const updates = {
      [`products/${record.id}`]: record,
      [`publicProducts/${record.id}`]: record.active ? publicProduct(record) : null,
      [`auditLogs/${Date.now()}-${record.id}`]: {
        actorUid: firebaseState.auth?.currentUser?.uid || '',
        action: 'product.upsert',
        targetType: 'product',
        targetId: record.id,
        createdAt: new Date().toISOString(),
      },
    };
    await firebaseState.databaseApi.update(databaseReference('/'), updates);
    return record;
  }

  const backend = {
    get provider() {
      return activeProvider;
    },
    get schemaVersion() {
      return backendConfig.schemaVersion || 1;
    },
    get initializationError() {
      return initializationError;
    },
    get authUid() {
      return firebaseState.auth?.currentUser?.uid || '';
    },
    get capabilities() {
      if (activeProvider === 'firebase') {
        return Object.freeze({
          adminMutations: adminUnlocked,
          orderCreation: true,
          orderManagement: adminUnlocked,
          realtimeProducts: true,
          publicSettings: true,
          publicPromoCodes: true,
          subscribers: true,
        });
      }
      return Object.freeze({
        adminMutations: true,
        orderCreation: true,
        orderManagement: true,
        realtimeProducts: false,
        publicSettings: false,
        publicPromoCodes: false,
        subscribers: true,
      });
    },

    async init(options = {}) {
      if (requestedProvider !== 'firebase') {
        await localBackend.init(options);
        activeProvider = 'local';
        return backend;
      }

      try {
        await initializeFirebase();
        activeProvider = 'firebase';
        initializationError = null;
      } catch (error) {
        initializationError = error;
        if (!fallbackEnabled) throw error;
        console.warn('Firebase is unavailable; Pavia is using the local fallback.', error);
        await localBackend.init(options);
        activeProvider = 'local';
      }
      return backend;
    },

    products: {
      async list() {
        if (activeProvider === 'local') return localBackend.products.list();
        try {
          const record = await readPath('publicProducts');
          return orderedProducts(record).map(normalizePublicProduct);
        } catch (error) {
          if (!fallbackEnabled) throw error;
          console.warn('Firebase products are unavailable; using local catalog data.', error);
          return localBackend.products.list();
        }
      },
      async replace(products) {
        if (activeProvider === 'local') return localBackend.products.replace(products);
        await assertAdminReady();
        const current = await readPath('products');
        const incoming = new Set((products || []).map((product) => String(product.id)));
        const updates = {};
        (products || []).forEach((product) => {
          const record = normalizeProductRecord(product);
          updates[`products/${record.id}`] = record;
          updates[`publicProducts/${record.id}`] = record.active ? publicProduct(record) : null;
        });
        Object.keys(current || {}).forEach((id) => {
          if (!incoming.has(id)) {
            updates[`products/${id}`] = null;
            updates[`publicProducts/${id}`] = null;
          }
        });
        await firebaseState.databaseApi.update(databaseReference('/'), updates);
      },
      async upsert(product) {
        if (activeProvider === 'local') return localBackend.products.upsert(product);
        return writeProduct(product);
      },
      async remove(id) {
        if (activeProvider === 'local') return localBackend.products.remove(id);
        await assertAdminReady();
        const productId = String(id || '').trim();
        if (!productId) return;
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`products/${productId}`]: null,
          [`publicProducts/${productId}`]: null,
          [`auditLogs/${Date.now()}-${productId}`]: {
            actorUid: firebaseState.auth?.currentUser?.uid || '',
            action: 'product.remove',
            targetType: 'product',
            targetId: productId,
            createdAt: new Date().toISOString(),
          },
        });
      },
      subscribe(listener) {
        if (activeProvider === 'local') return localBackend.products.subscribe(listener);
        return subscribePath('publicProducts', listener);
      },
    },

    orders: {
      async list() {
        if (activeProvider === 'local') return localBackend.orders.list();
        await assertAdminReady();
        return values(await readPath('orders'));
      },
      async create(order) {
        if (activeProvider === 'local') return localBackend.orders.create(order);
        const uid = firebaseState.auth?.currentUser?.uid;
        if (!uid) throw new Error('Anonymous sign-in is required before placing an order.');
        const requestId = safeKey(order.requestId, `req-${Date.now()}`);
        const orderId = safeKey(order.id, `order-${Date.now()}`);
        const now = new Date().toISOString();
        const existingRequest = await readPath(`orderRequests/${requestId}`);
        if (existingRequest?.orderId) {
          const existingOrder = await readPath(`orders/${existingRequest.orderId}`);
          if (existingOrder) return clone(existingOrder);
          throw new Error('This order request is already being processed.');
        }

        await firebaseState.databaseApi.set(databaseReference(`orderRequests/${requestId}`), {
          uid,
          orderId,
          status: 'creating',
          createdAt: now,
        });

        const items = normalizeOrderItems(order.items);
        if (!items.length) throw new Error('Your bag is empty.');

        const publicProducts = {};
        for (const item of items) {
          const product = await readPath(`publicProducts/${item.id}`);
          if (!product || product.active !== true) throw new Error(`${item.name || item.id} is no longer available.`);
          if (Number(product.stock || 0) < item.qty) throw new Error(`${product.name} has only ${product.stock || 0} left.`);
          publicProducts[item.id] = product;
        }

        const pricingItems = items.map((item) => ({
          ...item,
          name: publicProducts[item.id].name || item.name,
          price: Number(publicProducts[item.id].price) || 0,
        }));
        const subtotal = pricingItems.reduce((sum, item) => sum + item.price * item.qty, 0);
        const promoCode = safeKey(order.promoCode || order.promo || '').toUpperCase();
        const promo = promoCode ? await readPath(`publicPromoCodes/${promoCode}`) : null;
        const discount = calculatePromoDiscount(promo, subtotal);
        const settings = (await readPath('publicStoreSettings')) || {};
        const customer = order.customer || {};
        const deliveryArea = customer.deliveryArea === 'beirut' ? 'beirut' : 'lebanon';
        const delivery = calculateDelivery(settings, Math.max(0, subtotal - discount), promo, deliveryArea);
        const total = Math.max(0, subtotal - discount) + delivery;
        const reserved = [];

        try {
          for (const item of pricingItems) {
            await transactStock(`products/${item.id}/stock`, -item.qty);
            reserved.push({ path: `products/${item.id}/stock`, qty: item.qty });
            await transactStock(`publicProducts/${item.id}/stock`, -item.qty);
            reserved.push({ path: `publicProducts/${item.id}/stock`, qty: item.qty });
          }

          const paymentMethod = order.paymentMethod === 'whish_money' || customer.payment === 'Whish Money'
            ? 'whish_money'
            : 'cash_on_delivery';
          const record = {
            id: orderId,
            requestId,
            orderNumber: order.orderNumber || `PAV-${Date.now().toString().slice(-6)}`,
            status: 'new',
            paymentStatus: 'awaiting_confirmation',
            paymentMethod,
            items: pricingItems,
            customer: {
              name: String(customer.name || '').trim().slice(0, 120),
              phone: String(customer.phone || '').trim().slice(0, 40),
              city: String(customer.city || '').trim().slice(0, 120),
              deliveryArea,
              address: String(customer.address || '').trim().slice(0, 300),
              notes: String(customer.notes || '').trim().slice(0, 500),
              payment: customer.payment || (paymentMethod === 'whish_money' ? 'Whish Money' : 'Cash on delivery'),
            },
            subtotal,
            discount,
            delivery,
            total,
            promoCode: promoCode || '',
            notes: String(order.notes || customer.notes || '').trim().slice(0, 500),
            source: 'web',
            whatsappText: String(order.whatsappText || '').slice(0, 4000),
            pricingReview: {
              status: 'client_recalculated_from_public_rtdb',
              expectedSubtotal: subtotal,
              expectedDiscount: discount,
              expectedDelivery: delivery,
              expectedTotal: total,
              checkedAt: now,
            },
            stockReserved: true,
            stockRestored: false,
            createdAt: now,
            updatedAt: now,
            createdBy: uid,
            updatedBy: uid,
          };

          await firebaseState.databaseApi.update(databaseReference('/'), {
            [`orders/${orderId}`]: record,
            [`orderRequests/${requestId}/status`]: 'created',
          });
          return clone(record);
        } catch (error) {
          await Promise.allSettled(reserved.map((entry) => transactStock(entry.path, entry.qty)));
          await firebaseState.databaseApi.update(databaseReference('/'), {
            [`orderRequests/${requestId}/status`]: 'failed',
            [`orderRequests/${requestId}/error`]: String(error.message || 'Order creation failed.').slice(0, 180),
          }).catch(() => null);
          throw error;
        }
      },
      async complete(id) {
        if (activeProvider === 'local') return localBackend.orders.complete(id);
        await assertAdminReady();
        const orderId = String(id || '').trim();
        if (!orderId) return null;
        const now = new Date().toISOString();
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`orders/${orderId}/status`]: 'completed',
          [`orders/${orderId}/completedAt`]: now,
          [`orders/${orderId}/updatedAt`]: now,
          [`orders/${orderId}/updatedBy`]: firebaseState.auth?.currentUser?.uid || '',
        });
        return readPath(`orders/${orderId}`);
      },
      async update(id, changes = {}) {
        if (activeProvider === 'local') return localBackend.orders.update(id, changes);
        await assertAdminReady();
        const orderId = String(id || '').trim();
        if (!orderId) return null;
        const currentOrder = await readPath(`orders/${orderId}`);
        if (!currentOrder) return null;
        const now = new Date().toISOString();
        const status = String(changes.status || '').trim();
        const paymentStatus = String(changes.paymentStatus || '').trim();
        const updates = {
          [`orders/${orderId}/updatedAt`]: now,
          [`orders/${orderId}/updatedBy`]: firebaseState.auth?.currentUser?.uid || '',
        };
        if (status) {
          updates[`orders/${orderId}/status`] = status;
          if (status === 'completed') updates[`orders/${orderId}/completedAt`] = now;
          if (status === 'cancelled') updates[`orders/${orderId}/cancelledAt`] = now;
        }
        if (paymentStatus) updates[`orders/${orderId}/paymentStatus`] = paymentStatus;
        if ('adminNotes' in changes) updates[`orders/${orderId}/adminNotes`] = String(changes.adminNotes || '');
        if ('cancellationReason' in changes) {
          updates[`orders/${orderId}/cancellationReason`] = String(changes.cancellationReason || '');
        }
        updates[`auditLogs/${Date.now()}-${orderId}`] = {
          actorUid: firebaseState.auth?.currentUser?.uid || '',
          action: 'order.update',
          targetType: 'order',
          targetId: orderId,
          createdAt: now,
        };
        if (status === 'cancelled'
          && currentOrder.status !== 'cancelled'
          && currentOrder.stockReserved === true
          && currentOrder.stockRestored !== true) {
          const items = normalizeOrderItems(currentOrder.items);
          for (const item of items) {
            await transactStock(`products/${item.id}/stock`, item.qty);
            await transactStock(`publicProducts/${item.id}/stock`, item.qty);
          }
          updates[`orders/${orderId}/stockRestored`] = true;
          updates[`orders/${orderId}/stockRestoredAt`] = now;
        }
        await firebaseState.databaseApi.update(databaseReference('/'), updates);
        return readPath(`orders/${orderId}`);
      },
      subscribe(listener) {
        if (activeProvider === 'local') return localBackend.orders.subscribe(listener);
        return subscribePath('orders', listener);
      },
    },

    settings: {
      async get() {
        if (activeProvider === 'local') return localBackend.settings.get();
        if (adminUnlocked) {
          await assertAdminReady();
          return clone((await readPath('storeSettings')) || {});
        }
        return clone((await readPath('publicStoreSettings')) || {});
      },
      async update(settings) {
        if (activeProvider === 'local') return localBackend.settings.update(settings);
        await assertAdminReady();
        const current = (await readPath('storeSettings')) || {};
        const record = normalizeSettingsRecord({ ...current, ...settings });
        const now = new Date().toISOString();
        await firebaseState.databaseApi.update(databaseReference('/'), {
          storeSettings: record,
          publicStoreSettings: publicSettings(record),
          [`auditLogs/${Date.now()}-settings`]: {
            actorUid: firebaseState.auth?.currentUser?.uid || '',
            action: 'settings.update',
            targetType: 'settings',
            targetId: 'storeSettings',
            createdAt: now,
          },
        });
        return record;
      },
      subscribe(listener) {
        if (activeProvider === 'local') return localBackend.settings.subscribe(listener);
        return subscribePath('publicStoreSettings', listener);
      },
    },

    promoCodes: {
      async list() {
        if (activeProvider === 'local') return localBackend.promoCodes.list();
        if (adminUnlocked) {
          await assertAdminReady();
          return clone((await readPath('promoCodes')) || {});
        }
        return clone((await readPath('publicPromoCodes')) || {});
      },
      async upsert(code, promo) {
        if (activeProvider === 'local') return localBackend.promoCodes.upsert(code, promo);
        await assertAdminReady();
        const record = normalizePromoRecord(code, promo);
        const now = new Date().toISOString();
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`promoCodes/${record.code}`]: record,
          [`publicPromoCodes/${record.code}`]: record.active ? publicPromo(record) : null,
          [`auditLogs/${Date.now()}-${record.code}`]: {
            actorUid: firebaseState.auth?.currentUser?.uid || '',
            action: 'promo.upsert',
            targetType: 'promoCode',
            targetId: record.code,
            createdAt: now,
          },
        });
        return record;
      },
      async remove(code) {
        if (activeProvider === 'local') return localBackend.promoCodes.remove(code);
        await assertAdminReady();
        const promoCode = String(code || '').trim().toUpperCase();
        if (!promoCode) return;
        const now = new Date().toISOString();
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`promoCodes/${promoCode}`]: null,
          [`publicPromoCodes/${promoCode}`]: null,
          [`auditLogs/${Date.now()}-${promoCode}`]: {
            actorUid: firebaseState.auth?.currentUser?.uid || '',
            action: 'promo.remove',
            targetType: 'promoCode',
            targetId: promoCode,
            createdAt: now,
          },
        });
      },
      subscribe(listener) {
        if (activeProvider === 'local') return localBackend.promoCodes.subscribe(listener);
        return subscribePath('publicPromoCodes', listener);
      },
    },

    subscribers: {
      async create(record) {
        if (activeProvider === 'local') return localBackend.subscribers.create(record);
        const email = String(record.email || '').trim().toLowerCase();
        const consent = record.consent === true;
        if (!email || !consent) throw new Error('Subscriber email and consent are required.');
        const ref = firebaseState.databaseApi.push(databaseReference('subscribers'));
        const entry = {
          id: ref.key,
          email,
          consent: true,
          source: record.source || 'storefront',
          createdAt: record.createdAt || new Date().toISOString(),
          createdBy: firebaseState.auth?.currentUser?.uid || '',
        };
        await firebaseState.databaseApi.set(ref, entry);
        return clone(entry);
      },
    },

    analytics: {
      async recordSessionVisit() {
        if (activeProvider === 'local') return localBackend.analytics.recordSessionVisit();
      },
      async recordEvent(name) {
        if (activeProvider === 'local') return localBackend.analytics.recordEvent(name);
      },
    },

    media: localBackend.media,

    admin: {
      isCurrentUidAllowlisted,
    },

    setAdminUnlocked(value) {
      adminUnlocked = Boolean(value);
    },

    onAuthChanged(listener) {
      firebaseState.authListeners.add(listener);
      return () => firebaseState.authListeners.delete(listener);
    },

    async signOut() {
      adminUnlocked = false;
      if (activeProvider === 'firebase' && firebaseState.authApi && firebaseState.auth) {
        await firebaseState.authApi.signOut(firebaseState.auth);
      }
    },
  };

  window.PaviaBackend = Object.freeze(backend);
})();
