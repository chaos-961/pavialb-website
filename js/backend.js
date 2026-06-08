(() => {
  'use strict';

  const config = window.PAVIA_BACKEND_CONFIG || {};
  const namespace = config.namespace || 'pavia';
  const backendScriptUrl = document.currentScript?.src || new URL('js/backend.js', document.baseURI).href;
  const siteBaseUrl = new URL('../', backendScriptUrl);
  const keys = {
    products: 'PAVIA_PRODUCTS',
    orders: 'PAVIA_ORDERS',
    statistics: 'PAVIA_STATISTICS',
  };
  const listeners = {
    products: new Set(),
    orders: new Set(),
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

  function versionedUrl(url, version) {
    const resolved = publicImageUrl(url);
    if (!version || /^(data:|blob:)/i.test(resolved) || /[?&]pv=/.test(resolved)) return resolved;
    const separator = resolved.includes('?') ? '&' : '?';
    return `${resolved}${separator}pv=${encodeURIComponent(version)}`;
  }

  async function resolveImage(image, version = '') {
    const value = String(image || '');
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

  function updateStatistics(mutator) {
    const statistics = read(keys.statistics, {
      visits: 0,
      events: {},
      lastVisitAt: null,
      updatedAt: null,
    });
    mutator(statistics);
    statistics.updatedAt = new Date().toISOString();
    write(keys.statistics, statistics);
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
        return clone(read(keys.orders, []));
      },
      async create(order) {
        const orders = read(keys.orders, []);
        orders.push(clone(order));
        write(keys.orders, orders);
        emit('orders');
        return clone(order);
      },
      async complete(id) {
        const orders = read(keys.orders, []);
        const order = orders.find((item) => String(item.id) === String(id));
        if (!order) return null;
        order.status = 'completed';
        order.completedAt = new Date().toISOString();
        write(keys.orders, orders);
        emit('orders');
        return clone(order);
      },
      subscribe(listener) {
        return subscribe('orders', listener);
      },
    },

    analytics: {
      async recordSessionVisit() {
        if (config.analytics?.enabled === false) return;
        const sessionKey = config.analytics?.sessionKey || 'PAVIA_VISIT_RECORDED';
        if (sessionStorage.getItem(sessionKey)) return;
        sessionStorage.setItem(sessionKey, '1');
        updateStatistics((statistics) => {
          statistics.visits = (Number(statistics.visits) || 0) + 1;
          statistics.lastVisitAt = new Date().toISOString();
        });
      },
      async recordEvent(name) {
        if (config.analytics?.enabled === false || !name) return;
        updateStatistics((statistics) => {
          statistics.events ||= {};
          statistics.events[name] = (Number(statistics.events[name]) || 0) + 1;
        });
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
