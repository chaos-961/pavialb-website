(() => {
  'use strict';

  const config = window.PAVIA_BACKEND_CONFIG || {};
  const namespace = config.namespace || 'pavia';
  const backendScriptUrl = document.currentScript?.src || new URL('js/backend.js', document.baseURI).href;
  const siteBaseUrl = new URL('../', backendScriptUrl);
  const keys = {
    products: 'PAVIA_PRODUCTS',
    orders: 'PAVIA_ORDERS',
    settings: 'PAVIA_SETTINGS',
    subscribers: 'PAVIA_SUBSCRIBERS',
    orderRequests: 'PAVIA_ORDER_REQUESTS',
    mediaLibrary: 'PAVIA_MEDIA_LIBRARY',
  };
  const listeners = {
    products: new Set(),
    orders: new Set(),
    settings: new Set(),
  };
  const objectUrls = new Map();
  const channel = 'BroadcastChannel' in window
    ? new BroadcastChannel(`${namespace}-backend`)
    : null;

  function read(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function emit(collection) {
    listeners[collection].forEach((listener) => listener());
    channel?.postMessage({ collection });
  }

  function subscribe(collection, listener) {
    listeners[collection].add(listener);
    return () => listeners[collection].delete(listener);
  }

  channel?.addEventListener('message', (event) => {
    const collection = event.data?.collection;
    if (listeners[collection]) {
      listeners[collection].forEach((listener) => listener());
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === keys.products) {
      listeners.products.forEach((listener) => listener());
    }
    if (event.key === keys.orders) {
      listeners.orders.forEach((listener) => listener());
    }
    if (event.key === keys.settings) {
      listeners.settings.forEach((listener) => listener());
    }
  });

  function openMediaDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`${namespace}-media`, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('images')) {
          request.result.createObjectStore('images', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function mediaPut(record) {
    const database = await openMediaDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('images', 'readwrite');
      transaction.objectStore('images').put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }

  async function mediaGet(id) {
    const database = await openMediaDatabase();
    const result = await new Promise((resolve, reject) => {
      const transaction = database.transaction('images', 'readonly');
      const request = transaction.objectStore('images').get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return result;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Image compression failed.')),
        type,
        quality,
      );
    });
  }

  function loadImageSource(file) {
    if ('createImageBitmap' in window) {
      return createImageBitmap(file);
    }

    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('The selected image could not be opened.'));
      };
      image.src = url;
    });
  }

  async function optimizeImage(file, overrides = {}) {
    if (!(file instanceof Blob) || !String(file.type).startsWith('image/')) {
      throw new Error('Choose a valid image file.');
    }

    const imageConfig = { ...(config.images || {}), ...overrides };
    if (file.size > (imageConfig.maxInputBytes || 15 * 1024 * 1024)) {
      throw new Error('Image is too large. Choose a file smaller than 15 MB.');
    }

    const bitmap = await loadImageSource(file);
    const scale = Math.min(
      1,
      (imageConfig.maxWidth || 1600) / bitmap.width,
      (imageConfig.maxHeight || 2000) / bitmap.height,
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    let type = imageConfig.format || 'image/webp';
    let blob = await canvasToBlob(canvas, type, imageConfig.quality ?? 0.82);
    if (type === 'image/webp' && blob.type !== 'image/webp') {
      type = 'image/jpeg';
      blob = await canvasToBlob(canvas, type, imageConfig.quality ?? 0.82);
    }

    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    return {
      blob,
      id: hash,
      metadata: {
        width,
        height,
        type: blob.type || type,
        bytes: blob.size,
        originalBytes: file.size,
        originalName: file.name || 'product-image',
        updatedAt: new Date().toISOString(),
      },
    };
  }

  async function saveImage(file, overrides = {}) {
    const optimized = await optimizeImage(file, overrides);
    await mediaPut({
      id: optimized.id,
      blob: optimized.blob,
      metadata: optimized.metadata,
    });
    return {
      image: `local-media:${optimized.id}`,
      imageVersion: optimized.id,
      imageMeta: optimized.metadata,
    };
  }

  function publicImageUrl(value) {
    if (/^(data:|blob:|https?:)/i.test(value)) return value;
    return new URL(value.replace(/^(\.\/)+/, ''), siteBaseUrl).href;
  }

  function catalogImageUrl(value) {
    const raw = String(value || '').trim();
    const resolved = window.PaviaImages?.resolve?.(raw);
    if (!resolved || resolved === raw) return null;
    return resolved;
  }

  function versionedUrl(url, version) {
    const resolved = publicImageUrl(url);
    if (!version || /^(data:|blob:)/i.test(resolved) || /[?&]pv=/.test(resolved)) return resolved;
    const separator = resolved.includes('?') ? '&' : '?';
    return `${resolved}${separator}pv=${encodeURIComponent(version)}`;
  }

  async function resolveImage(image, version = '') {
    const value = String(image || '');
    const catalogUrl = catalogImageUrl(value);
    if (catalogUrl) return versionedUrl(catalogUrl, version);

    if (!value.startsWith('local-media:')) return versionedUrl(value, version);

    const id = value.slice('local-media:'.length);
    if (objectUrls.has(id)) return objectUrls.get(id);
    const record = await mediaGet(id);
    if (!record?.blob) return publicImageUrl('assets/logo.svg');
    const url = URL.createObjectURL(record.blob);
    objectUrls.set(id, url);
    return url;
  }

  async function resolveProductImages(products) {
    return Promise.all((products || []).map(async (product) => ({
      ...product,
      imageSource: product.image,
      image: await resolveImage(product.image, product.imageVersion),
    })));
  }

  const backend = {
    provider: config.provider || 'local',
    schemaVersion: config.schemaVersion || 1,

    async init({ defaultProducts = [] } = {}) {
      if (localStorage.getItem(keys.products) === null) {
        write(keys.products, clone(defaultProducts));
      }
      if (localStorage.getItem(keys.orders) === null) {
        write(keys.orders, []);
      }
      if (localStorage.getItem(keys.settings) === null) {
        write(keys.settings, clone(window.PAVIA_CONFIG || {}));
      }
      if (localStorage.getItem(keys.subscribers) === null) {
        write(keys.subscribers, []);
      }
      if (localStorage.getItem(keys.orderRequests) === null) {
        write(keys.orderRequests, {});
      }
      return backend;
    },

    products: {
      async list() {
        return clone(read(keys.products, []));
      },
      async replace(products) {
        write(keys.products, clone(products || []));
        emit('products');
      },
      async upsert(product) {
        const products = read(keys.products, []);
        const index = products.findIndex((item) => String(item.id) === String(product.id));
        if (index >= 0) products[index] = clone(product);
        else products.push(clone(product));
        write(keys.products, products);
        emit('products');
      },
      async remove(id) {
        const products = read(keys.products, [])
          .filter((item) => String(item.id) !== String(id));
        write(keys.products, products);
        emit('products');
      },
      subscribe(listener) {
        return subscribe('products', listener);
      },
    },

    orders: {
      async list() {
        // Mirror the Firebase provider's bounded read: newest-first, capped so the
        // studio never loads the entire order history at once.
        const LIMIT = 300;
        const all = read(keys.orders, []);
        return clone([...all]
          .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0))
          .slice(0, LIMIT));
      },
      async create(order) {
        const requestId = String(order.requestId || '').trim();
        const requests = read(keys.orderRequests, {});
        if (requestId && requests[requestId]?.orderId) {
          const existing = read(keys.orders, []).find((item) => String(item.id) === String(requests[requestId].orderId));
          if (existing) return clone(existing);
        }
        const products = read(keys.products, []);
        const items = Array.isArray(order.items) ? order.items : Object.values(order.items || {});
        const normalizedItems = items.map((item) => {
          const product = products.find((entry) => String(entry.id) === String(item.id));
          const qty = Math.max(1, Number(item.qty) || 1);
          if (!product) throw new Error(`${item.name || item.id || 'Item'} is no longer available.`);
          // Stock removed from the store: any existing product is always orderable,
          // so there is no availability check and no decrement.
          return {
            ...clone(item),
            name: product.name,
            price: Number(product.price || item.price || 0),
            qty,
          };
        });
        const orders = read(keys.orders, []);
        // Recompute money from the normalized (re-priced, qty-clamped) items so the
        // stored total can't disagree with its own line items — the local mirror of
        // the Firebase provider's server-authoritative totals.
        const subtotal = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
        const delivery = Math.max(0, Number(order.delivery) || 0);
        const created = {
          ...clone(order),
          items: normalizedItems,
          subtotal,
          discount: 0,
          delivery,
          total: subtotal + delivery,
          stockReserved: true,
          stockRestored: false,
        };
        orders.push(created);
        write(keys.orders, orders);
        if (requestId) {
          requests[requestId] = {
            uid: 'local',
            orderId: created.id,
            status: 'created',
            createdAt: created.createdAt || new Date().toISOString(),
          };
          write(keys.orderRequests, requests);
        }
        emit('orders');
        return clone(created);
      },
      async complete(id) {
        const orders = read(keys.orders, []);
        const order = orders.find((item) => String(item.id) === String(id));
        if (!order) return null;
        order.status = 'completed';
        order.paymentStatus ||= 'paid';
        order.completedAt = new Date().toISOString();
        order.updatedAt = order.completedAt;
        write(keys.orders, orders);
        emit('orders');
        return clone(order);
      },
      async update(id, changes = {}) {
        const orders = read(keys.orders, []);
        const order = orders.find((item) => String(item.id) === String(id));
        if (!order) return null;
        Object.assign(order, clone(changes), { updatedAt: new Date().toISOString() });
        if (order.status === 'completed' && !order.completedAt) order.completedAt = order.updatedAt;
        if (order.status === 'cancelled' && !order.cancelledAt) order.cancelledAt = order.updatedAt;
        write(keys.orders, orders);
        emit('orders');
        return clone(order);
      },
      async remove(id) {
        const orders = read(keys.orders, []).filter((item) => String(item.id) !== String(id));
        write(keys.orders, orders);
        emit('orders');
        return true;
      },
      subscribe(listener) {
        return subscribe('orders', listener);
      },
    },

    settings: {
      async get() {
        return clone(read(keys.settings, window.PAVIA_CONFIG || {}));
      },
      async update(settings) {
        const record = {
          ...read(keys.settings, window.PAVIA_CONFIG || {}),
          ...clone(settings || {}),
          updatedAt: new Date().toISOString(),
        };
        write(keys.settings, record);
        emit('settings');
        return clone(record);
      },
      subscribe(listener) {
        return subscribe('settings', listener);
      },
    },

    subscribers: {
      async create(record) {
        const subscribers = read(keys.subscribers, []);
        const entry = {
          id: record.id || `sub-${Date.now()}`,
          email: String(record.email || '').trim().toLowerCase(),
          consent: record.consent === true,
          source: record.source || 'storefront',
          createdAt: record.createdAt || new Date().toISOString(),
        };
        if (!entry.email || !entry.consent) throw new Error('Subscriber email and consent are required.');
        subscribers.push(entry);
        write(keys.subscribers, subscribers);
        return clone(entry);
      },
    },

    catalog: {
      // Local mode has no manifest; returning null tells the storefront to take
      // the full-list path (localStorage reads are already instant). The catalog
      // cache still persists the result for instant first paint and offline.
      async readManifest() {
        return null;
      },
      subscribeManifest(listener) {
        return subscribe('products', listener);
      },
      async fetchProducts(ids) {
        const wanted = new Set((ids || []).map((id) => String(id)));
        return clone(read(keys.products, []).filter((product) => wanted.has(String(product.id))));
      },
    },

    // Saved image-library index (hosted-image records) so the studio can browse
    // and pick images. Local mirror of the Firebase `mediaLibrary` node; uploads
    // go to the image host (imgbb).
    mediaLibrary: {
      async list() {
        return clone(read(keys.mediaLibrary, []));
      },
      async upsert(item) {
        const id = String(item?.id || '').trim();
        if (!id) return;
        const items = read(keys.mediaLibrary, []).filter((entry) => String(entry.id) !== id);
        items.unshift(clone(item));
        write(keys.mediaLibrary, items);
      },
      async remove(id) {
        const target = String(id || '').trim();
        const items = read(keys.mediaLibrary, []).filter((entry) => String(entry.id) !== target);
        write(keys.mediaLibrary, items);
      },
      async replaceAll(items) {
        write(keys.mediaLibrary, clone(Array.isArray(items) ? items : []));
      },
    },

    media: {
      optimizeImage,
      saveImage,
      resolveImage,
      resolveProductImages,
    },
  };

  window.PaviaBackend = Object.freeze(backend);
})();
