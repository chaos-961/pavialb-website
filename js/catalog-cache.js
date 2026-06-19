/* =========================================================
   PAVIA — catalog cache (P14)
   IndexedDB stale-while-revalidate cache for the storefront:
   - raw public product records (for differential rebuild across reloads)
   - the publicCatalogManifest (for rev diffing)
   - a resolved-image-URL cache keyed by imageId|driveFileId + imageVersion
   Namespaced by backend schemaVersion; invalidated cleanly on a schema bump.
   Degrades gracefully to no-ops when IndexedDB is unavailable.
   ========================================================= */
(() => {
  'use strict';

  const config = window.PAVIA_BACKEND_CONFIG || {};
  const namespace = config.namespace || 'pavia';
  const schemaVersion = Number(config.schemaVersion) || 1;
  const CORE = window.PaviaStoreCore || {};

  const DB_NAME = `${namespace}-catalog`;
  const DB_VERSION = 1;
  const STORE_CATALOG = 'catalog';
  const STORE_META = 'meta';
  const STORE_IMAGES = 'images';
  // Resolved image URLs are tiny strings (~200 bytes), so this cap can be large:
  // 1000 entries is well under 1 MB and comfortably covers any realistic catalog
  // plus gallery images, so URLs never churn out of the cache. The actual image
  // bytes are NOT stored here — cross-origin Drive thumbnails live in the
  // browser HTTP cache, which is sized in hundreds of MB and auto-managed.
  const IMAGE_CACHE_MAX = 1000;
  // Run the (full-scan) prune only once every this many resolved-URL writes.
  const PRUNE_INTERVAL = 50;
  const hasIDB = typeof indexedDB !== 'undefined';

  let dbPromise = null;
  let putsSincePrune = 0;

  function openDb() {
    if (!hasIDB) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_CATALOG)) db.createObjectStore(STORE_CATALOG, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    }).catch(() => null);
    return dbPromise;
  }

  function store(db, name, mode) {
    return db.transaction(name, mode).objectStore(name);
  }

  function reqToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function txDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function getMeta(db, key) {
    try {
      return await reqToPromise(store(db, STORE_META, 'readonly').get(key));
    } catch {
      return null;
    }
  }

  async function clearAll(db) {
    try {
      const transaction = db.transaction([STORE_CATALOG, STORE_META, STORE_IMAGES], 'readwrite');
      transaction.objectStore(STORE_CATALOG).clear();
      transaction.objectStore(STORE_META).clear();
      transaction.objectStore(STORE_IMAGES).clear();
      await txDone(transaction);
    } catch {
      /* best effort */
    }
  }

  // Returns true when the cached schema matches; otherwise wipes and re-stamps.
  async function ensureSchema(db) {
    const record = await getMeta(db, 'schema');
    if (record && record.value === schemaVersion) return true;
    await clearAll(db);
    try {
      const transaction = db.transaction(STORE_META, 'readwrite');
      transaction.objectStore(STORE_META).put({ key: 'schema', value: schemaVersion });
      await txDone(transaction);
    } catch {
      /* best effort */
    }
    return false;
  }

  async function pruneImages(max = IMAGE_CACHE_MAX) {
    const db = await openDb();
    if (!db) return;
    try {
      const all = await reqToPromise(store(db, STORE_IMAGES, 'readonly').getAll());
      const prune = CORE.pruneLruKeys || (() => []);
      const keysToDelete = prune((all || []).map((entry) => ({ key: entry.key, lastUsed: entry.lastUsed })), max);
      if (!keysToDelete.length) return;
      const transaction = db.transaction(STORE_IMAGES, 'readwrite');
      keysToDelete.forEach((key) => transaction.objectStore(STORE_IMAGES).delete(key));
      await txDone(transaction);
    } catch {
      /* best effort */
    }
  }

  const api = {
    // Read the persisted catalog (validated). null => caller should fetch fresh.
    async readCatalog() {
      const db = await openDb();
      if (!db) return null;
      const schemaOk = await ensureSchema(db);
      if (!schemaOk) return null;
      try {
        const rawProducts = await reqToPromise(store(db, STORE_CATALOG, 'readonly').getAll());
        const manifestRecord = await getMeta(db, 'manifest');
        const valid = (rawProducts || []).filter((product) => product && product.id && product.name);
        if (!valid.length) return null;
        return { rawProducts: valid, manifest: manifestRecord ? manifestRecord.value : null };
      } catch {
        return null;
      }
    },

    // Replace the cached raw catalog + manifest.
    async writeCatalog(rawProducts, manifest) {
      const db = await openDb();
      if (!db) return;
      await ensureSchema(db);
      try {
        const transaction = db.transaction([STORE_CATALOG, STORE_META], 'readwrite');
        const catalogStore = transaction.objectStore(STORE_CATALOG);
        catalogStore.clear();
        (Array.isArray(rawProducts) ? rawProducts : []).forEach((product) => {
          const id = String(product && product.id ? product.id : '').trim();
          if (id) catalogStore.put({ ...product, id });
        });
        transaction.objectStore(STORE_META).put({ key: 'manifest', value: manifest || null });
        await txDone(transaction);
      } catch {
        /* best effort */
      }
    },

    async getResolvedImage(key) {
      if (!key) return null;
      const db = await openDb();
      if (!db) return null;
      try {
        const record = await reqToPromise(store(db, STORE_IMAGES, 'readonly').get(key));
        if (!record || !record.url) return null;
        try {
          store(db, STORE_IMAGES, 'readwrite').put({ ...record, lastUsed: Date.now() });
        } catch {
          /* touch is best effort */
        }
        return record.url;
      } catch {
        return null;
      }
    },

    async putResolvedImage(key, url) {
      if (!key || !url) return;
      const db = await openDb();
      if (!db) return;
      try {
        const transaction = db.transaction(STORE_IMAGES, 'readwrite');
        transaction.objectStore(STORE_IMAGES).put({ key, url, lastUsed: Date.now() });
        await txDone(transaction);
      } catch {
        return;
      }
      // Pruning does a full getAll(), so don't run it on every write — that would
      // be O(n^2) when resolving a large catalog on first load. Amortize it: prune
      // once every PRUNE_INTERVAL writes (and only then if actually over the cap).
      putsSincePrune += 1;
      if (putsSincePrune >= PRUNE_INTERVAL) {
        putsSincePrune = 0;
        await pruneImages();
      }
    },

    pruneImages,

    // Ask the browser to keep this origin's storage (IndexedDB catalog + the
    // browser's image cache quota) from being evicted under disk pressure, and
    // report how much room we have. Best-effort: unsupported browsers no-op.
    async persist() {
      const storage = (typeof navigator !== 'undefined' && navigator.storage) || null;
      if (!storage) return { persisted: false, supported: false };
      let persisted = false;
      try {
        if (storage.persisted) persisted = await storage.persisted();
        if (!persisted && storage.persist) persisted = await storage.persist();
      } catch {
        /* best effort */
      }
      let usage = 0;
      let quota = 0;
      try {
        if (storage.estimate) {
          const estimate = await storage.estimate();
          usage = Number(estimate.usage) || 0;
          quota = Number(estimate.quota) || 0;
        }
      } catch {
        /* best effort */
      }
      return { persisted, supported: true, usage, quota };
    },

    async clear() {
      const db = await openDb();
      if (db) await clearAll(db);
    },
  };

  window.PaviaCatalogCache = Object.freeze(api);
})();
