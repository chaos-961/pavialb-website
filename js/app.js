(() => {
  const STORE_KEYS = {
    products: 'PAVIA_PRODUCTS',
    cart: 'PAVIA_CART',
    wishlist: 'PAVIA_WISHLIST',
    subscribers: 'PAVIA_SUBSCRIBERS',
    orders: 'PAVIA_ORDERS'
  };

  const WHATSAPP_NUMBER = '9613017725';
  const FREE_DELIVERY_AT = 100;
  const DELIVERY_BEIRUT = 3;
  const DELIVERY_LEBANON = 5;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  const readJSON = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.warn(`Could not read ${key}`, error);
      return fallback;
    }
  };

  const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const money = (value) => `$${Number(value || 0).toFixed(0)}`;
  const normalize = (value) => String(value || '').trim().toLowerCase();

  let products = readJSON(STORE_KEYS.products, window.PAVIA_DEFAULT_PRODUCTS || []);
  let cart = readJSON(STORE_KEYS.cart, []);
  let wishlist = readJSON(STORE_KEYS.wishlist, []);
  let activeCategory = 'All';
  let modalProduct = null;
  let selectedSize = '';
  let selectedColor = '';
  let selectedQty = 1;

  const nodes = {
    header: $('[data-header]'),
    productGrid: $('[data-product-grid]'),
    productSearch: $('#productSearch'),
    sizeFilter: $('#sizeFilter'),
    sortFilter: $('#sortFilter'),
    categoryPills: $('[data-category-pills]'),
    resultCount: $('[data-result-count]'),
    clearFilters: $('#clearFilters'),
    cartDrawer: $('[data-cart-drawer]'),
    wishlistDrawer: $('[data-wishlist-drawer]'),
    cartItems: $('[data-cart-items]'),
    wishlistItems: $('[data-wishlist-items]'),
    cartCount: $('[data-cart-count]'),
    wishlistCount: $('[data-wishlist-count]'),
    subtotal: $('[data-subtotal]'),
    total: $('[data-total]'),
    deliveryEstimate: $('[data-delivery-estimate]'),
    modal: $('[data-product-modal]'),
    modalContent: $('[data-modal-content]'),
    checkoutModal: $('[data-checkout-modal]'),
    checkoutSummary: $('[data-checkout-summary]'),
    toastRegion: $('[data-toast-region]'),
    mobileNav: $('[data-mobile-nav]')
  };

  const categories = () => ['All', ...new Set(products.map(product => product.category))];
  const cartSubtotal = () => cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
  const cartQuantity = () => cart.reduce((sum, item) => sum + item.qty, 0);
  const getProduct = (id) => products.find(product => product.id === id);

  function init() {
    renderCategories();
    renderProducts();
    renderCart();
    renderWishlist();
    bindEvents();
    registerServiceWorker();
  }

  function bindEvents() {
    window.addEventListener('scroll', () => {
      nodes.header.classList.toggle('is-scrolled', window.scrollY > 12);
    });

    $('[data-menu-toggle]')?.addEventListener('click', () => nodes.mobileNav.classList.toggle('is-open'));
    $$('.mobile-nav a').forEach(link => link.addEventListener('click', () => nodes.mobileNav.classList.remove('is-open')));

    nodes.productSearch?.addEventListener('input', renderProducts);
    nodes.sizeFilter?.addEventListener('change', renderProducts);
    nodes.sortFilter?.addEventListener('change', renderProducts);
    nodes.clearFilters?.addEventListener('click', clearFilters);
    $('.search-trigger')?.addEventListener('click', () => {
      document.location.hash = '#shop';
      setTimeout(() => nodes.productSearch?.focus(), 250);
    });

    $('[data-open-cart]')?.addEventListener('click', () => openDrawer(nodes.cartDrawer));
    $('[data-close-cart]')?.addEventListener('click', () => closeDrawer(nodes.cartDrawer));
    $('[data-continue-shopping]')?.addEventListener('click', () => closeDrawer(nodes.cartDrawer));
    $('[data-open-wishlist]')?.addEventListener('click', () => openDrawer(nodes.wishlistDrawer));
    $('[data-close-wishlist]')?.addEventListener('click', () => closeDrawer(nodes.wishlistDrawer));

    nodes.cartDrawer?.addEventListener('click', (event) => {
      if (event.target === nodes.cartDrawer) closeDrawer(nodes.cartDrawer);
    });
    nodes.wishlistDrawer?.addEventListener('click', (event) => {
      if (event.target === nodes.wishlistDrawer) closeDrawer(nodes.wishlistDrawer);
    });

    $('[data-close-modal]')?.addEventListener('click', closeProductModal);
    nodes.modal?.addEventListener('click', (event) => {
      if (event.target === nodes.modal) closeProductModal();
    });
    $('[data-close-checkout]')?.addEventListener('click', closeCheckout);
    nodes.checkoutModal?.addEventListener('click', (event) => {
      if (event.target === nodes.checkoutModal) closeCheckout();
    });

    $('[data-checkout]')?.addEventListener('click', openCheckout);
    $('[data-checkout-form]')?.addEventListener('submit', submitCheckout);
    $('[data-checkout-form] [name="city"]')?.addEventListener('input', (event) => renderCheckoutSummary(event.target.value));
    $('[data-copy-order]')?.addEventListener('click', copyOrderText);

    $$('[data-category-jump]').forEach(button => {
      button.addEventListener('click', () => {
        activeCategory = button.dataset.categoryJump;
        document.location.hash = '#shop';
        renderCategories();
        renderProducts();
      });
    });

    $$('[data-featured-product]').forEach(button => {
      button.addEventListener('click', () => openProductModal(button.dataset.featuredProduct));
    });

    $('[data-newsletter]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector('input');
      const subscribers = readJSON(STORE_KEYS.subscribers, []);
      subscribers.push({ email: input.value, date: new Date().toISOString() });
      writeJSON(STORE_KEYS.subscribers, subscribers);
      input.value = '';
      toast('Saved. Connect this form to your email platform when going live.');
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeProductModal();
        closeCheckout();
        closeDrawer(nodes.cartDrawer);
        closeDrawer(nodes.wishlistDrawer);
      }
    });
  }

  function renderCategories() {
    nodes.categoryPills.innerHTML = categories().map(category => `
      <button type="button" class="${category === activeCategory ? 'is-active' : ''}" data-category="${category}">${category}</button>
    `).join('');

    $$('[data-category]', nodes.categoryPills).forEach(button => {
      button.addEventListener('click', () => {
        activeCategory = button.dataset.category;
        renderCategories();
        renderProducts();
      });
    });
  }

  function filteredProducts() {
    const query = normalize(nodes.productSearch?.value);
    const size = nodes.sizeFilter?.value || 'all';
    const sort = nodes.sortFilter?.value || 'featured';

    let result = products.filter(product => {
      const matchesQuery = !query || [product.name, product.category, product.description, product.badge].some(value => normalize(value).includes(query));
      const matchesCategory = activeCategory === 'All' || product.category === activeCategory;
      const matchesSize = size === 'all' || product.sizes.includes(size);
      return matchesQuery && matchesCategory && matchesSize;
    });

    if (sort === 'price-low') result.sort((a, b) => a.price - b.price);
    if (sort === 'price-high') result.sort((a, b) => b.price - a.price);
    if (sort === 'newest') result = [...result].reverse();
    if (sort === 'featured') result.sort((a, b) => Number(b.featured) - Number(a.featured));

    return result;
  }

  function renderProducts() {
    const result = filteredProducts();
    nodes.resultCount.textContent = result.length;

    if (!result.length) {
      nodes.productGrid.innerHTML = `<div class="empty-state"><h3>No styles found</h3><p>Try another search, size, or category.</p></div>`;
      return;
    }

    nodes.productGrid.innerHTML = result.map(product => `
      <article class="product-card reveal">
        <div class="product-media">
          <img src="${product.image}" alt="${product.name}" loading="lazy" />
          <span class="badge">${product.badge}</span>
          <button class="wish-btn ${wishlist.includes(product.id) ? 'is-active' : ''}" data-wishlist-toggle="${product.id}" aria-label="Toggle ${product.name} wishlist">♡</button>
        </div>
        <div class="product-info">
          <div class="product-title-row">
            <h3>${product.name}</h3>
            <div class="price">${money(product.price)}${product.compareAt ? `<span class="compare">${money(product.compareAt)}</span>` : ''}</div>
          </div>
          <p>${product.description}</p>
          <div class="product-actions">
            <button class="quick-button" data-quick-view="${product.id}">Quick view</button>
            <button class="mini-button" data-fast-add="${product.id}" aria-label="Fast add ${product.name}">+</button>
          </div>
        </div>
      </article>
    `).join('');

    $$('[data-quick-view]').forEach(button => button.addEventListener('click', () => openProductModal(button.dataset.quickView)));
    $$('[data-fast-add]').forEach(button => button.addEventListener('click', () => fastAdd(button.dataset.fastAdd)));
    $$('[data-wishlist-toggle]').forEach(button => button.addEventListener('click', () => toggleWishlist(button.dataset.wishlistToggle)));
  }

  function clearFilters() {
    activeCategory = 'All';
    nodes.productSearch.value = '';
    nodes.sizeFilter.value = 'all';
    nodes.sortFilter.value = 'featured';
    renderCategories();
    renderProducts();
  }

  function openProductModal(id) {
    const product = getProduct(id);
    if (!product) return;
    modalProduct = product;
    selectedSize = product.sizes[0];
    selectedColor = product.colors[0];
    selectedQty = 1;
    renderProductModal();
    nodes.modal.classList.add('is-open');
    nodes.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }

  function renderProductModal() {
    const product = modalProduct;
    nodes.modalContent.innerHTML = `
      <div class="modal-product">
        <img src="${product.image}" alt="${product.name}" />
        <div class="modal-details">
          <p class="eyebrow">${product.category} · ${product.badge}</p>
          <h2 id="modalTitle">${product.name}</h2>
          <p class="muted">${product.description}</p>
          <p><strong>${money(product.price)}</strong>${product.compareAt ? ` <span class="compare">${money(product.compareAt)}</span>` : ''}</p>
          <p class="muted">${product.stock} pieces available. Delivery across Lebanon.</p>
          <div class="option-group">
            <span>Size</span>
            <div class="size-options">${product.sizes.map(size => `<button type="button" class="${size === selectedSize ? 'is-selected' : ''}" data-size-option="${size}">${size}</button>`).join('')}</div>
          </div>
          <div class="option-group">
            <span>Color</span>
            <div class="swatches">${product.colors.map(color => `<button type="button" class="${color === selectedColor ? 'is-selected' : ''}" data-color-option="${color}">${color}</button>`).join('')}</div>
          </div>
          <div class="qty-add">
            <div class="qty-control" aria-label="Quantity">
              <button type="button" data-modal-qty="minus">−</button>
              <span>${selectedQty}</span>
              <button type="button" data-modal-qty="plus">+</button>
            </div>
            <button class="button button-primary" data-modal-add>Add to bag · ${money(product.price * selectedQty)}</button>
          </div>
        </div>
      </div>
    `;

    $$('[data-size-option]', nodes.modalContent).forEach(button => button.addEventListener('click', () => {
      selectedSize = button.dataset.sizeOption;
      renderProductModal();
    }));

    $$('[data-color-option]', nodes.modalContent).forEach(button => button.addEventListener('click', () => {
      selectedColor = button.dataset.colorOption;
      renderProductModal();
    }));

    $$('[data-modal-qty]', nodes.modalContent).forEach(button => button.addEventListener('click', () => {
      selectedQty = button.dataset.modalQty === 'plus' ? Math.min(modalProduct.stock, selectedQty + 1) : Math.max(1, selectedQty - 1);
      renderProductModal();
    }));

    $('[data-modal-add]', nodes.modalContent).addEventListener('click', () => {
      addToCart(modalProduct, selectedSize, selectedColor, selectedQty);
      closeProductModal();
      openDrawer(nodes.cartDrawer);
    });
  }

  function closeProductModal() {
    if (!nodes.modal?.classList.contains('is-open')) return;
    nodes.modal.classList.remove('is-open');
    nodes.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }

  function fastAdd(id) {
    const product = getProduct(id);
    if (!product) return;
    addToCart(product, product.sizes[0], product.colors[0], 1);
  }

  function addToCart(product, size, color, qty) {
    const key = `${product.id}-${size}-${color}`;
    const existing = cart.find(item => item.key === key);
    if (existing) {
      existing.qty = Math.min(product.stock, existing.qty + qty);
    } else {
      cart.push({
        key,
        id: product.id,
        name: product.name,
        price: product.price,
        image: product.image,
        size,
        color,
        qty
      });
    }
    saveCart();
    toast(`${product.name} added to bag.`);
  }

  function saveCart() {
    writeJSON(STORE_KEYS.cart, cart);
    renderCart();
  }

  function renderCart() {
    nodes.cartCount.textContent = cartQuantity();
    const subtotal = cartSubtotal();
    nodes.subtotal.textContent = money(subtotal);
    nodes.total.textContent = money(subtotal);
    nodes.deliveryEstimate.textContent = subtotal >= FREE_DELIVERY_AT ? 'Free' : 'Calculated at checkout';

    if (!cart.length) {
      nodes.cartItems.innerHTML = `<div class="empty-cart"><h3>Your bag is empty</h3><p>Add an elegant piece from the collection.</p></div>`;
      return;
    }

    nodes.cartItems.innerHTML = cart.map(item => `
      <article class="cart-row">
        <img src="${item.image}" alt="${item.name}" />
        <div>
          <h3>${item.name}</h3>
          <p>${item.size} · ${item.color}</p>
          <p>${money(item.price)} each</p>
          <div class="cart-row-footer">
            <div class="qty-control">
              <button type="button" data-cart-change="${item.key}" data-direction="minus">−</button>
              <span>${item.qty}</span>
              <button type="button" data-cart-change="${item.key}" data-direction="plus">+</button>
            </div>
            <strong>${money(item.price * item.qty)}</strong>
          </div>
          <button class="remove-btn" type="button" data-remove-cart="${item.key}">Remove</button>
        </div>
      </article>
    `).join('');

    $$('[data-cart-change]').forEach(button => button.addEventListener('click', () => changeCartQty(button.dataset.cartChange, button.dataset.direction)));
    $$('[data-remove-cart]').forEach(button => button.addEventListener('click', () => removeFromCart(button.dataset.removeCart)));
  }

  function changeCartQty(key, direction) {
    const item = cart.find(row => row.key === key);
    const product = getProduct(item?.id);
    if (!item || !product) return;
    item.qty = direction === 'plus' ? Math.min(product.stock, item.qty + 1) : item.qty - 1;
    if (item.qty <= 0) cart = cart.filter(row => row.key !== key);
    saveCart();
  }

  function removeFromCart(key) {
    cart = cart.filter(item => item.key !== key);
    saveCart();
  }

  function toggleWishlist(id) {
    wishlist = wishlist.includes(id) ? wishlist.filter(itemId => itemId !== id) : [...wishlist, id];
    writeJSON(STORE_KEYS.wishlist, wishlist);
    renderWishlist();
    renderProducts();
    toast(wishlist.includes(id) ? 'Saved to wishlist.' : 'Removed from wishlist.');
  }

  function renderWishlist() {
    nodes.wishlistCount.textContent = wishlist.length;
    const wishlistProducts = wishlist.map(getProduct).filter(Boolean);
    if (!wishlistProducts.length) {
      nodes.wishlistItems.innerHTML = `<div class="empty-cart"><h3>No saved styles yet</h3><p>Tap the heart on any item to save it here.</p></div>`;
      return;
    }
    nodes.wishlistItems.innerHTML = wishlistProducts.map(product => `
      <article class="cart-row">
        <img src="${product.image}" alt="${product.name}" />
        <div>
          <h3>${product.name}</h3>
          <p>${product.category} · ${product.badge}</p>
          <div class="cart-row-footer">
            <strong>${money(product.price)}</strong>
            <button class="quick-button" data-wishlist-quick="${product.id}">View</button>
          </div>
          <button class="remove-btn" type="button" data-wishlist-remove="${product.id}">Remove</button>
        </div>
      </article>
    `).join('');
    $$('[data-wishlist-quick]').forEach(button => button.addEventListener('click', () => {
      closeDrawer(nodes.wishlistDrawer);
      openProductModal(button.dataset.wishlistQuick);
    }));
    $$('[data-wishlist-remove]').forEach(button => button.addEventListener('click', () => toggleWishlist(button.dataset.wishlistRemove)));
  }

  function openDrawer(drawer) {
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }

  function closeDrawer(drawer) {
    drawer?.classList.remove('is-open');
    drawer?.setAttribute('aria-hidden', 'true');
    if (!nodes.modal?.classList.contains('is-open') && !nodes.checkoutModal?.classList.contains('is-open')) {
      document.body.classList.remove('no-scroll');
    }
  }

  function deliveryFee(city = '') {
    if (cartSubtotal() >= FREE_DELIVERY_AT) return 0;
    return normalize(city).includes('beirut') ? DELIVERY_BEIRUT : DELIVERY_LEBANON;
  }

  function openCheckout() {
    if (!cart.length) {
      toast('Your bag is empty. Add an item first.');
      return;
    }
    closeDrawer(nodes.cartDrawer);
    renderCheckoutSummary();
    nodes.checkoutModal.classList.add('is-open');
    nodes.checkoutModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
  }

  function closeCheckout() {
    if (!nodes.checkoutModal?.classList.contains('is-open')) return;
    nodes.checkoutModal.classList.remove('is-open');
    nodes.checkoutModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }

  function renderCheckoutSummary(city = '') {
    const subtotal = cartSubtotal();
    const delivery = deliveryFee(city);
    const total = subtotal + delivery;
    nodes.checkoutSummary.innerHTML = `
      ${cart.map(item => `<div class="summary-line"><span>${item.qty}× ${item.name}<br><small>${item.size} · ${item.color}</small></span><strong>${money(item.price * item.qty)}</strong></div>`).join('')}
      <div class="summary-line"><span>Subtotal</span><strong>${money(subtotal)}</strong></div>
      <div class="summary-line"><span>Delivery</span><strong>${delivery ? money(delivery) : 'Free'}</strong></div>
      <div class="summary-line total"><span>Total</span><strong>${money(total)}</strong></div>
    `;
  }

  function orderText(formData = null) {
    const values = formData ? Object.fromEntries(formData.entries()) : {};
    const delivery = deliveryFee(values.city || '');
    const total = cartSubtotal() + delivery;
    const lines = [
      'Hello Pavia, I would like to place this order:',
      '',
      ...cart.map(item => `• ${item.qty}× ${item.name} — ${item.size}, ${item.color} — ${money(item.price * item.qty)}`),
      '',
      `Subtotal: ${money(cartSubtotal())}`,
      `Delivery: ${delivery ? money(delivery) : 'Free'}`,
      `Total: ${money(total)}`,
      '',
      values.name ? `Name: ${values.name}` : '',
      values.phone ? `Phone: ${values.phone}` : '',
      values.city ? `City/Area: ${values.city}` : '',
      values.address ? `Address: ${values.address}` : '',
      values.payment ? `Payment: ${values.payment}` : '',
      values.notes ? `Notes: ${values.notes}` : ''
    ].filter(Boolean);
    return lines.join('\n');
  }

  function submitCheckout(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const text = orderText(formData);
    const order = {
      id: `PAVIA-${Date.now()}`,
      date: new Date().toISOString(),
      items: cart,
      customer: Object.fromEntries(formData.entries()),
      total: cartSubtotal() + deliveryFee(formData.get('city'))
    };
    const orders = readJSON(STORE_KEYS.orders, []);
    orders.push(order);
    writeJSON(STORE_KEYS.orders, orders);
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    toast('Order prepared for WhatsApp.');
  }

  async function copyOrderText() {
    try {
      await navigator.clipboard.writeText(orderText(new FormData($('[data-checkout-form]'))));
      toast('Order text copied.');
    } catch (error) {
      toast('Could not copy automatically.');
    }
  }

  function toast(message) {
    const element = document.createElement('div');
    element.className = 'toast';
    element.textContent = message;
    nodes.toastRegion.appendChild(element);
    setTimeout(() => element.remove(), 3200);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('service-worker.js').catch(() => null);
    }
  }

  init();
})();
