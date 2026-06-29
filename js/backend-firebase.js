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
  // Cap how many orders the studio pulls at once so the read stays bounded as the
  // order history grows (newest first, by createdAt). Older orders stay in the DB;
  // this is a page size, not a delete. Pairs with the `.indexOn: ["createdAt"]`
  // rule so the server returns only this many rows instead of the entire node.
  const ORDERS_LOAD_LIMIT = 300;

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
  // Best-effort client throttle: collapse machine-speed repeats of the same event
  // type (a stuck page, a tight loop, a casual script) into at most one write per
  // interval. Analytics is non-critical, so a dropped duplicate is invisible to the
  // shopper, and real browsing never fires the same event this fast. This is a UX
  // guardrail, not a security control — the rules are the enforced limit.
  const EVENT_MIN_INTERVAL_MS = 1000;
  const lastEventAt = new Map();
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
    // Use initializeAuth WITHOUT a popupRedirectResolver. The Studio signs in with
    // email/password and customers sign in anonymously — neither needs the
    // popup/redirect flow. getAuth() installs the default browser resolver, which
    // eagerly loads https://apis.google.com/js/api.js and trips the page CSP
    // (script-src) with a console error. Skipping the resolver removes that load
    // entirely. Fall back to getAuth() if auth was somehow already initialized.
    let auth;
    try {
      auth = authApi.initializeAuth(app, {
        persistence: [authApi.indexedDBLocalPersistence, authApi.browserLocalPersistence],
      });
    } catch {
      auth = authApi.getAuth(app);
    }
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

  function subscribePath(path, listener, makeQuery) {
    if (!firebaseState.initialized) return () => {};
    const base = databaseReference(path);
    const target = makeQuery ? makeQuery(base, firebaseState.databaseApi) : base;
    const unsubscribe = firebaseState.databaseApi.onValue(
      target,
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
    // Force a fresh ID token before every admin write. While the Studio tab sits
    // idle or backgrounded, browsers throttle the SDK's background token refresh
    // (mobile especially), so the cached token can be expired by the time the owner
    // comes back and saves — the write then fails the rules with PERMISSION_DENIED
    // ("you don't have permission"). Forcing a refresh makes the Realtime DB re-auth
    // (via onIdTokenChanged) before the write. A transient network failure is
    // tolerated (fall through to the cached token); a real auth failure asks for a
    // fresh sign-in instead of a confusing generic error.
    try {
      await user.getIdToken(true);
    } catch (error) {
      if (error?.code && error.code !== 'auth/network-request-failed') {
        throw new Error('Your admin session expired. Please enter the admin password again.');
      }
    }
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
      // Storefront content controls (all optional, public, length-capped). Empty
      // values mean "use the built-in default", so the storefront is unchanged
      // until the owner sets them.
      heroHeadline: String(settings.heroHeadline || '').slice(0, 120),
      announcementText: String(settings.announcementText || '').slice(0, 160),
      announcementEnabled: Boolean(settings.announcementEnabled),
      addressLine: String(settings.addressLine || '').slice(0, 200),
      // Canonicalize the scheme to lowercase https:// — the publicStoreSettings
      // DB rule's beginsWith('https://') is case-sensitive, so an uppercase or
      // http scheme would reject the whole atomic settings write.
      mapsUrl: /^https?:\/\//i.test(String(settings.mapsUrl || '')) ? String(settings.mapsUrl).replace(/^https?:\/\//i, 'https://').slice(0, 600) : '',
      businessHours: String(settings.businessHours || '').slice(0, 200),
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
    const productId = String(product?.id || product?.slug || '').trim();
    if (!productId) throw new Error('Product ID is required.');
    // The manifest revision is the storefront's cache-invalidation signal. A
    // product form can legitimately omit rev, so derive from the authoritative
    // private record instead of silently resetting every edit to rev 1.
    const existing = await readPath(`products/${productId}`);
    const record = normalizeProductRecord({
      ...product,
      rev: Math.max(Number(product?.rev) || 0, Number(existing?.rev) || 0),
    });
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

  // Shape a Drive file record for the saved media-library index. Coerces every
  // field (Firebase rejects undefined) and never carries a token/secret.
  function normalizeMediaRecord(item) {
    const id = String(item?.id || '').trim();
    return {
      id,
      name: String(item?.name || ''),
      mimeType: String(item?.mimeType || ''),
      size: Number(item?.size) || 0,
      createdTime: String(item?.createdTime || ''),
      width: Number(item?.width) || 0,
      height: Number(item?.height) || 0,
      imageUrl: String(item?.imageUrl || ''),
      imageVersion: String(item?.imageVersion || ''),
      contentHash: String(item?.contentHash || ''),
    };
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
      // Fetch only the changed/new product nodes named by a manifest diff. Reads
      // run in bounded-concurrency batches (not a serial await loop), so a cold
      // start over a large manifest doesn't become hundreds of sequential RTDB
      // round-trips. A per-id read failure simply drops that id from this batch;
      // syncCatalog leaves it out of knownRevs so the next sync retries it.
      async fetchProducts(ids) {
        if (activeProvider === 'local') return localBackend.catalog.fetchProducts(ids);
        const list = Array.isArray(ids) ? ids : [];
        const out = [];
        const CONCURRENCY = 10;
        for (let i = 0; i < list.length; i += CONCURRENCY) {
          const chunk = list.slice(i, i + CONCURRENCY);
          const records = await Promise.all(
            chunk.map((id) => readPath(`publicProducts/${id}`).catch(() => null)),
          );
          records.forEach((record) => { if (record) out.push(normalizePublicProduct(record)); });
        }
        return out;
      },
    },

    orders: {
      async list() {
        if (activeProvider === 'local') return localBackend.orders.list();
        await assertAdminReady();
        // Newest ORDERS_LOAD_LIMIT only, server-side (needs the createdAt index).
        const api = firebaseState.databaseApi;
        const recent = api.query(
          databaseReference('orders'),
          api.orderByChild('createdAt'),
          api.limitToLast(ORDERS_LOAD_LIMIT),
        );
        const snapshot = await api.get(recent);
        return values(snapshot.exists() ? snapshot.val() : null);
      },
      async create(order) {
        if (activeProvider === 'local') return localBackend.orders.create(order);
        const uid = firebaseState.auth?.currentUser?.uid;
        if (!uid) throw new Error('Anonymous sign-in is required before placing an order.');
        // Scope the dedupe identity to THIS anonymous uid. The client persists a
        // requestId/orderId in localStorage and replays them across retries so a
        // dropped response dedupes instead of duplicating. But an anonymous uid
        // can change (the SDK re-signs-in as a new anonymous user if the old
        // token/account is gone), and the persisted requestId then points at an
        // orderRequests node owned by the OLD uid. The rules correctly deny
        // reading or overwriting another uid's request, so this optimistic read
        // returned PERMISSION_DENIED and aborted checkout — permanently, because
        // every retry replayed the same poisoned id. Binding the id to the
        // current uid means we only ever touch our own node, so the read can
        // never be denied and a uid change simply starts a clean order.
        const uidTag = safeKey(uid).slice(0, 16);
        const requestId = safeKey(`${safeKey(order.requestId, `req-${Date.now()}`)}-${uidTag}`);
        let orderId = safeKey(`${safeKey(order.id, `order-${Date.now()}`)}-${uidTag}`);
        const now = new Date().toISOString();

        // Best-effort idempotency. These reads must NEVER be fatal: if one fails
        // (transient network or any rules edge case) we fall through and place a
        // fresh order rather than wedging checkout. A rare duplicate is the worst
        // case, and the disabled submit button plus the 15s 'creating' window
        // already make that unlikely; a hard failure here is exactly what the
        // "could not place your order" error was.
        let existingRequest = null;
        try {
          existingRequest = await readPath(`orderRequests/${requestId}`);
        } catch {
          existingRequest = null;
        }
        if (existingRequest?.orderId) {
          let existingOrder = null;
          try {
            existingOrder = await readPath(`orders/${existingRequest.orderId}`);
          } catch {
            existingOrder = null;
          }
          // Already created → return it so a retry (e.g. a response lost to a
          // dropped connection) is an idempotent no-op, never a duplicate order.
          if (existingOrder) return clone(existingOrder);
          // A very recent 'creating' stub means another attempt is genuinely
          // in flight (e.g. a second tab) — let it finish rather than racing it.
          const ageMs = Date.now() - Date.parse(existingRequest.createdAt || '');
          if (existingRequest.status === 'creating' && ageMs >= 0 && ageMs < 15000) {
            throw new Error('This order is already being placed. Please wait a moment.');
          }
          // Otherwise the prior attempt failed or was interrupted with no order
          // written: re-attempt under the SAME orderId, which the database rules
          // and this dedupe both key on.
          orderId = existingRequest.orderId;
        }

        // Mark the request 'creating' for idempotency/recovery. error:null clears any
        // stale failure note from a previous attempt. (Stock is no longer tracked or
        // reserved — every active product is always orderable — so there is no
        // inventory decrement to guard against on a retry.)
        await firebaseState.databaseApi.update(databaseReference(`orderRequests/${requestId}`), {
          uid,
          orderId,
          status: 'creating',
          createdAt: now,
          error: null,
        });

        // Everything below runs inside the try so ANY failure (validation or write)
        // marks the request 'failed', leaving it safe to recover on a later retry
        // under the same orderId.
        try {
          const items = normalizeOrderItems(order.items);
          if (!items.length) throw new Error('Your bag is empty.');

          const publicProducts = {};
          for (const item of items) {
            const product = await readPath(`publicProducts/${item.id}`);
            if (!product || product.active !== true) throw new Error(`${item.name || item.id} is no longer available.`);
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

          // No stock reservation: stock has been removed from the store, so any active
          // product is always orderable. The order record still carries the
          // stockReserved/stockRestored flags below because the deployed database
          // rules validate their presence on customer-created orders.
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
          // Mark the request 'failed' so a later retry recovers under the same
          // orderId. There is no stock to roll back (stock was removed from the store).
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
        await firebaseState.databaseApi.update(databaseReference('/'), updates);
        return readPath(`orders/${orderId}`);
      },
      async remove(id) {
        if (activeProvider === 'local') return localBackend.orders.remove(id);
        await assertAdminReady();
        const orderId = String(id || '').trim();
        if (!orderId) return false;
        const now = new Date().toISOString();
        // Admin-only hard delete. The deployed rules permit the admin identity to
        // write (and therefore null out) any order node; the audit log records it.
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`orders/${orderId}`]: null,
          [`auditLogs/${Date.now()}-${orderId}`]: {
            actorUid: firebaseState.auth?.currentUser?.uid || '',
            action: 'order.remove',
            targetType: 'order',
            targetId: orderId,
            createdAt: now,
          },
        });
        return true;
      },
      subscribe(listener) {
        if (activeProvider === 'local') return localBackend.orders.subscribe(listener);
        // Bound the live subscription to the same newest-N window as list().
        return subscribePath('orders', listener, (ref, api) =>
          api.query(ref, api.orderByChild('createdAt'), api.limitToLast(ORDERS_LOAD_LIMIT)));
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
        // Drop repeats fired faster than a human ever could (see EVENT_MIN_INTERVAL_MS).
        const nowMs = Date.now();
        if (nowMs - (lastEventAt.get(name) || 0) < EVENT_MIN_INTERVAL_MS) return;
        lastEventAt.set(name, nowMs);
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

    // Saved image-library index. The studio reads this to browse/pick images with
    // no Google Drive connection (admin-only node). Upload/delete still need Drive;
    // a connected session reconciles this index against the live Drive listing.
    mediaLibrary: {
      async list() {
        if (activeProvider === 'local') return localBackend.mediaLibrary.list();
        try {
          const record = await readPath('mediaLibrary');
          return values(record)
            .map(normalizeMediaRecord)
            .filter((item) => item.id && item.imageUrl)
            .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
        } catch (error) {
          console.warn('Pavia media library read failed.', error);
          return [];
        }
      },
      async upsert(item) {
        if (activeProvider === 'local') return localBackend.mediaLibrary.upsert(item);
        await assertAdminReady();
        const record = normalizeMediaRecord(item);
        if (!record.id || !record.imageUrl) return;
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`mediaLibrary/${record.id}`]: record,
        });
      },
      async remove(id) {
        if (activeProvider === 'local') return localBackend.mediaLibrary.remove(id);
        await assertAdminReady();
        const fileId = String(id || '').trim();
        if (!fileId) return;
        await firebaseState.databaseApi.update(databaseReference('/'), {
          [`mediaLibrary/${fileId}`]: null,
        });
      },
      // Reconcile the saved library against an authoritative Drive listing: write
      // only new/changed entries and drop entries whose Drive file is gone, so a
      // routine refresh with no changes costs no write at all.
      async replaceAll(items) {
        if (activeProvider === 'local') return localBackend.mediaLibrary.replaceAll(items);
        await assertAdminReady();
        const incoming = new Map(
          (Array.isArray(items) ? items : [])
            .map(normalizeMediaRecord)
            .filter((item) => item.id && item.imageUrl)
            .map((item) => [item.id, item]),
        );
        const current = (await readPath('mediaLibrary')) || {};
        const updates = {};
        incoming.forEach((record, id) => {
          if (JSON.stringify(current[id]) !== JSON.stringify(record)) updates[`mediaLibrary/${id}`] = record;
        });
        Object.keys(current).forEach((id) => {
          if (!incoming.has(id)) updates[`mediaLibrary/${id}`] = null;
        });
        if (Object.keys(updates).length) {
          await firebaseState.databaseApi.update(databaseReference('/'), updates);
        }
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
      // One-time cleanup: the footer version is owned by js/config.js, so purge any
      // legacy `version` field an older Studio build may have persisted into the
      // settings nodes. The token is fresh here (just signed in); best-effort, never
      // block unlock on it.
      try {
        await firebaseState.databaseApi.update(databaseReference('/'), {
          'storeSettings/version': null,
          'publicStoreSettings/version': null,
        });
      } catch (error) {
        console.warn('Could not purge legacy settings/version.', error);
      }
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
