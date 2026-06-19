(() => {
  'use strict';

  const localBackend = window.PaviaBackend;
  const backendConfig = window.PAVIA_BACKEND_CONFIG || {};
  const firebaseConfig = window.PAVIA_FIREBASE_CONFIG || {};
  const CORE = window.PaviaStoreCore || {};
  const sdkVersion = '12.14.0';
  const sdkBase = `https://www.gstatic.com/firebasejs/${sdkVersion}`;
  const localhostNames = new Set(['localhost', '127.0.0.1', '::1']);
  const localHost = localhostNames.has(window.location.hostname);
  const requestedByQuery = localHost
    ? new URLSearchParams(window.location.search).get('backend')
    : '';
  const requestedProvider = requestedByQuery || backendConfig.provider || 'local';
  const fallbackEnabled = backendConfig.fallbackToLocal !== false;
  const adminEmail = String(backendConfig.admin?.email || '').trim().toLowerCase();
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

  // --- Visitor analytics helpers (anonymous users/{uid} model, matching the
  // sibling marketing sites). A short session cookie dedupes repeat pageviews
  // so visits/count increments once per session, not once per page. ---
  const VISIT_EVENTS = new Set(['product_view', 'add_to_cart', 'checkout_started', 'order_created']);
  const VISIT_SESSION_COOKIE = 'pavia_visit_session';

  function createEventId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function getVisitSessionId() {
    const match = document.cookie.match(/(?:^|; )pavia_visit_session=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function setVisitSessionId(sessionId) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${VISIT_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=1800; SameSite=Lax${secure}`;
  }

  function startOfLocalDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  // Pure aggregation of the raw users node into the figures the admin Overview
  // shows. Mirrors the sibling sites' stats-core summarizer.
  function summarizeVisitors(rawUsers, now = Date.now()) {
    const dayMs = 86400000;
    const startOfDay = startOfLocalDay(now);
    const activeNowStart = now - 15 * 60000;
    const weekStart = startOfDay - 6 * dayMs;
    const monthStart = startOfDay - 29 * dayMs;
    const eventTypes = ['product_view', 'add_to_cart', 'checkout_started', 'order_created'];
    const eventTotals = Object.fromEntries(eventTypes.map((type) => [type, 0]));
    const recent = [];
    let totalVisitors = 0;
    let newToday = 0;
    let activeNow = 0;
    let active7d = 0;
    let active30d = 0;
    let sessions = 0;
    let todaySessions = 0;

    Object.entries(rawUsers || {}).forEach(([uid, user = {}]) => {
      totalVisitors += 1;
      const createdAt = Number(user.profile?.createdAt) || 0;
      const lastAt = Number(user.activity?.lastSeenAt || user.visits?.lastAt) || 0;
      sessions += Number(user.visits?.count) || 0;
      if (createdAt >= startOfDay) newToday += 1;
      if (lastAt >= activeNowStart) activeNow += 1;
      if (lastAt >= weekStart) active7d += 1;
      if (lastAt >= monthStart) active30d += 1;
      Object.values(user.sessionHistory || {}).forEach((entry) => {
        if ((Number(entry?.startedAt) || 0) >= startOfDay) todaySessions += 1;
      });
      eventTypes.forEach((type) => { eventTotals[type] += Number(user.events?.[type]?.count) || 0; });
      recent.push({ uid, lastAt, visitCount: Number(user.visits?.count) || 0 });
    });

    recent.sort((left, right) => right.lastAt - left.lastAt);
    return {
      totalVisitors,
      newToday,
      activeNow,
      active7d,
      active30d,
      sessions,
      todaySessions,
      events: eventTypes.map((type) => ({ type, count: eventTotals[type] })),
      recent: recent.slice(0, 8),
    };
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
      (error) => {
        const optionalPublicPath = /^public(?:Products|StoreSettings|CatalogManifest)/.test(path);
        if (optionalPublicPath && error?.code === 'PERMISSION_DENIED') return;
        console.warn(`Pavia Firebase subscription failed for ${path}.`, error);
      },
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
    if (CORE.normalizeOrderItems) {
      return CORE.normalizeOrderItems(items, { maxQty: 20, safeKey });
    }
    return (Array.isArray(items) ? items : values(items)).map((item) => ({
      id: safeKey(item.id),
      name: String(item.name || '').trim().slice(0, 120),
      qty: Math.max(1, Math.min(20, Number(item.qty) || 1)),
      price: Math.max(0, Number(item.price) || 0),
      size: String(item.size || '').trim().slice(0, 40),
      color: String(item.color || '').trim().slice(0, 60),
    })).filter((item) => item.id && item.qty > 0);
  }

  // Single universal flat delivery fee (default $3). No per-area pricing, no
  // free-delivery threshold, no promos.
  function calculateDelivery(settings) {
    if (CORE.calculateDelivery) return CORE.calculateDelivery(settings);
    const fee = settings && settings.deliveryFee !== undefined && settings.deliveryFee !== null
      ? Number(settings.deliveryFee)
      : 3;
    return Math.max(0, Number.isFinite(fee) ? fee : 3);
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

  async function assertAdminReady() {
    if (activeProvider === 'local') return;
    const user = firebaseState.auth?.currentUser;
    if (!user?.uid) {
      throw new Error('Admin sign-in is required before admin operations.');
    }
    if (adminEmail && String(user.email || '').trim().toLowerCase() !== adminEmail) {
      throw new Error('The signed-in account is not the configured admin.');
    }
    if (!adminUnlocked) throw new Error('Admin unlock is required before this operation.');
  }

  function normalizeProductRecord(product) {
    const now = new Date().toISOString();
    const id = String(product.id || product.slug || '').trim();
    if (!id) throw new Error('Product ID is required.');
    const imageId = String(product.imageId || window.PaviaImages?.idFor?.(product.image) || '').trim();
    const imageValue = String(product.imageUrl || product.image || '');
    const imageUrl = /^https?:\/\//i.test(imageValue)
      ? String(product.imageUrl || product.image)
      : '';
    const driveFileId = String(product.driveFileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
    const requestedProvider = product.imageProvider || '';
    const provider = ['google_drive', 'external', 'local_legacy'].includes(requestedProvider)
      ? requestedProvider
      : driveFileId ? 'google_drive' : imageUrl ? 'external' : 'local_legacy';
    const imageMeta = safeImageMeta(product.imageMeta);
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
      imageProvider: provider,
      driveFileId,
      imageVersion: product.imageVersion || '',
      imageMeta,
      gallery: CORE.normalizeGallery
        ? CORE.normalizeGallery(product.gallery)
        : (Array.isArray(product.gallery) ? product.gallery : []),
      material: product.material || '',
      fit: product.fit || '',
      care: product.care || '',
      active: product.active !== false,
      featured: Boolean(product.featured),
      rev: Math.max(1, Math.floor(Number(product.rev) || 0) + 1),
      sortOrder: Number(product.sortOrder || product.createdAt) || Date.now(),
      seoTitle: product.seoTitle || product.name || 'Pavia product',
      seoDescription: product.seoDescription || product.description || '',
      createdAt: product.createdAt || now,
      updatedAt: now,
      createdBy: product.createdBy || firebaseState.auth?.currentUser?.uid || 'admin',
      updatedBy: firebaseState.auth?.currentUser?.uid || 'admin',
    };
  }

  function safeImageMeta(meta = {}) {
    const source = meta && typeof meta === 'object' ? meta : {};
    const clean = {
      provider: String(source.provider || '').slice(0, 40),
      originalName: String(source.originalName || '').slice(0, 120),
      optimizedName: String(source.optimizedName || '').slice(0, 140),
      mimeType: String(source.mimeType || source.type || '').slice(0, 40),
      width: Math.max(0, Number(source.width) || 0),
      height: Math.max(0, Number(source.height) || 0),
      byteSize: Math.max(0, Number(source.byteSize || source.bytes) || 0),
      originalBytes: Math.max(0, Number(source.originalBytes) || 0),
      targetBytes: Math.max(0, Number(source.targetBytes) || 0),
      contentHash: String(source.contentHash || '').replace(/[^a-f0-9]/gi, '').slice(0, 80),
      imageVersion: String(source.imageVersion || '').slice(0, 40),
      driveFileId: String(source.driveFileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120),
      publicUrl: /^https:\/\//i.test(String(source.publicUrl || '')) ? String(source.publicUrl).slice(0, 600) : '',
      updatedAt: String(source.updatedAt || '').slice(0, 40),
    };
    Object.keys(clean).forEach((key) => {
      if (clean[key] === '' || clean[key] === 0) delete clean[key];
    });
    return clean;
  }

  function publicProduct(record) {
    const { createdBy, updatedBy, ...publicFields } = record;
    return publicFields;
  }

  function normalizeSettingsRecord(settings) {
    const paymentMethods = settings.paymentMethods || {};
    // One phone field (phone == WhatsApp). Map any legacy fields onto it.
    const phone = String(settings.phone || settings.phoneNumber || settings.phoneDisplay || '').trim();
    const deliveryFee = settings.deliveryFee !== undefined && settings.deliveryFee !== null
      ? Math.max(0, Number(settings.deliveryFee) || 0)
      : 3;
    return {
      siteName: settings.siteName || 'Pavia',
      siteTitle: settings.siteTitle || 'Pavia Lebanon',
      location: settings.location || 'Beirut',
      deliveryArea: settings.deliveryArea || 'Lebanon',
      tagline: settings.tagline || '',
      description: settings.description || '',
      phone,
      instagramHandle: settings.instagramHandle || '',
      currency: settings.currency || 'USD',
      deliveryFee,
      checkoutEnabled: settings.checkoutEnabled !== false,
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

  async function writeProduct(product) {
    await assertAdminReady();
    const record = normalizeProductRecord(product);
    const updates = {
      [`products/${record.id}`]: record,
      [`publicProducts/${record.id}`]: record.active ? publicProduct(record) : null,
      [`publicCatalogManifest/products/${record.id}`]: record.active ? record.rev : null,
      'publicCatalogManifest/catalogRev': Date.now(),
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
          subscribers: true,
        });
      }
      return Object.freeze({
        adminMutations: true,
        orderCreation: true,
        orderManagement: true,
        realtimeProducts: false,
        publicSettings: false,
        subscribers: true,
      });
    },

    async init(options = {}) {
      if (requestedProvider !== 'firebase') {
        await localBackend.init(options);
        activeProvider = 'local';
        return backend;
      }

      await localBackend.init(options);

      try {
        await initializeFirebase();
        activeProvider = 'firebase';
        initializationError = null;
      } catch (error) {
        initializationError = error;
        if (!fallbackEnabled) throw error;
        console.warn('Firebase is unavailable; Pavia is using the local fallback.', error);
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
          updates[`publicCatalogManifest/products/${record.id}`] = record.active ? record.rev : null;
        });
        Object.keys(current || {}).forEach((id) => {
          if (!incoming.has(id)) {
            updates[`products/${id}`] = null;
            updates[`publicProducts/${id}`] = null;
            updates[`publicCatalogManifest/products/${id}`] = null;
          }
        });
        updates['publicCatalogManifest/catalogRev'] = Date.now();
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
          [`publicCatalogManifest/products/${productId}`]: null,
          'publicCatalogManifest/catalogRev': Date.now(),
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

    catalog: {
      // Tiny manifest read used by the storefront to detect catalog changes (P14).
      async readManifest() {
        if (activeProvider === 'local') return localBackend.catalog.readManifest();
        return readPath('publicCatalogManifest');
      },
      subscribeManifest(listener) {
        if (activeProvider === 'local') return localBackend.catalog.subscribeManifest(listener);
        return subscribePath('publicCatalogManifest', listener);
      },
      // Fetch only the changed/new product nodes named by a manifest diff.
      async fetchProducts(ids) {
        if (activeProvider === 'local') return localBackend.catalog.fetchProducts(ids);
        const out = [];
        for (const id of ids || []) {
          try {
            const record = await readPath(`publicProducts/${id}`);
            if (record) out.push(normalizePublicProduct(record));
          } catch (error) {
            /* skip unreadable node; differential sync tolerates gaps */
          }
        }
        return out;
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
        const settings = (await readPath('publicStoreSettings')) || {};
        const customer = order.customer || {};
        const deliveryArea = customer.deliveryArea === 'beirut' ? 'beirut' : 'lebanon';
        const discount = 0;
        const delivery = calculateDelivery(settings);
        const total = subtotal + delivery;
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
            status: 'pending',
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
            notes: String(order.notes || customer.notes || '').trim().slice(0, 500),
            source: 'web',
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
        try {
          return clone((await readPath('publicStoreSettings')) || {});
        } catch {
          return localBackend.settings.get();
        }
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
      // A storefront visitor (anonymous Firebase session) records one session
      // visit per cookie window, plus a live lastSeenAt heartbeat.
      async recordSessionVisit() {
        if (activeProvider === 'local') return localBackend.analytics.recordSessionVisit();
        const user = firebaseState.auth?.currentUser;
        if (!user?.uid || !user.isAnonymous) return;
        const api = firebaseState.databaseApi;
        const base = `users/${user.uid}`;
        const createdAt = Date.parse(user.metadata?.creationTime) || Date.now();
        const updates = {
          [`${base}/profile/createdAt`]: createdAt,
          [`${base}/activity/lastSeenAt`]: api.serverTimestamp(),
        };
        if (getVisitSessionId()) {
          await api.update(databaseReference('/'), updates).catch(() => {});
          return;
        }
        const sessionId = createEventId();
        updates[`${base}/visits/count`] = api.increment(1);
        updates[`${base}/visits/lastAt`] = api.serverTimestamp();
        updates[`${base}/sessionHistory/${sessionId}/startedAt`] = api.serverTimestamp();
        try {
          await api.update(databaseReference('/'), updates);
        } catch {
          await api.update(databaseReference('/'), {
            [`${base}/visits/count`]: api.increment(1),
            [`${base}/visits/lastAt`]: api.serverTimestamp(),
          }).catch(() => {});
        }
        setVisitSessionId(sessionId);
      },
      // Storefront engagement events (product views, add-to-cart, checkout, order).
      async recordEvent(name) {
        if (activeProvider === 'local') return localBackend.analytics.recordEvent(name);
        if (!VISIT_EVENTS.has(name)) return;
        const user = firebaseState.auth?.currentUser;
        if (!user?.uid || !user.isAnonymous) return;
        const api = firebaseState.databaseApi;
        const base = `users/${user.uid}`;
        const createdAt = Date.parse(user.metadata?.creationTime) || Date.now();
        const eventId = createEventId();
        try {
          await api.update(databaseReference('/'), {
            [`${base}/profile/createdAt`]: createdAt,
            [`${base}/activity/lastSeenAt`]: api.serverTimestamp(),
            [`${base}/events/${name}/count`]: api.increment(1),
            [`${base}/events/${name}/lastAt`]: api.serverTimestamp(),
            [`${base}/eventHistory/${eventId}/type`]: name,
            [`${base}/eventHistory/${eventId}/at`]: api.serverTimestamp(),
          });
        } catch {
          await api.update(databaseReference('/'), {
            [`${base}/events/${name}/count`]: api.increment(1),
            [`${base}/events/${name}/lastAt`]: api.serverTimestamp(),
          }).catch(() => {});
        }
      },
      // Admin-only: read and summarize the visitor analytics for the dashboard.
      async readStatistics() {
        if (activeProvider !== 'firebase') return summarizeVisitors({});
        try {
          const users = await readPath('users');
          return summarizeVisitors(users || {});
        } catch (error) {
          console.warn('Pavia visitor analytics read failed.', error);
          return summarizeVisitors({});
        }
      },
      // Admin-only: live updates as visitors arrive. Notifies with no args; the
      // dashboard re-reads via readStatistics().
      subscribeStatistics(listener) {
        if (activeProvider !== 'firebase') return () => {};
        return subscribePath('users', listener);
      },
    },

    media: localBackend.media,

    setAdminUnlocked(value) {
      adminUnlocked = Boolean(value);
    },

    // Sign in as the configured admin with Firebase Email/Password using the
    // unlock password. This is the real trust boundary: the database rules only
    // grant admin writes to auth.token.email === the configured admin email.
    async signInAdmin(password) {
      if (activeProvider === 'local') {
        adminUnlocked = true;
        return { uid: 'local-admin' };
      }
      if (!adminEmail) {
        throw new Error('Admin email is not configured in backend-config.js.');
      }
      if (!firebaseState.authApi || !firebaseState.auth) {
        throw new Error('Firebase auth is not ready.');
      }
      const credential = await firebaseState.authApi.signInWithEmailAndPassword(
        firebaseState.auth,
        adminEmail,
        password,
      );
      adminUnlocked = true;
      return { uid: credential.user?.uid || '' };
    },

    // Drop the admin credential and restore a low-privilege anonymous session
    // (so the storefront-style identity is back in place after locking).
    async lockAdmin() {
      adminUnlocked = false;
      if (activeProvider === 'firebase' && firebaseState.authApi && firebaseState.auth) {
        try {
          await firebaseState.authApi.signOut(firebaseState.auth);
          await firebaseState.authApi.signInAnonymously(firebaseState.auth);
        } catch (error) {
          console.warn('Failed to restore anonymous session after lock.', error);
        }
      }
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
