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
      sku: product.sku || '',
      material: product.material || '',
      fit: product.fit || '',
      care: product.care || '',
      createdAt: safeNumber(product.createdAt),
    };
  }

  function calculatePromoDiscount(promo, subtotal, today = new Date().toISOString().slice(0, 10)) {
    if (!promo || promo.active === false) return 0;
    const base = Math.max(0, safeNumber(subtotal));
    if (safeNumber(promo.minSubtotal) > base) return 0;
    if (promo.startsAt && promo.startsAt > today) return 0;
    if (promo.endsAt && promo.endsAt < today) return 0;
    if (promo.type === 'percent') {
      return Math.min(base, Math.round(base * (Math.max(0, safeNumber(promo.value)) / 100)));
    }
    if (promo.type === 'fixed') {
      return Math.min(base, Math.max(0, safeNumber(promo.value)));
    }
    return 0;
  }

  function calculateDelivery(settings = {}, subtotalAfterDiscount = 0, promo = null, deliveryArea = 'lebanon') {
    if (promo?.type === 'freeship' && promo.active !== false) return 0;
    const threshold = safeNumber(settings.freeDeliveryAt);
    if (threshold > 0 && safeNumber(subtotalAfterDiscount) >= threshold) return 0;
    return deliveryArea === 'beirut'
      ? Math.max(0, safeNumber(settings.deliveryBeirut))
      : Math.max(0, safeNumber(settings.deliveryLebanon));
  }

  function calculateOrderTotals({ items = [], promo = null, settings = {}, deliveryArea = 'lebanon' } = {}) {
    const subtotal = items.reduce((sum, item) => {
      return sum + Math.max(0, safeNumber(item.price)) * Math.max(0, safeNumber(item.qty));
    }, 0);
    const discount = calculatePromoDiscount(promo, subtotal);
    const delivery = calculateDelivery(settings, Math.max(0, subtotal - discount), promo, deliveryArea);
    return {
      subtotal,
      discount,
      delivery,
      total: Math.max(0, subtotal - discount) + delivery,
    };
  }

  // ---- Output escaping / safe templating (storefront XSS hardening) ----
  // Under the P12 open-write model any signed-in visitor can store arbitrary
  // strings in product/settings/promo records. Every value rendered into the
  // DOM must therefore be escaped. escapeHtml() escapes text and attribute
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
        if (product.sku) item.sku = String(product.sku);
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
    calculatePromoDiscount,
    colorObject,
    escapeHtml,
    formatMoney,
    html,
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
