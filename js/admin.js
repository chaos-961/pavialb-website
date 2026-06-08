/* Pavia Studio admin dashboard.
 * This is a client-side convenience gate, not server-side security.
 */
(() => {
  'use strict';

  const KEYS = {
    products: 'PAVIA_PRODUCTS',
    orders: 'PAVIA_ORDERS',
    pwHash: 'PAVIA_ADMIN_HASH_V2',
    session: 'PAVIA_ADMIN_SESSION_V2',
  };
  const DEFAULT_USER = 'admin';
  const DEFAULT_PASS_HASH = '96e34e7e9381851c922f86fcfe6e4d033766e9425c6f30ff5afeef953e17761f';
  const BACKEND = window.PaviaBackend;
  let productsCache = [];
  let ordersCache = [];

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

  function normalizeImagePath(value) {
    const path = String(value || '').trim();
    if (!path) return 'assets/logo.svg';
    return path.replace(/^(\.\/)+/, '').replace(/^(\.\.\/)+/, '');
  }

  function imageSrc(path) {
    const src = normalizeImagePath(path);
    if (/^(https?:|data:|\/)/i.test(src)) return src;
    return `../${src}`;
  }

  function splitList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
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

  function normalizeProduct(product) {
    const tags = Array.isArray(product.tags) ? product.tags : [];
    return {
      ...product,
      id: product.id || slugify(product.name),
      sku: product.sku || '',
      name: product.name || 'Untitled product',
      category: product.category || 'New Arrivals',
      price: Number(product.price) || 0,
      compareAt: Number(product.compareAt ?? product.comparePrice ?? 0) || 0,
      stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : 0,
      image: normalizeImagePath(product.image),
      imageVersion: product.imageVersion || '',
      imageMeta: product.imageMeta || null,
      description: product.description || '',
      sizes: Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['One size'],
      colors: Array.isArray(product.colors) ? product.colors : [],
      tags,
      badge: product.badge || '',
      featured: Boolean(product.featured),
      active: product.active !== false,
      material: product.material || '',
      fit: product.fit || '',
      care: product.care || '',
      createdAt: Number(product.createdAt) || Date.now(),
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

  async function saveProducts(products) {
    productsCache = products.map(normalizeProduct);
    if (BACKEND) await BACKEND.products.replace(productsCache);
    else writeLS(KEYS.products, productsCache);
  }

  async function sha256(text) {
    const encoded = new TextEncoder().encode(text);
    const buffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(buffer))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  async function getStoredHash() {
    let hash = localStorage.getItem(KEYS.pwHash);
    if (!hash) {
      hash = DEFAULT_PASS_HASH;
      localStorage.setItem(KEYS.pwHash, hash);
    }
    return hash;
  }

  function isAuthed() {
    return sessionStorage.getItem(KEYS.session) === 'ok';
  }

  function setAuthed(value) {
    if (value) sessionStorage.setItem(KEYS.session, 'ok');
    else sessionStorage.removeItem(KEYS.session);
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

  async function handleLogin(event) {
    event.preventDefault();
    const error = $('#loginError');
    error.classList.remove('show');

    const validUser = $('#loginUser').value.trim() === DEFAULT_USER;
    const validPassword = await sha256($('#loginPass').value) === await getStoredHash();
    if (!validUser || !validPassword) {
      error.textContent = 'Invalid username or password.';
      error.classList.add('show');
      return;
    }

    setAuthed(true);
    showDashboard();
  }

  function showLogin() {
    $('#loginScreen').hidden = false;
    $('#dashboard').hidden = true;
    $('#loginPass').value = '';
  }

  function showDashboard() {
    $('#loginScreen').hidden = true;
    $('#dashboard').hidden = false;
    void refreshAll();
  }

  function logout() {
    setAuthed(false);
    showLogin();
  }

  function getOrders() {
    return ordersCache.map((order) => ({
      ...order,
      status: order.status || 'available',
    }));
  }

  async function loadOrders() {
    const source = BACKEND ? await BACKEND.orders.list() : readLS(KEYS.orders, []);
    ordersCache = source;
  }

  function isAvailableOrder(order) {
    return ['available', 'new', 'pending'].includes(norm(order.status));
  }

  function renderOrderItem(order) {
    const customer = order.customer || {};
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
    const date = new Date(order.date || order.createdAt || Date.now()).toLocaleString();

    return `
      <article class="order-item" data-order-id="${escapeHtml(order.id)}">
        <div class="order-topline">
          <div>
            <span class="order-id">#${escapeHtml(order.id || '')}</span>
            <time>${escapeHtml(date)}</time>
          </div>
          <strong class="order-total">${fmt(order.total)}</strong>
        </div>
        <div class="order-customer">
          <div><span>Customer</span><strong>${escapeHtml(customer.name || 'Customer')}</strong></div>
          <div><span>Phone</span><strong>${escapeHtml(customer.phone || '-')}</strong></div>
          <div><span>Area</span><strong>${escapeHtml(customer.city || '-')}</strong></div>
          <div><span>Payment</span><strong>${escapeHtml(customer.payment || 'Cash on delivery')}</strong></div>
        </div>
        <p class="order-address">${escapeHtml(customer.address || 'No address supplied')}</p>
        ${customer.notes ? `<p class="order-note"><strong>Notes:</strong> ${escapeHtml(customer.notes)}</p>` : ''}
        <ul class="order-products">${items}</ul>
        <div class="order-actions">
          <button class="btn btn-primary" data-complete-order="${escapeHtml(order.id)}">Mark completed</button>
        </div>
      </article>
    `;
  }

  function renderAvailableOrders() {
    const orders = getOrders().filter(isAvailableOrder).reverse();
    $('#availableOrderCount').textContent = orders.length;
    $('#availableOrders').innerHTML = orders.length
      ? orders.map(renderOrderItem).join('')
      : `
        <div class="empty-state-admin">
          <strong>All caught up</strong>
          <p>New storefront orders will appear here.</p>
        </div>
      `;

    $$('[data-complete-order]').forEach((button) => {
      button.addEventListener('click', () => markOrderCompleted(button.dataset.completeOrder));
    });
  }

  async function markOrderCompleted(id) {
    if (BACKEND) await BACKEND.orders.complete(id);
    else {
      const order = ordersCache.find((item) => String(item.id) === String(id));
      if (!order) return;
      order.status = 'completed';
      order.completedAt = new Date().toISOString();
      writeLS(KEYS.orders, ordersCache);
    }
    await loadOrders();
    renderAvailableOrders();
    toast('Order marked completed');
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function parseImageMeta() {
    try {
      return JSON.parse($('#prodImageMeta').value || 'null');
    } catch {
      return null;
    }
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
      <span>${metadata.width} x ${metadata.height} · ${formatBytes(metadata.bytes)}${
        metadata.originalBytes ? ` · ${reduction}% smaller` : ''
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
      $('#prodImage').value = saved.image;
      $('#prodImageVersion').value = saved.imageVersion;
      $('#prodImageMeta').value = JSON.stringify(saved.imageMeta);
      showImageResult(saved.imageMeta);
      await updateProductPreview();
      toast('Image optimized and ready');
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
    const previewImage = $('#productPreviewImage');

    $('#productPreviewName').textContent = name;
    $('#productPreviewCategory').textContent = category;
    $('#productPreviewDescription').textContent = description;
    $('#productPreviewPrice').textContent = fmt(price);

    const compare = $('#productPreviewCompare');
    compare.hidden = !(compareAt > price);
    compare.textContent = fmt(compareAt);

    const badgeElement = $('#productPreviewBadge');
    badgeElement.hidden = !badge;
    badgeElement.textContent = badge;

    const statusElement = $('#productPreviewStatus');
    statusElement.textContent = status === 'published' ? 'Published' : 'Draft';
    statusElement.className = `status-pill ${status}`;

    previewImage.src = BACKEND
      ? await BACKEND.media.resolveImage($('#prodImage').value, $('#prodImageVersion').value)
      : imageSrc($('#prodImage').value);
    previewImage.alt = name;
  }

  function resetForm() {
    $('#productForm').reset();
    $('#prodId').value = '';
    $('#prodStock').value = 10;
    $('#prodStatus').value = 'published';
    $('#prodImageVersion').value = '';
    $('#prodImageMeta').value = '';
    $('#imageOptimizationResult').hidden = true;
    setSelectedSizes(['One size']);
    setColorRows([]);
    $('#formTitle').textContent = 'Add a product';
    $('#formSubmit').textContent = 'Add product';
    void updateProductPreview();
  }

  function loadIntoForm(id) {
    const product = getProducts().find((item) => item.id === id);
    if (!product) return;

    $('#prodId').value = product.id;
    $('#prodName').value = product.name;
    $('#prodCategory').value = product.category;
    $('#prodBadge').value = product.badge;
    $('#prodSku').value = product.sku;
    $('#prodStatus').value = product.active ? 'published' : 'draft';
    $('#prodFeatured').checked = product.featured;
    $('#prodDesc').value = product.description;
    $('#prodPrice').value = product.price;
    $('#prodCompare').value = product.compareAt || '';
    $('#prodStock').value = product.stock;
    $('#prodTags').value = product.tags.join(', ');
    $('#prodImage').value = product.image;
    $('#prodImageVersion').value = product.imageVersion || '';
    $('#prodImageMeta').value = product.imageMeta ? JSON.stringify(product.imageMeta) : '';
    showImageResult(product.imageMeta);
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
    const price = Number($('#prodPrice').value) || 0;
    const compareAt = Number($('#prodCompare').value) || 0;
    if (compareAt > 0 && compareAt <= price) {
      toast('Compare-at price must be higher than the selling price');
      $('#prodCompare').focus();
      return;
    }

    const products = getProducts();
    const id = $('#prodId').value || slugify($('#prodName').value);
    const existing = products.find((product) => product.id === id);
    const product = normalizeProduct({
      id,
      sku: $('#prodSku').value.trim(),
      name: $('#prodName').value.trim(),
      category: $('#prodCategory').value.trim(),
      badge: $('#prodBadge').value.trim(),
      active: $('#prodStatus').value === 'published',
      featured: $('#prodFeatured').checked,
      description: $('#prodDesc').value.trim(),
      price,
      compareAt,
      stock: Number.parseInt($('#prodStock').value, 10) || 0,
      tags: splitList($('#prodTags').value),
      image: normalizeImagePath($('#prodImage').value),
      imageVersion: $('#prodImageVersion').value,
      imageMeta: parseImageMeta(),
      sizes: splitList($('#prodSizes').value),
      colors: parseColors($('#prodColors').value),
      material: $('#prodMaterial').value.trim(),
      fit: $('#prodFit').value.trim(),
      care: $('#prodCare').value.trim(),
      createdAt: existing?.createdAt || Date.now(),
    });

    if (existing) Object.assign(existing, product);
    else products.push(product);

    await saveProducts(products);
    await renderProductList();
    resetForm();
    toast(existing ? 'Product updated' : 'Product added');
  }

  async function deleteProduct(id) {
    if (!window.confirm('Delete this product permanently?')) return;
    await saveProducts(getProducts().filter((product) => product.id !== id));
    await renderProductList();
    if ($('#prodId').value === id) resetForm();
    toast('Product deleted');
  }

  async function renderProductList() {
    const products = getProducts();
    const imageUrls = await Promise.all(products.map((product) => (
      BACKEND
        ? BACKEND.media.resolveImage(product.image, product.imageVersion)
        : Promise.resolve(imageSrc(product.image))
    )));
    $('#catalogCount').textContent = products.length;
    const wrap = $('#productList');
    wrap.innerHTML = products.length
      ? products.map((product, index) => `
        <article class="product-row">
          <img src="${escapeHtml(imageUrls[index])}" alt="" />
          <div class="product-row-info">
            <div class="product-row-title">
              <strong>${escapeHtml(product.name)}</strong>
              <span class="status-pill ${product.active ? 'published' : 'draft'}">${product.active ? 'Published' : 'Draft'}</span>
            </div>
            <p>${escapeHtml(product.category)}${product.sku ? ` · ${escapeHtml(product.sku)}` : ''}</p>
            <div class="product-row-meta">
              <span>${fmt(product.price)}</span>
              <span>${product.stock} in stock</span>
              ${product.featured ? '<span>Featured</span>' : ''}
            </div>
          </div>
          <div class="product-row-actions">
            <button class="btn btn-secondary" data-edit="${escapeHtml(product.id)}">Edit</button>
            <button class="btn btn-ghost danger-button" data-delete="${escapeHtml(product.id)}">Delete</button>
          </div>
        </article>
      `).join('')
      : '<div class="empty-state-admin"><strong>No products yet</strong><p>Add the first product using the editor above.</p></div>';

    $$('img', wrap).forEach((image) => {
      image.addEventListener('error', () => {
        image.src = '../assets/logo.svg';
      }, { once: true });
    });
    $$('[data-edit]', wrap).forEach((button) => {
      button.addEventListener('click', () => loadIntoForm(button.dataset.edit));
    });
    $$('[data-delete]', wrap).forEach((button) => {
      button.addEventListener('click', () => void deleteProduct(button.dataset.delete));
    });
  }

  async function handlePasswordChange(event) {
    event.preventDefault();
    const message = $('#pwMsg');
    message.classList.remove('show');

    if (await sha256($('#pwCurrent').value) !== await getStoredHash()) {
      message.textContent = 'Current password is incorrect.';
      message.classList.add('show');
      return;
    }
    if ($('#pwNew').value.length < 8) {
      message.textContent = 'New password must be at least 8 characters.';
      message.classList.add('show');
      return;
    }
    if ($('#pwNew').value !== $('#pwConfirm').value) {
      message.textContent = 'Passwords do not match.';
      message.classList.add('show');
      return;
    }

    localStorage.setItem(KEYS.pwHash, await sha256($('#pwNew').value));
    $('#passwordForm').reset();
    toast('Password updated');
  }

  function setupTabs() {
    $$('.admin-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        $$('.admin-tab').forEach((item) => item.classList.toggle('active', item === tab));
        $$('.admin-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.dataset.panel === target);
        });
        if (target === 'dashboard') renderAvailableOrders();
        if (target === 'products') void renderProductList();
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
      '#prodImage',
      '#prodStatus',
    ].forEach((selector) => {
      $(selector).addEventListener('input', () => void updateProductPreview());
      $(selector).addEventListener('change', () => void updateProductPreview());
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

  async function refreshAll() {
    await Promise.all([loadOrders(), loadProducts()]);
    renderAvailableOrders();
    await renderProductList();
    await updateProductPreview();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (BACKEND) {
      await BACKEND.init({ defaultProducts: window.PAVIA_DEFAULT_PRODUCTS || [] });
      BACKEND.orders.subscribe(async () => {
        await loadOrders();
        renderAvailableOrders();
      });
      BACKEND.products.subscribe(async () => {
        await loadProducts();
        await renderProductList();
      });
    }
    await Promise.all([loadOrders(), loadProducts()]);
    await getStoredHash();
    $('#loginForm').addEventListener('submit', handleLogin);
    $('#logoutBtn').addEventListener('click', logout);
    $('#productForm').addEventListener('submit', handleProductSubmit);
    $('#formReset').addEventListener('click', resetForm);
    $('#formCancel').addEventListener('click', resetForm);
    $('#passwordForm').addEventListener('submit', handlePasswordChange);
    setupTabs();
    setupProductPreview();
    setupVariantBuilders();
    setupImageUploader();
    resetForm();

    if (isAuthed()) showDashboard();
    else showLogin();
  });
})();
