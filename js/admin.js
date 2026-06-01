/* Pavia Studio — Admin dashboard
 * Client-side gated with SHA-256 password hashing.
 * NOTE: This is a soft gate, not real security. Anyone with file access
 * can read the source. Use a real backend for sensitive deployments.
 */
(function () {
  'use strict';

  const KEYS = {
    products: 'PAVIA_PRODUCTS',
    orders: 'PAVIA_ORDERS',
    subscribers: 'PAVIA_SUBSCRIBERS',
    pwHash: 'PAVIA_ADMIN_HASH',
    session: 'PAVIA_ADMIN_SESSION',
  };
  const DEFAULT_USER = 'admin';
  const DEFAULT_PASS = 'pavia2025';

  /* ---------- helpers ---------- */
  const $ = (s, ctx = document) => ctx.querySelector(s);
  const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));
  const fmt = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const norm = (v) => String(v || '').trim().toLowerCase();

  function readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function writeLS(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function slugify(value) {
    return norm(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `p${Date.now().toString(36)}`;
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

  function normalizeProduct(product) {
    const tags = Array.isArray(product.tags) ? product.tags : [];
    const compareAt = Number(product.compareAt ?? product.comparePrice ?? 0) || 0;
    return {
      ...product,
      id: product.id || slugify(product.name),
      name: product.name || 'Untitled product',
      price: Number(product.price) || 0,
      compareAt,
      category: product.category || 'New Arrivals',
      stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : 0,
      image: normalizeImagePath(product.image),
      sizes: Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['One size'],
      colors: Array.isArray(product.colors) ? product.colors : [],
      description: product.description || '',
      tags,
      badge: product.badge || tags[0] || '',
      featured: Boolean(product.featured || tags.map(norm).includes('featured')),
      createdAt: Number(product.createdAt) || Date.now(),
    };
  }

  async function sha256(text) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function toast(message) {
    const wrap = $('#toastWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 2400);
  }

  /* ---------- auth ---------- */
  async function getStoredHash() {
    let hash = localStorage.getItem(KEYS.pwHash);
    if (!hash) {
      hash = await sha256(DEFAULT_PASS);
      localStorage.setItem(KEYS.pwHash, hash);
    }
    return hash;
  }

  function isAuthed() {
    return sessionStorage.getItem(KEYS.session) === 'ok';
  }

  function setAuthed(v) {
    if (v) sessionStorage.setItem(KEYS.session, 'ok');
    else sessionStorage.removeItem(KEYS.session);
  }

  async function handleLogin(e) {
    e.preventDefault();
    const user = $('#loginUser').value.trim();
    const pass = $('#loginPass').value;
    const err = $('#loginError');
    err.classList.remove('show');

    if (user !== DEFAULT_USER) {
      err.textContent = 'Invalid username or password.';
      err.classList.add('show');
      return;
    }
    const stored = await getStoredHash();
    const entered = await sha256(pass);
    if (entered !== stored) {
      err.textContent = 'Invalid username or password.';
      err.classList.add('show');
      return;
    }
    setAuthed(true);
    showDashboard();
  }

  function logout() {
    setAuthed(false);
    showLogin();
  }

  function showLogin() {
    $('#loginScreen').hidden = false;
    $('#dashboard').hidden = true;
    $('#loginPass') && ($('#loginPass').value = '');
  }

  function showDashboard() {
    $('#loginScreen').hidden = true;
    $('#dashboard').hidden = false;
    refreshAll();
  }

  /* ---------- products ---------- */
  function getProducts() {
    const stored = readLS(KEYS.products, null);
    const source = stored || window.PAVIA_DEFAULT_PRODUCTS || [];
    return source.map(normalizeProduct);
  }

  function saveProducts(list) {
    writeLS(KEYS.products, list.map(normalizeProduct));
  }

  function parseColors(str) {
    return str
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((tok) => {
        const [name, hex] = tok.split(':').map((p) => (p || '').trim());
        return {
          name: name || 'Color',
          hex: hex && hex.startsWith('#') ? hex : '#cccccc',
        };
      });
  }

  function colorsToString(colors) {
    if (!colors || !colors.length) return '';
    return colors
      .map((c) => {
        if (typeof c === 'string') return c;
        return `${c.name}:${c.hex}`;
      })
      .join(', ');
  }

  function renderProductList() {
    const list = getProducts();
    const wrap = $('#productList');
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">No products yet. Add one above.</div>';
      return;
    }
    wrap.innerHTML = list
      .map(
        (p) => `
      <div class="product-row" data-id="${escapeHtml(p.id)}">
        <img src="${escapeHtml(imageSrc(p.image))}" alt="" />
        <div class="info">
          <strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(p.category || '')} · ${fmt(p.price)}${
          p.compareAt ? ` <s>${fmt(p.compareAt)}</s>` : ''
        } · stock ${p.stock ?? 0}</small>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" data-edit="${escapeHtml(p.id)}">Edit</button>
          <button class="btn btn-ghost" data-del="${escapeHtml(p.id)}">Delete</button>
        </div>
      </div>
    `,
      )
      .join('');

    wrap.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        img.src = '../assets/logo.svg';
      }, { once: true });
    });

    wrap.querySelectorAll('[data-edit]').forEach((b) =>
      b.addEventListener('click', () => loadIntoForm(b.dataset.edit)),
    );
    wrap.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', () => deleteProduct(b.dataset.del)),
    );
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  }

  function resetForm() {
    $('#productForm').reset();
    $('#prodId').value = '';
    $('#formTitle').textContent = 'Add a product';
    $('#formSubmit').textContent = 'Add product';
  }

  function loadIntoForm(id) {
    const p = getProducts().find((x) => x.id === id);
    if (!p) return;
    $('#prodId').value = p.id;
    $('#prodName').value = p.name || '';
    $('#prodPrice').value = p.price ?? '';
    $('#prodCompare').value = p.compareAt || '';
    $('#prodCategory').value = p.category || '';
    $('#prodStock').value = p.stock ?? 0;
    $('#prodImage').value = p.image || '';
    $('#prodSizes').value = (p.sizes || []).join(', ');
    $('#prodColors').value = colorsToString(p.colors);
    $('#prodDesc').value = p.description || '';
    $('#prodTags').value = (p.tags || []).join(', ');
    $('#formTitle').textContent = 'Edit product';
    $('#formSubmit').textContent = 'Save changes';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    const list = getProducts().filter((p) => p.id !== id);
    saveProducts(list);
    renderProductList();
    refreshStats();
    toast('Product deleted');
  }

  function handleProductSubmit(e) {
    e.preventDefault();
    const id = $('#prodId').value || slugify($('#prodName').value);
    const list = getProducts();
    const existing = list.find((p) => p.id === id);
    const product = {
      id,
      name: $('#prodName').value.trim(),
      price: parseFloat($('#prodPrice').value) || 0,
      compareAt: $('#prodCompare').value
        ? parseFloat($('#prodCompare').value)
        : 0,
      category: $('#prodCategory').value.trim(),
      stock: parseInt($('#prodStock').value, 10) || 0,
      image: normalizeImagePath($('#prodImage').value),
      sizes: $('#prodSizes').value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      colors: parseColors($('#prodColors').value),
      description: $('#prodDesc').value.trim(),
      tags: $('#prodTags').value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      featured: $('#prodTags').value
        .split(',')
        .map((s) => norm(s))
        .includes('featured'),
      createdAt: existing?.createdAt ?? Date.now(),
    };

    if (existing) {
      Object.assign(existing, product);
    } else {
      list.push(product);
    }
    saveProducts(list);
    renderProductList();
    refreshStats();
    resetForm();
    toast(existing ? 'Product updated' : 'Product added');
  }

  /* ---------- orders ---------- */
  function getOrders() {
    return readLS(KEYS.orders, []);
  }

  function renderOrderItem(order) {
    const itemsHtml = (order.items || [])
      .map((it) => {
        const color = typeof it.color === 'string' ? it.color : it.color?.name || '';
        const options = [it.size, color].filter(Boolean).map(escapeHtml).join(' ? ');
        return `<div>&middot; ${escapeHtml(it.name)} x ${it.qty || 1}${
          options ? ` ? ${options}` : ''
        } - ${fmt((it.price || 0) * (it.qty || 1))}</div>`;
      })
      .join('');
    const customer = order.customer || {};
    const when = new Date(order.date || order.createdAt || Date.now()).toLocaleString();
    return `
      <div class="order-item">
        <div class="head">
          <span class="id">#${escapeHtml(order.id || '')}</span>
          <span class="when">${when}</span>
        </div>
        <div class="body">
          <div><strong>${escapeHtml(customer.name || 'Customer')}</strong> ? ${escapeHtml(
      customer.phone || '',
    )}</div>
          <div>${escapeHtml(customer.address || '')}${
      customer.city ? `, ${escapeHtml(customer.city)}` : ''
    }</div>
          <div>Payment: ${escapeHtml(customer.payment || order.payment || 'Cash on delivery')}</div>
          ${order.promo ? `<div>Promo: <strong>${escapeHtml(order.promo)}</strong></div>` : ''}
          ${itemsHtml}
          <div class="total">Total: ${fmt(order.total || 0)}</div>
        </div>
      </div>
    `;
  }

  function renderRecentOrders() {
    const orders = getOrders().slice(-5).reverse();
    const wrap = $('#recentOrders');
    wrap.innerHTML = orders.length
      ? orders.map(renderOrderItem).join('')
      : '<div class="empty">No orders yet. Once customers check out, their orders will appear here.</div>';
  }

  function renderAllOrders() {
    const orders = getOrders().slice().reverse();
    const wrap = $('#allOrders');
    wrap.innerHTML = orders.length
      ? orders.map(renderOrderItem).join('')
      : '<div class="empty">No orders yet.</div>';
  }

  /* ---------- stats ---------- */
  function refreshStats() {
    const orders = getOrders();
    const products = getProducts();
    const subs = readLS(KEYS.subscribers, []);

    const revenue = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const items = orders.reduce(
      (s, o) =>
        s + (o.items || []).reduce((a, it) => a + (Number(it.qty) || 0), 0),
      0,
    );
    const avg = orders.length ? revenue / orders.length : 0;

    $('#statRevenue').textContent = fmt(revenue);
    $('#statOrders').textContent = orders.length;
    $('#statItems').textContent = items;
    $('#statSubs').textContent = subs.length;
    $('#statCatalog').textContent = products.length;
    $('#statAvg').textContent = fmt(avg);
    $('#subscriberCount').textContent = `${subs.length} subscriber${subs.length === 1 ? '' : 's'}`;
  }

  /* ---------- settings ---------- */
  async function handlePasswordChange(e) {
    e.preventDefault();
    const current = $('#pwCurrent').value;
    const next = $('#pwNew').value;
    const confirmPw = $('#pwConfirm').value;
    const msg = $('#pwMsg');
    msg.classList.remove('show');

    const stored = await getStoredHash();
    const enteredCurrent = await sha256(current);
    if (enteredCurrent !== stored) {
      msg.textContent = 'Current password is incorrect.';
      msg.classList.add('show');
      return;
    }
    if (next.length < 6) {
      msg.textContent = 'New password must be at least 6 characters.';
      msg.classList.add('show');
      return;
    }
    if (next !== confirmPw) {
      msg.textContent = 'Passwords do not match.';
      msg.classList.add('show');
      return;
    }
    const newHash = await sha256(next);
    localStorage.setItem(KEYS.pwHash, newHash);
    $('#passwordForm').reset();
    toast('Password updated');
  }

  function exportSubscribers() {
    const subs = readLS(KEYS.subscribers, []);
    if (!subs.length) {
      toast('No subscribers yet');
      return;
    }
    const rows = [['email', 'date']];
    subs.forEach((s) => {
      const email = typeof s === 'string' ? s : s.email || '';
      const when =
        typeof s === 'string'
          ? ''
          : s.date || s.subscribedAt
          ? new Date(s.date || s.subscribedAt).toISOString()
          : '';
      rows.push([email, when]);
    });
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pavia-subscribers-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Exported');
  }

  function clearSubscribers() {
    if (!confirm('Clear all subscribers?')) return;
    writeLS(KEYS.subscribers, []);
    refreshStats();
    toast('Subscribers cleared');
  }

  function clearOrders() {
    if (!confirm('Clear all orders? This cannot be undone.')) return;
    writeLS(KEYS.orders, []);
    refreshStats();
    renderRecentOrders();
    renderAllOrders();
    toast('Orders cleared');
  }

  function resetCatalog() {
    if (!confirm('Reset catalog to defaults? Custom products will be lost.')) return;
    localStorage.removeItem(KEYS.products);
    renderProductList();
    refreshStats();
    toast('Catalog reset');
  }

  /* ---------- tabs ---------- */
  function setupTabs() {
    $$('.admin-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        $$('.admin-tab').forEach((t) => t.classList.toggle('active', t === tab));
        $$('.admin-panel').forEach((p) =>
          p.classList.toggle('active', p.dataset.panel === target),
        );
        if (target === 'orders') renderAllOrders();
        if (target === 'products') renderProductList();
        if (target === 'dashboard') {
          refreshStats();
          renderRecentOrders();
        }
        if (target === 'settings') refreshStats();
      });
    });
  }

  function refreshAll() {
    refreshStats();
    renderRecentOrders();
    renderProductList();
  }

  /* ---------- init ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    // Make sure default hash is seeded
    await getStoredHash();

    $('#loginForm').addEventListener('submit', handleLogin);
    $('#logoutBtn').addEventListener('click', logout);
    $('#productForm').addEventListener('submit', handleProductSubmit);
    $('#formReset').addEventListener('click', resetForm);
    $('#passwordForm').addEventListener('submit', handlePasswordChange);
    $('#exportSubs').addEventListener('click', exportSubscribers);
    $('#clearSubs').addEventListener('click', clearSubscribers);
    $('#clearOrders').addEventListener('click', clearOrders);
    $('#resetCatalog').addEventListener('click', resetCatalog);
    setupTabs();

    if (isAuthed()) showDashboard();
    else showLogin();
  });
})();
