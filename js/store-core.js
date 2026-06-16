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
    formatMoney,
    normalizeLebanonPhone,
    normalizeOrderItems,
    normalizeProduct,
    normalizeText,
    safeNumber,
    stringToHex,
  });

  global.PaviaStoreCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
