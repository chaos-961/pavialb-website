/* =========================================================
   PAVIA — main app
   Storefront logic: catalog, cart, wishlist, orders, modals,
   recently-viewed, promo codes, smooth UI, and PWA bits.
   ========================================================= */
(() => {
  'use strict';

  // ---------- Constants ----------
  const STORE_KEYS = {
    products:    'PAVIA_PRODUCTS',
    cart:        'PAVIA_CART',
    wishlist:    'PAVIA_WISHLIST',
    subscribers: 'PAVIA_SUBSCRIBERS',
    orders:      'PAVIA_ORDERS',
    recent:      'PAVIA_RECENT',
    promo:       'PAVIA_PROMO'
  };

  const WHATSAPP_NUMBER = '9613017725';
  const FREE_DELIVERY_AT = 100;
  const DELIVERY_BEIRUT = 3;
  const DELIVERY_LEBANON = 5;
  const RECENT_LIMIT = 8;

  // ---------- Helpers ----------
  const $  = (sel, scope = document) => scope.querySelector(sel);
  const $$ = (sel, scope = document) => Array.from(scope.querySelectorAll(sel));

  const readJSON = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.warn('Storage full?', e); }
  };
  const money = (v) => `$${Number(v || 0).toFixed(0)}`;
  const norm  = (v) => String(v || '').trim().toLowerCase();
  const debounce = (fn, ms = 200) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  // Color helpers — products may store strings or {name, hex}
  const colorObj = (c) => typeof c === 'string'
    ? { name: c, hex: stringToHex(c) }
    : { name: c.name, hex: c.hex || stringToHex(c.name) };
  function stringToHex(name) {
    const lookup = {
      'sky blue':'#9ec1de','white':'#fafafa','medium blue':'#5a7da3','azure':'#7fa8d6',
      'cocoa':'#5c4034','mocha':'#7a5443','ivory':'#f3ead8','cream':'#ede2cf',
      'chocolate':'#4b322a','beige':'#c9a779','black':'#1a1612','olive':'#7a7d56',
      'taupe':'#a78970'
    };
    return lookup[norm(name)] || '#a78970';
  }

  function normalizeProduct(p) {
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const compareAt = Number(p.compareAt ?? p.comparePrice ?? 0) || 0;
    const stock = Number.isFinite(Number(p.stock)) ? Number(p.stock) : 0;
    return {
      ...p,
      id: p.id || `product-${Date.now()}`,
      name: p.name || 'Untitled product',
      category: p.category || 'New Arrivals',
      price: Number(p.price) || 0,
      compareAt,
      badge: p.badge || (tags[0] || ''),
      image: p.image || 'assets/logo.svg',
      description: p.description || '',
      sizes: Array.isArray(p.sizes) && p.sizes.length ? p.sizes : ['One size'],
      colors: (Array.isArray(p.colors) && p.colors.length ? p.colors : ['Default']).map(colorObj),
      tags,
      stock,
      featured: Boolean(p.featured || tags.map(norm).includes('featured')),
      createdAt: Number(p.createdAt) || 0
    };
  }

  // ---------- State ----------
  let products = readJSON(STORE_KEYS.products, window.PAVIA_DEFAULT_PRODUCTS || []);
  // Migrate older saved product records into the current storefront shape.
  products = products.map(normalizeProduct);

  let cart        = readJSON(STORE_KEYS.cart, []);
  let wishlist    = readJSON(STORE_KEYS.wishlist, []);
  let recent      = readJSON(STORE_KEYS.recent, []);
  let appliedPromo = readJSON(STORE_KEYS.promo, null);
  let activeCategory = 'All';
  let activeAvail = 'all';
  let activePrice = 'all';

  let modalProduct = null;
  let selectedSize = '';
  let selectedColor = '';
  let selectedQty = 1;

  // ---------- Node references ----------
  const n = {
    header:           $('[data-header]'),
    productGrid:      $('[data-product-grid]'),
    productSearch:    $('#productSearch'),
    searchClear:      $('[data-search-clear]'),
    sizeFilter:       $('#sizeFilter'),
    sortFilter:       $('#sortFilter'),
    priceFilter:      $('#priceFilter'),
    availFilter:      $('#availFilter'),
    categoryPills:    $('[data-category-pills]'),
    resultCount:      $('[data-result-count]'),
    clearFilters:     $('#clearFilters'),
    toolbar:          $('[data-toolbar]'),
    filterToggle:     $('[data-filter-toggle]'),
    filterPanel:      $('[data-filter-panel]'),

    cartDrawer:       $('[data-cart-drawer]'),
    wishlistDrawer:   $('[data-wishlist-drawer]'),
    ordersDrawer:     $('[data-orders-drawer]'),
    cartItems:        $('[data-cart-items]'),
    wishlistItems:    $('[data-wishlist-items]'),
    ordersItems:      $('[data-orders-items]'),

    cartCounts:       $$('[data-cart-count]'),
    wishCounts:       $$('[data-wishlist-count]'),

    subtotalEl:       $('[data-subtotal]'),
    totalEl:          $('[data-total]'),
    deliveryEl:       $('[data-delivery-estimate]'),
    discountLine:     $('[data-discount-line]'),
    discountEl:       $('[data-discount]'),
    promoInput:       $('[data-promo-input]'),
    promoApply:       $('[data-promo-apply]'),
    promoApplied:     $('[data-promo-applied]'),

    modal:            $('[data-product-modal]'),
    modalContent:     $('[data-modal-content]'),
    checkoutModal:    $('[data-checkout-modal]'),
    checkoutSummary:  $('[data-checkout-summary]'),
    checkoutForm:     $('[data-checkout-form]'),

    toastRegion:      $('[data-toast-region]'),
    backTop:          $('[data-back-top]'),
    recentSection:    $('[data-recent-section]'),
    recentList:       $('[data-recent-list]')
  };

  // ---------- Derived ----------
  const categories = () => ['All', ...new Set(products.map(p => p.category))];
  const cartSubtotal = () => cart.reduce((s, i) => s + i.price * i.qty, 0);
  const cartQty = () => cart.reduce((s, i) => s + i.qty, 0);
  const getProduct = (id) => products.find(p => p.id === id);

  // Promo / discount
  function discountAmount() {
    if (!appliedPromo) return 0;
    const codes = window.PAVIA_PROMO_CODES || {};
    const c = codes[appliedPromo];
    if (!c) return 0;
    if (c.type === 'percent') return Math.round(cartSubtotal() * (c.value / 100));
    return 0;
  }
  function isFreeShipPromo() {
    if (!appliedPromo) return false;
    const c = (window.PAVIA_PROMO_CODES || {})[appliedPromo];
    return c && c.type === 'freeship';
  }

  // ---------- Boot ----------
  function init() {
    $('[data-year]').textContent = new Date().getFullYear();
    showSkeletons();
    renderCategories();
    // Stagger the actual product render so the skeletons get a moment to breathe
    setTimeout(() => {
      renderProducts();
      renderRecent();
    }, 250);
    renderCart();
    renderWishlist();
    bindEvents();
    setupRevealObserver();
    registerServiceWorker();
  }

  // ---------- Event bindings ----------
  function bindEvents() {
    // Header scroll state
    let lastY = 0;
    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      n.header.classList.toggle('is-scrolled', y > 8);
      if (n.toolbar) n.toolbar.classList.toggle('is-stuck', y > 280);
      n.backTop.classList.toggle('is-visible', y > 600);
      lastY = y;
    }, { passive: true });

    // Search & filters (debounced for smoothness)
    const debouncedRender = debounce(renderProducts, 120);
    n.productSearch?.addEventListener('input', () => {
      n.productSearch.parentElement.classList.toggle('has-value', !!n.productSearch.value);
      debouncedRender();
    });
    n.searchClear?.addEventListener('click', () => {
      n.productSearch.value = '';
      n.productSearch.parentElement.classList.remove('has-value');
      n.productSearch.focus();
      renderProducts();
    });
    [n.sizeFilter, n.sortFilter, n.priceFilter, n.availFilter].forEach(el => {
      el?.addEventListener('change', () => {
        if (el === n.priceFilter) activePrice = el.value;
        if (el === n.availFilter) activeAvail = el.value;
        updateFilterDot();
        renderProducts();
      });
    });
    n.clearFilters?.addEventListener('click', clearAllFilters);

    // Filter toggle
    n.filterToggle?.addEventListener('click', () => {
      n.filterPanel?.classList.toggle('is-open');
    });

    // Header / mobile nav buttons (multiple may share data-attr)
    $$('[data-open-cart]').forEach(b => b.addEventListener('click', () => openDrawer(n.cartDrawer)));
    $$('[data-open-wishlist]').forEach(b => b.addEventListener('click', () => openDrawer(n.wishlistDrawer)));
    $$('[data-open-orders]').forEach(b => b.addEventListener('click', () => { renderOrders(); openDrawer(n.ordersDrawer); }));
    $$('[data-open-search]').forEach(b => b.addEventListener('click', () => {
      document.location.hash = '#shop';
      setTimeout(() => n.productSearch?.focus(), 280);
    }));

    $('[data-close-cart]')?.addEventListener('click', () => closeDrawer(n.cartDrawer));
    $('[data-close-wishlist]')?.addEventListener('click', () => closeDrawer(n.wishlistDrawer));
    $('[data-close-orders]')?.addEventListener('click', () => closeDrawer(n.ordersDrawer));
    $('[data-continue-shopping]')?.addEventListener('click', () => closeDrawer(n.cartDrawer));

    [n.cartDrawer, n.wishlistDrawer, n.ordersDrawer].forEach(d => {
      d?.addEventListener('click', e => { if (e.target === d) closeDrawer(d); });
    });

    // Modals
    $('[data-close-modal]')?.addEventListener('click', closeProductModal);
    n.modal?.addEventListener('click', e => { if (e.target === n.modal) closeProductModal(); });
    $('[data-close-checkout]')?.addEventListener('click', closeCheckout);
    n.checkoutModal?.addEventListener('click', e => { if (e.target === n.checkoutModal) closeCheckout(); });

    $('[data-checkout]')?.addEventListener('click', openCheckout);
    n.checkoutForm?.addEventListener('submit', submitCheckout);
    n.checkoutForm?.querySelector('[name="city"]')?.addEventListener('input', e => renderCheckoutSummary(e.target.value));
    $('[data-copy-order]')?.addEventListener('click', copyOrderText);

    // Promo
    n.promoApply?.addEventListener('click', applyPromo);
    n.promoInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyPromo(); } });

    // Collection jumps + featured product
    $$('[data-category-jump]').forEach(b => {
      b.addEventListener('click', () => {
        activeCategory = b.dataset.categoryJump;
        document.location.hash = '#shop';
        renderCategories();
        renderProducts();
      });
    });
    $$('[data-featured-product]').forEach(b => {
      b.addEventListener('click', () => openProductModal(b.dataset.featuredProduct));
    });

    // Newsletter
    $('[data-newsletter]')?.addEventListener('submit', e => {
      e.preventDefault();
      const inp = e.currentTarget.querySelector('input');
      const subs = readJSON(STORE_KEYS.subscribers, []);
      subs.push({ email: inp.value, date: new Date().toISOString() });
      writeJSON(STORE_KEYS.subscribers, subs);
      inp.value = '';
      toast('Subscribed. We\'ll keep you posted.');
    });

    // Back to top
    n.backTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // ESC closes things
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeProductModal(); closeCheckout();
        closeDrawer(n.cartDrawer); closeDrawer(n.wishlistDrawer); closeDrawer(n.ordersDrawer);
      }
    });

    // Smooth-scroll fallback for anchor links (some browsers don't honor hash with sticky header)
    $$('a[href^="#"]').forEach(link => {
      link.addEventListener('click', e => {
        const href = link.getAttribute('href');
        if (href && href.length > 1 && href !== '#') {
          const target = document.querySelector(href);
          if (target) {
            e.preventDefault();
            const top = target.getBoundingClientRect().top + window.scrollY - (n.header?.offsetHeight || 64) + 1;
            window.scrollTo({ top, behavior: 'smooth' });
          }
        }
      });
    });
  }

  // ---------- Reveal on scroll ----------
  function setupRevealObserver() {
    const els = $$('.reveal');
    if (!('IntersectionObserver' in window)) {
      els.forEach(el => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });
    els.forEach(el => io.observe(el));
  }

  // ---------- Categories ----------
  function renderCategories() {
    n.categoryPills.innerHTML = categories().map(c => `
      <button type="button" class="${c === activeCategory ? 'is-active' : ''}" data-category="${c}">${c}</button>
    `).join('');
    $$('[data-category]', n.categoryPills).forEach(b => {
      b.addEventListener('click', () => {
        activeCategory = b.dataset.category;
        renderCategories();
        renderProducts();
      });
    });
  }

  function updateFilterDot() {
    const hasActive = (n.priceFilter?.value !== 'all') || (n.availFilter?.value !== 'all') || (n.sizeFilter?.value !== 'all');
    n.filterToggle?.classList.toggle('has-active', hasActive);
  }

  // ---------- Filtering ----------
  function filteredProducts() {
    const q = norm(n.productSearch?.value);
    const size = n.sizeFilter?.value || 'all';
    const sort = n.sortFilter?.value || 'featured';
    const price = n.priceFilter?.value || 'all';
    const avail = n.availFilter?.value || 'all';

    let result = products.filter(p => {
      const hay = [p.name, p.category, p.description, p.badge].map(norm).join(' ');
      if (q && !hay.includes(q)) return false;
      if (activeCategory !== 'All' && p.category !== activeCategory) return false;
      if (size !== 'all' && !p.sizes.includes(size)) return false;
      if (price !== 'all') {
        const [min, max] = price.split('-').map(Number);
        if (p.price < min || p.price > max) return false;
      }
      if (avail === 'featured' && !p.featured) return false;
      if (avail === 'sale' && !(p.compareAt && p.compareAt > p.price)) return false;
      return true;
    });

    if (sort === 'price-low')  result.sort((a, b) => a.price - b.price);
    if (sort === 'price-high') result.sort((a, b) => b.price - a.price);
    if (sort === 'newest')     result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (sort === 'featured')   result.sort((a, b) => Number(b.featured) - Number(a.featured));

    return result;
  }

  // ---------- Skeletons ----------
  function showSkeletons() {
    if (!n.productGrid) return;
    n.productGrid.innerHTML = Array.from({ length: 6 }).map(() => `
      <div class="skeleton">
        <div class="skeleton-media"></div>
        <div class="skeleton-info">
          <div class="skeleton-line short"></div>
          <div class="skeleton-line med"></div>
          <div class="skeleton-line short"></div>
        </div>
      </div>
    `).join('');
  }

  // ---------- Product card ----------
  function productCard(p) {
    const colors = (p.colors || []).map(colorObj);
    const swatches = colors.slice(0, 4)
      .map(c => `<span style="background:${c.hex}"></span>`).join('');
    const moreCount = colors.length > 4 ? `<span class="color-mini-count">+${colors.length - 4}</span>` : '';
    const onSale = p.compareAt && p.compareAt > p.price;
    const savePct = onSale ? Math.round((1 - p.price / p.compareAt) * 100) : 0;

    const badges = [];
    if (norm(p.badge) === 'new') badges.push(`<span class="badge new">${p.badge}</span>`);
    else if (onSale) badges.push(`<span class="badge sale">-${savePct}%</span>`);
    if (p.stock <= 4) badges.push(`<span class="badge low">Only ${p.stock} left</span>`);
    if (!badges.length && p.badge) badges.push(`<span class="badge">${p.badge}</span>`);

    return `
      <article class="product-card reveal" data-low-stock="${p.stock <= 4}" data-product-id="${p.id}">
        <div class="product-media">
          <img src="${p.image}" alt="${p.name}" loading="lazy" />
          <div class="badge-stack">${badges.join('')}</div>
          <button class="wish-btn ${wishlist.includes(p.id) ? 'is-active' : ''}" data-wish="${p.id}" aria-label="Save ${p.name}">
            <svg viewBox="0 0 24 24"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>
          </button>
          <button class="quick-add" data-fast-add="${p.id}" aria-label="Quick add ${p.name}">
            <svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Quick add
          </button>
        </div>
        <div class="product-info">
          <span class="product-category">${p.category}</span>
          <h3 class="product-name" data-quick-view="${p.id}" role="button" tabindex="0">${p.name}</h3>
          <div class="product-price">
            <span class="now">${money(p.price)}</span>
            ${onSale ? `<span class="was">${money(p.compareAt)}</span><span class="save">Save ${savePct}%</span>` : ''}
          </div>
          <div class="color-mini">${swatches}${moreCount}</div>
          <div class="stock-bar">Only ${p.stock} left in stock</div>
        </div>
      </article>
    `;
  }

  function renderProducts() {
    const result = filteredProducts();
    n.resultCount.textContent = result.length;

    if (!result.length) {
      n.productGrid.innerHTML = `
        <div class="empty-state">
          <h3>No styles found</h3>
          <p>Try another search, size, or category.</p>
          <button type="button" class="text-btn" id="emptyClear">Clear all filters</button>
        </div>`;
      $('#emptyClear')?.addEventListener('click', clearAllFilters);
      return;
    }

    n.productGrid.innerHTML = result.map(productCard).join('');
    // Stagger reveal
    $$('.product-grid .reveal').forEach((el, i) => {
      el.style.transitionDelay = `${Math.min(i * 40, 320)}ms`;
      requestAnimationFrame(() => el.classList.add('is-visible'));
    });

    // Bind card actions
    $$('[data-quick-view]', n.productGrid).forEach(el => {
      el.addEventListener('click', () => openProductModal(el.dataset.quickView));
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProductModal(el.dataset.quickView); } });
    });
    $$('[data-fast-add]', n.productGrid).forEach(el => el.addEventListener('click', e => { e.stopPropagation(); fastAdd(el.dataset.fastAdd); }));
    $$('[data-wish]', n.productGrid).forEach(el => el.addEventListener('click', e => {
      e.stopPropagation();
      el.classList.add('is-pulsing');
      setTimeout(() => el.classList.remove('is-pulsing'), 500);
      toggleWishlist(el.dataset.wish);
    }));
    // Make whole image area clickable
    $$('.product-media img', n.productGrid).forEach((el, i) => {
      el.addEventListener('click', () => {
        const id = el.closest('[data-product-id]')?.dataset.productId;
        if (id) openProductModal(id);
      });
    });
  }

  function clearAllFilters() {
    activeCategory = 'All';
    n.productSearch.value = '';
    n.productSearch.parentElement.classList.remove('has-value');
    n.sizeFilter.value = 'all';
    n.sortFilter.value = 'featured';
    n.priceFilter.value = 'all';
    n.availFilter.value = 'all';
    updateFilterDot();
    renderCategories();
    renderProducts();
  }

  // ---------- Product modal ----------
  function openProductModal(id) {
    const p = getProduct(id);
    if (!p) return;
    modalProduct = p;
    selectedSize = p.sizes[0] || '';
    selectedColor = (p.colors[0] && p.colors[0].name) || '';
    selectedQty = 1;
    addToRecent(id);
    renderProductModal();
    n.modal.classList.add('is-open');
    n.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }

  function renderProductModal() {
    const p = modalProduct;
    const colors = (p.colors || []).map(colorObj);
    const onSale = p.compareAt && p.compareAt > p.price;
    const savePct = onSale ? Math.round((1 - p.price / p.compareAt) * 100) : 0;

    n.modalContent.innerHTML = `
      <div class="modal-product">
        <div class="image-wrap">
          <img src="${p.image}" alt="${p.name}" />
        </div>
        <div class="modal-details">
          <span class="eyebrow">${p.category} · ${p.badge || ''}</span>
          <h2 id="modalTitle">${p.name}</h2>
          <p class="muted">${p.description}</p>
          <div class="modal-price-row">
            <span class="now">${money(p.price)}</span>
            ${onSale ? `<span class="was">${money(p.compareAt)}</span><span class="save">Save ${savePct}%</span>` : ''}
          </div>

          <div class="option-group">
            <div class="label"><span>Size</span><span>${selectedSize}</span></div>
            <div class="size-options">
              ${p.sizes.map(s => `<button type="button" class="${s === selectedSize ? 'is-selected' : ''}" data-size="${s}">${s}</button>`).join('')}
            </div>
          </div>

          <div class="option-group">
            <div class="label"><span>Color</span><span>${selectedColor}</span></div>
            <div class="color-swatches">
              ${colors.map(c => `
                <button type="button" class="${c.name === selectedColor ? 'is-selected' : ''}" data-color="${c.name}">
                  <span class="color-dot" style="background:${c.hex}"></span>${c.name}
                </button>
              `).join('')}
            </div>
          </div>

          <div class="qty-add-row">
            <div class="qty-control" aria-label="Quantity">
              <button type="button" data-modal-qty="minus" aria-label="Decrease quantity">−</button>
              <span>${selectedQty}</span>
              <button type="button" data-modal-qty="plus" aria-label="Increase quantity">+</button>
            </div>
            <button class="btn btn-primary" data-modal-add>
              Add to bag · ${money(p.price * selectedQty)}
            </button>
          </div>

          <div class="modal-meta">
            <div>
              <svg viewBox="0 0 24 24"><path d="M5 8h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8z"/></svg>
              <span>${p.stock} pieces available · Delivery across Lebanon</span>
            </div>
            <div>
              <svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>
              <span>Free delivery on orders over $${FREE_DELIVERY_AT}</span>
            </div>
            <div>
              <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.2-5.6A8.4 8.4 0 1 1 21 11.5Z"/></svg>
              <span>Order via WhatsApp · 24h support</span>
            </div>
          </div>
        </div>
      </div>
    `;

    $$('[data-size]', n.modalContent).forEach(b => b.addEventListener('click', () => { selectedSize = b.dataset.size; renderProductModal(); }));
    $$('[data-color]', n.modalContent).forEach(b => b.addEventListener('click', () => { selectedColor = b.dataset.color; renderProductModal(); }));
    $$('[data-modal-qty]', n.modalContent).forEach(b => b.addEventListener('click', () => {
      selectedQty = b.dataset.modalQty === 'plus'
        ? Math.min(modalProduct.stock, selectedQty + 1)
        : Math.max(1, selectedQty - 1);
      renderProductModal();
    }));
    $('[data-modal-add]', n.modalContent).addEventListener('click', () => {
      addToCart(modalProduct, selectedSize, selectedColor, selectedQty);
      closeProductModal();
      openDrawer(n.cartDrawer);
    });
  }

  function closeProductModal() {
    if (!n.modal.classList.contains('is-open')) return;
    n.modal.classList.remove('is-open');
    n.modal.setAttribute('aria-hidden', 'true');
    if (!n.checkoutModal.classList.contains('is-open')) document.body.classList.remove('no-scroll');
  }

  // ---------- Cart ----------
  function fastAdd(id) {
    const p = getProduct(id);
    if (!p) return;
    const firstColor = (p.colors[0] && p.colors[0].name) || '';
    addToCart(p, p.sizes[0], firstColor, 1);
  }

  function addToCart(product, size, color, qty) {
    const key = `${product.id}-${size}-${color}`;
    const existing = cart.find(i => i.key === key);
    if (existing) existing.qty = Math.min(product.stock, existing.qty + qty);
    else cart.push({
      key, id: product.id, name: product.name, price: product.price, image: product.image,
      size, color, qty
    });
    saveCart();
    bumpCounter('[data-cart-count]');
    toast(`${product.name} added to bag.`);
  }

  function saveCart() { writeJSON(STORE_KEYS.cart, cart); renderCart(); }

  function renderCart() {
    const qty = cartQty();
    n.cartCounts.forEach(c => {
      c.textContent = qty;
      c.classList.toggle('is-visible', qty > 0);
    });

    const subtotal = cartSubtotal();
    const discount = discountAmount();
    const freeShip = isFreeShipPromo() || (subtotal - discount) >= FREE_DELIVERY_AT;
    const total = Math.max(0, subtotal - discount);

    n.subtotalEl.textContent = money(subtotal);
    n.totalEl.textContent = money(total);
    n.deliveryEl.textContent = freeShip ? 'Free' : 'Calculated at checkout';

    if (discount > 0) {
      n.discountLine.classList.remove('is-hidden');
      n.discountEl.textContent = `-${money(discount)}`;
    } else {
      n.discountLine.classList.add('is-hidden');
    }

    if (appliedPromo) {
      const codes = window.PAVIA_PROMO_CODES || {};
      const c = codes[appliedPromo];
      if (c) {
        n.promoApplied.textContent = `✓ ${appliedPromo} — ${c.label}`;
        n.promoApplied.classList.remove('is-hidden');
      }
    } else {
      n.promoApplied.classList.add('is-hidden');
    }

    if (!cart.length) {
      n.cartItems.innerHTML = `
        <div class="empty-drawer">
          <svg viewBox="0 0 48 48"><path d="M10 14h28l-2.5 24a3 3 0 0 1-3 2.7H15.5a3 3 0 0 1-3-2.7L10 14z"/><path d="M18 14V9a6 6 0 0 1 12 0v5"/></svg>
          <h3>Your bag is empty</h3>
          <p>Add an elegant piece from the collection.</p>
          <a href="#shop" class="btn btn-primary" data-continue-shopping>Browse the collection</a>
        </div>`;
      $('[data-continue-shopping]', n.cartItems)?.addEventListener('click', () => closeDrawer(n.cartDrawer));
      return;
    }

    n.cartItems.innerHTML = cart.map(i => `
      <article class="cart-row" data-key="${i.key}">
        <img src="${i.image}" alt="${i.name}" />
        <div class="cart-row-content">
          <h3>${i.name}</h3>
          <div class="meta">${i.size} · ${i.color}</div>
          <div class="meta">${money(i.price)} each</div>
          <div class="price-row">
            <div class="qty-control">
              <button type="button" data-cart-change="${i.key}" data-direction="minus" aria-label="Decrease">−</button>
              <span>${i.qty}</span>
              <button type="button" data-cart-change="${i.key}" data-direction="plus" aria-label="Increase">+</button>
            </div>
            <strong>${money(i.price * i.qty)}</strong>
          </div>
        </div>
        <button class="remove-btn" type="button" data-remove="${i.key}" aria-label="Remove ${i.name}">×</button>
      </article>
    `).join('');

    $$('[data-cart-change]').forEach(b => b.addEventListener('click', () => changeCartQty(b.dataset.cartChange, b.dataset.direction)));
    $$('[data-remove]').forEach(b => b.addEventListener('click', () => {
      const row = b.closest('.cart-row');
      row.classList.add('is-removing');
      setTimeout(() => removeFromCart(b.dataset.remove), 320);
    }));
  }

  function changeCartQty(key, dir) {
    const item = cart.find(r => r.key === key);
    const product = getProduct(item?.id);
    if (!item || !product) return;
    item.qty = dir === 'plus' ? Math.min(product.stock, item.qty + 1) : item.qty - 1;
    if (item.qty <= 0) cart = cart.filter(r => r.key !== key);
    saveCart();
  }
  function removeFromCart(key) { cart = cart.filter(i => i.key !== key); saveCart(); }

  // ---------- Wishlist ----------
  function toggleWishlist(id) {
    const wasIn = wishlist.includes(id);
    wishlist = wasIn ? wishlist.filter(x => x !== id) : [...wishlist, id];
    writeJSON(STORE_KEYS.wishlist, wishlist);
    n.wishCounts.forEach(c => {
      c.textContent = wishlist.length;
      c.classList.toggle('is-visible', wishlist.length > 0);
    });
    bumpCounter('[data-wishlist-count]');
    renderWishlist();
    // Update card heart state without full grid re-render
    $$(`[data-wish="${id}"]`).forEach(b => b.classList.toggle('is-active', !wasIn));
    toast(wasIn ? 'Removed from wishlist.' : 'Saved to wishlist.');
  }

  function renderWishlist() {
    const qty = wishlist.length;
    n.wishCounts.forEach(c => { c.textContent = qty; c.classList.toggle('is-visible', qty > 0); });
    const items = wishlist.map(getProduct).filter(Boolean);

    if (!items.length) {
      n.wishlistItems.innerHTML = `
        <div class="empty-drawer">
          <svg viewBox="0 0 48 48"><path d="M24 42s-14-9-19-18A11 11 0 0 1 24 12a11 11 0 0 1 19 12c-5 9-19 18-19 18z"/></svg>
          <h3>No saved styles yet</h3>
          <p>Tap the heart on any item to save it here.</p>
        </div>`;
      return;
    }
    n.wishlistItems.innerHTML = items.map(p => `
      <article class="cart-row">
        <img src="${p.image}" alt="${p.name}" />
        <div class="cart-row-content">
          <h3>${p.name}</h3>
          <div class="meta">${p.category} · ${p.badge || ''}</div>
          <div class="price-row">
            <strong>${money(p.price)}</strong>
            <div style="display:flex;gap:6px">
              <button class="btn btn-soft btn-sm" data-wish-quick="${p.id}">View</button>
              <button class="btn btn-soft btn-sm" data-wish-add="${p.id}">+ Bag</button>
            </div>
          </div>
        </div>
        <button class="remove-btn" type="button" data-wish-remove="${p.id}" aria-label="Remove ${p.name}">×</button>
      </article>
    `).join('');

    $$('[data-wish-quick]').forEach(b => b.addEventListener('click', () => {
      closeDrawer(n.wishlistDrawer);
      openProductModal(b.dataset.wishQuick);
    }));
    $$('[data-wish-add]').forEach(b => b.addEventListener('click', () => fastAdd(b.dataset.wishAdd)));
    $$('[data-wish-remove]').forEach(b => b.addEventListener('click', () => toggleWishlist(b.dataset.wishRemove)));
  }

  // ---------- Recently viewed ----------
  function addToRecent(id) {
    recent = [id, ...recent.filter(x => x !== id)].slice(0, RECENT_LIMIT);
    writeJSON(STORE_KEYS.recent, recent);
    renderRecent();
  }

  function renderRecent() {
    const items = recent.map(getProduct).filter(Boolean);
    if (!items.length) {
      n.recentSection.classList.remove('is-visible');
      return;
    }
    n.recentSection.classList.add('is-visible');
    n.recentList.innerHTML = items.map(p => `
      <div class="recent-card" data-recent-view="${p.id}">
        <img src="${p.image}" alt="${p.name}" loading="lazy" />
        <div>
          <strong>${p.name}</strong>
          <span>${money(p.price)}</span>
        </div>
      </div>
    `).join('');
    $$('[data-recent-view]').forEach(c => c.addEventListener('click', () => openProductModal(c.dataset.recentView)));
  }

  // ---------- Orders drawer ----------
  function renderOrders() {
    const orders = readJSON(STORE_KEYS.orders, []);
    if (!orders.length) {
      n.ordersItems.innerHTML = `
        <div class="empty-drawer">
          <svg viewBox="0 0 48 48"><path d="M10 14h28l-2.5 24a3 3 0 0 1-3 2.7H15.5a3 3 0 0 1-3-2.7L10 14z"/><path d="M18 14V9a6 6 0 0 1 12 0v5"/></svg>
          <h3>No orders yet</h3>
          <p>Your past orders will be listed here.</p>
        </div>`;
      return;
    }
    n.ordersItems.innerHTML = orders.slice().reverse().map(o => `
      <article class="cart-row" style="grid-template-columns:1fr">
        <div class="cart-row-content">
          <h3>${o.id}</h3>
          <div class="meta">${new Date(o.date).toLocaleString()}</div>
          <div class="meta">${o.items.length} item(s) · ${o.customer.payment || 'Cash on delivery'}</div>
          <div class="price-row">
            <strong>${money(o.total)}</strong>
            <span class="meta">${o.customer.city || ''}</span>
          </div>
        </div>
      </article>
    `).join('');
  }

  // ---------- Drawers ----------
  function openDrawer(d) {
    if (!d) return;
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }
  function closeDrawer(d) {
    if (!d) return;
    d.classList.remove('is-open');
    d.setAttribute('aria-hidden', 'true');
    if (!n.modal.classList.contains('is-open') && !n.checkoutModal.classList.contains('is-open')) {
      document.body.classList.remove('no-scroll');
    }
  }

  // ---------- Promo ----------
  function applyPromo() {
    const code = (n.promoInput.value || '').trim().toUpperCase();
    if (!code) { toast('Enter a promo code.'); return; }
    const codes = window.PAVIA_PROMO_CODES || {};
    if (!codes[code]) {
      appliedPromo = null;
      writeJSON(STORE_KEYS.promo, null);
      toast('Invalid promo code.');
      renderCart();
      return;
    }
    appliedPromo = code;
    writeJSON(STORE_KEYS.promo, code);
    n.promoInput.value = '';
    renderCart();
    toast(`Promo applied: ${codes[code].label}`);
  }

  // ---------- Checkout ----------
  function deliveryFee(city = '') {
    if (isFreeShipPromo()) return 0;
    if (cartSubtotal() - discountAmount() >= FREE_DELIVERY_AT) return 0;
    return norm(city).includes('beirut') ? DELIVERY_BEIRUT : DELIVERY_LEBANON;
  }

  function openCheckout() {
    if (!cart.length) { toast('Your bag is empty. Add an item first.'); return; }
    closeDrawer(n.cartDrawer);
    renderCheckoutSummary();
    n.checkoutModal.classList.add('is-open');
    n.checkoutModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }
  function closeCheckout() {
    if (!n.checkoutModal.classList.contains('is-open')) return;
    n.checkoutModal.classList.remove('is-open');
    n.checkoutModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }

  function renderCheckoutSummary(city = '') {
    const subtotal = cartSubtotal();
    const discount = discountAmount();
    const delivery = deliveryFee(city);
    const total = Math.max(0, subtotal - discount) + delivery;
    n.checkoutSummary.innerHTML = `
      ${cart.map(i => `
        <div class="summary-line">
          <span>${i.qty}× ${i.name}<br><small style="color:var(--muted)">${i.size} · ${i.color}</small></span>
          <strong>${money(i.price * i.qty)}</strong>
        </div>`).join('')}
      <div class="summary-line"><span>Subtotal</span><strong>${money(subtotal)}</strong></div>
      ${discount > 0 ? `<div class="summary-line"><span>Discount${appliedPromo ? ` (${appliedPromo})` : ''}</span><strong>-${money(discount)}</strong></div>` : ''}
      <div class="summary-line"><span>Delivery</span><strong>${delivery ? money(delivery) : 'Free'}</strong></div>
      <div class="summary-line total"><span>Total</span><strong>${money(total)}</strong></div>
    `;
  }

  function orderText(formData = null) {
    const v = formData ? Object.fromEntries(formData.entries()) : {};
    const subtotal = cartSubtotal();
    const discount = discountAmount();
    const delivery = deliveryFee(v.city || '');
    const total = Math.max(0, subtotal - discount) + delivery;
    const lines = [
      'Hello Pavia, I would like to place this order:',
      '',
      ...cart.map(i => `• ${i.qty}× ${i.name} — ${i.size}, ${i.color} — ${money(i.price * i.qty)}`),
      '',
      `Subtotal: ${money(subtotal)}`,
      discount > 0 ? `Discount${appliedPromo ? ` (${appliedPromo})` : ''}: -${money(discount)}` : '',
      `Delivery: ${delivery ? money(delivery) : 'Free'}`,
      `Total: ${money(total)}`,
      '',
      v.name ? `Name: ${v.name}` : '',
      v.phone ? `Phone: ${v.phone}` : '',
      v.city ? `City/Area: ${v.city}` : '',
      v.address ? `Address: ${v.address}` : '',
      v.payment ? `Payment: ${v.payment}` : '',
      v.notes ? `Notes: ${v.notes}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }

  function submitCheckout(e) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const txt = orderText(formData);
    const order = {
      id: `PAVIA-${Date.now().toString().slice(-7)}`,
      date: new Date().toISOString(),
      items: cart.slice(),
      customer: Object.fromEntries(formData.entries()),
      promo: appliedPromo,
      discount: discountAmount(),
      total: Math.max(0, cartSubtotal() - discountAmount()) + deliveryFee(formData.get('city'))
    };
    const orders = readJSON(STORE_KEYS.orders, []);
    orders.push(order);
    writeJSON(STORE_KEYS.orders, orders);

    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(txt)}`, '_blank', 'noopener,noreferrer');
    toast('Order prepared. Sending on WhatsApp.');

    // Clear cart + promo after a successful submission
    setTimeout(() => {
      cart = [];
      appliedPromo = null;
      writeJSON(STORE_KEYS.cart, cart);
      writeJSON(STORE_KEYS.promo, null);
      renderCart();
      closeCheckout();
    }, 800);
  }

  async function copyOrderText() {
    try {
      await navigator.clipboard.writeText(orderText(new FormData(n.checkoutForm)));
      toast('Order text copied.');
    } catch {
      toast('Could not copy automatically.');
    }
  }

  // ---------- Counter bump animation ----------
  function bumpCounter(selector) {
    $$(selector).forEach(el => {
      el.classList.remove('is-bumping');
      void el.offsetWidth;
      el.classList.add('is-bumping');
    });
  }

  // ---------- Toast ----------
  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    n.toastRegion.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 320);
    }, 2800);
  }

  // ---------- Service worker ----------
  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('service-worker.js').catch(() => null);
    }
  }

  init();
})();
