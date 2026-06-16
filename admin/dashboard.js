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

  let productsCache = [];
  let ordersCache = [];
  let settingsCache = {};
  let promoCache = {};

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
      <p class="desc">UID allowlisting, encrypted local unlock, and database rules must all be active before writes are enabled.</p>
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

  function imageReferenceFromFields() {
    const imageUrl = $('#prodImageUrl').value.trim();
    const imageId = $('#prodImageId').value.trim();
    return imageUrl || imageId || window.PAVIA_IMAGE_PLACEHOLDER || 'pavia-look-01';
  }

  function normalizeImagePath(value) {
    const path = String(value || '').trim();
    if (!path) return window.PAVIA_IMAGE_PLACEHOLDER || 'pavia-look-01';
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

  function renderMetrics() {
    const openOrders = ordersCache.filter((order) => !['completed', 'cancelled'].includes(order.status));
    const pendingPayments = ordersCache.filter((order) => ['pending', 'awaiting_confirmation'].includes(order.paymentStatus));
    const today = todayKey();
    const todayOrders = ordersCache.filter((order) => todayKey(order.createdAt || order.date) === today);
    const revenue = ordersCache
      .filter((order) => order.status !== 'cancelled')
      .reduce((sum, order) => sum + (Number(order.total) || 0), 0);
    const lowStock = productsCache.filter((product) => product.stock > 0 && product.stock <= LOW_STOCK_AT);

    $('#metricsGrid').innerHTML = [
      ['Open orders', openOrders.length, 'Orders still in progress'],
      ['Today', todayOrders.length, 'Orders created today'],
      ['Revenue est.', fmt(revenue), 'Browser/order snapshot estimate'],
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

  function renderOrders() {
    const orders = ordersCache
      .filter(orderMatchesFilters)
      .sort((left, right) => new Date(right.createdAt || right.date || 0) - new Date(left.createdAt || left.date || 0));
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
    if (product.imageUrl && !/^https:\/\//i.test(product.imageUrl)) {
      errors.prodImageUrl = 'External images must use HTTPS.';
    }
    if (!product.imageUrl && !catalogImageIds().includes(product.imageId)) {
      errors.prodImageId = 'Choose a valid preset image ID.';
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
    $('#productForm').reset();
    $('#prodId').value = '';
    $('#prodSlug').value = '';
    $('#prodStock').value = 10;
    $('#prodSortOrder').value = nextSortOrder();
    $('#prodStatus').value = 'published';
    $('#prodImageId').value = window.PAVIA_IMAGE_PLACEHOLDER || 'pavia-look-01';
    $('#prodImageUrl').value = '';
    $('#prodImage').value = $('#prodImageId').value;
    $('#prodImageVersion').value = '';
    $('#prodImageMeta').value = '';
    $('#imageOptimizationResult').hidden = true;
    setSelectedSizes(['One size']);
    setColorRows([]);
    clearProductErrors();
    $('#formTitle').textContent = 'Add a product';
    $('#formSubmit').textContent = 'Add product';
    void updateProductPreview();
  }

  function nextSortOrder() {
    const max = Math.max(0, ...productsCache.map((product) => Number(product.sortOrder) || 0));
    return max + 1;
  }

  function loadIntoForm(id) {
    const product = getProducts().find((item) => item.id === id);
    if (!product) return;
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
    $('#prodImageId').value = product.imageUrl ? '' : (product.imageId || window.PAVIA_IMAGE_PLACEHOLDER || 'pavia-look-01');
    $('#prodImageUrl').value = product.imageUrl || '';
    $('#prodImage').value = product.imageUrl || product.imageId || product.image;
    $('#prodImageVersion').value = product.imageVersion || '';
    $('#prodImageMeta').value = product.imageMeta ? JSON.stringify(product.imageMeta) : '';
    setSelectedSizes(product.sizes);
    setColorRows(product.colors);
    $('#prodMaterial').value = product.material;
    $('#prodFit').value = product.fit;
    $('#prodCare').value = product.care;
    $('#formTitle').textContent = 'Edit product';
    $('#formSubmit').textContent = 'Save changes';
    void updateProductPreview();
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
    const imageId = imageUrl ? '' : ($('#prodImageId').value.trim() || window.PAVIA_IMAGE_PLACEHOLDER || 'pavia-look-01');
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
      toast('Fix the highlighted product fields');
      return;
    }

    try {
      await upsertProduct(product);
      await renderProductList();
      renderMetrics();
      updateCategoryOptions();
      resetForm();
      toast(existing ? 'Product updated' : 'Product added');
    } catch (error) {
      toast(error.message || 'Could not save product');
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
    const haystack = norm([product.name, product.sku, product.category, product.tags?.join(' ')].join(' '));
    return (!query || haystack.includes(query))
      && (!stock || (stock === 'low' && product.stock > 0 && product.stock <= LOW_STOCK_AT)
        || (stock === 'out' && product.stock <= 0));
  }

  async function renderProductList() {
    const products = getProducts()
      .filter(productMatchesFilters)
      .sort((left, right) => (Number(left.sortOrder) || 0) - (Number(right.sortOrder) || 0)
        || left.name.localeCompare(right.name));
    const imageUrls = await Promise.all(products.map((product) => (
      BACKEND
        ? BACKEND.media.resolveImage(product.imageUrl || product.imageId || product.image, product.imageVersion)
        : Promise.resolve(imageSrc(product.imageUrl || product.imageId || product.image))
    )));
    $('#catalogCount').textContent = productsCache.length;
    $('#productList').innerHTML = products.length
      ? products.map((product, index) => {
        const stockClass = product.stock <= 0 ? 'out' : product.stock <= LOW_STOCK_AT ? 'low' : 'ok';
        return `
          <article class="product-row">
            <img src="${escapeHtml(imageUrls[index])}" alt="" />
            <div class="product-row-info">
              <div class="product-row-title">
                <strong>${escapeHtml(product.name)}</strong>
                <span class="status-pill ${product.active ? 'published' : 'draft'}">${product.active ? 'Published' : 'Draft'}</span>
                <span class="stock-pill ${stockClass}">${product.stock <= 0 ? 'Out of stock' : product.stock <= LOW_STOCK_AT ? 'Low stock' : 'In stock'}</span>
              </div>
              <p>${escapeHtml(product.category)}${product.sku ? ` - ${escapeHtml(product.sku)}` : ''}</p>
              <div class="product-row-meta">
                <span>${fmt(product.price)}</span>
                <span>${product.stock} in stock</span>
                <span>Sort ${Number(product.sortOrder) || 0}</span>
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
    const reduction = metadata.originalBytes
      ? Math.max(0, Math.round((1 - metadata.bytes / metadata.originalBytes) * 100))
      : 0;
    result.hidden = false;
    result.innerHTML = `
      <strong>Optimized image ready</strong>
      <span>${metadata.width} x ${metadata.height} - ${formatBytes(metadata.bytes)}${
        metadata.originalBytes ? ` - ${reduction}% smaller` : ''
      }</span>
    `;
  }

  function imageOptimizationOptions() {
    const presets = {
      compact: { maxWidth: 1200, maxHeight: 1600, quality: 0.76 },
      balanced: { maxWidth: 1600, maxHeight: 2000, quality: 0.82 },
      detail: { maxWidth: 2000, maxHeight: 2400, quality: 0.88 },
    };
    return presets[$('#imageOptimization').value] || presets.balanced;
  }

  async function handleImageUpload(file) {
    if (!file || !BACKEND) return;
    const dropzone = $('#imageDropzone');
    dropzone.classList.add('is-processing');
    $('#imageOptimizationResult').hidden = false;
    $('#imageOptimizationResult').textContent = 'Optimizing image...';
    try {
      const saved = await BACKEND.media.saveImage(file, imageOptimizationOptions());
      $('#prodImageUrl').value = '';
      $('#prodImageId').value = saved.image;
      $('#prodImage').value = saved.image;
      $('#prodImageVersion').value = saved.imageVersion;
      $('#prodImageMeta').value = JSON.stringify(saved.imageMeta);
      showImageResult(saved.imageMeta);
      await updateProductPreview();
      toast('Image optimized for local fallback');
    } catch (error) {
      showImageResult(null);
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
    try {
      settingsCache = BACKEND?.settings?.update
        ? await BACKEND.settings.update(record)
        : record;
      if (!BACKEND?.settings?.update) writeLS(KEYS.settings, settingsCache);
      fillSettingsForm();
      toast('Settings saved');
    } catch (error) {
      toast(error.message || 'Could not save settings');
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
      toast('Promo saved');
    } catch (error) {
      toast(error.message || 'Could not save promo');
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
        if (target === 'dashboard') renderMetrics();
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
    ['#orderSearch', '#orderStatusFilter', '#paymentStatusFilter', '#orderDateFilter'].forEach((selector) => {
      $(selector).addEventListener('input', renderOrders);
      $(selector).addEventListener('change', renderOrders);
    });
    ['#productSearch', '#stockFilter'].forEach((selector) => {
      $(selector).addEventListener('input', () => void renderProductList());
      $(selector).addEventListener('change', () => void renderProductList());
    });
  }

  async function refreshAll() {
    await Promise.all([loadOrders(), loadProducts(), loadSettings(), loadPromos()]);
    updateCategoryOptions();
    updateImageOptions();
    fillSettingsForm();
    renderMetrics();
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
    }
    await refreshAll();
    applyBackendCapabilities();
    $('#logoutBtn').addEventListener('click', () => {
      window.PaviaAdminShell?.lock?.('Locked. Enter the admin credentials again.');
    });
    $('#productForm').addEventListener('submit', handleProductSubmit);
    $('#formReset').addEventListener('click', resetForm);
    $('#formCancel').addEventListener('click', resetForm);
    $('#settingsForm').addEventListener('submit', handleSettingsSubmit);
    $('#promoForm').addEventListener('submit', handlePromoSubmit);
    $('#promoReset').addEventListener('click', resetPromoForm);
    setupTabs();
    setupProductPreview();
    setupVariantBuilders();
    setupImageUploader();
    setupFilters();
    resetForm();
    resetPromoForm();
    $('#dashboard').hidden = false;
  });
})();
