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
  // Revision the open product had when the editor loaded it. Compared at save
  // time against the live (subscription-updated) rev to catch a concurrent edit
  // from another device before silently overwriting it. null = new product.
  let editingBaseRev = null;
  let ordersCache = [];
  let settingsCache = {};
  // P15 UX state
  let formDirty = false;
  let suppressDirty = false;
  let savingProduct = false;
  let savingSettings = false;
  let draftTimer = 0;
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
    const ref = order.orderNumber || order.id || '';
    const firstName = String(order.customer?.name || order.customerName || '').trim().split(/\s+/)[0] || '';
    const lines = (order.items || []).map((item) => {
      const color = typeof item.color === 'string' ? item.color : item.color?.name || '';
      const opts = [item.size, color].filter(Boolean).join('/');
      return `• ${item.qty || 1}× ${item.name}${opts ? ` (${opts})` : ''}`;
    });
    const body = [
      `Hello${firstName ? ` ${firstName}` : ''}, this is Pavia about your order${ref ? ` #${ref}` : ''}.`,
      lines.length ? '' : null,
      ...lines,
      Number.isFinite(Number(order.total)) ? `\nTotal: ${fmt(order.total)}` : null,
    ].filter((line) => line !== null).join('\n');
    return `https://wa.me/${phone}?text=${encodeURIComponent(body)}`;
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

  // ---- Custom dialogs (replace native confirm/alert/prompt) ----
  // Each returns a Promise: confirm/alert resolve a boolean, prompt resolves the
  // entered string or null when cancelled. One dialog shows at a time.
  let dialogResolve = null;
  function closeDialog(result) {
    const host = $('#paviaDialog');
    if (!host) return;
    host.classList.remove('show');
    host.hidden = true;
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(result);
  }
  function dialogOpen() {
    const host = $('#paviaDialog');
    return host && !host.hidden;
  }
  function openDialog({ title = '', message = '', confirmText = 'OK', cancelText = 'Cancel', showCancel = true, prompt = false, defaultValue = '', danger = false }) {
    return new Promise((resolve) => {
      const host = $('#paviaDialog');
      if (!host) { resolve(prompt ? (window.prompt(message || title, defaultValue) ?? null) : window.confirm(message || title)); return; }
      // Settle any dialog already open before opening a new one.
      if (dialogResolve) { const prev = dialogResolve; dialogResolve = null; prev(prompt ? null : false); }
      dialogResolve = resolve;
      const titleEl = $('#paviaDialogTitle');
      titleEl.textContent = title;
      titleEl.hidden = !title;
      const messageEl = $('#paviaDialogMessage');
      messageEl.textContent = message;
      messageEl.hidden = !message;
      const field = $('#paviaDialogField');
      const input = $('#paviaDialogInput');
      field.hidden = !prompt;
      if (prompt) input.value = defaultValue || '';
      const confirmBtn = $('#paviaDialogConfirm');
      const cancelBtn = $('#paviaDialogCancel');
      confirmBtn.textContent = confirmText;
      confirmBtn.classList.toggle('danger-button', Boolean(danger));
      cancelBtn.textContent = cancelText;
      cancelBtn.hidden = !showCancel;
      host.hidden = false;
      requestAnimationFrame(() => host.classList.add('show'));
      (prompt ? input : confirmBtn).focus({ preventScroll: true });
    });
  }
  function confirmDialog(message, opts = {}) {
    return openDialog({
      message,
      title: opts.title || 'Please confirm',
      confirmText: opts.confirmText || 'Confirm',
      cancelText: opts.cancelText || 'Cancel',
      danger: opts.danger,
    }).then(Boolean);
  }
  function alertDialog(message, opts = {}) {
    return openDialog({
      message,
      title: opts.title || 'Heads up',
      confirmText: opts.confirmText || 'OK',
      showCancel: false,
    }).then(() => true);
  }
  function promptDialog(message, defaultValue = '', opts = {}) {
    return openDialog({
      message,
      title: opts.title || message,
      prompt: true,
      defaultValue,
      confirmText: opts.confirmText || 'OK',
    });
  }
  function setupDialog() {
    const host = $('#paviaDialog');
    if (!host) return;
    const prompting = () => !$('#paviaDialogField').hidden;
    $('#paviaDialogConfirm').addEventListener('click', () => closeDialog(prompting() ? $('#paviaDialogInput').value : true));
    $('#paviaDialogCancel').addEventListener('click', () => closeDialog(prompting() ? null : false));
    host.addEventListener('click', (event) => { if (event.target === host) closeDialog(prompting() ? null : false); });
    $('#paviaDialogInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); closeDialog($('#paviaDialogInput').value); }
    });
  }

  // ---- New-order alerts ----
  // The orders subscription fires live. Announce genuinely new orders with a
  // toast, a soft beep, and a (N) title badge cleared when the owner refocuses
  // the tab. A 2-minute recency guard means pre-existing orders never alert,
  // even if the baseline snapshot is taken at an awkward moment.
  let knownOrderIds = null;
  let unseenOrders = 0;
  let orderAudioCtx = null;
  const adminBaseTitle = document.title || 'Pavia Studio';
  const NEW_ORDER_RECENT_MS = 2 * 60 * 1000;

  function updateOrderTitleBadge() {
    document.title = unseenOrders > 0 ? `(${unseenOrders}) ${adminBaseTitle}` : adminBaseTitle;
  }
  function clearOrderBadge() { if (unseenOrders) { unseenOrders = 0; updateOrderTitleBadge(); } }
  function orderBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      orderAudioCtx = orderAudioCtx || new Ctx();
      if (orderAudioCtx.state === 'suspended') orderAudioCtx.resume();
      const osc = orderAudioCtx.createOscillator();
      const gain = orderAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(orderAudioCtx.destination);
      const t = orderAudioCtx.currentTime;
      osc.start(t);
      osc.stop(t + 0.18);
    } catch { /* audio may be blocked — the toast + badge still notify */ }
  }
  function detectNewOrders() {
    const ids = ordersCache.map((order) => order.id).filter(Boolean);
    if (knownOrderIds === null) { knownOrderIds = new Set(ids); return; } // baseline, no alert
    const fresh = ordersCache.filter((order) => order.id && !knownOrderIds.has(order.id));
    fresh.forEach((order) => knownOrderIds.add(order.id));
    const now = Date.now();
    const reallyNew = fresh.filter((order) => {
      const t = Date.parse(order.createdAt || order.date || '');
      return Number.isFinite(t) && (now - t) < NEW_ORDER_RECENT_MS;
    });
    if (!reallyNew.length) return;
    toast(`${reallyNew.length} new order${reallyNew.length === 1 ? '' : 's'} received`);
    orderBeep();
    if (!document.hasFocus()) { unseenOrders += reallyNew.length; updateOrderTitleBadge(); }
  }
  window.addEventListener('focus', clearOrderBadge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) clearOrderBadge(); });

  // Field info "i": tap/click toggles its hint tooltip (desktop hover and keyboard
  // focus are handled in CSS). Tapping one closes any other; tapping away closes all.
  document.addEventListener('click', (event) => {
    const tip = event.target.closest ? event.target.closest('.field-tip') : null;
    document.querySelectorAll('.field-tip.is-open').forEach((open) => { if (open !== tip) open.classList.remove('is-open'); });
    if (tip) { event.preventDefault(); tip.classList.toggle('is-open'); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { document.querySelectorAll('.field-tip.is-open').forEach((open) => open.classList.remove('is-open')); return; }
    const tip = event.target.closest ? event.target.closest('.field-tip') : null;
    if (tip && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); tip.classList.toggle('is-open'); }
  });

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

  // Returns a Promise<boolean>. Callers must await it (custom dialog is async).
  function confirmDiscardIfDirty(message) {
    if (!formDirty) return Promise.resolve(true);
    return confirmDialog(message, { title: 'Discard changes?', confirmText: 'Discard', danger: true });
  }

  function serializeProductForm() {
    return {
      id: $('#prodId').value,
      slug: $('#prodSlug').value,
      name: $('#prodName').value,
      category: $('#prodCategory').value,
      badge: $('#prodBadge').value,
      status: $('#prodStatus').value,
      featured: $('#prodFeatured').checked,
      description: $('#prodDesc').value,
      price: $('#prodPrice').value,
      tags: $('#prodTags').value,
      sizes: $('#prodSizes').value,
      colors: $('#prodColors').value,
      imageUrl: $('#prodImageUrl').value,
      imageId: $('#prodImageId').value,
      imageVersion: $('#prodImageVersion').value,
      imageMeta: $('#prodImageMeta').value,
      storageKey: $('#prodStorageKey').value,
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
    $('#prodStatus').value = draft.status || 'published';
    $('#prodFeatured').checked = Boolean(draft.featured);
    $('#prodDesc').value = draft.description || '';
    $('#prodPrice').value = draft.price || '';
    $('#prodTags').value = draft.tags || '';
    $('#prodImageUrl').value = draft.imageUrl || '';
    $('#prodImageId').value = draft.imageId || '';
    $('#prodImage').value = draft.imageUrl || draft.imageId || '';
    $('#prodImageVersion').value = draft.imageVersion || '';
    $('#prodImageMeta').value = draft.imageMeta || '';
    $('#prodStorageKey').value = draft.storageKey || '';
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

  // Accept a typed color like "#c9a779", "c9a779", "#fff", or "FFF" and return a
  // canonical 6-digit "#rrggbb" the native swatch can hold. Returns null while the
  // text is not yet a valid hex color, so callers can wait for more typing.
  function normalizeHex(value) {
    let v = String(value == null ? '' : value).trim().replace(/^#+/, '');
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.split('').map((c) => c + c).join('');
    return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : null;
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
    const startHex = normalizeHex(color.hex) || '#c9a779';
    const row = document.createElement('div');
    row.className = 'color-row';
    row.innerHTML = `
      <label class="color-swatch-control" title="Choose color">
        <input data-color-value type="color" value="${escapeHtml(startHex)}" />
        <span style="background:${escapeHtml(startHex)}"></span>
      </label>
      <label class="color-name-field">
        Color name
        <input data-color-name type="text" value="${escapeHtml(color.name || '')}" placeholder="e.g. Ivory" />
      </label>
      <label class="color-hex-field">
        Hex
        <input data-color-hex type="text" value="${escapeHtml(startHex)}" placeholder="#c9a779"
          spellcheck="false" autocapitalize="off" autocomplete="off" maxlength="7" aria-label="Hex color code" />
      </label>
      <button type="button" class="remove-color" aria-label="Remove color">&times;</button>
    `;
    $('#colorBuilder').appendChild(row);

    const picker = $('[data-color-value]', row);
    const hexInput = $('[data-color-hex]', row);
    const swatch = $('.color-swatch-control span', row);

    // Keep the swatch, the native picker, and the typed hex box in lockstep.
    function applyHex(hex) {
      picker.value = hex;
      swatch.style.background = hex;
      syncColorsField();
    }
    // Native picker -> hex text box.
    picker.addEventListener('input', () => {
      hexInput.value = picker.value;
      swatch.style.background = picker.value;
      syncColorsField();
    });
    // Typed hex -> picker, but only once it parses to a real color so a
    // half-typed value does not snap the swatch around mid-keystroke.
    hexInput.addEventListener('input', () => {
      const hex = normalizeHex(hexInput.value);
      if (hex) applyHex(hex);
    });
    // On blur, tidy the field: canonicalize a valid value to #rrggbb, or restore
    // the last good color when the text was left incomplete.
    hexInput.addEventListener('blur', () => {
      const hex = normalizeHex(hexInput.value);
      hexInput.value = hex || picker.value;
      if (hex) applyHex(hex);
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
    // A product intentionally saved with no image is not a migration candidate,
    // even though normalizeProduct backfills image with the neutral logo path.
    const image = String(product.image || '').trim();
    const hasNoImage = !product.imageUrl && !product.imageId
      && (!image || image === 'assets/logo.svg' || image === '../assets/logo.svg');
    if (hasNoImage) return false;
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
      name: product.name || 'Untitled product',
      category: product.category || 'New Arrivals',
      price: Number(product.price) || 0,
      compareAt: Number(product.compareAt ?? product.comparePrice ?? 0) || 0,
      // Stock removed from the store: persist a high constant so any code path that
      // still reads stock treats every product as always orderable.
      stock: 999999,
      imageId,
      imageUrl,
      image: imageUrl || imageId || normalizeImagePath(product.image),
      imageProvider: product.imageProvider || ((product.storageKey || imageUrl) ? 'external' : 'local_legacy'),
      storageKey: product.storageKey || '',
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
      && (!query || haystack.includes(query));
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
          <div><span>Phone</span><strong>${escapeHtml(phone || 'Not provided')}</strong></div>
          <div><span>Area</span><strong>${escapeHtml(customer.city || customer.area || 'Not provided')}</strong></div>
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
          <button class="btn btn-ghost" data-export-order="${id}">Export</button>
          ${order.status === 'cancelled' ? `<button class="btn btn-ghost danger-button" data-delete-order="${id}"${disabled}>Delete</button>` : ''}
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
      : ($('#orderSearch')?.value
        ? '<div class="empty-state-admin"><strong>No matching orders</strong><p>Try clearing the search.</p></div>'
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
    $$('[data-export-order]').forEach((button) => {
      button.addEventListener('click', () => exportOrder(button.dataset.exportOrder));
    });
    $$('[data-delete-order]').forEach((button) => {
      button.addEventListener('click', () => void deleteOrder(button.dataset.deleteOrder));
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
      const reason = await promptDialog('Reason for cancelling this order? (optional)', '', { title: 'Cancel order', confirmText: 'Cancel order' });
      if (reason === null) return; // dismissed the dialog
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

  // Hard-delete an order. Guarded to cancelled orders only, with a custom confirm.
  async function deleteOrder(id) {
    if (!orderManagementEnabled()) {
      toast('Order management is disabled for this session');
      return;
    }
    const order = ordersCache.find((item) => String(item.id) === String(id));
    if (!order) return;
    if (normalizeStatus(order.status) !== 'cancelled') {
      toast('Only cancelled orders can be deleted');
      return;
    }
    const label = order.orderNumber || order.id;
    const ok = await confirmDialog(
      `Delete order #${label} permanently? This cannot be undone.`,
      { title: 'Delete order', confirmText: 'Delete order', danger: true },
    );
    if (!ok) return;
    try {
      if (BACKEND?.orders?.remove) await BACKEND.orders.remove(id);
      else {
        ordersCache = ordersCache.filter((item) => String(item.id) !== String(id));
        writeLS(KEYS.orders, ordersCache);
      }
      await loadOrders();
      renderOrders();
      renderMetrics();
      toast('Order deleted');
    } catch (error) {
      toast(error.message || 'Could not delete order');
    }
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
    if (product.price <= 0) errors.prodPrice = 'Price must be greater than zero.';
    // A product may have no image at all — the storefront shows an elegant
    // placeholder. Only enforce HTTPS when an image URL is actually set.
    if (product.imageUrl && !/^https:\/\//i.test(product.imageUrl)) {
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
    editingBaseRev = null;
    $('#productForm').reset();
    $('#prodId').value = '';
    $('#prodSlug').value = '';
    $('#prodStatus').value = 'published';
    $('#prodImageId').value = '';
    $('#prodImageUrl').value = '';
    $('#prodImage').value = '';
    $('#prodImageVersion').value = '';
    $('#prodImageMeta').value = '';
    $('#prodStorageKey').value = '';
    $('#prodImageProvider').value = '';
    $('#prodGallery').value = '';
    galleryItems = [];
    renderGalleryStrip();
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

  async function loadIntoForm(id) {
    const product = getProducts().find((item) => item.id === id);
    if (!product) return;
    if (!(await confirmDiscardIfDirty('Discard unsaved changes and edit this product?'))) return;
    suppressDirty = true;
    setFormStatus('productFormStatus', '');
    editingBaseRev = Number(product.rev) || 0;
    $('#prodId').value = product.id;
    $('#prodSlug').value = product.slug || product.id;
    $('#prodName').value = product.name;
    $('#prodCategory').value = product.category;
    $('#prodBadge').value = product.badge;
    $('#prodStatus').value = product.active ? 'published' : 'draft';
    $('#prodFeatured').checked = product.featured;
    $('#prodDesc').value = product.description;
    $('#prodPrice').value = product.price;
    $('#prodTags').value = product.tags.join(', ');
    $('#prodImageId').value = product.imageUrl ? '' : (product.imageId || '');
    $('#prodImageUrl').value = product.imageUrl || '';
    $('#prodImage').value = product.imageUrl || product.imageId || product.image;
    $('#prodImageVersion').value = product.imageVersion || '';
    $('#prodImageMeta').value = product.imageMeta ? JSON.stringify(product.imageMeta) : '';
    $('#prodStorageKey').value = product.storageKey || product.imageMeta?.storageKey || '';
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
    // Move keyboard focus into the populated editor (the Edit button is now
    // offscreen); preventScroll so it doesn't fight the smooth scroll above.
    $('#prodName')?.focus({ preventScroll: true });
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
    const storageKey = $('#prodStorageKey').value.trim();
    const imageProvider = $('#prodImageProvider').value.trim()
      || ((storageKey || imageUrl) ? 'external' : 'local_legacy');
    const existing = productsCache.find((product) => product.id === $('#prodId').value);
    const product = normalizeProduct({
      id,
      slug: id,
      name: $('#prodName').value.trim(),
      category: $('#prodCategory').value.trim(),
      badge: $('#prodBadge').value.trim(),
      active: $('#prodStatus').value === 'published',
      featured: $('#prodFeatured').checked,
      // Sort order is auto-managed: keep the existing position on edit, append new
      // products to the end. Owners arrange products by dragging in the catalog.
      sortOrder: Number(existing?.sortOrder) || nextSortOrder(),
      description: $('#prodDesc').value.trim(),
      price: Number($('#prodPrice').value) || 0,
      tags: splitList($('#prodTags').value),
      image: imageUrl || imageId,
      imageId,
      imageUrl,
      imageProvider,
      storageKey,
      imageVersion: $('#prodImageVersion').value,
      imageMeta: parseImageMeta(),
      gallery: parseGalleryField(),
      sizes: selectedSizes(),
      colors: parseColors($('#prodColors').value),
      rev: Number(existing?.rev) || 0,
      createdAt: existing?.createdAt || new Date().toISOString(),
    });

    if (!validateProduct(id, product)) {
      setFormStatus('productFormStatus', 'Fix the highlighted fields and try again.', 'error');
      toast('Fix the highlighted product fields');
      return;
    }

    // Concurrent-edit guard: if this product's stored revision advanced past the
    // one we opened (another device/tab saved in the meantime), don't silently
    // clobber it — confirm first. productsCache is kept live by the subscription.
    if (existing && editingBaseRev !== null && (Number(existing.rev) || 0) > editingBaseRev) {
      const proceed = await confirmDialog(
        'This product was changed elsewhere since you opened it. Save anyway and overwrite those changes?',
        { title: 'Product changed elsewhere', confirmText: 'Overwrite', danger: true },
      );
      if (!proceed) {
        setFormStatus('productFormStatus', 'Save cancelled. Reopen the product to load the latest version.', 'error');
        toast('Save cancelled: product changed elsewhere');
        return;
      }
      editingBaseRev = Number(existing.rev) || 0; // accept current as the new base
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
    const ok = await confirmDialog(
      `Delete "${name}" permanently? This removes it from the public storefront too.`,
      { title: 'Delete product', confirmText: 'Delete product', danger: true },
    );
    if (!ok) return;
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
    const imageFilter = $('#imageMigrationFilter')?.value || '';
    const haystack = norm([product.name, product.category, product.tags?.join(' ')].join(' '));
    return (!query || haystack.includes(query))
      && (!imageFilter || (imageFilter === 'needs-image' && productNeedsImageMigration(product)));
  }

  function productSortKey() {
    return $('#productSort')?.value || 'sortOrder';
  }

  // Reordering is only meaningful (and unambiguous) in the unfiltered "My order" view.
  function reorderEnabled() {
    return productSortKey() === 'sortOrder'
      && !norm($('#productSearch')?.value || '')
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
    const total = matched.length;
    $('#productList').innerHTML = products.length
      ? products.map((product, index) => {
        const selected = selectedProductIds.has(product.id);
        // Absolute position across the whole catalog (not just this page).
        const position = catalogPage * CATALOG_PAGE_SIZE + index;
        const move = canReorder ? `
          <div class="row-move" role="group" aria-label="Reorder">
            <button type="button" class="row-move-btn" data-move-up="${escapeHtml(product.id)}" aria-label="Move up"${position === 0 ? ' disabled' : ''}>↑</button>
            <span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
            <button type="button" class="row-move-btn" data-move-down="${escapeHtml(product.id)}" aria-label="Move down"${position >= total - 1 ? ' disabled' : ''}>↓</button>
          </div>` : '';
        return `
          <article class="product-row${selected ? ' is-selected' : ''}" data-product-id="${escapeHtml(product.id)}"${canReorder ? ' draggable="true"' : ''}>
            <div class="row-lead">
              <label class="row-select">
                <input type="checkbox" data-select="${escapeHtml(product.id)}"${selected ? ' checked' : ''} aria-label="Select ${escapeHtml(product.name)}" />
              </label>
              ${move}
            </div>
            <img src="${escapeHtml(imageUrls[index])}" alt="" />
            <div class="product-row-info">
              <div class="product-row-title">
                <strong>${escapeHtml(product.name)}</strong>
                <span class="status-pill ${product.active ? 'published' : 'draft'}">${product.active ? 'Published' : 'Draft'}</span>
              </div>
              <p>${escapeHtml(product.category)}</p>
              <div class="product-row-inline">
                <strong class="row-price">${fmt(product.price)}</strong>
                ${productNeedsImageMigration(product) ? '<span class="row-flag">Needs image migration</span>' : ''}
                ${product.featured ? '<span class="row-flag">Featured</span>' : ''}
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
      button.addEventListener('click', () => void loadIntoForm(button.dataset.edit));
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
    $$('[data-move-up]').forEach((button) => {
      button.addEventListener('click', () => void moveProductByStep(button.dataset.moveUp, -1));
    });
    $$('[data-move-down]').forEach((button) => {
      button.addEventListener('click', () => void moveProductByStep(button.dataset.moveDown, 1));
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

  // Move a product one position earlier/later in the custom order. Mobile-friendly
  // alternative to dragging; delegates to reorderProducts with the neighbour's id.
  async function moveProductByStep(id, delta) {
    if (!adminMutationsEnabled()) {
      toast('Catalog editing is disabled for this session');
      return;
    }
    const sortOrderComparator = CORE.compareProducts
      ? CORE.compareProducts('sortOrder')
      : (a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    const ordered = [...productsCache].sort(sortOrderComparator);
    const from = ordered.findIndex((item) => item.id === id);
    if (from < 0) return;
    const to = from + delta;
    if (to < 0 || to >= ordered.length) return;
    await reorderProducts(id, ordered[to].id);
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
    if (action === 'delete' && !(await confirmDialog(
      `Delete ${ids.size} selected product(s) permanently?`,
      { title: 'Delete products', confirmText: 'Delete', danger: true },
    ))) return;
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

  function imageOptimizationOptions() {
    // Single balanced profile (the upload-detail selector was removed). ~1600px long
    // edge at good quality, encoded down to stay comfortably under 400 KB — usually
    // ~200-320 KB — so every product image is light but still sharp.
    return { longEdge: 1600, quality: 0.82, targetBytes: 320 * 1024, maxDetailBytes: 380 * 1024 };
  }

  async function updateProductPreview() {
    const name = $('#prodName').value.trim() || 'Product name';
    const category = $('#prodCategory').value.trim() || 'Category';
    const description = $('#prodDesc').value.trim() || 'Your product description will appear here.';
    const badge = $('#prodBadge').value.trim();
    const price = Number($('#prodPrice').value) || 0;
    const status = $('#prodStatus').value;
    const imageRef = imageReferenceFromFields();

    $('#prodImage').value = imageRef;
    $('#productPreviewName').textContent = name;
    $('#productPreviewCategory').textContent = category;
    $('#productPreviewDescription').textContent = description;
    $('#productPreviewPrice').textContent = fmt(price);
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
    $('#settingTagline').value = settingsCache.tagline || '';
    $('#settingLocation').value = settingsCache.location || '';
    $('#settingDeliveryArea').value = settingsCache.deliveryArea || '';
    $('#settingHeroHeadline').value = settingsCache.heroHeadline || '';
    $('#settingDescription').value = settingsCache.description || '';
    $('#settingAnnouncementText').value = settingsCache.announcementText || '';
    $('#settingAnnouncementEnabled').checked = Boolean(settingsCache.announcementEnabled);
    $('#settingAddressLine').value = settingsCache.addressLine || '';
    $('#settingMapsUrl').value = settingsCache.mapsUrl || '';
    $('#settingBusinessHours').value = settingsCache.businessHours || '';
    $('#settingPhone').value = settingsPhone();
    $('#settingInstagramHandle').value = String(settingsCache.instagramHandle || '').replace(/^@+/, '');
    $('#settingDeliveryFee').value = settingsCache.deliveryFee !== undefined && settingsCache.deliveryFee !== null
      ? Number(settingsCache.deliveryFee)
      : 3;
    $('#settingCheckoutEnabled').checked = settingsCache.checkoutEnabled !== false;
    $('#settingCash').checked = settingsCache.paymentMethods?.cash_on_delivery !== false;
    $('#settingWhish').checked = settingsCache.paymentMethods?.whish_money !== false;
  }

  function validateSettings(phone, deliveryFee, mapsUrl) {
    setFieldError('settingPhone');
    setFieldError('settingDeliveryFee');
    setFieldError('settingMapsUrl');
    let ok = true;
    if (phone && !/^[+\d][\d\s().-]{5,23}$/.test(phone)) {
      setFieldError('settingPhone', 'Enter a valid phone number, or leave it blank.');
      ok = false;
    }
    if (!(deliveryFee >= 0) || deliveryFee > 10000) {
      setFieldError('settingDeliveryFee', 'Delivery fee must be between 0 and 10000.');
      ok = false;
    }
    if (mapsUrl && !/^https:\/\//i.test(mapsUrl)) {
      setFieldError('settingMapsUrl', 'Maps link must start with https://, or leave it blank.');
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
    const mapsUrl = $('#settingMapsUrl').value.trim();
    if (!validateSettings(phone, deliveryFee, mapsUrl)) {
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
      tagline: $('#settingTagline').value.trim(),
      location: $('#settingLocation').value.trim(),
      deliveryArea: $('#settingDeliveryArea').value.trim(),
      heroHeadline: $('#settingHeroHeadline').value.trim(),
      description: $('#settingDescription').value.trim(),
      announcementText: $('#settingAnnouncementText').value.trim(),
      announcementEnabled: $('#settingAnnouncementEnabled').checked,
      addressLine: $('#settingAddressLine').value.trim(),
      mapsUrl,
      businessHours: $('#settingBusinessHours').value.trim(),
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

  function imageStore() { return window.PaviaImageStore; }

  // Map of storageKey -> [product names] using it (main image or a gallery entry).
  function storageImageUsage() {
    const usage = new Map();
    const add = (id, name) => {
      const key = String(id || '').trim();
      if (!key) return;
      if (!usage.has(key)) usage.set(key, new Set());
      usage.get(key).add(name);
    };
    productsCache.forEach((product) => {
      const name = product.name || product.id;
      add(product.storageKey || product.imageMeta?.storageKey, name);
      (Array.isArray(product.gallery) ? product.gallery : []).forEach((entry) => add(entry?.storageKey, name));
    });
    const out = new Map();
    usage.forEach((set, key) => out.set(key, [...set]));
    return out;
  }

  // ---- Library storage (imgbb) status ----
  function setLibraryStorageStatus(message, detail = '') {
    if ($('#libraryStorageStatus')) $('#libraryStorageStatus').textContent = message;
    if ($('#libraryStorageDetail')) $('#libraryStorageDetail').textContent = detail;
  }
  function refreshLibraryStoragePanel() {
    const button = $('#libraryConnectBtn');
    const dropzone = $('#libraryDropzone');
    const store = imageStore();
    if (!store?.configured?.()) {
      setLibraryStorageStatus('Image storage not configured', 'Add your imgbb API key in js/backend-config.js.');
      if (button) { button.disabled = true; button.hidden = false; }
      if (dropzone) dropzone.hidden = true;
      return;
    }
    // imgbb uploads need no connect step, so hide the connect button entirely and
    // always show the dropzone once configured.
    if (button) button.hidden = true;
    setLibraryStorageStatus('Image storage ready', 'Upload images below, or add them while editing a product.');
    if (dropzone) dropzone.hidden = false;
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
    if (libraryLoading) return;
    libraryLoading = true;
    refreshLibraryStoragePanel();
    try {
      // The saved library lives in the backend, so images show without a storage
      // connection. Connecting is only needed to upload or delete.
      const saved = await BACKEND?.mediaLibrary?.list?.();
      libraryCache = Array.isArray(saved) ? saved : [];
      libraryPage = 0;
      renderLibrary();

      // Some providers can list the live bucket and reconcile the saved index.
      // imgbb can't from the browser, so this block is skipped and the RTDB
      // library index above is authoritative.
      if (imageStore()?.canList?.()) {
        if (!silent) setLibraryStatus('Loading library…');
        const files = await imageStore().listFiles({ pageSize: 300 });
        libraryCache = files;
        libraryPage = 0;
        if (!silent) setLibraryStatus('');
        try { await BACKEND?.mediaLibrary?.replaceAll?.(files); }
        catch (error) { console.warn('Could not save the image library index.', error); }
      }
    } catch (error) {
      setLibraryStatus(error.message || 'Could not load the library', true);
    } finally {
      libraryLoading = false;
      renderLibrary();
    }
  }

  function libraryTileHtml(file, usage, picker, connected = false) {
    const used = usage.get(file.id) || [];
    const dims = file.width && file.height ? ` · ${file.width}×${file.height}` : '';
    const usageText = used.length ? `Used by ${used.length} product${used.length === 1 ? '' : 's'}` : 'Unused';
    const thumb = `<div class="library-thumb"><img src="${escapeHtml(file.imageUrl)}" alt="${escapeHtml(file.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></div>`;
    const caption = `
      <figcaption>
        <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(formatBytes(file.size))}${escapeHtml(dims)}</span>
        <span class="library-usage ${used.length ? 'is-used' : 'is-free'}" title="${escapeHtml(used.join(', '))}">${escapeHtml(usageText)}</span>
      </figcaption>`;
    // Picker tiles are a single tappable button so the whole card selects the image.
    if (picker) {
      return `
        <button type="button" class="library-tile library-tile-pick" data-file-id="${escapeHtml(file.id)}" data-lib-pick>
          ${thumb}
          ${caption}
          <span class="library-pick-check" aria-hidden="true">Select</span>
        </button>`;
    }
    // Delete needs the storage connection, so it only appears when connected.
    // Copy URL is safe offline.
    const deleteButton = connected
      ? `<button type="button" class="btn btn-ghost danger-button" data-lib-delete${used.length ? ' title="In use, remove from products first"' : ''}>Delete</button>`
      : '';
    return `
      <figure class="library-tile" data-file-id="${escapeHtml(file.id)}">
        ${thumb}
        ${caption}
        <div class="library-tile-actions">
          <button type="button" class="btn btn-ghost" data-lib-copy>Copy URL</button>
          ${deleteButton}
        </div>
      </figure>`;
  }

  function renderLibrary() {
    const grid = $('#libraryGrid');
    const pager = $('#libraryPager');
    if (!grid) return;
    $('#libraryCount').textContent = libraryCache.length;
    // "connected" here means uploads/actions are available. imgbb is ready
    // whenever it's configured (uploads need no connect step).
    const connected = Boolean(imageStore()?.connected?.());

    if (!libraryCache.length) {
      if (!imageStore()?.configured?.()) {
        grid.innerHTML = '<div class="empty-state-admin"><strong>Image storage not configured</strong><p>Add your imgbb API key in js/backend-config.js.</p></div>';
      } else {
        grid.innerHTML = '<div class="empty-state-admin"><strong>No images yet</strong><p>Upload images above, or add them while editing a product.</p></div>';
      }
      pager.hidden = true;
      return;
    }

    const usage = storageImageUsage();
    const pages = Math.max(1, Math.ceil(libraryCache.length / LIBRARY_PAGE_SIZE));
    libraryPage = Math.min(libraryPage, pages - 1);
    const start = libraryPage * LIBRARY_PAGE_SIZE;
    const slice = libraryCache.slice(start, start + LIBRARY_PAGE_SIZE);
    grid.innerHTML = slice.map((file) => libraryTileHtml(file, usage, false, connected)).join('');

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
    const used = storageImageUsage().get(fileId) || [];
    if (used.length) {
      await alertDialog(`This image is still used by: ${used.join(', ')}. Remove it from those products first, then delete it here.`, { title: 'Image in use' });
      return;
    }
    const ok = await confirmDialog(`Remove "${file?.name || 'this image'}" from your library? The file stays on imgbb; you can delete it from your imgbb account later.`, { title: 'Remove image', confirmText: 'Remove', danger: true });
    if (!ok) return;
    try {
      await imageStore().deleteFile(fileId);
      try { await BACKEND?.mediaLibrary?.remove?.(fileId); }
      catch (error) { console.warn('Could not update the saved image library.', error); }
      libraryCache = libraryCache.filter((item) => item.id !== fileId);
      renderLibrary();
      toast('Image removed from library');
    } catch (error) {
      toast(error.message || 'Could not delete the image');
    }
  }

  // imgbb needs no connect step. This just refreshes the library; the connect
  // button is hidden while imgbb is the provider.
  async function connectLibraryStorage() {
    refreshLibraryStoragePanel();
    await loadLibrary();
  }

  async function handleLibraryUpload(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    const store = imageStore();
    if (!store) { toast('Image storage tools are unavailable'); return; }
    if (!store.configured?.()) {
      toast('Add your imgbb API key in js/backend-config.js first');
      refreshLibraryStoragePanel();
      return;
    }
    let done = 0;
    for (let i = 0; i < list.length; i += 1) {
      // Frame each image to 4:5 before it uploads; skip any the owner cancels.
      const file = await openCropper(list[i], `Library image · 4:5 (${i + 1}/${list.length})`);
      if (!file) continue;
      $('#libraryDropzone')?.classList.add('is-processing');
      try {
        setLibraryStatus(`Optimizing ${file.name} (${done + 1}/${list.length})…`);
        const optimized = await imageStore().optimizeImage(file, imageOptimizationOptions());
        setLibraryStatus(`Uploading ${file.name} (${done + 1}/${list.length})…`);
        const uploaded = await imageStore().uploadOptimizedImage(optimized);
        const record = {
          id: uploaded.storageKey,
          name: uploaded.imageMeta?.optimizedName || file.name,
          mimeType: uploaded.imageMeta?.mimeType || 'image/webp',
          size: Number(uploaded.imageMeta?.byteSize) || 0,
          createdTime: new Date().toISOString(),
          width: Number(uploaded.imageMeta?.width) || 0,
          height: Number(uploaded.imageMeta?.height) || 0,
          imageUrl: uploaded.imageUrl,
          imageVersion: uploaded.imageVersion || uploaded.imageMeta?.imageVersion || '',
          contentHash: uploaded.imageMeta?.contentHash || '',
        };
        libraryCache.unshift(record);
        // Save the record so the image shows in the library even before connecting.
        try { await BACKEND?.mediaLibrary?.upsert?.(record); }
        catch (error) { console.warn('Could not save the uploaded image to the library index.', error); }
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
    return {
      imageUrl: file.imageUrl,
      storageKey: file.id,
      imageVersion: file.imageVersion || '',
      imageMeta: {
        storageKey: file.id,
        optimizedName: file.name,
        byteSize: file.size,
        provider: 'imgbb',
        publicUrl: file.imageUrl,
        imageVersion: file.imageVersion || '',
        contentHash: file.contentHash || '',
      },
    };
  }
  async function openLibraryPicker(mode) {
    libraryPickerMode = mode === 'main' ? 'main' : 'gallery';
    const picker = $('#libraryPicker');
    $('#libraryPickerTitle').textContent = libraryPickerMode === 'main' ? 'Choose the main image' : 'Add gallery images';
    $('#libraryPickerHint').textContent = libraryPickerMode === 'main' ? 'Pick the photo shown on the product card.' : 'Pick a photo to add to the gallery.';
    picker.hidden = false;
    const grid = $('#libraryPickerGrid');
    grid.innerHTML = '<div class="empty-state-admin"><strong>Loading…</strong></div>';
    if (!libraryCache.length) await loadLibrary({ silent: true });
    renderLibraryPicker();
  }
  function closeLibraryPicker() { $('#libraryPicker').hidden = true; }
  function renderLibraryPicker() {
    const grid = $('#libraryPickerGrid');
    if (!grid) return;
    if (!libraryCache.length) {
      grid.innerHTML = '<div class="empty-state-admin"><strong>Library is empty</strong><p>Open Library to upload or refresh your images first.</p><button type="button" class="btn btn-secondary" data-open-library>Open Library</button></div>';
      grid.querySelector('[data-open-library]')?.addEventListener('click', () => {
        closeLibraryPicker();
        activateTab('library');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return;
    }
    const usage = storageImageUsage();
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
    return { imageUrl, storageKey: $('#prodStorageKey').value.trim(), imageVersion: $('#prodImageVersion').value.trim() };
  }
  function setMainImage(item) {
    $('#prodImageUrl').value = item.imageUrl || '';
    $('#prodImageId').value = '';
    $('#prodImage').value = item.imageUrl || '';
    $('#prodImageVersion').value = item.imageVersion || '';
    $('#prodStorageKey').value = item.storageKey || '';
    $('#prodImageProvider').value = (item.storageKey || item.imageUrl) ? 'external' : 'local_legacy';
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
    galleryItems.push({ imageUrl: item.imageUrl, storageKey: item.storageKey || '', imageVersion: item.imageVersion || '' });
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
      : '<p class="gallery-empty">No images selected yet. Choose a main image or add gallery images from the Library.</p>';

    $$('[data-gallery-remove]', strip).forEach((button) => {
      button.addEventListener('click', () => {
        const tile = button.closest('[data-gallery-index]');
        const index = Number(tile.dataset.galleryIndex);
        if (index < 0) { // removing the main image
          if (galleryItems.length) {
            // Promote the first gallery image so the product keeps a main image.
            const next = galleryItems.shift();
            syncGalleryField();
            $('#prodImageMeta').value = '';
            setMainImage(next);
          } else {
            setMainImage({ imageUrl: '', storageKey: '', imageVersion: '' });
            $('#prodImageMeta').value = '';
          }
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

  // ============================================================
  // 4:5 crop / framing step (runs before every image upload so the
  // owner controls exactly what the product card shows).
  // ============================================================
  const CROP_STAGE_W = 320;
  const CROP_STAGE_H = 400;          // 4:5 — matches the storefront card
  const CROP_MAX_OUT_W = 1600;
  let cropBitmap = null;
  let cropResolve = null;
  let cropName = 'image';
  let cropCover = 1;
  let cropZoom = 1;
  let cropOX = 0;
  let cropOY = 0;
  let cropRotation = 0;
  let cropFlipX = 1;
  let cropFlipY = 1;
  let cropBrightness = 100;
  let cropContrast = 100;
  let cropSaturation = 100;
  let cropDragging = false;
  let cropLastX = 0;
  let cropLastY = 0;

  function loadCropBitmap(file) {
    if (window.createImageBitmap) return window.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => window.createImageBitmap(file));
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('open failed')); };
      img.src = url;
    });
  }

  function clampCropOffsets(dispW, dispH) {
    cropOX = Math.min(0, Math.max(CROP_STAGE_W - dispW, cropOX));
    cropOY = Math.min(0, Math.max(CROP_STAGE_H - dispH, cropOY));
  }

  function rotatedCropSize() {
    const quarterTurn = Math.abs(cropRotation % 180) === 90;
    return {
      width: quarterTurn ? cropBitmap.height : cropBitmap.width,
      height: quarterTurn ? cropBitmap.width : cropBitmap.height,
    };
  }

  function centerCrop() {
    if (!cropBitmap) return;
    const size = rotatedCropSize();
    const scale = cropCover * cropZoom;
    cropOX = (CROP_STAGE_W - size.width * scale) / 2;
    cropOY = (CROP_STAGE_H - size.height * scale) / 2;
  }

  function recalculateCropCover({ center = false } = {}) {
    if (!cropBitmap) return;
    const size = rotatedCropSize();
    cropCover = Math.max(CROP_STAGE_W / size.width, CROP_STAGE_H / size.height);
    if (center) centerCrop();
  }

  function cropFilter() {
    return `brightness(${cropBrightness}%) contrast(${cropContrast}%) saturate(${cropSaturation}%)`;
  }

  function drawCropImage(ctx, outputScale = 1) {
    const scale = cropCover * cropZoom * outputScale;
    const size = rotatedCropSize();
    const dispW = size.width * scale;
    const dispH = size.height * scale;
    const ox = cropOX * outputScale;
    const oy = cropOY * outputScale;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = cropFilter();
    ctx.translate(ox + dispW / 2, oy + dispH / 2);
    ctx.scale(scale * cropFlipX, scale * cropFlipY);
    ctx.rotate(cropRotation * Math.PI / 180);
    ctx.drawImage(cropBitmap, -cropBitmap.width / 2, -cropBitmap.height / 2);
    ctx.restore();
  }

  function updateCropControls() {
    const values = {
      cropZoom: cropZoom,
      cropBrightness: cropBrightness,
      cropContrast: cropContrast,
      cropSaturation: cropSaturation,
    };
    Object.entries(values).forEach(([id, value]) => {
      const input = $(`#${id}`);
      if (input) input.value = String(value);
    });
    if ($('#cropZoomValue')) $('#cropZoomValue').textContent = `${Math.round(cropZoom * 100)}%`;
    if ($('#cropBrightnessValue')) $('#cropBrightnessValue').textContent = `${cropBrightness}%`;
    if ($('#cropContrastValue')) $('#cropContrastValue').textContent = `${cropContrast}%`;
    if ($('#cropSaturationValue')) $('#cropSaturationValue').textContent = `${cropSaturation}%`;
    $('#cropFlipHorizontal')?.setAttribute('aria-pressed', cropFlipX < 0 ? 'true' : 'false');
    $('#cropFlipVertical')?.setAttribute('aria-pressed', cropFlipY < 0 ? 'true' : 'false');
  }

  function resetCropAdjustments() {
    cropZoom = 1;
    cropRotation = 0;
    cropFlipX = 1;
    cropFlipY = 1;
    cropBrightness = 100;
    cropContrast = 100;
    cropSaturation = 100;
    recalculateCropCover({ center: true });
    updateCropControls();
    drawCrop();
  }

  function drawCrop() {
    const canvas = $('#cropCanvas');
    if (!canvas || !cropBitmap) return;
    const ctx = canvas.getContext('2d');
    const scale = cropCover * cropZoom;
    const size = rotatedCropSize();
    const dispW = size.width * scale;
    const dispH = size.height * scale;
    clampCropOffsets(dispW, dispH);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.fillStyle = '#efe6d4';
    ctx.fillRect(0, 0, CROP_STAGE_W, CROP_STAGE_H);
    ctx.restore();
    drawCropImage(ctx);
  }

  function openCropper(file, label) {
    return new Promise(async (resolve) => {
      let bmp;
      try { bmp = await loadCropBitmap(file); }
      catch { toast('Could not open that image'); resolve(null); return; }
      cropBitmap = bmp;
      cropResolve = resolve;
      cropName = String(file.name || 'image');
      cropZoom = 1;
      cropRotation = 0;
      cropFlipX = 1;
      cropFlipY = 1;
      cropBrightness = 100;
      cropContrast = 100;
      cropSaturation = 100;
      recalculateCropCover({ center: true });
      updateCropControls();
      if ($('#cropTitle')) $('#cropTitle').textContent = label || 'Frame your image';
      $('#cropModal').hidden = false;
      requestAnimationFrame(drawCrop);
    });
  }

  function finishCrop(result) {
    $('#cropModal').hidden = true;
    cropBitmap?.close?.();
    cropBitmap = null;
    const resolve = cropResolve;
    cropResolve = null;
    if (resolve) resolve(result);
  }

  function confirmCrop() {
    if (!cropBitmap) { finishCrop(null); return; }
    const scale = cropCover * cropZoom;
    const sourceWindowWidth = CROP_STAGE_W / scale;
    const outW = Math.max(1, Math.min(CROP_MAX_OUT_W, Math.round(sourceWindowWidth)));
    const outH = Math.round(outW * (CROP_STAGE_H / CROP_STAGE_W));
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const octx = out.getContext('2d', { alpha: false });
    octx.fillStyle = '#efe6d4';
    octx.fillRect(0, 0, outW, outH);
    drawCropImage(octx, outW / CROP_STAGE_W);
    out.toBlob((blob) => {
      if (!blob) { toast('Could not process that image'); finishCrop(null); return; }
      const base = cropName.replace(/\.[^.]+$/, '') || 'image';
      finishCrop(new File([blob], `${base}.webp`, { type: 'image/webp' }));
    }, 'image/webp', 0.92);
  }

  function setupCropper() {
    const canvas = $('#cropCanvas');
    $('#cropZoom')?.addEventListener('input', (event) => {
      const next = Number(event.target.value) || 1;
      const oldScale = cropCover * cropZoom;
      const newScale = cropCover * next;
      const cx = CROP_STAGE_W / 2;
      const cy = CROP_STAGE_H / 2;
      const imgX = (cx - cropOX) / oldScale;
      const imgY = (cy - cropOY) / oldScale;
      cropZoom = next;
      cropOX = cx - imgX * newScale;
      cropOY = cy - imgY * newScale;
      updateCropControls();
      drawCrop();
    });
    [
      ['cropBrightness', 'cropBrightness'],
      ['cropContrast', 'cropContrast'],
      ['cropSaturation', 'cropSaturation'],
    ].forEach(([id, stateKey]) => {
      $(`#${id}`)?.addEventListener('input', (event) => {
        const value = Number(event.target.value) || 100;
        if (stateKey === 'cropBrightness') cropBrightness = value;
        if (stateKey === 'cropContrast') cropContrast = value;
        if (stateKey === 'cropSaturation') cropSaturation = value;
        updateCropControls();
        drawCrop();
      });
    });
    const rotate = (direction) => {
      cropRotation = (cropRotation + direction + 360) % 360;
      recalculateCropCover({ center: true });
      updateCropControls();
      drawCrop();
    };
    $('#cropRotateLeft')?.addEventListener('click', () => rotate(-90));
    $('#cropRotateRight')?.addEventListener('click', () => rotate(90));
    $('#cropFlipHorizontal')?.addEventListener('click', () => {
      cropFlipX *= -1;
      updateCropControls();
      drawCrop();
    });
    $('#cropFlipVertical')?.addEventListener('click', () => {
      cropFlipY *= -1;
      updateCropControls();
      drawCrop();
    });
    $('#cropReset')?.addEventListener('click', resetCropAdjustments);
    canvas?.addEventListener('pointerdown', (event) => {
      cropDragging = true;
      cropLastX = event.clientX;
      cropLastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas?.addEventListener('pointermove', (event) => {
      if (!cropDragging) return;
      const rect = canvas.getBoundingClientRect();
      cropOX += (event.clientX - cropLastX) * (CROP_STAGE_W / rect.width);
      cropOY += (event.clientY - cropLastY) * (CROP_STAGE_H / rect.height);
      cropLastX = event.clientX;
      cropLastY = event.clientY;
      drawCrop();
    });
    const endDrag = () => { cropDragging = false; };
    canvas?.addEventListener('pointerup', endDrag);
    canvas?.addEventListener('pointercancel', endDrag);
    $('#cropConfirm')?.addEventListener('click', confirmCrop);
    $('#cropCancel')?.addEventListener('click', () => finishCrop(null));
    $('#cropClose')?.addEventListener('click', () => finishCrop(null));
    $('#cropModal')?.addEventListener('click', (event) => { if (event.target === $('#cropModal')) finishCrop(null); });
  }

  function setupLibrary() {
    setupCropper();
    refreshLibraryStoragePanel();
    $('#libraryConnectBtn')?.addEventListener('click', () => void connectLibraryStorage());
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

  function setupFilters() {
    const ordersChanged = () => { orderPage = 0; renderOrders(); };
    ['#orderSearch', '#orderSort'].forEach((selector) => {
      $(selector)?.addEventListener('input', ordersChanged);
      $(selector)?.addEventListener('change', ordersChanged);
    });
    const catalogChanged = () => { catalogPage = 0; void renderProductList(); };
    ['#productSearch', '#imageMigrationFilter', '#productSort'].forEach((selector) => {
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
      if (event.key === 'Escape' && dialogOpen()) {
        event.preventDefault();
        closeDialog(!$('#paviaDialogField').hidden ? null : false);
        return;
      }
      if (event.key === 'Escape' && !$('#cropModal')?.hidden) {
        event.preventDefault();
        finishCrop(null);
        return;
      }
      if (event.key === 'Escape' && !$('#libraryPicker')?.hidden) {
        event.preventDefault();
        closeLibraryPicker();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
        if (activePanel === 'products') { event.preventDefault(); $('#productForm').requestSubmit(); }
        else if (activePanel === 'settings') { event.preventDefault(); $('#settingsForm').requestSubmit(); }
      }
      if (event.key === 'Escape' && activePanel === 'products') {
        confirmDiscardIfDirty('Discard unsaved product changes?').then((ok) => { if (ok) resetForm(); });
      }
    });

    maybeShowDraftBanner();
  }

  async function refreshAll() {
    await Promise.all([loadOrders(), loadProducts(), loadSettings()]);
    updateCategoryOptions();
    updateImageOptions();
    fillSettingsForm();
    renderMetrics();
    renderOrders();
    await renderProductList();
    await updateProductPreview();
  }

  let dashboardBooted = false;
  document.addEventListener('DOMContentLoaded', async () => {
    // admin.js injects this script then dispatches a synthetic DOMContentLoaded;
    // if a real one also fires, this guard stops a second boot (which would
    // double-bind subscriptions and duplicate new-order alerts).
    if (dashboardBooted) return;
    dashboardBooted = true;
    if (BACKEND) {
      await BACKEND.init({ defaultProducts: window.PAVIA_DEFAULT_PRODUCTS || [] });
      BACKEND.orders.subscribe(async () => {
        await loadOrders();
        detectNewOrders();
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
    }
    await refreshAll();
    applyBackendCapabilities();
    $('#logoutBtn').addEventListener('click', () => {
      confirmDiscardIfDirty('You have unsaved product changes (saved as a recoverable draft). Lock the studio anyway?')
        .then((ok) => { if (ok) window.PaviaAdminShell?.lock?.('Locked. Enter the admin credentials again.'); });
    });
    $('#productForm').addEventListener('submit', handleProductSubmit);
    $('#formReset').addEventListener('click', () => {
      confirmDiscardIfDirty('Discard unsaved changes and start a new product?').then((ok) => { if (ok) resetForm(); });
    });
    $('#formCancel').addEventListener('click', () => {
      confirmDiscardIfDirty('Discard unsaved changes?').then((ok) => { if (ok) resetForm(); });
    });
    $('#settingsForm').addEventListener('submit', handleSettingsSubmit);
    setupDialog();
    setupTabs();
    setupProductPreview();
    setupVariantBuilders();
    setupLibrary();
    setupFilters();
    setupAdminUx();
    resetForm();
    $('#dashboard').hidden = false;
  });
})();
