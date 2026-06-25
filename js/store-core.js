/* Shared storefront calculations and normalization helpers. */
((global) => {
  'use strict';

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatMoney(value, currency = '$') {
    return `${currency}${safeNumber(value).toFixed(0)}`;
  }

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function normalizeLebanonPhone(value) {
    const raw = String(value || '').trim();
    const compact = raw.replace(/\s/g, '');
    const digits = raw.replace(/\D/g, '');
    if (/^\+961\d{7,8}$/.test(compact)) return compact;
    if (/^961\d{7,8}$/.test(digits)) return `+${digits}`;
    if (/^0\d{7,8}$/.test(digits)) return `+961${digits.slice(1)}`;
    if (/^\d{7,8}$/.test(digits)) return `+961${digits}`;
    return '';
  }

  function stringToHex(name) {
    const lookup = {
      'sky blue': '#9ec1de',
      white: '#fafafa',
      'medium blue': '#5a7da3',
      azure: '#7fa8d6',
      cocoa: '#5c4034',
      mocha: '#7a5443',
      ivory: '#f3ead8',
      cream: '#ede2cf',
      chocolate: '#4b322a',
      beige: '#c9a779',
      black: '#1a1612',
      olive: '#7a7d56',
      taupe: '#a78970',
    };
    return lookup[normalizeText(name)] || '#a78970';
  }

  function colorObject(color) {
    if (typeof color === 'string') return { name: color, hex: stringToHex(color) };
    return {
      name: color?.name || 'Default',
      hex: color?.hex || stringToHex(color?.name || 'Default'),
    };
  }

  function normalizeProduct(product = {}, options = {}) {
    const tags = Array.isArray(product.tags) ? product.tags : [];
    const imageIdResolver = options.imageIdResolver || (() => '');
    const imageResolver = options.imageResolver || ((value) => value);
    const imageSource = product.image || product.imageId || '';
    const imageId = product.imageId || imageIdResolver(product.image) || '';
    return {
      ...product,
      id: product.id || `product-${Date.now()}`,
      name: product.name || 'Untitled product',
      category: product.category || 'New Arrivals',
      price: safeNumber(product.price),
      compareAt: safeNumber(product.compareAt ?? product.comparePrice),
      badge: product.badge || tags[0] || '',
      imageId,
      image: imageResolver(imageSource) || product.image || 'assets/logo.svg',
      description: product.description || '',
      sizes: Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['One size'],
      colors: (Array.isArray(product.colors) && product.colors.length ? product.colors : ['Default']).map(colorObject),
      tags,
      stock: safeNumber(product.stock),
      featured: Boolean(product.featured || tags.map(normalizeText).includes('featured')),
      active: product.active !== false,
      material: product.material || '',
      fit: product.fit || '',
      care: product.care || '',
      createdAt: safeNumber(product.createdAt),
    };
  }

  // Single universal flat delivery fee (default $3). No per-area pricing, no
  // free-delivery threshold, no promos.
  const DEFAULT_DELIVERY_FEE = 3;
  function calculateDelivery(settings = {}) {
    const fee = settings && settings.deliveryFee !== undefined && settings.deliveryFee !== null
      ? safeNumber(settings.deliveryFee, DEFAULT_DELIVERY_FEE)
      : DEFAULT_DELIVERY_FEE;
    return Math.max(0, fee);
  }

  function calculateOrderTotals({ items = [], settings = {} } = {}) {
    const subtotal = items.reduce((sum, item) => {
      return sum + Math.max(0, safeNumber(item.price)) * Math.max(0, safeNumber(item.qty));
    }, 0);
    const delivery = calculateDelivery(settings);
    return {
      subtotal,
      delivery,
      total: subtotal + delivery,
    };
  }

  // ---- Multi-image gallery model (P2) ----
  // A product has one MAIN image (imageUrl/driveFileId/imageVersion) plus an
  // ordered gallery of additional images. Each gallery entry carries its own
  // driveFileId + imageVersion so it caches and busts independently of the main.
  const MAX_GALLERY = 12;
  function normalizeGalleryEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') {
      const url = entry.trim();
      return url ? { imageUrl: url, driveFileId: '', imageVersion: '' } : null;
    }
    if (typeof entry !== 'object') return null;
    const imageUrl = String(entry.imageUrl || entry.image || entry.url || '').trim();
    if (!imageUrl) return null;
    return {
      imageUrl,
      driveFileId: String(entry.driveFileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120),
      imageVersion: String(entry.imageVersion || '').slice(0, 40),
    };
  }
  function normalizeGallery(list) {
    const source = Array.isArray(list) ? list : [];
    const seen = new Set();
    const out = [];
    for (const raw of source) {
      const entry = normalizeGalleryEntry(raw);
      if (!entry || seen.has(entry.imageUrl)) continue;
      seen.add(entry.imageUrl);
      out.push(entry);
      if (out.length >= MAX_GALLERY) break;
    }
    return out;
  }

  // Derive the public Instagram profile URL from a stored handle (single source).
  function instagramUrlFromHandle(handle) {
    const clean = String(handle || '').trim().replace(/^@+/, '').replace(/\s+/g, '');
    if (!clean) return '';
    if (/^https?:\/\//i.test(handle || '')) return String(handle).trim();
    return `https://instagram.com/${clean}`;
  }

  // ---- Output escaping / safe templating (storefront XSS hardening) ----
  // Database rules lock catalog/settings writes to the admin account, but output
  // escaping stays as defense in depth: every value rendered into the DOM is
  // escaped so a compromised record can never inject markup. escapeHtml()
  // escapes text and attribute
  // contexts; html`` is an auto-escaping tagged template that is safe by
  // default — interpolations are escaped unless they are themselves html``
  // fragments (or html.raw(...)) or arrays of such fragments.
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isSafeHtml(value) {
    return Boolean(value) && typeof value === 'object' && value.__paviaSafeHtml === true;
  }

  function markSafe(str) {
    const value = str === null || str === undefined ? '' : String(str);
    return { __paviaSafeHtml: true, value, toString() { return value; } };
  }

  function resolveHtmlValue(value) {
    if (value === null || value === undefined || value === false) return '';
    if (isSafeHtml(value)) return value.value;
    if (Array.isArray(value)) return value.map(resolveHtmlValue).join('');
    return escapeHtml(value);
  }

  function html(strings, ...valuesToInsert) {
    let out = strings[0];
    for (let index = 0; index < valuesToInsert.length; index += 1) {
      out += resolveHtmlValue(valuesToInsert[index]) + strings[index + 1];
    }
    return markSafe(out);
  }
  html.raw = (value) => markSafe(value);

  // Attribute-value sanitizers (escaping prevents breakout; these add a
  // scheme/format allowlist as defense in depth so hostile values render inert).
  function safeImageSrc(value, fallback = 'assets/logo.svg') {
    const str = String(value === null || value === undefined ? '' : value).trim();
    if (!str) return fallback;
    if (/^(?:https?:\/\/|data:image\/|blob:|assets\/|\.\/|\/)/i.test(str)) return str;
    if (/^[\w./-]+\.(?:svg|png|jpe?g|webp|gif|avif)$/i.test(str)) return str;
    return fallback;
  }

  function safeCssColor(value, fallback = '#a78970') {
    const str = String(value === null || value === undefined ? '' : value).trim();
    if (/^#[0-9a-fA-F]{3,8}$/.test(str)) return str;
    if (/^[a-zA-Z]{1,24}$/.test(str)) return str;
    if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(str)) return str;
    return fallback;
  }

  function safeExternalUrl(value, fallback = '') {
    const str = String(value === null || value === undefined ? '' : value).trim();
    if (/^https?:\/\//i.test(str) || /^(?:mailto:|tel:)/i.test(str)) return str;
    return fallback;
  }

  // ---- Revision-aware catalog cache helpers (P14, pure / node-testable) ----
  // The storefront keeps a tiny publicCatalogManifest { catalogRev, products: {id:rev} }
  // so it can detect changes with one small read and fetch only changed product nodes.
  function manifestProductRevs(manifest) {
    if (!manifest || typeof manifest !== 'object') return {};
    const source = manifest.products && typeof manifest.products === 'object' ? manifest.products : {};
    const revs = {};
    Object.keys(source).forEach((id) => {
      const rev = Number(source[id]);
      if (id && Number.isFinite(rev)) revs[id] = rev;
    });
    return revs;
  }

  function diffManifest(prevRevs = {}, nextRevs = {}) {
    const prev = prevRevs || {};
    const next = nextRevs || {};
    const changed = [];
    const removed = [];
    Object.keys(next).forEach((id) => {
      if (prev[id] === undefined || prev[id] !== next[id]) changed.push(id);
    });
    Object.keys(prev).forEach((id) => {
      if (next[id] === undefined) removed.push(id);
    });
    return { changed, removed };
  }

  function buildCatalogManifest(products = [], catalogRev = 0) {
    const map = {};
    (Array.isArray(products) ? products : []).forEach((product) => {
      const id = String(product?.id || '').trim();
      if (!id || product.active === false) return;
      map[id] = Math.max(1, Math.floor(safeNumber(product.rev, 1)) || 1);
    });
    return { catalogRev: safeNumber(catalogRev), products: map };
  }

  // Resolved-image-URL cache key: stable across reloads, busts when imageVersion changes.
  function imageCacheKey(product = {}) {
    const base = String(product.driveFileId || product.imageId || product.image || '').trim();
    if (!base) return '';
    const version = String(product.imageVersion || '').trim();
    return `${base}::${version}`;
  }

  // Only persist resolved URLs that survive a reload (never session-scoped blob: URLs).
  function isStableImageUrl(url) {
    const str = String(url || '').trim();
    if (!str || /^blob:/i.test(str)) return false;
    return /^(https?:|data:image\/|assets\/|\.{0,2}\/|[\w.-]+\/)/i.test(str) || /^[\w.-]+\.(?:svg|png|jpe?g|webp|gif|avif)/i.test(str);
  }

  // LRU eviction: returns the keys to delete so a capped cache keeps the most-recent.
  function pruneLruKeys(entries = [], max = 60) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length <= max) return [];
    const sorted = [...list].sort((a, b) => (safeNumber(a.lastUsed) - safeNumber(b.lastUsed)));
    return sorted.slice(0, list.length - max).map((entry) => entry.key);
  }

  // ---- Admin list/sort + image-dedup helpers (P15, pure / node-testable) ----
  function compareProducts(key) {
    const byName = (a, b) => String(a && a.name ? a.name : '').localeCompare(String(b && b.name ? b.name : ''));
    switch (key) {
      case 'name':
        return byName;
      case 'price':
        return (a, b) => (safeNumber(a.price) - safeNumber(b.price)) || byName(a, b);
      case 'price-desc':
        return (a, b) => (safeNumber(b.price) - safeNumber(a.price)) || byName(a, b);
      case 'stock':
        return (a, b) => (safeNumber(a.stock) - safeNumber(b.stock)) || byName(a, b);
      case 'stock-desc':
        return (a, b) => (safeNumber(b.stock) - safeNumber(a.stock)) || byName(a, b);
      default:
        return (a, b) => (safeNumber(a.sortOrder) - safeNumber(b.sortOrder)) || byName(a, b);
    }
  }

  // Dedup an admin image re-upload: reuse the existing Drive file when the freshly
  // optimized bytes hash to the same value the product already stores.
  function shouldReuseImage(existingContentHash, candidateContentHash) {
    const existing = String(existingContentHash || '').trim();
    const candidate = String(candidateContentHash || '').trim();
    return Boolean(existing) && existing === candidate;
  }

  // ---- SEO / structured-data helpers (P16, pure / node-testable) ----
  function absoluteImageUrl(image, siteUrl = '') {
    const str = String(image || '').trim();
    if (!str) return '';
    if (/^https?:\/\//i.test(str)) return str;
    if (/^(?:data:|blob:)/i.test(str)) return '';
    const base = String(siteUrl || '').replace(/\/+$/, '');
    return base ? `${base}/${str.replace(/^\.?\/+/, '')}` : str;
  }

  function buildProductListJsonLd(products = [], options = {}) {
    const siteUrl = String(options.siteUrl || '').replace(/\/+$/, '');
    const currency = options.currency || 'USD';
    const limit = Math.max(1, safeNumber(options.limit, 24));
    const itemListElement = (Array.isArray(products) ? products : [])
      .filter((product) => product && product.active !== false)
      .slice(0, limit)
      .map((product, index) => {
        const image = absoluteImageUrl(product.image || product.imageUrl || '', siteUrl);
        const offer = {
          '@type': 'Offer',
          price: Math.max(0, safeNumber(product.price)),
          priceCurrency: currency,
          availability: safeNumber(product.stock) > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        };
        if (siteUrl && product.id) offer.url = `${siteUrl}/#${product.id}`;
        const item = {
          '@type': 'Product',
          name: String(product.name || 'Product'),
          offers: offer,
        };
        if (image) item.image = image;
        if (product.description) item.description = String(product.description).slice(0, 300);
        if (product.category) item.category = String(product.category);
        return { '@type': 'ListItem', position: index + 1, item };
      });
    return {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: options.siteName || 'Pavia Lebanon',
      numberOfItems: itemListElement.length,
      itemListElement,
    };
  }

  function normalizeOrderItems(items, options = {}) {
    const maxQty = Math.max(1, safeNumber(options.maxQty, 20));
    const safeKey = options.safeKey || ((value) => String(value || '').trim());
    const source = Array.isArray(items) ? items : Object.values(items || {});
    return source.map((item) => ({
      id: safeKey(item.id),
      name: String(item.name || '').trim().slice(0, 120),
      qty: Math.max(1, Math.min(maxQty, safeNumber(item.qty, 1))),
      price: Math.max(0, safeNumber(item.price)),
      size: String(item.size || '').trim().slice(0, 40),
      color: String(item.color || '').trim().slice(0, 60),
    })).filter((item) => item.id && item.qty > 0);
  }

  const api = Object.freeze({
    calculateDelivery,
    calculateOrderTotals,
    colorObject,
    escapeHtml,
    formatMoney,
    html,
    instagramUrlFromHandle,
    normalizeGallery,
    normalizeGalleryEntry,
    normalizeLebanonPhone,
    normalizeOrderItems,
    normalizeProduct,
    normalizeText,
    safeCssColor,
    safeExternalUrl,
    safeImageSrc,
    safeNumber,
    stringToHex,
    absoluteImageUrl,
    buildCatalogManifest,
    buildProductListJsonLd,
    compareProducts,
    diffManifest,
    imageCacheKey,
    isStableImageUrl,
    manifestProductRevs,
    pruneLruKeys,
    shouldReuseImage,
  });

  global.PaviaStoreCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
