/* Pavia Studio admin dashboard.
 * Runs only after the Phase 04 dual gate decrypts this payload.
 */
(() => {
  'use strict';

  const KEYS = {
    products: 'PAVIA_PRODUCTS',
    orders: 'PAVIA_ORDERS',
    settings: 'PAVIA_SETTINGS',
    promoCodes: 'PAVIA_PROMO_CODES',
  };
  const BACKEND = window.PaviaBackend;
  const LOW_STOCK_AT = 3;
  const ORDER_STATUSES = ['new', 'confirmed', 'preparing', 'out_for_delivery', 'completed', 'cancelled'];
  const PAYMENT_STATUSES = ['pending', 'awaiting_confirmation', 'paid', 'failed', 'refunded'];
  const STATUS_LABELS = {
    new: 'New',
    confirmed: 'Confirmed',
    preparing: 'Preparing',
    out_for_delivery: 'Out for delivery',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  const PAYMENT_LABELS = {
    pending: 'Pending',
    awaiting_confirmation: 'Awaiting confirmation',
    paid: 'Paid',
    failed: 'Failed',
    refunded: 'Refunded',
  };

  const CORE = window.PaviaStoreCore || {};
  const DRAFT_KEY = 'PAVIA_PRODUCT_DRAFT';

  let productsCache = [];
  let ordersCache = [];
  let settingsCache = {};
  let statsCache = null;
  const EVENT_LABELS = {
    product_view: 'Product views',
    add_to_cart: 'Add to cart',
    checkout_started: 'Checkout started',
    order_created: 'Orders placed',
  };
  let promoCache = {};
  let pendingDriveImage = null;

  // P15 UX state
  let formDirty = false;
  let suppressDirty = false;
  let savingProduct = false;
  let savingSettings = false;
  let savingPromo = false;
  let draftTimer = 0;
  let optimizedPreviewUrl = '';
  const selectedProductIds = new Set();

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const fmt = (value) => `$${(Number(value) || 0).toFixed(2)}`;
  const norm = (value) => String(value || '').trim().toLowerCase();

  function readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeLS(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function slugify(value) {
    return norm(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `product-${Date.now().toString(36)}`;
  }

  function splitList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function todayKey(value) {
    return new Date(value || Date.now()).toISOString().slice(0, 10);
  }

  function normalizeStatus(status) {
    const value = norm(status || 'new');
    if (value === 'available' || value === 'pending') return 'new';
    return ORDER_STATUSES.includes(value) ? value : 'new';
  }

  function normalizePaymentStatus(status) {
    const value = norm(status || 'pending');
    return PAYMENT_STATUSES.includes(value) ? value : 'pending';
  }

  function normalizePhone(value) {
    return String(value || '').replace(/[^\d+]/g, '');
  }

  function phoneLink(value) {
    const phone = normalizePhone(value);
    return phone ? `tel:${phone}` : '';
  }

  function whatsappLink(value, order) {
    const phone = normalizePhone(value).replace(/^\+/, '');
    if (!phone) return '';
    const text = encodeURIComponent(`Hello from Pavia about order #${order.id || order.orderNumber || ''}`);
    return `https://wa.me/${phone}?text=${text}`;
  }

  function toast(message) {
    const wrap = $('#toastWrap');
    if (!wrap) return;
    const element = document.createElement('div');
    element.className = 'toast';
    element.textContent = message;
    wrap.appendChild(element);
    requestAnimationFrame(() => element.classList.add('show'));
    setTimeout(() => {
      element.classList.remove('show');
      setTimeout(() => element.remove(), 250);
    }, 2400);
  }

  // ---- P15: save feedback, dirty tracking, draft autosave ----
  function setButtonLoading(button, loading, text) {
    if (!button) return;
    button.disabled = Boolean(loading);
    button.classList.toggle('is-loading', Boolean(loading));
    if (text) button.textContent = text;
  }

  function setFormStatus(id, message, tone = 'info') {
    const element = $(`#${id}`);
    if (!element) return;
    element.textContent = message || '';
    element.dataset.tone = message ? tone : '';
    element.classList.toggle('show', Boolean(message));
  }

  function markFormDirty() {
    if (suppressDirty) return;
    formDirty = true;
    scheduleDraftSave();
  }

  function clearFormDirty() {
    formDirty = false;
    clearTimeout(draftTimer);
  }

  function confirmDiscardIfDirty(message) {
    return !formDirty || window.confirm(message);
  }

  function serializeProductForm() {
    return {
      id: $('#prodId').value,
      slug: $('#prodSlug').value,
      name: $('#prodName').value,
      category: $('#prodCategory').value,
      badge: $('#prodBadge').value,
      sku: $('#prodSku').value,
      status: $('#prodStatus').value,
      featured: $('#prodFeatured').checked,
      sortOrder: $('#prodSortOrder').value,
      description: $('#prodDesc').value,
      price: $('#prodPrice').value,
      compareAt: $('#prodCompare').value,
      stock: $('#prodStock').value,
      tags: $('#prodTags').value,
      sizes: $('#prodSizes').value,
      colors: $('#prodColors').value,
      material: $('#prodMaterial').value,
      fit: $('#prodFit').value,
      care: $('#prodCare').value,
      imageUrl: $('#prodImageUrl').value,
      imageId: $('#prodImageId').value,
      imageVersion: $('#prodImageVersion').value,
      imageMeta: $('#prodImageMeta').value,
      driveFileId: $('#prodDriveFileId').value,
      imageProvider: $('#prodImageProvider').value,
      savedAt: new Date().toISOString(),
    };
  }

  function draftHasContent(draft) {
    if (!draft) return false;
    return Boolean(String(draft.name || '').trim()
      || String(draft.description || '').trim()
      || (Number(draft.price) > 0)
      || String(draft.imageUrl || '').trim());
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(saveDraft, 600);
  }

  function saveDraft() {
    if (!formDirty) return;
    const draft = serializeProductForm();
    if (!draftHasContent(draft)) return;
    writeLS(DRAFT_KEY, draft);
  }

  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    const banner = $('#draftBanner');
    if (banner) banner.hidden = true;
  }

  function applyDraft(draft) {
    if (!draft) return;
    suppressDirty = true;
    $('#prodId').value = draft.id || '';
    $('#prodSlug').value = draft.slug || '';
    $('#prodName').value = draft.name || '';
    $('#prodCategory').value = draft.category || '';
    $('#prodBadge').value = draft.badge || '';
    $('#prodSku').value = draft.sku || '';
    $('#prodStatus').value = draft.status || 'published';
    $('#prodFeatured').checked = Boolean(draft.featured);
    $('#prodSortOrder').value = draft.sortOrder || nextSortOrder();
    $('#prodDesc').value = draft.description || '';
    $('#prodPrice').value = draft.price || '';
    $('#prodCompare').value = draft.compareAt || '';
    $('#prodStock').value = draft.stock || 0;
    $('#prodTags').value = draft.tags || '';
    $('#prodImageUrl').value = draft.imageUrl || '';
    $('#prodImageId').value = draft.imageId || '';
    $('#prodImage').value = draft.imageUrl || draft.imageId || '';
    $('#prodImageVersion').value = draft.imageVersion || '';
    $('#prodImageMeta').value = draft.imageMeta || '';
    $('#prodDriveFileId').value = draft.driveFileId || '';
    $('#prodImageProvider').value = draft.imageProvider || '';
    setSelectedSizes(splitList(draft.sizes));
    setColorRows(parseColors(draft.colors));
    $('#prodMaterial').value = draft.material || '';
    $('#prodFit').value = draft.fit || '';
    $('#prodCare').value = draft.care || '';
    $('#formTitle').textContent = draft.id ? 'Edit product' : 'Add a product';
    $('#formSubmit').textContent = draft.id ? 'Save changes' : 'Add product';
    suppressDirty = false;
    formDirty = true;
    void updateProductPreview();
  }

  function maybeShowDraftBanner() {
    const banner = $('#draftBanner');
    if (!banner) return;
    const draft = readLS(DRAFT_KEY, null);
    if (!draftHasContent(draft)) {
      banner.hidden = true;
      return;
    }
    $('#draftBannerMeta').textContent = `"${draft.name || 'Untitled'}" saved ${new Date(draft.savedAt || Date.now()).toLocaleString()}`;
    banner.hidden = false;
  }

  function adminMutationsEnabled() {
    return BACKEND?.capabilities?.adminMutations !== false;
  }

  function orderManagementEnabled() {
    return BACKEND?.capabilities?.orderManagement !== false;
  }

  function applyBackendCapabilities() {
    if (adminMutationsEnabled() && orderManagementEnabled()) return;
    const dashboard = $('#dashboard');
    const notice = document.createElement('div');
    notice.className = 'panel-card';
    notice.innerHTML = `
      <p class="admin-kicker">Read-only mode</p>
      <strong>Admin operations are locked for this session.</strong>
      <p class="desc">The encrypted local password unlock must succeed before editing is enabled. Realtime Database rules require only a signed-in user.</p>
    `;
    dashboard.prepend(notice);
    $$('form input, form select, form textarea, form button, [data-delete], [data-update-order]')
      .forEach((control) => { control.disabled = true; });
  }

  function parseColors(value) {
    return splitList(value).map((token) => {
      const separator = token.indexOf(':');
      const name = separator >= 0 ? token.slice(0, separator).trim() : token;
      const hex = separator >= 0 ? token.slice(separator + 1).trim() : '';
      return {
        name: name || 'Color',
        hex: /^#[0-9a-f]{3,8}$/i.test(hex) ? hex : '#cccccc',
      };
    });
  }

  function colorsToString(colors) {
    return (colors || []).map((color) => {
      if (typeof color === 'string') return color;
      return `${color.name || 'Color'}:${color.hex || '#cccccc'}`;
    }).join(', ');
  }

  const PRESET_SIZES = ['One size', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];

  function selectedSizes() {
    return splitList($('#prodSizes').value);
  }

  function setSelectedSizes(sizes) {
    const unique = [...new Set((sizes || []).map((size) => String(size).trim()).filter(Boolean))];
    $('#prodSizes').value = unique.join(', ');
    $$('[data-size-option]').forEach((button) => {
      button.classList.toggle('is-selected', unique.includes(button.dataset.sizeOption));
    });
    const custom = unique.filter((size) => !PRESET_SIZES.includes(size));
    $('#customSizeList').innerHTML = custom.map((size) => `
      <button type="button" class="selection-chip" data-remove-size="${escapeHtml(size)}">
        ${escapeHtml(size)}
        <span aria-hidden="true">&times;</span>
      </button>
    `).join('');
    $$('[data-remove-size]').forEach((button) => {
      button.addEventListener('click', () => {
        setSelectedSizes(selectedSizes().filter((size) => size !== button.dataset.removeSize));
      });
    });
    markFormDirty();
  }

  function togglePresetSize(size) {
    const sizes = selectedSizes();
    if (size === 'One size') {
      setSelectedSizes(sizes.includes(size) ? [] : ['One size']);
      return;
    }
    const withoutOneSize = sizes.filter((item) => item !== 'One size');
    setSelectedSizes(withoutOneSize.includes(size)
      ? withoutOneSize.filter((item) => item !== size)
      : [...withoutOneSize, size]);
  }

  function addCustomSize() {
    const input = $('#customSize');
    const size = input.value.trim();
    if (!size) return;
    setSelectedSizes([...selectedSizes().filter((item) => item !== 'One size'), size]);
    input.value = '';
    input.focus();
  }

  function colorRows() {
    return $$('.color-row', $('#colorBuilder')).map((row) => ({
      name: $('[data-color-name]', row).value.trim() || 'Color',
      hex: $('[data-color-value]', row).value,
    }));
  }

  function syncColorsField() {
    $('#prodColors').value = colorsToString(colorRows());
    markFormDirty();
  }

  function addColorRow(color = { name: '', hex: '#c9a779' }) {
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `
      <label class="color-swatch-control" title="Choose color">
        <input data-color-value type="color" value="${escapeHtml(color.hex || '#c9a779')}" />
        <span style="background:${escapeHtml(color.hex || '#c9a779')}"></span>
      </label>
      <label class="color-name-field">
        Color name
        <input data-color-name type="text" value="${escapeHtml(color.name || '')}" placeholder="e.g. Ivory" />
      </label>
      <code data-color-code>${escapeHtml(color.hex || '#c9a779')}</code>
      <button type="button" class="remove-color" aria-label="Remove color">&times;</button>
    `;
    $('#colorBuilder').appendChild(row);

    const picker = $('[data-color-value]', row);
    picker.addEventListener('input', () => {
      $('.color-swatch-control span', row).style.background = picker.value;
      $('[data-color-code]', row).textContent = picker.value;
      syncColorsField();
    });
    $('[data-color-name]', row).addEventListener('input', syncColorsField);
    $('.remove-color', row).addEventListener('click', () => {
      row.remove();
      if (!$$('.color-row', $('#colorBuilder')).length) addColorRow();
      syncColorsField();
    });
    syncColorsField();
  }

  function setColorRows(colors) {
    $('#colorBuilder').innerHTML = '';
    const list = (colors || []).map((color) => typeof color === 'string'
      ? { name: color, hex: '#cccccc' }
      : color);
    (list.length ? list : [{ name: '', hex: '#c9a779' }]).forEach(addColorRow);
    syncColorsField();
  }

  function catalogImageIds() {
    return Object.keys(window.PAVIA_IMAGE_CATALOG || {});
  }

  function productNeedsImageMigration(product) {
    const provider = String(product.imageProvider || '').trim();
    return !product.imageUrl || Boolean(product.imageId) || provider === 'local' || provider === 'local_legacy';
  }

  function imageReferenceFromFields() {
    const imageUrl = $('#prodImageUrl').value.trim();
    const imageId = $('#prodImageId').value.trim();
    return imageUrl || imageId || 'assets/logo.svg';
  }

  function normalizeImagePath(value) {
    const path = String(value || '').trim();
    if (!path) return 'assets/logo.svg';
    if (/^https?:\/\//i.test(path)) return path;
    const preset = window.PaviaImages?.idFor?.(path) || path;
    return preset.replace(/^(\.\/)+/, '').replace(/^(\.\.\/)+/, '');
  }

  function imageSrc(path) {
    const resolved = window.PaviaImages?.resolve?.(path) || path || 'assets/logo.svg';
    if (/^(https?:|data:|blob:|\/)/i.test(resolved)) return resolved;
    return `../${resolved}`;
  }

  function normalizeProduct(product) {
    const imageId = product.imageId || window.PaviaImages?.idFor?.(product.image) || '';
    const imageUrl = /^https?:\/\//i.test(String(product.imageUrl || product.image || ''))
      ? String(product.imageUrl || product.image)
      : '';
    return {
      ...product,
      id: product.id || product.slug || slugify(product.name),
      slug: product.slug || product.id || slugify(product.name),
      sku: product.sku || '',
      name: product.name || 'Untitled product',
      category: product.category || 'New Arrivals',
      price: Number(product.price) || 0,
      compareAt: Number(product.compareAt ?? product.comparePrice ?? 0) || 0,
      stock: Math.max(0, Number(product.stock) || 0),
      imageId,
      imageUrl,
      image: imageUrl || imageId || normalizeImagePath(product.image),
      imageProvider: product.imageProvider || (product.driveFileId ? 'google_drive' : imageUrl ? 'external' : 'local_legacy'),
      driveFileId: product.driveFileId || '',
      imageVersion: product.imageVersion || '',
      imageMeta: product.imageMeta || null,
      description: product.description || '',
      sizes: Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['One size'],
      colors: Array.isArray(product.colors) ? product.colors : [],
      tags: Array.isArray(product.tags) ? product.tags : [],
      badge: product.badge || '',
      featured: Boolean(product.featured),
      active: product.active !== false,
      material: product.material || '',
      fit: product.fit || '',
      care: product.care || '',
      sortOrder: Number(product.sortOrder) || 999,
      createdAt: product.createdAt || Date.now(),
    };
  }

  function getProducts() {
    return productsCache;
  }

  async function loadProducts() {
    const source = BACKEND
      ? await BACKEND.products.list()
      : readLS(KEYS.products, window.PAVIA_DEFAULT_PRODUCTS || []);
    productsCache = source.map(normalizeProduct);
  }

  async function upsertProduct(product) {
    if (!adminMutationsEnabled()) throw new Error('Catalog editing is disabled for this session.');
    const normalized = normalizeProduct(product);
    if (BACKEND?.products?.upsert) await BACKEND.products.upsert(normalized);
    else {
      const products = getProducts();
      const index = products.findIndex((item) => String(item.id) === String(normalized.id));
      if (index >= 0) products[index] = normalized;
      else products.push(normalized);
      writeLS(KEYS.products, products);
    }
    await loadProducts();
  }

  async function removeProduct(id) {
    if (!adminMutationsEnabled()) throw new Error('Catalog editing is disabled for this session.');
    if (BACKEND?.products?.remove) await BACKEND.products.remove(id);
    else writeLS(KEYS.products, getProducts().filter((product) => product.id !== id));
    await loadProducts();
  }

  async function loadOrders() {
    const source = BACKEND ? await BACKEND.orders.list() : readLS(KEYS.orders, []);
    ordersCache = (source || []).map((order) => ({
      ...order,
      items: Array.isArray(order.items) ? order.items : Object.values(order.items || {}),
      status: normalizeStatus(order.status),
      paymentStatus: normalizePaymentStatus(order.paymentStatus),
    }));
  }

  async function loadSettings() {
    settingsCache = BACKEND?.settings?.get
      ? await BACKEND.settings.get()
      : readLS(KEYS.settings, window.PAVIA_CONFIG || {});
  }

  async function loadPromos() {
    promoCache = BACKEND?.promoCodes?.list
      ? await BACKEND.promoCodes.list()
      : readLS(KEYS.promoCodes, window.PAVIA_PROMO_CODES || {});
  }

  async function loadStatistics() {
    statsCache = BACKEND?.analytics?.readStatistics
      ? await BACKEND.analytics.readStatistics().catch(() => null)
      : null;
  }

  function renderVisitorMetrics() {
    const grid = $('#visitorMetricsGrid');
    if (!grid) return;
    const stats = statsCache || { totalVisitors: 0, newToday: 0, activeNow: 0, sessions: 0, todaySessions: 0, events: [], recent: [] };
    grid.innerHTML = [
      ['Visitors', stats.totalVisitors, 'Unique anonymous visitors'],
      ['New today', stats.newToday, 'First-time visitors today'],
      ['Active now', stats.activeNow, 'Seen in the last 15 min'],
      ['Sessions', stats.sessions, `${stats.todaySessions} today`],
    ].map(([label, value, detail]) => `
      <article class="metric-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail)}</small>
      </article>
    `).join('');

    const events = $('#visitorEvents');
    if (!events) return;
    const rows = (stats.events || []).filter((entry) => Number(entry.count) > 0);
    events.innerHTML = rows.length
      ? rows.map((entry) => `
          <div class="compact-row">
            <div><strong>${escapeHtml(EVENT_LABELS[entry.type] || entry.type)}</strong></div>
            <b>${escapeHtml(entry.count)}</b>
          </div>
        `).join('')
      : '<div class="empty-state-admin compact-empty"><strong>No visitor activity yet</strong><p>Storefront sessions and engagement events will appear here.</p></div>';
  }

  function renderMetrics() {
    const openOrders = ordersCache.filter((order) => !['completed', 'cancelled'].includes(order.status));
    const pendingPayments = ordersCache.filter((order) => ['pending', 'awaiting_confirmation'].includes(order.paymentStatus));
    const today = todayKey();
    const todayOrders = ordersCache.filter((order) => todayKey(order.createdAt || order.date) === today);
    const lowStock = productsCache.filter((product) => product.stock > 0 && product.stock <= LOW_STOCK_AT);

    $('#metricsGrid').innerHTML = [
      ['Open orders', openOrders.length, 'Orders still in progress'],
      ['Today', todayOrders.length, 'Orders created today'],
      ['Pending pay', pendingPayments.length, 'Manual payment checks'],
      ['Low stock', lowStock.length, `At or below ${LOW_STOCK_AT}`],
    ].map(([label, value, detail]) => `
      <article class="metric-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail)}</small>
      </article>
    `).join('');

    $('#latestOrders').innerHTML = ordersCache.length
      ? [...ordersCache]
        .sort((left, right) => new Date(right.createdAt || right.date || 0) - new Date(left.createdAt || left.date || 0))
        .slice(0, 5)
        .map((order) => {
          const customer = order.customer || {};
          return `
            <div class="compact-row">
              <div>
                <strong>#${escapeHtml(order.orderNumber || order.id || '')}</strong>
                <span>${escapeHtml(customer.name || 'Customer')} - ${escapeHtml(STATUS_LABELS[order.status])}</span>
              </div>
              <b>${fmt(order.total)}</b>
            </div>
          `;
        }).join('')
      : '<div class="empty-state-admin compact-empty"><strong>No orders yet</strong><p>New orders will appear here after checkout is connected.</p></div>';

    $('#lowStockList').innerHTML = lowStock.length
      ? lowStock
        .sort((left, right) => left.stock - right.stock)
        .slice(0, 8)
        .map((product) => `
          <div class="compact-row">
            <div>
              <strong>${escapeHtml(product.name)}</strong>
              <span>${escapeHtml(product.sku || product.category)}</span>
            </div>
            <b>${product.stock}</b>
          </div>
        `).join('')
      : '<div class="empty-state-admin compact-empty"><strong>Stock looks steady</strong><p>No low-stock products right now.</p></div>';
  }

  function orderMatchesFilters(order) {
    const query = norm($('#orderSearch').value);
    const status = $('#orderStatusFilter').value;
    const payment = $('#paymentStatusFilter').value;
    const date = $('#orderDateFilter').value;
    const customer = order.customer || {};
    const haystack = norm([
      order.id,
      order.orderNumber,
      customer.name,
      customer.phone,
      customer.city,
      order.status,
      order.paymentStatus,
    ].join(' '));
    return (!query || haystack.includes(query))
      && (!status || order.status === status)
      && (!payment || order.paymentStatus === payment)
      && (!date || todayKey(order.createdAt || order.date) === date);
  }

  function statusOptions(current, labels) {
    return Object.entries(labels).map(([value, label]) => (
      `<option value="${value}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`
    )).join('');
  }

  function renderOrderItem(order) {
    const customer = order.customer || {};
    const phone = customer.phone || order.phone || '';
    const callHref = phoneLink(phone);
    const waHref = whatsappLink(phone, order);
    const items = (order.items || []).map((item) => {
      const color = typeof item.color === 'string' ? item.color : item.color?.name || '';
      const options = [item.size, color].filter(Boolean).map(escapeHtml).join(' / ');
      return `
        <li>
          <span>${escapeHtml(item.name)}${options ? ` <small>${options}</small>` : ''}</span>
          <strong>${item.qty || 1} x ${fmt(item.price || 0)}</strong>
        </li>
      `;
    }).join('');
    const disabled = orderManagementEnabled() ? '' : ' disabled';
    const date = new Date(order.date || order.createdAt || Date.now()).toLocaleString();
    const timeline = [
      ['Created', order.createdAt || order.date],
      ['Updated', order.updatedAt],
      ['Out for delivery', order.outForDeliveryAt],
      ['Completed', order.completedAt],
      ['Cancelled', order.cancelledAt],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `<li><span>${escapeHtml(label)}</span><time>${escapeHtml(new Date(value).toLocaleString())}</time></li>`)
      .join('');

    return `
      <article class="order-item" data-order-id="${escapeHtml(order.id)}">
        <div class="order-topline">
          <div>
            <span class="order-id">#${escapeHtml(order.orderNumber || order.id || '')}</span>
            <time>${escapeHtml(date)}</time>
          </div>
          <strong class="order-total">${fmt(order.total)}</strong>
        </div>
        <div class="order-customer">
          <div><span>Customer</span><strong>${escapeHtml(customer.name || 'Customer')}</strong></div>
          <div><span>Phone</span><strong>${escapeHtml(phone || '-')}</strong></div>
          <div><span>Area</span><strong>${escapeHtml(customer.city || customer.area || '-')}</strong></div>
          <div><span>Payment</span><strong>${escapeHtml(customer.payment || order.paymentMethod || 'Cash on delivery')}</strong></div>
        </div>
        <p class="order-address">${escapeHtml(customer.address || 'No address supplied')}</p>
        ${customer.notes || order.notes ? `<p class="order-note"><strong>Customer notes:</strong> ${escapeHtml(customer.notes || order.notes)}</p>` : ''}
        ${order.pricingReview ? `<p class="order-note"><strong>Pricing review:</strong> ${escapeHtml(order.pricingReview.status || 'Manual review required')} - expected total ${escapeHtml(fmt(order.pricingReview.expectedTotal || order.total || 0))}</p>` : ''}
        <ul class="order-products">${items}</ul>
        ${timeline ? `<ul class="order-timeline">${timeline}</ul>` : ''}
        <div class="order-workflow">
          <label>
            Order status
            <select data-order-status${disabled}>${statusOptions(order.status, STATUS_LABELS)}</select>
          </label>
          <label>
            Payment status
            <select data-payment-status${disabled}>${statusOptions(order.paymentStatus, PAYMENT_LABELS)}</select>
          </label>
          <label>
            Cancellation reason
            <input data-cancel-reason type="text" value="${escapeHtml(order.cancellationReason || '')}"${disabled} />
          </label>
          <label class="span-2">
            Admin notes
            <textarea data-admin-notes rows="2"${disabled}>${escapeHtml(order.adminNotes || '')}</textarea>
          </label>
        </div>
        <div class="order-actions">
          ${callHref ? `<a class="btn btn-secondary" href="${escapeHtml(callHref)}">Call</a>` : ''}
          ${waHref ? `<a class="btn btn-secondary" href="${escapeHtml(waHref)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          <button class="btn btn-ghost" data-print-order="${escapeHtml(order.id)}">Print</button>
          <button class="btn btn-ghost" data-export-order="${escapeHtml(order.id)}">Export</button>
          <button class="btn btn-primary" data-update-order="${escapeHtml(order.id)}"${disabled}>Save workflow</button>
        </div>
      </article>
    `;
  }

  function sortOrders(list) {
    const key = $('#orderSort')?.value || 'newest';
    const time = (order) => new Date(order.createdAt || order.date || 0).getTime();
    const total = (order) => Number(order.total) || 0;
    const arr = [...list];
    if (key === 'oldest') return arr.sort((left, right) => time(left) - time(right));
    if (key === 'total-desc') return arr.sort((left, right) => total(right) - total(left));
    if (key === 'total') return arr.sort((left, right) => total(left) - total(right));
    return arr.sort((left, right) => time(right) - time(left));
  }

  function renderOrders() {
    const orders = sortOrders(ordersCache.filter(orderMatchesFilters));
    const openCount = ordersCache.filter((order) => !['completed', 'cancelled'].includes(order.status)).length;
    $('#availableOrderCount').textContent = openCount;
    $('#availableOrders').innerHTML = orders.length
      ? orders.map(renderOrderItem).join('')
      : `
        <div class="empty-state-admin">
          <strong>No matching orders</strong>
          <p>Try clearing filters or wait for new storefront orders.</p>
        </div>
      `;
    $$('[data-update-order]').forEach((button) => {
      button.addEventListener('click', () => updateOrder(button.dataset.updateOrder));
    });
    $$('[data-print-order]').forEach((button) => {
      button.addEventListener('click', () => printOrder(button.dataset.printOrder));
    });
    $$('[data-export-order]').forEach((button) => {
      button.addEventListener('click', () => exportOrder(button.dataset.exportOrder));
    });
  }

  async function updateOrder(id) {
    if (!orderManagementEnabled()) {
      toast('Order management is disabled for this session');
      return;
    }
    const row = $(`[data-order-id="${CSS.escape(id)}"]`);
    const changes = {
      status: $('[data-order-status]', row).value,
      paymentStatus: $('[data-payment-status]', row).value,
      cancellationReason: $('[data-cancel-reason]', row).value.trim(),
      adminNotes: $('[data-admin-notes]', row).value.trim(),
    };
    try {
      if (BACKEND?.orders?.update) await BACKEND.orders.update(id, changes);
      else {
        const order = ordersCache.find((item) => String(item.id) === String(id));
        Object.assign(order, changes, { updatedAt: new Date().toISOString() });
        writeLS(KEYS.orders, ordersCache);
      }
      await loadOrders();
      renderOrders();
      renderMetrics();
      toast('Order updated');
    } catch (error) {
      toast(error.message || 'Could not update order');
    }
  }

  function printOrder(id) {
    const order = ordersCache.find((item) => String(item.id) === String(id));
    if (!order) return;
    const customer = order.customer || {};
    const printable = window.open('', '_blank', 'noopener,noreferrer,width=800,height=900');
    if (!printable) {
      toast('Pop-up blocked. Allow pop-ups to print orders.');
      return;
    }
    const items = (order.items || []).map((item) => (
      `<li>${escapeHtml(item.name)} - ${item.qty || 1} x ${fmt(item.price || 0)}</li>`
    )).join('');
    printable.document.write(`
      <!doctype html>
      <title>Pavia order ${escapeHtml(order.id)}</title>
      <body style="font-family:Arial,sans-serif;padding:24px;line-height:1.5">
        <h1>Pavia order #${escapeHtml(order.orderNumber || order.id || '')}</h1>
        <p><strong>Status:</strong> ${escapeHtml(STATUS_LABELS[order.status] || order.status)}</p>
        <p><strong>Payment:</strong> ${escapeHtml(PAYMENT_LABELS[order.paymentStatus] || order.paymentStatus)}</p>
        <h2>Customer</h2>
        <p>${escapeHtml(customer.name || '')}<br>${escapeHtml(customer.phone || '')}<br>${escapeHtml(customer.address || '')}</p>
        <h2>Items</h2>
        <ul>${items}</ul>
        <h2>Total: ${fmt(order.total)}</h2>
        <p>${escapeHtml(order.adminNotes || '')}</p>
      </body>
    `);
    printable.document.close();
    printable.focus();
    printable.print();
  }

  function exportOrder(id) {
    const order = ordersCache.find((item) => String(item.id) === String(id));
    if (!order) return;
    const blob = new Blob([JSON.stringify(order, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pavia-order-${order.orderNumber || order.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function setFieldError(id, message = '') {
    const element = $(`[data-error-for="${id}"]`);
    const field = $(`#${id}`);
    if (element) {
      element.textContent = message;
      element.classList.toggle('show', Boolean(message));
    }
    field?.classList.toggle('is-invalid', Boolean(message));
  }

  function clearProductErrors() {
    $$('[data-error-for]').forEach((element) => {
      element.textContent = '';
      element.classList.remove('show');
    });
    $$('#productForm .is-invalid, #promoForm .is-invalid').forEach((field) => field.classList.remove('is-invalid'));
  }

  function validateProduct(id, product) {
    clearProductErrors();
    const errors = {};
    if (!product.name.trim()) errors.prodName = 'Product name is required.';
    if (!product.category.trim()) errors.prodCategory = 'Category is required.';
    if (!product.description.trim()) errors.prodDesc = 'Description is required.';
    if (!id) errors.prodSlug = 'Slug is required.';
    if (productsCache.some((item) => item.id === id && item.id !== $('#prodId').value)) {
      errors.prodSlug = 'This slug is already used.';
    }
    if (product.sku && productsCache.some((item) => norm(item.sku) === norm(product.sku) && item.id !== $('#prodId').value)) {
      errors.prodSku = 'This SKU is already used.';
    }
    if (product.price <= 0) errors.prodPrice = 'Price must be greater than zero.';
    if (product.compareAt && product.compareAt <= product.price) {
      errors.prodCompare = 'Compare-at price must be higher than price.';
    }
    if (product.stock < 0) errors.prodStock = 'Stock cannot be negative.';
    if (!product.imageUrl) {
      errors.prodImageUrl = 'Upload a product photo to Google Drive or enter an approved HTTPS image URL.';
    } else if (!/^https:\/\//i.test(product.imageUrl)) {
      errors.prodImageUrl = 'Product image URLs must use HTTPS.';
    }
    Object.entries(errors).forEach(([field, message]) => setFieldError(field, message));
    return Object.keys(errors).length === 0;
  }

  function updateCategoryOptions() {
    const categories = [...new Set(productsCache.map((product) => product.category).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    $('#categoryOptions').innerHTML = categories
      .map((category) => `<option value="${escapeHtml(category)}"></option>`)
      .join('');
  }

  function updateImageOptions() {
    $('#imageIdOptions').innerHTML = catalogImageIds()
      .map((id) => `<option value="${escapeHtml(id)}"></option>`)
      .join('');
  }

  function resetForm() {
    suppressDirty = true;
    $('#productForm').reset();
    $('#prodId').value = '';
    $('#prodSlug').value = '';
    $('#prodStock').value = 10;
    $('#prodSortOrder').value = nextSortOrder();
    $('#prodStatus').value = 'published';
    pendingDriveImage = null;
    $('#prodImageId').value = '';
    $('#prodImageUrl').value = '';
    $('#prodImage').value = '';
    $('#prodImageVersion').value = '';
    $('#prodImageMeta').value = '';
    $('#prodDriveFileId').value = '';
    $('#prodImageProvider').value = '';
    $('#imageOptimizationResult').hidden = true;
    clearOptimizedPreview();
    setSelectedSizes(['One size']);
    setColorRows([]);
    clearProductErrors();
    setFormStatus('productFormStatus', '');
    $('#formTitle').textContent = 'Add a product';
    $('#formSubmit').textContent = 'Add product';
    void updateProductPreview();
    suppressDirty = false;
    clearFormDirty();
  }

  function nextSortOrder() {
    const max = Math.max(0, ...productsCache.map((product) => Number(product.sortOrder) || 0));
    return max + 1;
  }

  function loadIntoForm(id) {
    const product = getProducts().find((item) => item.id === id);
    if (!product) return;
    if (!confirmDiscardIfDirty('Discard unsaved changes and edit this product?')) return;
    suppressDirty = true;
    clearOptimizedPreview();
    setFormStatus('productFormStatus', '');
    $('#prodId').value = product.id;
    $('#prodSlug').value = product.slug || product.id;
    $('#prodName').value = product.name;
    $('#prodCategory').value = product.category;
    $('#prodBadge').value = product.badge;
    $('#prodSku').value = product.sku;
    $('#prodStatus').value = product.active ? 'published' : 'draft';
    $('#prodFeatured').checked = product.featured;
    $('#prodSortOrder').value = product.sortOrder || '';
    $('#prodDesc').value = product.description;
    $('#prodPrice').value = product.price;
    $('#prodCompare').value = product.compareAt || '';
    $('#prodStock').value = product.stock;
    $('#prodTags').value = product.tags.join(', ');
    pendingDriveImage = null;
    $('#prodImageId').value = product.imageUrl ? '' : (product.imageId || '');
    $('#prodImageUrl').value = product.imageUrl || '';
    $('#prodImage').value = product.imageUrl || product.imageId || product.image;
    $('#prodImageVersion').value = product.imageVersion || '';
    $('#prodImageMeta').value = product.imageMeta ? JSON.stringify(product.imageMeta) : '';
    $('#prodDriveFileId').value = product.driveFileId || product.imageMeta?.driveFileId || '';
    $('#prodImageProvider').value = product.imageProvider || (product.imageUrl ? 'external' : 'local_legacy');
    setSelectedSizes(product.sizes);
    setColorRows(product.colors);
    $('#prodMaterial').value = product.material;
    $('#prodFit').value = product.fit;
    $('#prodCare').value = product.care;
    $('#formTitle').textContent = 'Edit product';
    $('#formSubmit').textContent = 'Save changes';
    void updateProductPreview();
    suppressDirty = false;
    clearFormDirty();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleProductSubmit(event) {
    event.preventDefault();
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const id = slugify($('#prodSlug').value || $('#prodId').value || $('#prodName').value);
    const imageUrl = $('#prodImageUrl').value.trim();
    const imageId = imageUrl ? '' : $('#prodImageId').value.trim();
    const driveFileId = $('#prodDriveFileId').value.trim();
    const imageProvider = $('#prodImageProvider').value.trim()
      || (driveFileId ? 'google_drive' : imageUrl ? 'external' : 'local_legacy');
    const existing = productsCache.find((product) => product.id === $('#prodId').value);
    const product = normalizeProduct({
      id,
      slug: id,
      sku: $('#prodSku').value.trim(),
      name: $('#prodName').value.trim(),
      category: $('#prodCategory').value.trim(),
      badge: $('#prodBadge').value.trim(),
      active: $('#prodStatus').value === 'published',
      featured: $('#prodFeatured').checked,
      sortOrder: Number($('#prodSortOrder').value) || nextSortOrder(),
      description: $('#prodDesc').value.trim(),
      price: Number($('#prodPrice').value) || 0,
      compareAt: Number($('#prodCompare').value) || 0,
      stock: Number.parseInt($('#prodStock').value, 10) || 0,
      tags: splitList($('#prodTags').value),
      image: imageUrl || imageId,
      imageId,
      imageUrl,
      imageProvider,
      driveFileId,
      imageVersion: $('#prodImageVersion').value,
      imageMeta: parseImageMeta(),
      sizes: selectedSizes(),
      colors: parseColors($('#prodColors').value),
      material: $('#prodMaterial').value.trim(),
      fit: $('#prodFit').value.trim(),
      care: $('#prodCare').value.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
    });

    if (!validateProduct(id, product)) {
      setFormStatus('productFormStatus', 'Fix the highlighted fields and try again.', 'error');
      toast('Fix the highlighted product fields');
      return;
    }

    if (savingProduct) return; // double-submit guard
    savingProduct = true;
    const submitButton = $('#formSubmit');
    const originalText = submitButton.textContent;
    setButtonLoading(submitButton, true, 'Saving...');
    setFormStatus('productFormStatus', 'Saving product...', 'info');
    try {
      await upsertProduct(product);
      await renderProductList();
      renderMetrics();
      updateCategoryOptions();
      clearDraft();
      resetForm();
      setButtonLoading(submitButton, false);
      setFormStatus('productFormStatus', existing ? 'Product updated and synced.' : 'Product added and synced.', 'success');
      toast(existing ? 'Product updated' : 'Product added');
    } catch (error) {
      setButtonLoading(submitButton, false);
      submitButton.textContent = originalText;
      setFormStatus('productFormStatus', error.message || 'Could not save product.', 'error');
      toast(error.message || 'Could not save product');
    } finally {
      savingProduct = false;
    }
  }

  function parseImageMeta() {
    try {
      return JSON.parse($('#prodImageMeta').value || 'null');
    } catch {
      return null;
    }
  }

  async function deleteProduct(id) {
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const product = productsCache.find((item) => item.id === id);
    const name = product?.name || id;
    if (!window.confirm(`Delete "${name}" permanently? This removes it from the public storefront too.`)) return;
    try {
      await removeProduct(id);
      await renderProductList();
      renderMetrics();
      if ($('#prodId').value === id) resetForm();
      toast('Product deleted');
    } catch (error) {
      toast(error.message || 'Could not delete product');
    }
  }

  function productMatchesFilters(product) {
    const query = norm($('#productSearch')?.value || '');
    const stock = $('#stockFilter')?.value || '';
    const imageFilter = $('#imageMigrationFilter')?.value || '';
    const haystack = norm([product.name, product.sku, product.category, product.tags?.join(' ')].join(' '));
    return (!query || haystack.includes(query))
      && (!stock || (stock === 'low' && product.stock > 0 && product.stock <= LOW_STOCK_AT)
        || (stock === 'out' && product.stock <= 0))
      && (!imageFilter || (imageFilter === 'needs-image' && productNeedsImageMigration(product)));
  }

  function productSortKey() {
    return $('#productSort')?.value || 'sortOrder';
  }

  // Drag reorder is only meaningful (and unambiguous) in the unfiltered sortOrder view.
  function reorderEnabled() {
    return productSortKey() === 'sortOrder'
      && !norm($('#productSearch')?.value || '')
      && !($('#stockFilter')?.value)
      && !($('#imageMigrationFilter')?.value);
  }

  async function renderProductList() {
    const comparator = CORE.compareProducts
      ? CORE.compareProducts(productSortKey())
      : (left, right) => (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0) || left.name.localeCompare(right.name);
    const products = getProducts().filter(productMatchesFilters).sort(comparator);

    // Keep the selection set in sync with products that still exist.
    const existingIds = new Set(getProducts().map((product) => product.id));
    [...selectedProductIds].forEach((id) => { if (!existingIds.has(id)) selectedProductIds.delete(id); });

    const imageUrls = await Promise.all(products.map((product) => (
      BACKEND
        ? BACKEND.media.resolveImage(product.imageUrl || product.imageId || product.image, product.imageVersion)
        : Promise.resolve(imageSrc(product.imageUrl || product.imageId || product.image))
    )));
    const canReorder = reorderEnabled();
    $('#catalogCount').textContent = productsCache.length;
    $('#productList').innerHTML = products.length
      ? products.map((product, index) => {
        const stockClass = product.stock <= 0 ? 'out' : product.stock <= LOW_STOCK_AT ? 'low' : 'ok';
        const selected = selectedProductIds.has(product.id);
        return `
          <article class="product-row${selected ? ' is-selected' : ''}" data-product-id="${escapeHtml(product.id)}"${canReorder ? ' draggable="true"' : ''}>
            <div class="row-lead">
              <label class="row-select">
                <input type="checkbox" data-select="${escapeHtml(product.id)}"${selected ? ' checked' : ''} aria-label="Select ${escapeHtml(product.name)}" />
              </label>
              ${canReorder ? '<span class="drag-handle" aria-hidden="true" title="Drag to reorder">::</span>' : ''}
            </div>
            <img src="${escapeHtml(imageUrls[index])}" alt="" />
            <div class="product-row-info">
              <div class="product-row-title">
                <strong>${escapeHtml(product.name)}</strong>
                <span class="status-pill ${product.active ? 'published' : 'draft'}">${product.active ? 'Published' : 'Draft'}</span>
                <span class="stock-pill ${stockClass}">${product.stock <= 0 ? 'Out of stock' : product.stock <= LOW_STOCK_AT ? 'Low stock' : 'In stock'}</span>
              </div>
              <p>${escapeHtml(product.category)}${product.sku ? ` - ${escapeHtml(product.sku)}` : ''}</p>
              <div class="product-row-inline">
                <label class="inline-edit">Price <input type="number" min="0" step="0.01" data-quick-price="${escapeHtml(product.id)}" value="${Number(product.price) || 0}" /></label>
                <label class="inline-edit">Stock <input type="number" min="0" step="1" data-quick-stock="${escapeHtml(product.id)}" value="${Number(product.stock) || 0}" /></label>
                <span>Sort ${Number(product.sortOrder) || 0}</span>
                ${productNeedsImageMigration(product) ? '<span>Needs image migration</span>' : ''}
                ${product.featured ? '<span>Featured</span>' : ''}
              </div>
            </div>
            <div class="product-row-actions">
              <button class="btn btn-secondary" data-edit="${escapeHtml(product.id)}">Edit</button>
              <button class="btn btn-ghost danger-button" data-delete="${escapeHtml(product.id)}">Delete</button>
            </div>
          </article>
        `;
      }).join('')
      : '<div class="empty-state-admin"><strong>No products found</strong><p>Try clearing filters or add a new product.</p></div>';

    $$('#productList img').forEach((image) => {
      image.addEventListener('error', () => {
        image.src = '../assets/logo.svg';
      }, { once: true });
    });
    $$('[data-edit]').forEach((button) => {
      button.addEventListener('click', () => loadIntoForm(button.dataset.edit));
    });
    $$('[data-delete]').forEach((button) => {
      button.addEventListener('click', () => void deleteProduct(button.dataset.delete));
    });
    $$('#productList [data-select]').forEach((box) => {
      box.addEventListener('change', () => {
        if (box.checked) selectedProductIds.add(box.dataset.select);
        else selectedProductIds.delete(box.dataset.select);
        box.closest('.product-row')?.classList.toggle('is-selected', box.checked);
        updateBulkBar();
      });
    });
    $$('[data-quick-price]').forEach((input) => {
      input.addEventListener('change', () => void quickEditProduct(input.dataset.quickPrice, 'price', input.value));
    });
    $$('[data-quick-stock]').forEach((input) => {
      input.addEventListener('change', () => void quickEditProduct(input.dataset.quickStock, 'stock', input.value));
    });
    if (canReorder) bindReorder();
    updateBulkBar();
  }

  function updateBulkBar() {
    const bar = $('#bulkBar');
    if (!bar) return;
    const count = selectedProductIds.size;
    bar.hidden = count === 0;
    const countLabel = $('#bulkCount');
    if (countLabel) countLabel.textContent = count;
    const visible = $$('#productList [data-select]');
    const selectAll = $('#bulkSelectAll');
    if (selectAll) selectAll.checked = visible.length > 0 && visible.every((box) => box.checked);
  }

  function toggleSelectAll(checked) {
    $$('#productList [data-select]').forEach((box) => {
      box.checked = checked;
      if (checked) selectedProductIds.add(box.dataset.select);
      else selectedProductIds.delete(box.dataset.select);
      box.closest('.product-row')?.classList.toggle('is-selected', checked);
    });
    updateBulkBar();
  }

  function clearSelection() {
    selectedProductIds.clear();
    $$('#productList [data-select]').forEach((box) => {
      box.checked = false;
      box.closest('.product-row')?.classList.remove('is-selected');
    });
    updateBulkBar();
  }

  // Optimistic inline edit of price/stock; re-syncs from the backend on failure.
  async function quickEditProduct(id, field, rawValue) {
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const product = productsCache.find((item) => item.id === id);
    if (!product) return;
    const value = Math.max(0, Number(rawValue) || 0);
    if (Number(product[field]) === value) return;
    const updated = { ...product, [field]: value };
    product[field] = value;
    try {
      await upsertProduct(updated);
      renderMetrics();
      toast(`${field === 'price' ? 'Price' : 'Stock'} updated`);
    } catch (error) {
      await loadProducts();
      await renderProductList();
      toast(error.message || 'Could not update product');
    }
  }

  async function runBulkAction(action) {
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const ids = [...selectedProductIds];
    if (!ids.length) return;
    let stockValue = null;
    if (action === 'stock') {
      const input = window.prompt('Set stock for the selected products to:', '0');
      if (input === null) return;
      stockValue = Math.max(0, Number(input) || 0);
    }
    if (action === 'delete' && !window.confirm(`Delete ${ids.length} selected product(s) permanently?`)) return;
    try {
      for (const id of ids) {
        const product = productsCache.find((item) => item.id === id);
        if (!product) continue;
        if (action === 'delete') {
          await removeProduct(id);
          continue;
        }
        const updated = { ...product };
        if (action === 'publish') updated.active = true;
        if (action === 'unpublish') updated.active = false;
        if (action === 'stock') updated.stock = stockValue;
        await upsertProduct(updated);
      }
      selectedProductIds.clear();
      await loadProducts();
      await renderProductList();
      renderMetrics();
      updateCategoryOptions();
      toast(`Bulk ${action} applied to ${ids.length} product(s)`);
    } catch (error) {
      await loadProducts();
      await renderProductList();
      toast(error.message || 'Bulk action failed');
    }
  }

  let dragSourceId = '';
  function bindReorder() {
    $$('#productList .product-row[draggable="true"]').forEach((row) => {
      row.addEventListener('dragstart', (event) => {
        dragSourceId = row.dataset.productId;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        try {
          event.dataTransfer.setData('text/plain', dragSourceId);
        } catch {
          /* some browsers restrict setData */
        }
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (event) => {
        event.preventDefault();
        row.classList.remove('drag-over');
        const targetId = row.dataset.productId;
        if (dragSourceId && targetId && dragSourceId !== targetId) void reorderProducts(dragSourceId, targetId);
      });
    });
  }

  async function reorderProducts(sourceId, targetId) {
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const sortOrderComparator = CORE.compareProducts
      ? CORE.compareProducts('sortOrder')
      : (a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    const ordered = [...productsCache].sort(sortOrderComparator);
    const from = ordered.findIndex((item) => item.id === sourceId);
    const to = ordered.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    const changed = [];
    ordered.forEach((item, index) => {
      const newOrder = (index + 1) * 10;
      if (Number(item.sortOrder) !== newOrder) {
        item.sortOrder = newOrder;
        changed.push({ ...item });
      }
    });
    try {
      for (const item of changed) await upsertProduct(item);
      await loadProducts();
      await renderProductList();
      toast('Product order updated');
    } catch (error) {
      await loadProducts();
      await renderProductList();
      toast(error.message || 'Could not reorder products');
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showImageResult(metadata) {
    const result = $('#imageOptimizationResult');
    if (!metadata) {
      result.hidden = true;
      result.textContent = '';
      return;
    }
    const hasDimensions = metadata.width && metadata.height;
    const reduction = metadata.originalBytes
      ? Math.max(0, Math.round((1 - (metadata.byteSize || metadata.bytes) / metadata.originalBytes) * 100))
      : 0;
    result.hidden = false;
    result.innerHTML = `
      <strong>${escapeHtml(metadata.status || 'Optimized image ready')}</strong>
      ${hasDimensions ? `<span>${metadata.width} x ${metadata.height} - ${formatBytes(metadata.byteSize || metadata.bytes)}${
        metadata.originalBytes ? ` - ${reduction}% smaller` : ''
      }</span>` : ''}
      ${metadata.publicUrl ? `<small>${escapeHtml(metadata.publicUrl)}</small>` : ''}
    `;
  }

  function showOptimizedPreview(blob) {
    const row = $('#imagePreviewRow');
    const image = $('#imageOptimizedPreview');
    if (!row || !image || !blob) return;
    if (optimizedPreviewUrl) URL.revokeObjectURL(optimizedPreviewUrl);
    optimizedPreviewUrl = URL.createObjectURL(blob);
    image.src = optimizedPreviewUrl;
    row.hidden = false;
  }

  function clearOptimizedPreview() {
    if (optimizedPreviewUrl) {
      URL.revokeObjectURL(optimizedPreviewUrl);
      optimizedPreviewUrl = '';
    }
    const row = $('#imagePreviewRow');
    if (row) row.hidden = true;
  }

  function imageOptimizationOptions() {
    const presets = {
      compact: { longEdge: 1400, quality: 0.78, targetBytes: 260 * 1024 },
      balanced: { longEdge: 1600, quality: 0.82, targetBytes: 300 * 1024 },
      detail: { longEdge: 1800, quality: 0.86, targetBytes: 500 * 1024 },
    };
    return presets[$('#imageOptimization').value] || presets.balanced;
  }

  function setDriveStatus(message, detail = '') {
    $('#driveStatus').textContent = message;
    $('#driveStatusDetail').textContent = detail;
  }

  function refreshDrivePanel() {
    const drive = window.PaviaDriveImages;
    const button = $('#driveConnectBtn');
    if (!drive?.configured?.()) {
      setDriveStatus('Google Drive not configured', 'Add the OAuth client ID and Drive folder ID in js/backend-config.js.');
      button.disabled = true;
      return;
    }
    button.disabled = false;
    setDriveStatus(
      drive.accessToken?.() ? 'Google Drive connected' : 'Google Drive not connected',
      drive.accessToken?.()
        ? 'The access token is in memory only and is forgotten on lock, sign-out, or reload.'
        : 'Click Connect Google Drive to authorize image uploads.',
    );
  }

  async function connectDrive() {
    const drive = window.PaviaDriveImages;
    if (!drive) {
      toast('Google Drive tools are unavailable');
      return;
    }
    try {
      $('#driveConnectBtn').disabled = true;
      setDriveStatus('Connecting Google Drive...', 'Approve the Google permission popup to allow uploads to your folder.');
      await drive.connect();
      refreshDrivePanel();
      toast('Google Drive connected');
    } catch (error) {
      refreshDrivePanel();
      toast(error.message || 'Google Drive connection failed');
    }
  }

  async function handleImageUpload(file) {
    if (!file) return;
    const drive = window.PaviaDriveImages;
    if (!drive) {
      toast('Google Drive tools are unavailable');
      return;
    }
    const dropzone = $('#imageDropzone');
    dropzone.classList.add('is-processing');
    showImageResult({ status: 'Optimizing image...' });
    try {
      const optimized = await drive.optimizeImage(file, imageOptimizationOptions());
      showOptimizedPreview(optimized.blob);
      showImageResult({ ...optimized.metadata, status: 'Optimized. Preparing upload...' });

      // Dedup: if the freshly optimized bytes match the image this product already
      // stores, skip the Drive upload entirely and reuse the existing public URL.
      const existingMeta = parseImageMeta();
      const currentUrl = $('#prodImageUrl').value.trim();
      if (currentUrl && CORE.shouldReuseImage?.(existingMeta?.contentHash, optimized.metadata.contentHash)) {
        showImageResult({ ...existingMeta, status: 'Identical image - reused the existing Drive file (no re-upload).' });
        markFormDirty();
        await updateProductPreview();
        toast('Same image - reused the existing Drive file');
        return;
      }

      if (!drive.accessToken?.()) await connectDrive();
      if (!drive.accessToken?.()) throw new Error('Connect Google Drive before uploading.');
      showImageResult({ ...optimized.metadata, status: 'Uploading to Google Drive...' });
      const uploaded = await drive.uploadOptimizedImage(optimized);
      pendingDriveImage = uploaded;
      $('#prodImageUrl').value = uploaded.imageUrl;
      $('#prodImageId').value = '';
      $('#prodImage').value = uploaded.imageUrl;
      $('#prodImageVersion').value = uploaded.imageVersion;
      $('#prodDriveFileId').value = uploaded.driveFileId;
      $('#prodImageProvider').value = uploaded.imageProvider;
      $('#prodImageMeta').value = JSON.stringify(uploaded.imageMeta);
      markFormDirty();
      showImageResult({ ...uploaded.imageMeta, status: 'Uploaded to Google Drive; image URL saved to the product' });
      await updateProductPreview();
      toast('Image uploaded to Google Drive');
    } catch (error) {
      if (pendingDriveImage?.imageUrl) {
        showImageResult({ ...pendingDriveImage.imageMeta, status: 'Drive image is ready; retry the product save' });
      } else {
        showImageResult(null);
      }
      toast(error.message || 'Could not process this image');
    } finally {
      dropzone.classList.remove('is-processing');
      $('#prodImageFile').value = '';
    }
  }

  async function updateProductPreview() {
    const name = $('#prodName').value.trim() || 'Product name';
    const category = $('#prodCategory').value.trim() || 'Category';
    const description = $('#prodDesc').value.trim() || 'Your product description will appear here.';
    const badge = $('#prodBadge').value.trim();
    const price = Number($('#prodPrice').value) || 0;
    const compareAt = Number($('#prodCompare').value) || 0;
    const status = $('#prodStatus').value;
    const imageRef = imageReferenceFromFields();

    $('#prodImage').value = imageRef;
    $('#productPreviewName').textContent = name;
    $('#productPreviewCategory').textContent = category;
    $('#productPreviewDescription').textContent = description;
    $('#productPreviewPrice').textContent = fmt(price);
    $('#productPreviewCompare').hidden = !(compareAt > price);
    $('#productPreviewCompare').textContent = fmt(compareAt);
    $('#productPreviewBadge').hidden = !badge;
    $('#productPreviewBadge').textContent = badge;
    $('#productPreviewStatus').textContent = status === 'published' ? 'Published' : 'Draft';
    $('#productPreviewStatus').className = `status-pill ${status}`;
    $('#productPreviewImage').src = BACKEND
      ? await BACKEND.media.resolveImage(imageRef, $('#prodImageVersion').value)
      : imageSrc(imageRef);
    $('#productPreviewImage').alt = name;
  }

  function fillSettingsForm() {
    $('#settingSiteTitle').value = settingsCache.siteTitle || settingsCache.siteName || 'Pavia Lebanon';
    $('#settingPhoneDisplay').value = settingsCache.phoneDisplay || '';
    $('#settingPhoneNumber').value = settingsCache.phoneNumber || '';
    $('#settingWhatsapp').value = settingsCache.whatsappNumber || '';
    $('#settingInstagramHandle').value = settingsCache.instagramHandle || '';
    $('#settingInstagramUrl').value = settingsCache.instagramUrl || '';
    $('#settingLocation').value = settingsCache.location || '';
    $('#settingDeliveryArea').value = settingsCache.deliveryArea || '';
    $('#settingDeliveryBeirut').value = Number(settingsCache.deliveryBeirut) || 0;
    $('#settingDeliveryLebanon').value = Number(settingsCache.deliveryLebanon) || 0;
    $('#settingFreeDeliveryAt').value = Number(settingsCache.freeDeliveryAt) || 0;
    $('#settingCheckoutEnabled').checked = settingsCache.checkoutEnabled !== false;
    $('#settingWhatsappCheckout').checked = settingsCache.whatsappCheckoutEnabled !== false;
    $('#settingCash').checked = settingsCache.paymentMethods?.cash_on_delivery !== false;
    $('#settingWhish').checked = settingsCache.paymentMethods?.whish_money !== false;
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();
    if (!adminMutationsEnabled()) {
      toast('Settings editing is disabled for this session');
      return;
    }
    const record = {
      ...settingsCache,
      siteName: 'Pavia',
      siteTitle: $('#settingSiteTitle').value.trim() || 'Pavia Lebanon',
      phoneDisplay: $('#settingPhoneDisplay').value.trim(),
      phoneNumber: $('#settingPhoneNumber').value.trim(),
      whatsappNumber: $('#settingWhatsapp').value.trim(),
      instagramHandle: $('#settingInstagramHandle').value.trim(),
      instagramUrl: $('#settingInstagramUrl').value.trim(),
      location: $('#settingLocation').value.trim(),
      deliveryArea: $('#settingDeliveryArea').value.trim(),
      currency: 'USD',
      deliveryBeirut: Number($('#settingDeliveryBeirut').value) || 0,
      deliveryLebanon: Number($('#settingDeliveryLebanon').value) || 0,
      freeDeliveryAt: Number($('#settingFreeDeliveryAt').value) || 0,
      checkoutEnabled: $('#settingCheckoutEnabled').checked,
      whatsappCheckoutEnabled: $('#settingWhatsappCheckout').checked,
      paymentMethods: {
        cash_on_delivery: $('#settingCash').checked,
        whish_money: $('#settingWhish').checked,
      },
    };
    if (savingSettings) return;
    savingSettings = true;
    const button = event.submitter || $('#settingsForm button[type="submit"]');
    setButtonLoading(button, true, 'Saving...');
    try {
      settingsCache = BACKEND?.settings?.update
        ? await BACKEND.settings.update(record)
        : record;
      if (!BACKEND?.settings?.update) writeLS(KEYS.settings, settingsCache);
      fillSettingsForm();
      toast('Settings saved');
    } catch (error) {
      toast(error.message || 'Could not save settings');
    } finally {
      savingSettings = false;
      setButtonLoading(button, false, 'Save settings');
    }
  }

  function resetPromoForm() {
    $('#promoForm').reset();
    $('#promoOriginalCode').value = '';
    $('#promoActive').checked = true;
    $('#promoSubmit').textContent = 'Save promo';
    clearProductErrors();
  }

  function promoRows() {
    return Object.values(promoCache || {}).sort((left, right) => String(left.code).localeCompare(String(right.code)));
  }

  function renderPromos() {
    const promos = promoRows();
    $('#promoList').innerHTML = promos.length
      ? promos.map((promo) => `
        <article class="product-row promo-row">
          <div class="promo-code">${escapeHtml(promo.code)}</div>
          <div class="product-row-info">
            <div class="product-row-title">
              <strong>${escapeHtml(promo.label || promo.code)}</strong>
              <span class="status-pill ${promo.active !== false ? 'published' : 'draft'}">${promo.active !== false ? 'Active' : 'Inactive'}</span>
            </div>
            <p>${escapeHtml(promo.type)} - ${Number(promo.value) || 0}${promo.type === 'percent' ? '%' : ''} - min ${fmt(promo.minSubtotal)}</p>
            <div class="product-row-meta">
              <span>Used ${Number(promo.usageCount) || 0}${promo.usageLimit ? ` / ${promo.usageLimit}` : ''}</span>
              ${promo.startsAt ? `<span>Starts ${escapeHtml(promo.startsAt)}</span>` : ''}
              ${promo.endsAt ? `<span>Ends ${escapeHtml(promo.endsAt)}</span>` : ''}
            </div>
          </div>
          <div class="product-row-actions">
            <button class="btn btn-secondary" data-edit-promo="${escapeHtml(promo.code)}">Edit</button>
            <button class="btn btn-ghost danger-button" data-delete-promo="${escapeHtml(promo.code)}">Delete</button>
          </div>
        </article>
      `).join('')
      : '<div class="empty-state-admin"><strong>No promo codes</strong><p>Create a code to expose it to the storefront.</p></div>';
    $$('[data-edit-promo]').forEach((button) => {
      button.addEventListener('click', () => loadPromoIntoForm(button.dataset.editPromo));
    });
    $$('[data-delete-promo]').forEach((button) => {
      button.addEventListener('click', () => void deletePromo(button.dataset.deletePromo));
    });
  }

  function loadPromoIntoForm(code) {
    const promo = promoCache[code];
    if (!promo) return;
    $('#promoOriginalCode').value = promo.code;
    $('#promoCode').value = promo.code;
    $('#promoLabel').value = promo.label || '';
    $('#promoType').value = promo.type || 'percent';
    $('#promoValue').value = Number(promo.value) || 0;
    $('#promoMinSubtotal').value = Number(promo.minSubtotal) || 0;
    $('#promoUsageLimit').value = Number(promo.usageLimit) || 0;
    $('#promoStartsAt').value = promo.startsAt || '';
    $('#promoEndsAt').value = promo.endsAt || '';
    $('#promoActive').checked = promo.active !== false;
    $('#promoSubmit').textContent = 'Update promo';
  }

  async function handlePromoSubmit(event) {
    event.preventDefault();
    if (!adminMutationsEnabled()) {
      toast('Promo editing is disabled for this session');
      return;
    }
    clearProductErrors();
    const originalCode = $('#promoOriginalCode').value.trim().toUpperCase();
    const code = $('#promoCode').value.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
      setFieldError('promoCode', 'Use 3-24 letters, numbers, underscores, or hyphens.');
      return;
    }
    if (!originalCode && promoCache[code]) {
      setFieldError('promoCode', 'This promo code already exists.');
      return;
    }
    const promo = {
      ...(promoCache[originalCode || code] || {}),
      code,
      label: $('#promoLabel').value.trim() || code,
      type: $('#promoType').value,
      value: Number($('#promoValue').value) || 0,
      minSubtotal: Number($('#promoMinSubtotal').value) || 0,
      usageLimit: Number($('#promoUsageLimit').value) || 0,
      startsAt: $('#promoStartsAt').value,
      endsAt: $('#promoEndsAt').value,
      active: $('#promoActive').checked,
    };
    if (savingPromo) return;
    savingPromo = true;
    const button = $('#promoSubmit');
    const originalText = button.textContent;
    setButtonLoading(button, true, 'Saving...');
    try {
      if (originalCode && originalCode !== code && BACKEND?.promoCodes?.remove) {
        await BACKEND.promoCodes.remove(originalCode);
      }
      const saved = BACKEND?.promoCodes?.upsert
        ? await BACKEND.promoCodes.upsert(code, promo)
        : promo;
      promoCache[code] = saved;
      if (originalCode && originalCode !== code) delete promoCache[originalCode];
      if (!BACKEND?.promoCodes?.upsert) writeLS(KEYS.promoCodes, promoCache);
      renderPromos();
      resetPromoForm();
      setButtonLoading(button, false);
      toast('Promo saved');
    } catch (error) {
      setButtonLoading(button, false);
      button.textContent = originalText;
      toast(error.message || 'Could not save promo');
    } finally {
      savingPromo = false;
    }
  }

  async function deletePromo(code) {
    if (!adminMutationsEnabled()) {
      toast('Promo editing is disabled for this session');
      return;
    }
    if (!window.confirm(`Delete promo code "${code}"?`)) return;
    try {
      if (BACKEND?.promoCodes?.remove) await BACKEND.promoCodes.remove(code);
      delete promoCache[code];
      if (!BACKEND?.promoCodes?.remove) writeLS(KEYS.promoCodes, promoCache);
      renderPromos();
      resetPromoForm();
      toast('Promo deleted');
    } catch (error) {
      toast(error.message || 'Could not delete promo');
    }
  }

  function setupTabs() {
    $$('.admin-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        $$('.admin-tab').forEach((item) => item.classList.toggle('active', item === tab));
        $$('.admin-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.panel === target);
        });
        if (target === 'dashboard') { renderMetrics(); renderVisitorMetrics(); }
        if (target === 'orders') renderOrders();
        if (target === 'products') void renderProductList();
        if (target === 'promos') renderPromos();
      });
    });
  }

  function setupProductPreview() {
    [
      '#prodName',
      '#prodCategory',
      '#prodBadge',
      '#prodDesc',
      '#prodPrice',
      '#prodCompare',
      '#prodImageId',
      '#prodImageUrl',
      '#prodStatus',
    ].forEach((selector) => {
      $(selector).addEventListener('input', () => void updateProductPreview());
      $(selector).addEventListener('change', () => void updateProductPreview());
    });
    $('#prodName').addEventListener('input', () => {
      if (!$('#prodId').value && !$('#prodSlug').value.trim()) {
        $('#prodSlug').value = slugify($('#prodName').value);
      }
    });
    $('#productPreviewImage').addEventListener('error', (event) => {
      event.currentTarget.src = '../assets/logo.svg';
    });
  }

  function setupVariantBuilders() {
    $$('[data-size-option]').forEach((button) => {
      button.addEventListener('click', () => togglePresetSize(button.dataset.sizeOption));
    });
    $('#addCustomSize').addEventListener('click', addCustomSize);
    $('#customSize').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addCustomSize();
    });
    $('#addColor').addEventListener('click', () => addColorRow());
  }

  function setupImageUploader() {
    refreshDrivePanel();
    $('#driveConnectBtn').addEventListener('click', () => void connectDrive());
    $('#prodImageFile').addEventListener('change', (event) => {
      void handleImageUpload(event.target.files?.[0]);
    });
    $('#imageDropzone').addEventListener('dragover', (event) => {
      event.preventDefault();
      event.currentTarget.classList.add('is-dragging');
    });
    $('#imageDropzone').addEventListener('dragleave', (event) => {
      event.currentTarget.classList.remove('is-dragging');
    });
    $('#imageDropzone').addEventListener('drop', (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove('is-dragging');
      void handleImageUpload(event.dataTransfer.files?.[0]);
    });
  }

  function setupFilters() {
    ['#orderSearch', '#orderStatusFilter', '#paymentStatusFilter', '#orderDateFilter', '#orderSort'].forEach((selector) => {
      $(selector).addEventListener('input', renderOrders);
      $(selector).addEventListener('change', renderOrders);
    });
    ['#productSearch', '#stockFilter', '#imageMigrationFilter', '#productSort'].forEach((selector) => {
      $(selector).addEventListener('input', () => void renderProductList());
      $(selector).addEventListener('change', () => void renderProductList());
    });
  }

  function setupAdminUx() {
    // Bulk actions
    $('#bulkSelectAll')?.addEventListener('change', (event) => toggleSelectAll(event.target.checked));
    $('#bulkClear')?.addEventListener('click', clearSelection);
    $$('[data-bulk]').forEach((button) => {
      button.addEventListener('click', () => void runBulkAction(button.dataset.bulk));
    });

    // Unsaved-changes draft restore/discard
    $('#draftRestore')?.addEventListener('click', () => {
      const draft = readLS(DRAFT_KEY, null);
      if (draft) applyDraft(draft);
      $('#draftBanner').hidden = true;
      $('[data-tab="products"]')?.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('#draftDiscard')?.addEventListener('click', clearDraft);

    // Dirty tracking on the product form (programmatic fills are suppressed).
    const form = $('#productForm');
    form.addEventListener('input', markFormDirty);
    form.addEventListener('change', markFormDirty);

    // Warn before reload / navigation / tab close when there are unsaved edits.
    window.addEventListener('beforeunload', (event) => {
      if (!formDirty) return;
      event.preventDefault();
      event.returnValue = '';
    });

    // Keyboard shortcuts: Ctrl/Cmd+S saves the active form, Esc clears the product form.
    document.addEventListener('keydown', (event) => {
      const activePanel = $('.admin-panel.active')?.dataset.panel;
      if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        if (activePanel === 'products') { event.preventDefault(); $('#productForm').requestSubmit(); }
        else if (activePanel === 'settings') { event.preventDefault(); $('#settingsForm').requestSubmit(); }
        else if (activePanel === 'promos') { event.preventDefault(); $('#promoForm').requestSubmit(); }
      }
      if (event.key === 'Escape' && activePanel === 'products') {
        if (confirmDiscardIfDirty('Discard unsaved product changes?')) resetForm();
      }
    });

    maybeShowDraftBanner();
  }

  async function refreshAll() {
    await Promise.all([loadOrders(), loadProducts(), loadSettings(), loadPromos(), loadStatistics()]);
    updateCategoryOptions();
    updateImageOptions();
    fillSettingsForm();
    renderMetrics();
    renderVisitorMetrics();
    renderOrders();
    await renderProductList();
    renderPromos();
    await updateProductPreview();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (BACKEND) {
      await BACKEND.init({ defaultProducts: window.PAVIA_DEFAULT_PRODUCTS || [] });
      BACKEND.orders.subscribe(async () => {
        await loadOrders();
        renderOrders();
        renderMetrics();
      });
      BACKEND.products.subscribe(async () => {
        await loadProducts();
        updateCategoryOptions();
        await renderProductList();
        renderMetrics();
      });
      BACKEND.settings?.subscribe?.(async () => {
        await loadSettings();
        fillSettingsForm();
      });
      BACKEND.promoCodes?.subscribe?.(async () => {
        await loadPromos();
        renderPromos();
      });
      BACKEND.analytics?.subscribeStatistics?.(async () => {
        await loadStatistics();
        renderVisitorMetrics();
      });
    }
    await refreshAll();
    applyBackendCapabilities();
    $('#logoutBtn').addEventListener('click', () => {
      if (!confirmDiscardIfDirty('You have unsaved product changes (saved as a recoverable draft). Lock the studio anyway?')) return;
      window.PaviaAdminShell?.lock?.('Locked. Enter the admin credentials again.');
    });
    $('#productForm').addEventListener('submit', handleProductSubmit);
    $('#formReset').addEventListener('click', () => {
      if (confirmDiscardIfDirty('Discard unsaved changes and start a new product?')) resetForm();
    });
    $('#formCancel').addEventListener('click', () => {
      if (confirmDiscardIfDirty('Discard unsaved changes?')) resetForm();
    });
    $('#settingsForm').addEventListener('submit', handleSettingsSubmit);
    $('#promoForm').addEventListener('submit', handlePromoSubmit);
    $('#promoReset').addEventListener('click', resetPromoForm);
    setupTabs();
    setupProductPreview();
    setupVariantBuilders();
    setupImageUploader();
    setupFilters();
    setupAdminUx();
    resetForm();
    resetPromoForm();
    $('#dashboard').hidden = false;
  });
})();
