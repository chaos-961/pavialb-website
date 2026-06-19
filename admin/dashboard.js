/* Pavia Studio admin dashboard.
 * Runs only after the Phase 04 dual gate decrypts this payload.
 */
(() => {
  'use strict';

  const KEYS = {
    products: 'PAVIA_PRODUCTS',
    orders: 'PAVIA_ORDERS',
    settings: 'PAVIA_SETTINGS',
  };
  const BACKEND = window.PaviaBackend;
  const LOW_STOCK_AT = 3;
  // Simplified order lifecycle (D3 / P1 1.3): pending -> completed (+ cancelled).
  const ORDER_STATUSES = ['pending', 'completed', 'cancelled'];
  const PAYMENT_STATUSES = ['pending', 'awaiting_confirmation', 'paid', 'failed', 'refunded'];
  const STATUS_LABELS = {
    pending: 'Pending',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  const PAYMENT_LABELS = {
    pending: 'Unpaid',
    awaiting_confirmation: 'Awaiting confirmation',
    paid: 'Paid',
    failed: 'Failed',
    refunded: 'Refunded',
  };
  const ORDERS_PAGE_SIZE = 12;
  const CATALOG_PAGE_SIZE = 20;

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
  let pendingDriveImage = null;

  // P15 UX state
  let formDirty = false;
  let suppressDirty = false;
  let savingProduct = false;
  let savingSettings = false;
  let draftTimer = 0;
  let optimizedPreviewUrl = '';
  const selectedProductIds = new Set();

  // P3 list paging / order view state
  let orderView = 'pending';
  let orderPage = 0;
  let catalogPage = 0;

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
    const value = norm(status || 'pending');
    if (value === 'completed') return 'completed';
    if (value === 'cancelled' || value === 'canceled') return 'cancelled';
    // Everything else (new/available/confirmed/preparing/out_for_delivery/…) is still open.
    return 'pending';
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
      imageUrl: $('#prodImageUrl').value,
      imageId: $('#prodImageId').value,
      imageVersion: $('#prodImageVersion').value,
      imageMeta: $('#prodImageMeta').value,
      driveFileId: $('#prodDriveFileId').value,
      imageProvider: $('#prodImageProvider').value,
      gallery: $('#prodGallery').value,
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
    $('#prodGallery').value = draft.gallery || '';
    loadGalleryFromProduct({ gallery: parseGalleryField() });
    setSelectedSizes(splitList(draft.sizes));
    setColorRows(parseColors(draft.colors));
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
    const name = String(draft.name || '').trim() || 'Untitled product';
    $('#draftBannerName').textContent = draft.id ? `Editing “${name}”` : name;
    const saved = new Date(draft.savedAt || Date.now());
    const time = $('#draftBannerTime');
    if (time) {
      time.textContent = `last edited ${relativeTime(saved.getTime())}`;
      time.title = saved.toLocaleString();
    }
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
      <p class="desc">Unlock must succeed before editing is enabled: the password unlocks this dashboard and signs in as the admin. Database rules grant writes only to the verified admin identity.</p>
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

  async function loadStatistics() {
    statsCache = BACKEND?.analytics?.readStatistics
      ? await BACKEND.analytics.readStatistics().catch(() => null)
      : null;
  }

  function relativeTime(timestamp) {
    const ts = Number(timestamp) || 0;
    if (!ts) return 'unknown';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function renderVisitorMetrics() {
    const grid = $('#visitorMetricsGrid');
    if (!grid) return;
    const stats = statsCache || { totalVisitors: 0, newToday: 0, activeNow: 0, active7d: 0, active30d: 0, sessions: 0, todaySessions: 0, events: [], recent: [] };
    grid.innerHTML = [
      ['Visitors', stats.totalVisitors, 'Unique anonymous visitors'],
      ['New today', stats.newToday, 'First-time visitors today'],
      ['Active now', stats.activeNow, 'Seen in the last 15 min'],
      ['Active 7 days', stats.active7d || 0, 'Unique in the last week'],
      ['Active 30 days', stats.active30d || 0, 'Unique in the last month'],
      ['Sessions', stats.sessions, `${stats.todaySessions} today`],
    ].map(([label, value, detail]) => `
      <article class="metric-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail)}</small>
      </article>
    `).join('');

    const events = $('#visitorEvents');
    if (events) {
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

    const recent = $('#recentVisitors');
    if (recent) {
      const rows = (stats.recent || []).filter((entry) => entry && entry.lastAt);
      recent.innerHTML = rows.length
        ? rows.map((entry) => {
            const visits = Number(entry.visitCount) || 0;
            return `
              <div class="compact-row">
                <div>
                  <strong>Visitor ${escapeHtml(String(entry.uid || '').slice(0, 6) || '—')}</strong>
                  <span>${escapeHtml(relativeTime(entry.lastAt))}</span>
                </div>
                <b>${escapeHtml(visits)} ${visits === 1 ? 'visit' : 'visits'}</b>
              </div>
            `;
          }).join('')
        : '<div class="empty-state-admin compact-empty"><strong>No visitors yet</strong><p>Anonymous sessions will appear here as people browse the store.</p></div>';
    }
  }

  function renderMetrics() {
    const pending = ordersCache.filter((order) => order.status === 'pending');
    const completed = ordersCache.filter((order) => order.status === 'completed');
    const today = todayKey();
    const todayOrders = ordersCache.filter((order) => todayKey(order.createdAt || order.date) === today);

    $('#metricsGrid').innerHTML = [
      ['Pending', pending.length, 'Orders awaiting action', 'pending'],
      ['Today', todayOrders.length, 'Placed today', ''],
      ['Completed', completed.length, 'Fulfilled to date', 'completed'],
      ['All orders', ordersCache.length, 'Total received', ''],
    ].map(([label, value, detail, tone]) => `
      <article class="metric-card${tone ? ` metric-${tone}` : ''}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
        <small>${escapeHtml(detail)}</small>
      </article>
    `).join('');

    const latest = $('#latestOrders');
    if (latest) {
      latest.innerHTML = ordersCache.length
        ? [...ordersCache]
          .sort((left, right) => new Date(right.createdAt || right.date || 0) - new Date(left.createdAt || left.date || 0))
          .slice(0, 6)
          .map((order) => {
            const customer = order.customer || {};
            return `
              <div class="compact-row">
                <div>
                  <strong>#${escapeHtml(order.orderNumber || order.id || '')}</strong>
                  <span>${escapeHtml(customer.name || 'Customer')} · <span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span></span>
                </div>
                <b>${fmt(order.total)}</b>
              </div>
            `;
          }).join('')
        : '<div class="empty-state-admin compact-empty"><strong>No orders yet</strong><p>New storefront orders will appear here.</p></div>';
    }
  }

  function orderMatchesView(order) {
    if (orderView === 'all') return true;
    return order.status === orderView;
  }

  function orderMatchesFilters(order) {
    const query = norm($('#orderSearch')?.value || '');
    const date = $('#orderDateFilter')?.value || '';
    const customer = order.customer || {};
    const haystack = norm([
      order.id,
      order.orderNumber,
      customer.name,
      customer.phone,
      customer.city,
      customer.area,
      order.status,
    ].join(' '));
    return orderMatchesView(order)
      && (!query || haystack.includes(query))
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
          <strong>${item.qty || 1} × ${fmt(item.price || 0)}</strong>
        </li>
      `;
    }).join('');
    const id = escapeHtml(order.id);
    const disabled = orderManagementEnabled() ? '' : ' disabled';
    const date = new Date(order.date || order.createdAt || Date.now()).toLocaleString();
    const timeline = [
      ['Placed', order.createdAt || order.date],
      ['Updated', order.updatedAt],
      ['Completed', order.completedAt],
      ['Cancelled', order.cancelledAt],
    ]
      .filter(([, value]) => value)
      .map(([label, value]) => `<li><span>${escapeHtml(label)}</span><time>${escapeHtml(new Date(value).toLocaleString())}</time></li>`)
      .join('');

    // One-click actions tuned to the current status.
    const quick = [];
    if (order.status !== 'completed') {
      quick.push(`<button class="btn btn-primary" data-quick-status="completed" data-order="${id}"${disabled}>Mark completed</button>`);
    }
    if (order.status === 'pending') {
      quick.push(`<button class="btn btn-ghost danger-button" data-quick-status="cancelled" data-order="${id}"${disabled}>Cancel order</button>`);
    }
    if (order.status !== 'pending') {
      quick.push(`<button class="btn btn-secondary" data-quick-status="pending" data-order="${id}"${disabled}>Reopen</button>`);
    }

    return `
      <article class="order-item status-${escapeHtml(order.status)}" data-order-id="${id}">
        <div class="order-topline">
          <div class="order-topline-id">
            <span class="order-id">#${escapeHtml(order.orderNumber || order.id || '')}</span>
            <span class="status-pill status-${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span>
            <time>${escapeHtml(date)}</time>
          </div>
          <strong class="order-total">${fmt(order.total)}</strong>
        </div>
        <div class="order-customer">
          <div><span>Customer</span><strong>${escapeHtml(customer.name || 'Customer')}</strong></div>
          <div><span>Phone</span><strong>${escapeHtml(phone || '—')}</strong></div>
          <div><span>Area</span><strong>${escapeHtml(customer.city || customer.area || '—')}</strong></div>
          <div><span>Payment</span><strong>${escapeHtml(customer.payment || order.paymentMethod || 'Cash on delivery')}</strong></div>
        </div>
        <p class="order-address">${escapeHtml(customer.address || 'No address supplied')}</p>
        ${customer.notes || order.notes ? `<p class="order-note"><strong>Customer notes:</strong> ${escapeHtml(customer.notes || order.notes)}</p>` : ''}
        ${order.cancellationReason ? `<p class="order-note"><strong>Cancelled:</strong> ${escapeHtml(order.cancellationReason)}</p>` : ''}
        ${order.adminNotes ? `<p class="order-note"><strong>Your notes:</strong> ${escapeHtml(order.adminNotes)}</p>` : ''}
        <ul class="order-products">${items}</ul>
        ${timeline ? `<ul class="order-timeline">${timeline}</ul>` : ''}
        <div class="order-actions">
          ${quick.join('')}
          ${callHref ? `<a class="btn btn-secondary" href="${escapeHtml(callHref)}">Call</a>` : ''}
          ${waHref ? `<a class="btn btn-secondary" href="${escapeHtml(waHref)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
          <button class="btn btn-ghost" data-print-order="${id}">Print</button>
          <button class="btn btn-ghost" data-export-order="${id}">Export</button>
        </div>
        <details class="order-manage">
          <summary>Manage details</summary>
          <div class="order-workflow">
            <label>
              Order status
              <select data-order-status${disabled}>${statusOptions(order.status, STATUS_LABELS)}</select>
            </label>
            <label>
              Payment
              <select data-payment-status${disabled}>${statusOptions(order.paymentStatus, PAYMENT_LABELS)}</select>
            </label>
            <label>
              Cancellation reason
              <input data-cancel-reason type="text" value="${escapeHtml(order.cancellationReason || '')}"${disabled} />
            </label>
            <label class="span-2">
              Private notes
              <textarea data-admin-notes rows="2"${disabled}>${escapeHtml(order.adminNotes || '')}</textarea>
            </label>
            <div class="order-manage-actions span-2">
              <button class="btn btn-primary" data-update-order="${id}"${disabled}>Save changes</button>
            </div>
          </div>
        </details>
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

  function updateOrderViewCounts() {
    const counts = { pending: 0, completed: 0, cancelled: 0, all: ordersCache.length };
    ordersCache.forEach((order) => { counts[order.status] = (counts[order.status] || 0) + 1; });
    $$('[data-view-count]').forEach((el) => {
      el.textContent = counts[el.dataset.viewCount] ?? 0;
    });
    $('#availableOrderCount').textContent = counts.pending;
  }

  function renderOrders() {
    updateOrderViewCounts();
    const matched = sortOrders(ordersCache.filter(orderMatchesFilters));
    const pages = Math.max(1, Math.ceil(matched.length / ORDERS_PAGE_SIZE));
    orderPage = Math.min(Math.max(0, orderPage), pages - 1);
    const slice = matched.slice(orderPage * ORDERS_PAGE_SIZE, orderPage * ORDERS_PAGE_SIZE + ORDERS_PAGE_SIZE);

    const emptyCopy = {
      pending: ['No pending orders', 'New storefront orders land here, ready to fulfil.'],
      completed: ['No completed orders yet', 'Orders you mark completed are kept here as history.'],
      cancelled: ['No cancelled orders', 'Cancelled orders are kept here for your records.'],
      all: ['No orders yet', 'New storefront orders will appear here.'],
    };
    const [emptyTitle, emptyBody] = emptyCopy[orderView] || emptyCopy.all;

    $('#availableOrders').innerHTML = slice.length
      ? slice.map(renderOrderItem).join('')
      : (($('#orderSearch')?.value || $('#orderDateFilter')?.value)
        ? '<div class="empty-state-admin"><strong>No matching orders</strong><p>Try clearing the search or date filter.</p></div>'
        : `<div class="empty-state-admin"><strong>${emptyTitle}</strong><p>${emptyBody}</p></div>`);

    const pager = $('#orderPager');
    if (pager) {
      if (pages > 1) {
        pager.hidden = false;
        $('#orderPageInfo').textContent = `Page ${orderPage + 1} of ${pages} · ${matched.length} order${matched.length === 1 ? '' : 's'}`;
        $('#orderPrev').disabled = orderPage === 0;
        $('#orderNext').disabled = orderPage >= pages - 1;
      } else {
        pager.hidden = true;
      }
    }

    $$('[data-quick-status]').forEach((button) => {
      button.addEventListener('click', () => void quickOrderStatus(button.dataset.order, button.dataset.quickStatus));
    });
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

  // One-click status change (Mark completed / Cancel / Reopen) without opening Manage.
  async function quickOrderStatus(id, status) {
    if (!orderManagementEnabled()) {
      toast('Order management is disabled for this session');
      return;
    }
    if (!ORDER_STATUSES.includes(status)) return;
    const changes = { status };
    if (status === 'cancelled') {
      const reason = window.prompt('Reason for cancelling this order? (optional)', '');
      if (reason === null) return; // cancelled the prompt
      changes.cancellationReason = String(reason || '').trim();
    }
    try {
      if (BACKEND?.orders?.update) await BACKEND.orders.update(id, changes);
      else {
        const order = ordersCache.find((item) => String(item.id) === String(id));
        if (order) {
          Object.assign(order, changes, { updatedAt: new Date().toISOString() });
          if (status === 'completed') order.completedAt = order.updatedAt;
          if (status === 'cancelled') order.cancelledAt = order.updatedAt;
          writeLS(KEYS.orders, ordersCache);
        }
      }
      await loadOrders();
      renderOrders();
      renderMetrics();
      toast(status === 'completed' ? 'Order marked completed' : status === 'cancelled' ? 'Order cancelled' : 'Order reopened');
    } catch (error) {
      toast(error.message || 'Could not update order');
    }
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
    $$('#productForm .is-invalid, #settingsForm .is-invalid').forEach((field) => field.classList.remove('is-invalid'));
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
    $('#prodGallery').value = '';
    galleryItems = [];
    renderGalleryStrip();
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
    loadGalleryFromProduct(product);
    setSelectedSizes(product.sizes);
    setColorRows(product.colors);
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
      gallery: parseGalleryField(),
      sizes: selectedSizes(),
      colors: parseColors($('#prodColors').value),
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
    const matched = getProducts().filter(productMatchesFilters).sort(comparator);

    // Keep the selection set in sync with products that still exist.
    const existingIds = new Set(getProducts().map((product) => product.id));
    [...selectedProductIds].forEach((id) => { if (!existingIds.has(id)) selectedProductIds.delete(id); });

    // Paginate (drag-reorder stays correct because it operates on the full sorted list).
    const totalPages = Math.max(1, Math.ceil(matched.length / CATALOG_PAGE_SIZE));
    catalogPage = Math.min(Math.max(0, catalogPage), totalPages - 1);
    const products = matched.slice(catalogPage * CATALOG_PAGE_SIZE, catalogPage * CATALOG_PAGE_SIZE + CATALOG_PAGE_SIZE);

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

    const pager = $('#catalogPager');
    if (pager) {
      if (totalPages > 1) {
        pager.hidden = false;
        $('#catalogPageInfo').textContent = `Page ${catalogPage + 1} of ${totalPages} · ${matched.length} shown`;
        $('#catalogPrev').disabled = catalogPage === 0;
        $('#catalogNext').disabled = catalogPage >= totalPages - 1;
      } else {
        pager.hidden = true;
      }
    }
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

  // Persist the whole catalog in a single batched write (multi-path update on
  // Firebase, one localStorage write on the fallback) — avoids per-item write storms.
  async function saveAllProducts(list) {
    if (!adminMutationsEnabled()) throw new Error('Catalog editing is disabled for this session.');
    const normalized = (list || []).map(normalizeProduct);
    if (BACKEND?.products?.replace) await BACKEND.products.replace(normalized);
    else writeLS(KEYS.products, normalized);
    await loadProducts();
  }

  async function runBulkAction(action) {
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const ids = new Set([...selectedProductIds]);
    if (!ids.size) return;
    let stockValue = null;
    if (action === 'stock') {
      const input = window.prompt('Set stock for the selected products to:', '0');
      if (input === null) return;
      stockValue = Math.max(0, Number(input) || 0);
    }
    if (action === 'delete' && !window.confirm(`Delete ${ids.size} selected product(s) permanently?`)) return;
    try {
      let next;
      if (action === 'delete') {
        next = productsCache.filter((product) => !ids.has(product.id));
      } else {
        next = productsCache.map((product) => {
          if (!ids.has(product.id)) return product;
          const updated = { ...product };
          if (action === 'publish') updated.active = true;
          if (action === 'unpublish') updated.active = false;
          if (action === 'stock') updated.stock = stockValue;
          return updated;
        });
      }
      const count = ids.size;
      await saveAllProducts(next);
      selectedProductIds.clear();
      await renderProductList();
      renderMetrics();
      updateCategoryOptions();
      toast(`Bulk ${action} applied to ${count} product(s)`);
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
    let changedCount = 0;
    ordered.forEach((item, index) => {
      const newOrder = (index + 1) * 10;
      if (Number(item.sortOrder) !== newOrder) {
        item.sortOrder = newOrder;
        changedCount += 1;
      }
    });
    if (!changedCount) return;
    try {
      await saveAllProducts(ordered); // single batched write
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
      renderGalleryStrip();
      showImageResult({ ...uploaded.imageMeta, status: 'Uploaded to Google Drive; set as the main image' });
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

  // Single source for the storefront phone/WhatsApp number, with back-compat for
  // any legacy split fields still in an old settings record.
  function settingsPhone() {
    return String(settingsCache.phone || settingsCache.phoneNumber || settingsCache.whatsappNumber || settingsCache.phoneDisplay || '').trim();
  }

  function fillSettingsForm() {
    $('#settingSiteTitle').value = settingsCache.siteTitle || settingsCache.siteName || 'Pavia Lebanon';
    $('#settingLocation').value = settingsCache.location || '';
    $('#settingDeliveryArea').value = settingsCache.deliveryArea || '';
    $('#settingPhone').value = settingsPhone();
    $('#settingInstagramHandle').value = String(settingsCache.instagramHandle || '').replace(/^@+/, '');
    $('#settingDeliveryFee').value = settingsCache.deliveryFee !== undefined && settingsCache.deliveryFee !== null
      ? Number(settingsCache.deliveryFee)
      : 3;
    $('#settingCheckoutEnabled').checked = settingsCache.checkoutEnabled !== false;
    $('#settingCash').checked = settingsCache.paymentMethods?.cash_on_delivery !== false;
    $('#settingWhish').checked = settingsCache.paymentMethods?.whish_money !== false;
  }

  function validateSettings(phone, deliveryFee) {
    setFieldError('settingPhone');
    setFieldError('settingDeliveryFee');
    let ok = true;
    if (phone && !/^[+\d][\d\s().-]{5,23}$/.test(phone)) {
      setFieldError('settingPhone', 'Enter a valid phone number, or leave it blank.');
      ok = false;
    }
    if (!(deliveryFee >= 0) || deliveryFee > 10000) {
      setFieldError('settingDeliveryFee', 'Delivery fee must be between 0 and 10000.');
      ok = false;
    }
    return ok;
  }

  async function handleSettingsSubmit(event) {
    event.preventDefault();
    if (!adminMutationsEnabled()) {
      toast('Settings editing is disabled for this session');
      return;
    }
    const phone = $('#settingPhone').value.trim();
    const deliveryFee = Number($('#settingDeliveryFee').value);
    if (!validateSettings(phone, deliveryFee)) {
      setFormStatus('settingsFormStatus', 'Fix the highlighted fields and try again.', 'error');
      return;
    }
    // Write the cleaned model only; normalizeSettingsRecord drops the legacy fields.
    const { phoneDisplay, phoneNumber, whatsappNumber, instagramUrl,
      deliveryBeirut, deliveryLebanon, freeDeliveryAt, whatsappCheckoutEnabled,
      ...rest } = settingsCache;
    const record = {
      ...rest,
      siteName: 'Pavia',
      siteTitle: $('#settingSiteTitle').value.trim() || 'Pavia Lebanon',
      location: $('#settingLocation').value.trim(),
      deliveryArea: $('#settingDeliveryArea').value.trim(),
      phone,
      instagramHandle: $('#settingInstagramHandle').value.trim().replace(/^@+/, ''),
      currency: 'USD',
      deliveryFee: Math.max(0, deliveryFee || 0),
      checkoutEnabled: $('#settingCheckoutEnabled').checked,
      paymentMethods: {
        cash_on_delivery: $('#settingCash').checked,
        whish_money: $('#settingWhish').checked,
      },
    };
    if (savingSettings) return;
    savingSettings = true;
    const button = event.submitter || $('#settingsForm button[type="submit"]');
    setButtonLoading(button, true, 'Saving...');
    setFormStatus('settingsFormStatus', 'Saving…', 'info');
    try {
      settingsCache = BACKEND?.settings?.update
        ? await BACKEND.settings.update(record)
        : record;
      if (!BACKEND?.settings?.update) writeLS(KEYS.settings, settingsCache);
      fillSettingsForm();
      setFormStatus('settingsFormStatus', 'Settings saved and published.', 'success');
      toast('Settings saved');
    } catch (error) {
      setFormStatus('settingsFormStatus', error.message || 'Could not save settings.', 'error');
      toast(error.message || 'Could not save settings');
    } finally {
      savingSettings = false;
      setButtonLoading(button, false, 'Save settings');
    }
  }

  // ============================================================
  // P2: Image Library + multi-image gallery
  // ============================================================
  const LIBRARY_PAGE_SIZE = 18;
  let libraryCache = [];
  let libraryPage = 0;
  let libraryLoading = false;
  let galleryItems = [];          // EXTRA images only (main lives in #prodImage* fields)
  let libraryPickerMode = 'gallery';
  let galleryDragIndex = -1;

  function drive() { return window.PaviaDriveImages; }

  // Map of driveFileId -> [product names] using it (main image or a gallery entry).
  function driveImageUsage() {
    const usage = new Map();
    const add = (id, name) => {
      const key = String(id || '').trim();
      if (!key) return;
      if (!usage.has(key)) usage.set(key, new Set());
      usage.get(key).add(name);
    };
    productsCache.forEach((product) => {
      const name = product.name || product.id;
      add(product.driveFileId || product.imageMeta?.driveFileId, name);
      (Array.isArray(product.gallery) ? product.gallery : []).forEach((entry) => add(entry?.driveFileId, name));
    });
    const out = new Map();
    usage.forEach((set, key) => out.set(key, [...set]));
    return out;
  }

  // ---- Library Drive status ----
  function setLibraryDriveStatus(message, detail = '') {
    if ($('#libraryDriveStatus')) $('#libraryDriveStatus').textContent = message;
    if ($('#libraryDriveDetail')) $('#libraryDriveDetail').textContent = detail;
  }
  function refreshLibraryDrivePanel() {
    const button = $('#libraryConnectBtn');
    if (!button) return;
    if (!drive()?.configured?.()) {
      setLibraryDriveStatus('Google Drive not configured', 'Add the OAuth client ID and Drive folder ID in js/backend-config.js.');
      button.disabled = true;
      return;
    }
    button.disabled = false;
    const connected = Boolean(drive().accessToken?.());
    setLibraryDriveStatus(
      connected ? 'Google Drive connected' : 'Google Drive not connected',
      connected ? 'The access token is in memory only and is forgotten on lock or reload.' : 'Connect Google Drive to browse and upload images.',
    );
    button.textContent = connected ? 'Reconnect' : 'Connect Google Drive';
  }

  function setLibraryStatus(message, isError = false) {
    const el = $('#libraryUploadStatus');
    if (!el) return;
    if (!message) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.classList.toggle('is-error', Boolean(isError));
    el.innerHTML = `<strong>${escapeHtml(message)}</strong>`;
  }

  // ---- Load + render the library grid ----
  async function loadLibrary({ silent = false } = {}) {
    if (!drive()?.configured?.()) { libraryCache = []; renderLibrary(); refreshLibraryDrivePanel(); return; }
    refreshLibraryDrivePanel();
    if (!drive().accessToken?.()) { renderLibrary(); return; }
    if (libraryLoading) return;
    libraryLoading = true;
    if (!silent) setLibraryStatus('Loading library…');
    try {
      libraryCache = await drive().listFiles({ pageSize: 300 });
      libraryPage = 0;
      if (!silent) setLibraryStatus('');
    } catch (error) {
      setLibraryStatus(error.message || 'Could not load the library', true);
    } finally {
      libraryLoading = false;
      renderLibrary();
    }
  }

  function libraryTileHtml(file, usage, picker) {
    const used = usage.get(file.id) || [];
    const dims = file.width && file.height ? ` · ${file.width}×${file.height}` : '';
    const usageText = used.length ? `Used by ${used.length} product${used.length === 1 ? '' : 's'}` : 'Unused';
    const actions = picker
      ? '<div class="library-tile-actions"><button type="button" class="btn btn-secondary" data-lib-pick>Use this image</button></div>'
      : `<div class="library-tile-actions">
           <button type="button" class="btn btn-ghost" data-lib-copy>Copy URL</button>
           <button type="button" class="btn btn-ghost danger-button" data-lib-delete${used.length ? ' title="In use — remove from products first"' : ''}>Delete</button>
         </div>`;
    return `
      <figure class="library-tile" data-file-id="${escapeHtml(file.id)}">
        <div class="library-thumb"><img src="${escapeHtml(file.imageUrl)}" alt="${escapeHtml(file.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></div>
        <figcaption>
          <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
          <span>${escapeHtml(formatBytes(file.size))}${escapeHtml(dims)}</span>
          <span class="library-usage ${used.length ? 'is-used' : 'is-free'}" title="${escapeHtml(used.join(', '))}">${escapeHtml(usageText)}</span>
        </figcaption>
        ${actions}
      </figure>`;
  }

  function renderLibrary() {
    const grid = $('#libraryGrid');
    const pager = $('#libraryPager');
    if (!grid) return;
    $('#libraryCount').textContent = libraryCache.length;

    if (!drive()?.configured?.()) {
      grid.innerHTML = '<div class="empty-state-admin"><strong>Google Drive not configured</strong><p>Add the OAuth client ID and Drive folder ID in js/backend-config.js.</p></div>';
      pager.hidden = true;
      return;
    }
    if (!drive().accessToken?.()) {
      grid.innerHTML = '<div class="empty-state-admin"><strong>Connect Google Drive</strong><p>Connect to browse the images your studio uploaded.</p></div>';
      pager.hidden = true;
      return;
    }
    if (!libraryCache.length) {
      grid.innerHTML = '<div class="empty-state-admin"><strong>No images yet</strong><p>Upload images above, or add them while editing a product.</p></div>';
      pager.hidden = true;
      return;
    }

    const usage = driveImageUsage();
    const pages = Math.max(1, Math.ceil(libraryCache.length / LIBRARY_PAGE_SIZE));
    libraryPage = Math.min(libraryPage, pages - 1);
    const start = libraryPage * LIBRARY_PAGE_SIZE;
    const slice = libraryCache.slice(start, start + LIBRARY_PAGE_SIZE);
    grid.innerHTML = slice.map((file) => libraryTileHtml(file, usage, false)).join('');

    $$('[data-lib-delete]', grid).forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.closest('[data-file-id]')?.dataset.fileId;
        void deleteLibraryImage(id);
      });
    });
    $$('[data-lib-copy]', grid).forEach((button) => {
      button.addEventListener('click', async () => {
        const id = button.closest('[data-file-id]')?.dataset.fileId;
        const file = libraryCache.find((item) => item.id === id);
        if (!file) return;
        try { await navigator.clipboard.writeText(file.imageUrl); toast('Image URL copied'); }
        catch { toast('Could not copy URL'); }
      });
    });

    if (pages > 1) {
      pager.hidden = false;
      $('#libraryPageInfo').textContent = `Page ${libraryPage + 1} of ${pages}`;
      $('#libraryPrev').disabled = libraryPage === 0;
      $('#libraryNext').disabled = libraryPage >= pages - 1;
    } else {
      pager.hidden = true;
    }
  }

  async function deleteLibraryImage(id) {
    const fileId = String(id || '').trim();
    if (!fileId) return;
    const file = libraryCache.find((item) => item.id === fileId);
    const used = driveImageUsage().get(fileId) || [];
    if (used.length) {
      window.alert(`This image is still used by: ${used.join(', ')}.\n\nRemove it from those products first, then delete it here.`);
      return;
    }
    if (!window.confirm(`Delete "${file?.name || 'this image'}" from Google Drive permanently?`)) return;
    try {
      await drive().deleteFile(fileId);
      libraryCache = libraryCache.filter((item) => item.id !== fileId);
      renderLibrary();
      toast('Image deleted from Drive');
    } catch (error) {
      toast(error.message || 'Could not delete the image');
    }
  }

  async function connectLibraryDrive() {
    try {
      $('#libraryConnectBtn').disabled = true;
      setLibraryDriveStatus('Connecting Google Drive…', 'Approve the Google permission popup.');
      await drive().connect();
      refreshLibraryDrivePanel();
      refreshDrivePanel();
      await loadLibrary();
    } catch (error) {
      refreshLibraryDrivePanel();
      toast(error.message || 'Google Drive connection failed');
    }
  }

  async function handleLibraryUpload(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    if (!drive()) { toast('Google Drive tools are unavailable'); return; }
    try {
      if (!drive().accessToken?.()) { await drive().connect(); refreshLibraryDrivePanel(); }
    } catch (error) {
      toast(error.message || 'Connect Google Drive first');
      return;
    }
    $('#libraryDropzone')?.classList.add('is-processing');
    let done = 0;
    for (const file of list) {
      try {
        setLibraryStatus(`Optimizing ${file.name} (${done + 1}/${list.length})…`);
        const optimized = await drive().optimizeImage(file, imageOptimizationOptions());
        setLibraryStatus(`Uploading ${file.name} (${done + 1}/${list.length})…`);
        const uploaded = await drive().uploadOptimizedImage(optimized);
        libraryCache.unshift({
          id: uploaded.driveFileId,
          name: uploaded.imageMeta?.optimizedName || file.name,
          mimeType: uploaded.imageMeta?.mimeType || 'image/webp',
          size: Number(uploaded.imageMeta?.byteSize) || 0,
          createdTime: new Date().toISOString(),
          width: Number(uploaded.imageMeta?.width) || 0,
          height: Number(uploaded.imageMeta?.height) || 0,
          imageUrl: uploaded.imageUrl,
        });
        done += 1;
        libraryPage = 0;
        renderLibrary();
      } catch (error) {
        toast(error.message || `Could not upload ${file.name}`);
      }
    }
    setLibraryStatus(done ? `Uploaded ${done} image${done === 1 ? '' : 's'} to the library.` : '');
    $('#libraryDropzone')?.classList.remove('is-processing');
    $('#libraryFile').value = '';
  }

  // ---- Library picker (used from the product editor) ----
  function libraryItemFromFile(file) {
    return { imageUrl: file.imageUrl, driveFileId: file.id, imageVersion: '', imageMeta: { driveFileId: file.id, optimizedName: file.name, byteSize: file.size, provider: 'google_drive', publicUrl: file.imageUrl } };
  }
  async function openLibraryPicker(mode) {
    libraryPickerMode = mode === 'main' ? 'main' : 'gallery';
    const picker = $('#libraryPicker');
    $('#libraryPickerTitle').textContent = libraryPickerMode === 'main' ? 'Choose the main image' : 'Add gallery images';
    $('#libraryPickerHint').textContent = libraryPickerMode === 'main' ? 'Pick the photo shown on the product card.' : 'Pick a photo to add to the gallery.';
    picker.hidden = false;
    const grid = $('#libraryPickerGrid');
    grid.innerHTML = '<div class="empty-state-admin"><strong>Loading…</strong></div>';
    if (!drive()?.accessToken?.()) {
      try { await drive().connect(); refreshLibraryDrivePanel(); } catch { /* ignore */ }
    }
    if (!libraryCache.length) await loadLibrary({ silent: true });
    renderLibraryPicker();
  }
  function closeLibraryPicker() { $('#libraryPicker').hidden = true; }
  function renderLibraryPicker() {
    const grid = $('#libraryPickerGrid');
    if (!grid) return;
    if (!libraryCache.length) {
      grid.innerHTML = '<div class="empty-state-admin"><strong>No images yet</strong><p>Upload images in the Library tab first.</p></div>';
      return;
    }
    const usage = driveImageUsage();
    grid.innerHTML = libraryCache.map((file) => libraryTileHtml(file, usage, true)).join('');
    $$('[data-lib-pick]', grid).forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.closest('[data-file-id]')?.dataset.fileId;
        const file = libraryCache.find((item) => item.id === id);
        if (!file) return;
        if (libraryPickerMode === 'main') setMainImage(libraryItemFromFile(file));
        else addGalleryItem(libraryItemFromFile(file));
        closeLibraryPicker();
      });
    });
  }

  // ---- Main image + gallery state ----
  function currentMainItem() {
    const imageUrl = $('#prodImageUrl').value.trim();
    if (!imageUrl) return null;
    return { imageUrl, driveFileId: $('#prodDriveFileId').value.trim(), imageVersion: $('#prodImageVersion').value.trim() };
  }
  function setMainImage(item) {
    $('#prodImageUrl').value = item.imageUrl || '';
    $('#prodImageId').value = '';
    $('#prodImage').value = item.imageUrl || '';
    $('#prodImageVersion').value = item.imageVersion || '';
    $('#prodDriveFileId').value = item.driveFileId || '';
    $('#prodImageProvider').value = item.driveFileId ? 'google_drive' : (item.imageUrl ? 'external' : 'local_legacy');
    if (item.imageMeta) $('#prodImageMeta').value = JSON.stringify(item.imageMeta);
    markFormDirty();
    renderGalleryStrip();
    void updateProductPreview();
  }
  function syncGalleryField() {
    $('#prodGallery').value = JSON.stringify(galleryItems);
    markFormDirty();
  }
  function addGalleryItem(item) {
    if (!item?.imageUrl) return;
    if (!currentMainItem()) { setMainImage(item); return; } // no main yet → becomes main
    const exists = galleryItems.some((g) => g.imageUrl === item.imageUrl)
      || $('#prodImageUrl').value.trim() === item.imageUrl;
    if (exists) { toast('That image is already used'); return; }
    galleryItems.push({ imageUrl: item.imageUrl, driveFileId: item.driveFileId || '', imageVersion: item.imageVersion || '' });
    syncGalleryField();
    renderGalleryStrip();
  }
  function removeGalleryItem(index) {
    galleryItems.splice(index, 1);
    syncGalleryField();
    renderGalleryStrip();
  }
  function moveGalleryItem(from, to) {
    if (to < 0 || to >= galleryItems.length || from === to) return;
    const [item] = galleryItems.splice(from, 1);
    galleryItems.splice(to, 0, item);
    syncGalleryField();
    renderGalleryStrip();
  }
  function promoteGalleryItem(index) {
    const item = galleryItems[index];
    if (!item) return;
    const oldMain = currentMainItem();
    galleryItems.splice(index, 1);
    if (oldMain) galleryItems.unshift(oldMain);
    setMainImage(item);
    syncGalleryField();
    renderGalleryStrip();
  }

  function galleryTileHtml(item, index, isMain) {
    return `
      <div class="gallery-item${isMain ? ' is-main' : ''}" data-gallery-index="${index}"${isMain ? '' : ' draggable="true"'}>
        <img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
        ${isMain ? '<span class="gallery-badge">Main</span>' : ''}
        <div class="gallery-item-actions">
          ${isMain ? '' : '<button type="button" data-gallery-main title="Make main">★</button>'}
          ${isMain ? '' : `<button type="button" data-gallery-left title="Move earlier" ${index === 0 ? 'disabled' : ''}>‹</button>`}
          ${isMain ? '' : `<button type="button" data-gallery-right title="Move later" ${index === galleryItems.length - 1 ? 'disabled' : ''}>›</button>`}
          <button type="button" data-gallery-remove title="Remove">×</button>
        </div>
      </div>`;
  }
  function renderGalleryStrip() {
    const strip = $('#galleryStrip');
    if (!strip) return;
    const main = currentMainItem();
    const tiles = [];
    if (main) tiles.push(galleryTileHtml(main, -1, true));
    galleryItems.forEach((item, index) => tiles.push(galleryTileHtml(item, index, false)));
    strip.innerHTML = tiles.length
      ? tiles.join('')
      : '<p class="gallery-empty">No images yet. Upload a main photo or add from the library.</p>';

    $$('[data-gallery-remove]', strip).forEach((button) => {
      button.addEventListener('click', () => {
        const tile = button.closest('[data-gallery-index]');
        const index = Number(tile.dataset.galleryIndex);
        if (index < 0) { // removing the main image
          setMainImage({ imageUrl: '', driveFileId: '', imageVersion: '' });
          $('#prodImageMeta').value = '';
        } else {
          removeGalleryItem(index);
        }
      });
    });
    $$('[data-gallery-main]', strip).forEach((button) => {
      button.addEventListener('click', () => promoteGalleryItem(Number(button.closest('[data-gallery-index]').dataset.galleryIndex)));
    });
    $$('[data-gallery-left]', strip).forEach((button) => {
      button.addEventListener('click', () => { const i = Number(button.closest('[data-gallery-index]').dataset.galleryIndex); moveGalleryItem(i, i - 1); });
    });
    $$('[data-gallery-right]', strip).forEach((button) => {
      button.addEventListener('click', () => { const i = Number(button.closest('[data-gallery-index]').dataset.galleryIndex); moveGalleryItem(i, i + 1); });
    });
    // Drag-to-reorder for the extra (non-main) tiles.
    $$('.gallery-item[draggable="true"]', strip).forEach((tile) => {
      tile.addEventListener('dragstart', () => { galleryDragIndex = Number(tile.dataset.galleryIndex); tile.classList.add('is-dragging'); });
      tile.addEventListener('dragend', () => { galleryDragIndex = -1; tile.classList.remove('is-dragging'); });
      tile.addEventListener('dragover', (event) => event.preventDefault());
      tile.addEventListener('drop', (event) => {
        event.preventDefault();
        const to = Number(tile.dataset.galleryIndex);
        if (galleryDragIndex >= 0 && to >= 0) moveGalleryItem(galleryDragIndex, to);
      });
    });
  }

  function loadGalleryFromProduct(product) {
    const list = Array.isArray(product?.gallery) ? product.gallery : [];
    galleryItems = list
      .map((entry) => (CORE.normalizeGalleryEntry ? CORE.normalizeGalleryEntry(entry) : entry))
      .filter((entry) => entry && entry.imageUrl);
    $('#prodGallery').value = JSON.stringify(galleryItems);
    renderGalleryStrip();
  }
  function parseGalleryField() {
    try {
      const list = JSON.parse($('#prodGallery').value || '[]');
      return CORE.normalizeGallery ? CORE.normalizeGallery(list) : (Array.isArray(list) ? list : []);
    } catch {
      return [];
    }
  }

  async function handleGalleryUpload(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    if (!drive()) { toast('Google Drive tools are unavailable'); return; }
    try {
      if (!drive().accessToken?.()) { await connectDrive(); }
      if (!drive().accessToken?.()) throw new Error('Connect Google Drive before uploading.');
    } catch (error) {
      toast(error.message || 'Connect Google Drive first');
      return;
    }
    for (const file of list) {
      try {
        showImageResult({ status: `Optimizing ${file.name}…` });
        const optimized = await drive().optimizeImage(file, imageOptimizationOptions());
        showImageResult({ status: `Uploading ${file.name}…` });
        const uploaded = await drive().uploadOptimizedImage(optimized);
        addGalleryItem({ imageUrl: uploaded.imageUrl, driveFileId: uploaded.driveFileId, imageVersion: uploaded.imageVersion });
        libraryCache.unshift({
          id: uploaded.driveFileId, name: uploaded.imageMeta?.optimizedName || file.name, mimeType: uploaded.imageMeta?.mimeType || 'image/webp',
          size: Number(uploaded.imageMeta?.byteSize) || 0, createdTime: new Date().toISOString(),
          width: Number(uploaded.imageMeta?.width) || 0, height: Number(uploaded.imageMeta?.height) || 0, imageUrl: uploaded.imageUrl,
        });
        showImageResult({ ...uploaded.imageMeta, status: 'Added to gallery' });
      } catch (error) {
        toast(error.message || `Could not upload ${file.name}`);
      }
    }
    $('#galleryFile').value = '';
  }

  function setupLibrary() {
    refreshLibraryDrivePanel();
    $('#libraryConnectBtn')?.addEventListener('click', () => void connectLibraryDrive());
    $('#libraryRefresh')?.addEventListener('click', () => void loadLibrary());
    $('#libraryPrev')?.addEventListener('click', () => { if (libraryPage > 0) { libraryPage -= 1; renderLibrary(); } });
    $('#libraryNext')?.addEventListener('click', () => { libraryPage += 1; renderLibrary(); });
    $('#libraryFile')?.addEventListener('change', (event) => void handleLibraryUpload(event.target.files));
    const dz = $('#libraryDropzone');
    dz?.addEventListener('dragover', (event) => { event.preventDefault(); dz.classList.add('is-dragging'); });
    dz?.addEventListener('dragleave', () => dz.classList.remove('is-dragging'));
    dz?.addEventListener('drop', (event) => { event.preventDefault(); dz.classList.remove('is-dragging'); void handleLibraryUpload(event.dataTransfer.files); });

    // Gallery + picker controls in the product editor
    $('#chooseMainFromLibrary')?.addEventListener('click', () => void openLibraryPicker('main'));
    $('#galleryAddFromLibrary')?.addEventListener('click', () => void openLibraryPicker('gallery'));
    $('#galleryFile')?.addEventListener('change', (event) => void handleGalleryUpload(event.target.files));
    $('#libraryPickerClose')?.addEventListener('click', closeLibraryPicker);
    $('#libraryPicker')?.addEventListener('click', (event) => { if (event.target === $('#libraryPicker')) closeLibraryPicker(); });
  }

  function activateTab(target) {
    $$('.admin-tab').forEach((item) => {
      const on = item.dataset.tab === target;
      item.classList.toggle('active', on);
      item.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.admin-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === target);
    });
    if (target === 'dashboard') renderMetrics();
    if (target === 'visitors') renderVisitorMetrics();
    if (target === 'orders') renderOrders();
    if (target === 'products') void renderProductList();
    if (target === 'library') void loadLibrary();
  }

  function setupTabs() {
    $$('.admin-tab').forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });
    // In-panel buttons that jump to another tab (e.g. Overview → Orders).
    $$('[data-tab-link]').forEach((button) => {
      button.addEventListener('click', () => {
        activateTab(button.dataset.tabLink);
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const ordersChanged = () => { orderPage = 0; renderOrders(); };
    ['#orderSearch', '#orderDateFilter', '#orderSort'].forEach((selector) => {
      $(selector)?.addEventListener('input', ordersChanged);
      $(selector)?.addEventListener('change', ordersChanged);
    });
    const catalogChanged = () => { catalogPage = 0; void renderProductList(); };
    ['#productSearch', '#stockFilter', '#imageMigrationFilter', '#productSort'].forEach((selector) => {
      $(selector)?.addEventListener('input', catalogChanged);
      $(selector)?.addEventListener('change', catalogChanged);
    });

    // Order status views (segmented control).
    $$('[data-order-view]').forEach((button) => {
      button.addEventListener('click', () => {
        orderView = button.dataset.orderView;
        orderPage = 0;
        $$('[data-order-view]').forEach((item) => {
          const on = item === button;
          item.classList.toggle('is-active', on);
          item.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderOrders();
      });
    });

    // List pagers.
    $('#orderPrev')?.addEventListener('click', () => { if (orderPage > 0) { orderPage -= 1; renderOrders(); } });
    $('#orderNext')?.addEventListener('click', () => { orderPage += 1; renderOrders(); });
    $('#catalogPrev')?.addEventListener('click', () => { if (catalogPage > 0) { catalogPage -= 1; void renderProductList(); } });
    $('#catalogNext')?.addEventListener('click', () => { catalogPage += 1; void renderProductList(); });
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
      }
      if (event.key === 'Escape' && activePanel === 'products') {
        if (confirmDiscardIfDirty('Discard unsaved product changes?')) resetForm();
      }
    });

    maybeShowDraftBanner();
  }

  async function refreshAll() {
    await Promise.all([loadOrders(), loadProducts(), loadSettings(), loadStatistics()]);
    updateCategoryOptions();
    updateImageOptions();
    fillSettingsForm();
    renderMetrics();
    renderVisitorMetrics();
    renderOrders();
    await renderProductList();
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
    setupTabs();
    setupProductPreview();
    setupVariantBuilders();
    setupImageUploader();
    setupLibrary();
    setupFilters();
    setupAdminUx();
    resetForm();
    $('#dashboard').hidden = false;
  });
})();
