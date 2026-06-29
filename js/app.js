/* =========================================================
   PAVIA — main app
   Storefront logic: catalog, cart, wishlist, orders, modals,
   recently-viewed, smooth UI, and PWA bits.
   ========================================================= */
(() => {
  'use strict';

  // ---------- Constants ----------
  const STORE_KEYS = {
    products:    'PAVIA_PRODUCTS',
    cart:        'PAVIA_CART',
    wishlist:    'PAVIA_WISHLIST',
    orders:      'PAVIA_ORDERS',
    recent:      'PAVIA_RECENT',
    // Identity of the order currently being placed, so a retry after a lost
    // response reuses the same requestId/orderId and the backend dedupes it
    // instead of creating a duplicate. Cleared once the order is confirmed.
    pendingOrder:'PAVIA_PENDING_ORDER'
  };

  const SITE_CONFIG = window.PAVIA_CONFIG || {};
  const BACKEND = window.PaviaBackend;
  const CORE = window.PaviaStoreCore || {};
  // Single universal flat delivery fee (default $3); refreshed from settings.
  let DELIVERY_FEE = Number(SITE_CONFIG.deliveryFee);
  if (!Number.isFinite(DELIVERY_FEE)) DELIVERY_FEE = 3;
  // WhatsApp number, derived from the single phone field (digits only). Used for
  // the optional "Questions? Message us" link — never an automatic redirect.
  let WHATSAPP_NUMBER = '9613017725';
  const RECENT_LIMIT = 8;
  // Mirror the backend per-line clamp (normalizeOrderItems maxQty) so the qty a
  // shopper sees always matches the qty the stored order will actually hold.
  const MAX_QTY_PER_ITEM = 20;

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
  const money = CORE.formatMoney || ((v) => `$${Number(v || 0).toFixed(0)}`);
  const norm  = CORE.normalizeText || ((v) => String(v || '').trim().toLowerCase());
  const num   = CORE.safeNumber || ((v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; });
  // Persisted arrays (cart/wishlist/recent) must survive a localStorage value that
  // is valid JSON but not an array (e.g. "{}" or the literal "null"): without this
  // guard cart.reduce/.map throw on load and brick the whole storefront.
  const asArray = (v) => (Array.isArray(v) ? v : []);

  // ---------- Output escaping (storefront XSS hardening) ----------
  // Every dynamic string rendered via innerHTML below is escaped. `html` is an
  // auto-escaping tagged template (safe by default); esc/safeImg/safeColor/safeUrl
  // cover ad-hoc and attribute contexts. CORE provides these; fall back if absent.
  const esc = CORE.escapeHtml || ((value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  const html = CORE.html || (() => {
    const isSafe = (v) => Boolean(v) && typeof v === 'object' && v.__paviaSafeHtml === true;
    const resolve = (v) => {
      if (v === null || v === undefined || v === false) return '';
      if (isSafe(v)) return v.value;
      if (Array.isArray(v)) return v.map(resolve).join('');
      return esc(v);
    };
    const mark = (str) => { const value = String(str === null || str === undefined ? '' : str); return { __paviaSafeHtml: true, value, toString() { return value; } }; };
    const fn = (strings, ...vals) => {
      let out = strings[0];
      for (let i = 0; i < vals.length; i += 1) out += resolve(vals[i]) + strings[i + 1];
      return mark(out);
    };
    fn.raw = (v) => mark(v);
    return fn;
  })();
  const safeImg = CORE.safeImageSrc || ((value, fallback = 'assets/logo.svg') => {
    const str = String(value === null || value === undefined ? '' : value).trim();
    return str || fallback;
  });
  const safeColor = CORE.safeCssColor || ((value, fallback = '#a78970') => {
    const str = String(value === null || value === undefined ? '' : value).trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(str) || /^[a-zA-Z]{1,24}$/.test(str) ? str : fallback;
  });
  const safeUrl = CORE.safeExternalUrl || ((value, fallback = '') => {
    const str = String(value === null || value === undefined ? '' : value).trim();
    return /^https?:\/\//i.test(str) ? str : fallback;
  });
  const setHtml = (el, safe) => { if (el) el.innerHTML = String(safe); };
  const prefersReducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);

  // ---------- View Transitions (progressive enhancement) ----------
  // Wrap a DOM mutation so supporting browsers crossfade/morph between states.
  // Unsupported browsers (and reduced-motion users) just run the update inline,
  // so behavior is identical everywhere — only the polish differs. `typeClass`
  // is toggled on <html> for the transition's duration so CSS can scope which
  // ::view-transition pseudo-elements animate (e.g. grid filter vs modal morph).
  const supportsViewTransition = () => typeof document.startViewTransition === 'function';
  function withViewTransition(updateDom, typeClass = '') {
    if (!supportsViewTransition() || prefersReducedMotion()) { updateDom(); return null; }
    const root = document.documentElement;
    if (typeClass) root.classList.add(typeClass);
    let transition;
    try {
      transition = document.startViewTransition(updateDom);
    } catch {
      if (typeClass) root.classList.remove(typeClass);
      updateDom();
      return null;
    }
    if (typeClass) transition.finished.finally(() => root.classList.remove(typeClass));
    return transition;
  }

  // ---------- Elegant "no image" placeholder ----------
  // A tasteful editorial placeholder (gradient + dress-on-hanger line art +
  // wordmark) rendered as a self-contained data-URI SVG, so it is CSP-safe
  // (img-src 'self' data:) and never triggers a network request or a 404.
  // The gradient varies by product so a grid of placeholders looks intentional.
  const PLACEHOLDER_GRADIENTS = [
    ['#f4f4f4', '#d4d4d4'], // light gray
    ['#eeeeee', '#c9c9c9'], // soft gray
    ['#f1f1f1', '#cfcfcf'], // pale gray
    ['#eaeaea', '#c4c4c4'], // stone gray
    ['#f3f3f3', '#d1d1d1'], // mist gray
    ['#ececec', '#c6c6c6'], // ash gray
  ];
  function hashString(value) {
    const str = String(value || 'pavia');
    let h = 0;
    for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }
  function placeholderImage(seed) {
    const [top, bottom] = PLACEHOLDER_GRADIENTS[hashString(seed) % PLACEHOLDER_GRADIENTS.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 500' preserveAspectRatio='xMidYMid slice'>`
      + `<defs>`
      + `<linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${top}'/><stop offset='1' stop-color='${bottom}'/></linearGradient>`
      + `<radialGradient id='s' cx='0.5' cy='0.34' r='0.75'><stop offset='0' stop-color='#ffffff' stop-opacity='0.4'/><stop offset='1' stop-color='#ffffff' stop-opacity='0'/></radialGradient>`
      + `</defs>`
      + `<rect width='400' height='500' fill='url(#g)'/>`
      + `<rect width='400' height='500' fill='url(#s)'/>`
      + `<g fill='none' stroke='#4a4a4a' stroke-opacity='0.34' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'>`
      + `<path d='M200 150 q-7 -11 3 -17 q9 -5 8 5'/>` // hanger hook
      + `<path d='M200 152 L170 178 L230 178 Z'/>`       // hanger bar
      + `<path d='M172 180 Q200 197 228 180 L214 250 L249 362 Q200 381 151 362 L186 250 Z'/>` // dress
      + `<path d='M200 198 L200 360' stroke-opacity='0.18'/>` // soft center seam
      + `</g>`
      + `<text x='200' y='426' text-anchor='middle' font-family="Georgia,'Times New Roman',serif" font-size='30' letter-spacing='11' fill='#4a4a4a' fill-opacity='0.5'>PAVIA</text>`
      + `<text x='200' y='452' text-anchor='middle' font-family="Arial,Helvetica,sans-serif" font-size='12' letter-spacing='3.5' fill='#4a4a4a' fill-opacity='0.42'>IMAGE COMING SOON</text>`
      + `</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  function isMissingImage(src) {
    const s = String(src || '').trim();
    if (!s) return true;
    // Treat the brand marks as "no product image" in ANY URL form — relative or
    // absolute, with or without ?query/#hash — so a product saved with the logo
    // fallback never gets cropped into a card. Match on the filename only.
    const base = s.split(/[?#]/)[0].split('/').pop().toLowerCase();
    return base === 'logo.svg' || base === 'icon.svg';
  }
  // Resolve an <img> source: real image when present, else the elegant placeholder.
  function pickImage(src, seed) {
    return isMissingImage(src) ? placeholderImage(seed) : safeImg(src);
  }
  const productImage = (product) => pickImage(product?.image, product?.id || product?.name);

  // ---------- Throttled, lazy image loading (G-DRIVE-COST) ----------
  // Below-the-fold product images load only when near the viewport, and never
  // more than ~4 actually download at once (the rest queue). This keeps Google
  // Drive requests low: the grid shows MAIN images only; gallery images are
  // created (and therefore only requested) when the product modal opens.
  const IMG_MAX_CONCURRENCY = 4;
  // Drive's thumbnail endpoint is occasionally flaky/rate-limited, so a single
  // transient failure shouldn't permanently pin the placeholder. Retry once after
  // a short backoff before giving up. While a retry is pending, data-managed-retry
  // tells the global error handler to stay out of the way (see bindEvents).
  const IMG_MAX_RETRIES = 1;
  const IMG_RETRY_DELAY = 800;
  let imgInFlight = 0;
  const imgQueue = [];
  function pumpImgQueue() {
    while (imgInFlight < IMG_MAX_CONCURRENCY && imgQueue.length) {
      imgInFlight += 1;
      imgQueue.shift()();
    }
  }
  function loadImg(img, url, attempt = 0) {
    img.dataset.managedRetry = '1';
    imgQueue.push(() => {
      // settle() must run exactly once per attempt or the in-flight count drifts
      // and the ~4-at-a-time Drive throttle breaks. We remove BOTH listeners on
      // settle (not {once}) so a later event — e.g. the placeholder's own load —
      // can't re-enter and double-decrement imgInFlight.
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        imgInFlight -= 1;
        pumpImgQueue();
      };
      const onLoad = () => {
        img.classList.add('is-loaded');
        delete img.dataset.managedRetry;
        settle();
      };
      const onError = () => {
        if (attempt < IMG_MAX_RETRIES) {
          settle(); // free the slot during backoff so other images keep loading
          window.setTimeout(() => loadImg(img, url, attempt + 1), IMG_RETRY_DELAY);
          return;
        }
        delete img.dataset.managedRetry;
        img.dataset.placeheld = '1';
        // Reveal the placeholder directly: settle() already removed our load
        // listener, so the placeholder's load event won't fire onLoad for us.
        img.classList.add('is-loaded');
        img.src = placeholderImage(img.alt || img.closest('[data-product-id]')?.dataset.productId || 'pavia');
        settle();
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      img.src = url;
    });
    pumpImgQueue();
  }
  let lazyObserver = null;
  function observeLazyImages(container) {
    if (!container) return;
    const imgs = $$('img[data-src]', container);
    if (!('IntersectionObserver' in window)) {
      imgs.forEach((img) => { const s = img.dataset.src; delete img.dataset.src; loadImg(img, s); });
      return;
    }
    if (!lazyObserver) {
      lazyObserver = new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const img = entry.target;
          obs.unobserve(img);
          const src = img.dataset.src;
          if (src) { delete img.dataset.src; loadImg(img, src); }
        });
      }, { rootMargin: '320px 0px' });
    }
    imgs.forEach((img) => lazyObserver.observe(img));
  }
  // For the product modal: the gallery is few images the user opened on purpose,
  // so load them now (still through the ~4-concurrency queue) rather than waiting
  // on viewport intersection inside the overlay.
  function eagerLoadLazyImages(container) {
    if (!container) return;
    $$('img[data-src]', container).forEach((img) => {
      const src = img.dataset.src;
      delete img.dataset.src;
      loadImg(img, src);
    });
  }
  // Card image markup: placeholder products load instantly (free data-URI);
  // real images defer to the lazy/throttled loader via data-src.
  function lazyImgAttrs(realSrc, seed) {
    if (isMissingImage(realSrc)) return html.raw(`class="lazy-img is-loaded" src="${esc(placeholderImage(seed))}"`);
    return html.raw(`class="lazy-img" data-src="${esc(safeImg(realSrc))}"`);
  }

  // Resolve the modal gallery (main + extra images) through the imageVersion-keyed
  // cache. Called on modal OPEN so gallery images are only fetched then.
  async function resolveGalleryUrls(product) {
    const urls = [product.image];
    const extra = Array.isArray(product.gallery) ? product.gallery : [];
    for (const raw of extra) {
      const entry = CORE.normalizeGalleryEntry ? CORE.normalizeGalleryEntry(raw)
        : (raw && typeof raw === 'object' ? raw : { imageUrl: String(raw || '') });
      if (!entry || !entry.imageUrl) continue;
      const key = CORE.imageCacheKey
        ? CORE.imageCacheKey({ driveFileId: entry.driveFileId, image: entry.imageUrl, imageVersion: entry.imageVersion })
        : '';
      let url = key && CatalogCache ? await CatalogCache.getResolvedImage(key) : null;
      if (!url) {
        url = BACKEND ? await BACKEND.media.resolveImage(entry.imageUrl, entry.imageVersion) : entry.imageUrl;
        if (key && CatalogCache && (!CORE.isStableImageUrl || CORE.isStableImageUrl(url))) {
          await CatalogCache.putResolvedImage(key, url);
        }
      }
      urls.push(url);
    }
    return [...new Set(urls.filter(Boolean))];
  }

  // ---------- P16: storefront resilience state ----------
  let loadError = false;          // true when a catalog load truly failed with no data
  let lastDrawerFocus = null;     // restore focus when a drawer closes
  const debounce = (fn, ms = 200) => {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const makeRequestId = () => {
    if (window.crypto?.randomUUID) return `req-${window.crypto.randomUUID()}`;
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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

  // Stock was removed from the store. Treat every product as effectively unlimited
  // so nothing is ever gated, capped, or labelled "sold out"; the real value in the
  // database is ignored on the storefront.
  const ALWAYS_AVAILABLE = 999999;
  function normalizeProduct(p) {
    const normalized = CORE.normalizeProduct
      ? CORE.normalizeProduct(p, {
          imageIdResolver: (image) => window.PaviaImages?.idFor?.(image) || '',
          imageResolver: (image) => window.PaviaImages?.resolve?.(image) || image,
        })
      : (() => {
        const tags = Array.isArray(p.tags) ? p.tags : [];
        const compareAt = Number(p.compareAt ?? p.comparePrice ?? 0) || 0;
        const imageSource = p.image || p.imageId || '';
        return {
          ...p,
          id: p.id || `product-${Date.now()}`,
          name: p.name || 'Untitled product',
          category: p.category || 'New Arrivals',
          price: Number(p.price) || 0,
          compareAt,
          badge: p.badge || (tags[0] || ''),
          imageId: p.imageId || window.PaviaImages?.idFor?.(p.image) || '',
          image: window.PaviaImages?.resolve?.(imageSource) || p.image || 'assets/logo.svg',
          description: p.description || '',
          sizes: Array.isArray(p.sizes) && p.sizes.length ? p.sizes : ['One size'],
          colors: (Array.isArray(p.colors) && p.colors.length ? p.colors : ['Default']).map(colorObj),
          tags,
          featured: Boolean(p.featured || tags.map(norm).includes('featured')),
          active: p.active !== false,
          material: p.material || '',
          fit: p.fit || '',
          care: p.care || '',
          createdAt: Number(p.createdAt) || 0
        };
      })();
    normalized.stock = ALWAYS_AVAILABLE;
    return normalized;
  }

  // ---------- State ----------
  let products = (window.PAVIA_DEFAULT_PRODUCTS || [])
    .map(normalizeProduct)
    .filter(p => p.active);
  // O(1) id -> product index, rebuilt whenever `products` is reassigned. Replaces
  // repeated O(n) products.find() scans inside cart/wishlist/recent render loops.
  let productById = new Map();
  function indexProducts() { productById = new Map(products.map((p) => [String(p.id), p])); }
  indexProducts();

  let cart        = asArray(readJSON(STORE_KEYS.cart, []));
  let wishlist    = asArray(readJSON(STORE_KEYS.wishlist, []));
  let recent      = asArray(readJSON(STORE_KEYS.recent, []));
  let activeCategory = 'All';
  // Product-grid pagination ("Load more"); reset whenever the filter set changes.
  const PAGE_SIZE = 8;
  let visibleCount = PAGE_SIZE;
  const resetPaging = () => { visibleCount = PAGE_SIZE; };
  // Ids currently painted in the grid, in order. Lets renderProducts tell a
  // "Load more" extension (append only the new cards) apart from a filter/sort
  // change (crossfade the whole grid) instead of rebuilding everything each time.
  let lastShownIds = [];

  let modalProduct = null;
  let selectedSize = '';
  let selectedColor = '';
  let selectedQty = 1;
  let selectedImage = '';
  let modalGallery = [];
  let lastFocusedElement = null;

  // ---------- Node references ----------
  const n = {
    header:           $('[data-header]'),
    productGrid:      $('[data-product-grid]'),
    productSearch:    $('#productSearch'),
    searchClear:      $('[data-search-clear]'),
    sizeFilter:       $('#sizeFilter'),
    colorFilter:      $('#colorFilter'),
    sortFilter:       $('#sortFilter'),
    priceFilter:      $('#priceFilter'),
    availFilter:      $('#availFilter'),
    categoryPills:    $('[data-category-pills]'),
    activeFilters:    $('[data-active-filters]'),
    resultCount:      $('[data-result-count]'),
    resultNoun:       $('[data-result-noun]'),
    clearFilters:     $('#clearFilters'),
    toolbar:          $('[data-toolbar]'),
    filterToggle:     $('[data-filter-toggle]'),
    filterPanel:      $('[data-filter-panel]'),
    loadMoreWrap:     $('[data-load-more-wrap]'),
    loadMore:         $('[data-load-more]'),

    cartDrawer:       $('[data-cart-drawer]'),
    wishlistDrawer:   $('[data-wishlist-drawer]'),
    cartItems:        $('[data-cart-items]'),
    wishlistItems:    $('[data-wishlist-items]'),

    cartCounts:       $$('[data-cart-count]'),
    wishCounts:       $$('[data-wishlist-count]'),

    subtotalEl:       $('[data-subtotal]'),
    totalEl:          $('[data-total]'),
    deliveryEl:       $('[data-delivery-estimate]'),

    modal:            $('[data-product-modal]'),
    modalContent:     $('[data-modal-content]'),
    checkoutModal:    $('[data-checkout-modal]'),
    checkoutSummary:  $('[data-checkout-summary]'),
    checkoutForm:     $('[data-checkout-form]'),
    checkoutSuccess:  $('[data-checkout-success]'),

    toastRegion:      $('[data-toast-region]'),
    recentSection:    $('[data-recent-section]'),
    recentList:       $('[data-recent-list]')
  };

  // ---------- Derived ----------
  const categories = () => ['All', ...new Set(products.map(p => p.category))];
  const cartSubtotal = () => cart.reduce((s, i) => s + num(i.price) * num(i.qty), 0);
  const cartQty = () => cart.reduce((s, i) => s + num(i.qty), 0);
  const getProduct = (id) => productById.get(String(id));
  const cartLineQty = (productId, size = '', color = '') => cart
    .filter((item) => String(item.id) === String(productId)
      && String(item.size || '') === String(size || '')
      && String(item.color || '') === String(color || ''))
    .reduce((sum, item) => sum + Number(item.qty || 0), 0);
  // Total units of a product across ALL size/color lines. Stock is tracked per
  // product, so caps must apply to this sum, not to each line independently.
  const cartProductQty = (productId) => cart
    .filter((item) => String(item.id) === String(productId))
    .reduce((sum, item) => sum + Number(item.qty || 0), 0);

  function normalizeLebanonPhone(value) {
    if (CORE.normalizeLebanonPhone) return CORE.normalizeLebanonPhone(value);
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (/^\+961\d{7,8}$/.test(raw.replace(/\s/g, ''))) return raw.replace(/\s/g, '');
    if (/^961\d{7,8}$/.test(digits)) return `+${digits}`;
    if (/^0\d{7,8}$/.test(digits)) return `+961${digits.slice(1)}`;
    return '';
  }

  function revalidateCart({ notify = false } = {}) {
    let changed = false;
    // Refresh each line against the live catalog: drop items whose product is gone,
    // refresh name/price/image, and keep quantities within the per-item cap. There
    // is no stock to allocate against any more.
    cart = cart
      .map((item) => {
        const product = getProduct(item.id);
        if (!product) {
          changed = true;
          return null;
        }
        const nextQty = Math.min(Math.max(1, Number(item.qty || 1)), MAX_QTY_PER_ITEM);
        const nextPrice = Number(product.price || item.price || 0);
        const nextImage = product.imageSource || product.image || item.image;
        if (nextQty !== item.qty || nextPrice !== item.price || nextImage !== item.image) changed = true;
        return {
          ...item,
          name: product.name,
          price: nextPrice,
          image: nextImage,
          imageVersion: product.imageVersion || item.imageVersion || '',
          qty: nextQty,
        };
      })
      .filter(Boolean);
    if (changed) {
      writeJSON(STORE_KEYS.cart, cart);
      renderCart();
      if (notify) toast('Bag updated with the latest prices.', 'info');
    }
    return !changed;
  }

  function focusableElements(container) {
    return $$('a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter((el) => el.offsetParent !== null);
  }

  function trapFocus(event, container) {
    if (event.key !== 'Tab' || !container?.classList.contains('is-open')) return;
    const focusable = focusableElements(container);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ---------- Overlay scroll-lock + background inertness ----------
  // Lock the page behind drawers/modals with the position:fixed technique so iOS
  // Safari can't scroll the background and the exact scroll position is restored
  // on close (overflow:hidden alone leaks scroll + jumps on iOS). Ref-counted so
  // stacked overlays (e.g. quick-view -> cart) lock once and unlock once.
  let scrollLockCount = 0;
  let lockedScrollY = 0;
  function lockBodyScroll() {
    if (scrollLockCount === 0) {
      lockedScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.style.top = `-${lockedScrollY}px`;
      document.body.classList.add('scroll-locked');
    }
    scrollLockCount += 1;
  }
  function unlockBodyScroll() {
    if (scrollLockCount === 0) return;
    scrollLockCount -= 1;
    if (scrollLockCount === 0) {
      document.body.classList.remove('scroll-locked');
      document.body.style.top = '';
      window.scrollTo(0, lockedScrollY);
    }
  }
  // While any overlay is open, mark the page chrome `inert` so screen-reader and
  // keyboard focus can't escape behind it (the Tab trap only covers Tab keys).
  const overlayIsOpen = () => Boolean(
    n.cartDrawer?.classList.contains('is-open')
    || n.wishlistDrawer?.classList.contains('is-open')
    || n.modal?.classList.contains('is-open')
    || n.checkoutModal?.classList.contains('is-open'),
  );
  function syncBackgroundInert() {
    const on = overlayIsOpen();
    $$('[data-header], main, .site-footer, .whatsapp-fab').forEach((el) => {
      if (on) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
  }

  // ---------- Boot ----------
  function applySiteConfig() {
    const config = {
      version: '0.0.7',
      siteName: 'Pavia',
      siteTitle: 'Pavia Lebanon',
      location: 'Beirut',
      deliveryArea: 'Lebanon',
      tagline: 'Modern elegant fashion',
      description: '',
      phone: '03 017 725',
      instagramHandle: '@pavia.leb',
      ...SITE_CONFIG
    };

    // One phone field (phone == WhatsApp). Derive the tel:, wa.me, and display
    // forms, with back-compat for any legacy phoneNumber/whatsappNumber values.
    const rawPhone = String(config.phone || config.phoneNumber || config.phoneDisplay || '').trim();
    const telPhone = (CORE.normalizeLebanonPhone ? CORE.normalizeLebanonPhone(rawPhone) : '')
      || rawPhone.replace(/[^\d+]/g, '');
    const whatsappDigits = (telPhone || rawPhone).replace(/\D/g, '') || '9613017725';
    WHATSAPP_NUMBER = whatsappDigits;
    const instagramUrl = CORE.instagramUrlFromHandle
      ? CORE.instagramUrlFromHandle(config.instagramHandle)
      : `https://instagram.com/${String(config.instagramHandle || '').replace(/^@+/, '')}`;

    const setText = (selector, value) => {
      if (!value) return;
      $$(selector).forEach((el) => { el.textContent = value; });
    };

    setText('[data-site-name]', config.siteName);
    setText('[data-site-title]', config.siteTitle);
    setText('[data-site-location]', config.location);
    setText('[data-delivery-area]', config.deliveryArea);
    setText('[data-site-tagline]', config.tagline);
    setText('[data-phone-display]', rawPhone);
    setText('[data-instagram-handle]', config.instagramHandle);
    setText('[data-site-version]', `v${String(config.version).replace(/^v/i, '')}`);

    if (config.description) {
      $$('[data-site-description]').forEach((el) => {
        if (el.tagName === 'META') el.setAttribute('content', config.description);
        else el.textContent = config.description;
      });
    }

    $$('[data-phone-link]').forEach((el) => {
      el.href = `tel:${String(telPhone).replace(/[^\d+]/g, '')}`;
    });
    $$('[data-whatsapp-link]').forEach((el) => {
      el.href = `https://wa.me/${whatsappDigits}`;
    });
    $$('[data-instagram-link]').forEach((el) => {
      el.href = safeUrl(instagramUrl, 'https://instagram.com/');
    });

    // Hero headline override — blank keeps the built-in styled markup untouched.
    if (String(config.heroHeadline || '').trim()) {
      $$('[data-hero-headline]').forEach((el) => { el.textContent = String(config.heroHeadline).trim(); });
    }

    // Announcement bar — shown only when enabled AND given text.
    const announcement = $('[data-announcement]');
    if (announcement) {
      const text = String(config.announcementText || '').trim();
      const show = Boolean(config.announcementEnabled) && Boolean(text);
      announcement.textContent = show ? text : '';
      announcement.hidden = !show;
      document.body.classList.toggle('has-announcement', show);
    }

    // Visit section — address line, business hours, and a "Get directions" link.
    const addressLine = String(config.addressLine || '').trim();
    $$('[data-address-line]').forEach((el) => { el.textContent = addressLine; el.hidden = !addressLine; });
    const hours = String(config.businessHours || '').trim();
    $$('[data-business-hours]').forEach((el) => { el.textContent = hours ? `Hours · ${hours}` : ''; el.hidden = !hours; });
    const mapsUrl = safeUrl(config.mapsUrl, '');
    $$('[data-directions-link]').forEach((el) => {
      if (mapsUrl) { el.href = mapsUrl; el.hidden = false; } else { el.hidden = true; }
    });

    // Tab title stays the bare brand name ("Pavia") by request; richer wording for
    // Google/social lives in the static <title> fallback, meta tags, and JSON-LD.
    document.title = config.siteName || 'Pavia';
  }

  // ---------- Revision-aware catalog cache (P14) ----------
  const CatalogCache = window.PaviaCatalogCache || null;
  let rawById = new Map();        // id -> raw public product record (pre-normalize)
  let knownRevs = {};             // id -> rev currently held, for manifest diffing
  let currentManifest = null;     // last manifest we synced/persisted

  function orderRawProducts(list) {
    return [...list].sort((a, b) => {
      const order = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
      return order || String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
  }

  // Resolve image URLs through the persisted imageVersion-keyed cache so unchanged
  // images are never re-resolved or re-fetched from Google Drive.
  async function resolveProductImagesCached(list) {
    if (!BACKEND) return list;
    const resolved = [];
    for (const product of list) {
      const key = CORE.imageCacheKey ? CORE.imageCacheKey(product) : '';
      const cachedUrl = key && CatalogCache ? await CatalogCache.getResolvedImage(key) : null;
      if (cachedUrl && (!CORE.isStableImageUrl || CORE.isStableImageUrl(cachedUrl))) {
        resolved.push({ ...product, imageSource: product.image, image: cachedUrl });
        continue;
      }
      const [one] = await BACKEND.media.resolveProductImages([product]);
      resolved.push(one);
      if (key && CatalogCache && (!CORE.isStableImageUrl || CORE.isStableImageUrl(one.image))) {
        await CatalogCache.putResolvedImage(key, one.image);
      }
    }
    return resolved;
  }

  async function rebuildProductsFromRaw() {
    const normalized = orderRawProducts([...rawById.values()])
      .map(normalizeProduct)
      .filter((product) => product.active);
    products = await resolveProductImagesCached(normalized);
    indexProducts();
  }

  async function persistCatalog() {
    if (!CatalogCache) return;
    try {
      await CatalogCache.writeCatalog([...rawById.values()], currentManifest);
    } catch (error) {
      /* cache persistence is best effort */
    }
  }

  // Differential sync: read the tiny manifest, fetch only changed/new product nodes,
  // reuse cached objects for unchanged ids, drop deleted ids. Falls back to a full
  // list when no manifest exists, and keeps the cached catalog when offline.
  async function syncCatalog() {
    let manifest = null;
    let errored = false;
    try {
      manifest = BACKEND?.catalog?.readManifest ? await BACKEND.catalog.readManifest() : null;
    } catch (error) {
      errored = true;
    }

    if (errored && rawById.size) { loadError = false; return; } // offline: keep the cached catalog

    const nextRevs = manifest && CORE.manifestProductRevs ? CORE.manifestProductRevs(manifest) : {};
    if (manifest && Object.keys(nextRevs).length) {
      const cold = rawById.size === 0;
      const { changed, removed } = CORE.diffManifest(knownRevs, nextRevs);
      const toFetch = cold ? Object.keys(nextRevs) : changed;
      if (toFetch.length) {
        try {
          const fetched = await BACKEND.catalog.fetchProducts(toFetch);
          fetched.forEach((record) => rawById.set(String(record.id), record));
        } catch (error) {
          errored = true;
        }
      }
      removed.forEach((id) => rawById.delete(String(id)));
      [...rawById.keys()].forEach((id) => { if (nextRevs[id] === undefined) rawById.delete(id); });
      // Only mark an id as synced at its new rev once we actually hold its record.
      // A transient per-id fetch miss is left out of knownRevs so the next sync
      // retries it, instead of being permanently hidden because knownRevs advanced.
      knownRevs = {};
      Object.keys(nextRevs).forEach((id) => { if (rawById.has(String(id))) knownRevs[id] = nextRevs[id]; });
      currentManifest = manifest;
    } else {
      // No manifest yet (local provider or unseeded production): full list.
      let records = [];
      try {
        records = BACKEND
          ? await BACKEND.products.list()
          : readJSON(STORE_KEYS.products, window.PAVIA_DEFAULT_PRODUCTS || []);
      } catch (error) {
        errored = true;
      }
      if (!records.length && rawById.size) { loadError = false; return; } // keep cache rather than blanking
      rawById = new Map(records.map((record) => [String(record.id), record]));
      currentManifest = CORE.buildCatalogManifest ? CORE.buildCatalogManifest(records, Date.now()) : null;
      knownRevs = CORE.manifestProductRevs ? CORE.manifestProductRevs(currentManifest) : {};
    }

    // Only a genuine failure with no catalog at all surfaces the error/retry state.
    loadError = errored && rawById.size === 0;
    // A successful network sync proves we're online, so clear any offline banner
    // a missed 'online' event (or a flaky navigator.onLine at load) left stuck up.
    if (!errored) setOfflineBanner(false);
    await rebuildProductsFromRaw();
    if (rawById.size) await persistCatalog();
  }

  async function retryLoad() {
    loadError = false;
    showSkeletons();
    try {
      await syncCatalog();
    } catch (error) {
      loadError = true;
    }
    renderCategories();
    renderProducts();
    renderRecent();
    updateStructuredData();
  }

  function siteOrigin() {
    try {
      return new URL('.', document.baseURI).href.replace(/\/+$/, '');
    } catch (error) {
      return location.origin;
    }
  }

  // Inject/refresh an ItemList of Products as JSON-LD (a data block, not executed,
  // so it is unaffected by the strict script-src CSP).
  function updateStructuredData() {
    if (!CORE.buildProductListJsonLd) return;
    const data = CORE.buildProductListJsonLd(products, {
      siteUrl: siteOrigin(),
      siteName: SITE_CONFIG.siteTitle || 'Pavia Lebanon',
      currency: SITE_CONFIG.currency || 'USD',
      limit: 24,
    });
    let script = document.querySelector('script[data-product-jsonld]');
    if (!script) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-product-jsonld', '');
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);
  }

  // Point og:image/twitter:image at a real featured product image when one exists.
  // Local placeholder SVGs are skipped so the static social card stays valid until
  // Drive-hosted product photos are published.
  function updateSocialImage() {
    const featured = products.find((p) => p.featured && p.image) || products.find((p) => p.image);
    const candidate = SITE_CONFIG.ogImage || featured?.image || '';
    const absolute = CORE.absoluteImageUrl ? CORE.absoluteImageUrl(candidate, siteOrigin()) : candidate;
    if (!/^https:\/\//i.test(absolute) || /\.svg(?:$|\?)/i.test(absolute)) return;
    $$('meta[property="og:image"], meta[name="twitter:image"]').forEach((el) => el.setAttribute('content', absolute));
  }

  function setOfflineBanner(offline) {
    const banner = $('[data-offline-banner]');
    if (banner) banner.hidden = !offline;
  }

  function updateOnlineStatus() {
    setOfflineBanner(navigator.onLine === false);
  }

  async function onReconnect() {
    setOfflineBanner(false);
    try {
      await syncCatalog();
    } catch (error) {
      /* keep showing the cached catalog */
    }
    renderCategories();
    renderProducts();
    renderRecent();
    updateStructuredData();
    updateSocialImage();
  }

  // Stale-while-revalidate first paint: render the IndexedDB-cached catalog instantly.
  async function paintFromCache() {
    if (!CatalogCache) return false;
    let cached = null;
    try {
      cached = await CatalogCache.readCatalog();
    } catch (error) {
      return false;
    }
    if (!cached || !Array.isArray(cached.rawProducts) || !cached.rawProducts.length) return false;
    rawById = new Map(cached.rawProducts.map((record) => [String(record.id), record]));
    currentManifest = cached.manifest || null;
    // Trust a cached rev only for ids whose record we actually have, so a product
    // listed in the manifest but missing from the cached set is re-fetched.
    const cachedRevs = CORE.manifestProductRevs ? CORE.manifestProductRevs(currentManifest) : {};
    knownRevs = {};
    Object.keys(cachedRevs).forEach((id) => { if (rawById.has(String(id))) knownRevs[id] = cachedRevs[id]; });
    await rebuildProductsFromRaw();
    return products.length > 0;
  }

  function subscribeCatalog() {
    if (!BACKEND) return;
    const onChange = async () => {
      await syncCatalog();
      renderCategories();
      renderProducts();
      renderRecent();
      renderCart();
      updateStructuredData();
      updateSocialImage();
    };
    if (BACKEND.catalog?.subscribeManifest) BACKEND.catalog.subscribeManifest(onChange);
    else BACKEND.products.subscribe(onChange);
  }

  async function loadBackendPublicConfig() {
    if (!BACKEND) return;
    const settings = (await (BACKEND.settings?.get?.() || {})) || {};
    // The footer version is owned by js/config.js ONLY — never let a stale `version`
    // persisted in the backend settings override it.
    const { version: _ignoredVersion, ...safeSettings } = settings;
    Object.assign(SITE_CONFIG, safeSettings);
    const fee = Number(SITE_CONFIG.deliveryFee);
    DELIVERY_FEE = Number.isFinite(fee) ? Math.max(0, fee) : 3;
    applyCheckoutState();
  }

  // Tell the inline splash screen (index.html) that real content is on screen so
  // it can finish its progress bar and fade out. Fires at most once; the splash
  // also has its own time cap so it never traps the user if this never fires.
  let readySignaled = false;
  function signalReady() {
    if (readySignaled) return;
    readySignaled = true;
    try { window.dispatchEvent(new Event('pavia:ready')); } catch { /* noop */ }
  }

  async function init() {
    $('[data-year]').textContent = new Date().getFullYear();
    // Ask the browser to keep our cached catalog/images from being evicted under
    // disk pressure. Fire-and-forget; never blocks first paint.
    CatalogCache?.persist?.().catch(() => null);
    // Instant first paint from the cached catalog, else skeletons.
    const painted = await paintFromCache();
    if (painted) {
      renderCategories();
      renderProducts();
      renderRecent();
      applyHeroImages();
      signalReady(); // cached content is already on screen — drop the splash
    } else {
      showSkeletons();
    }
    if (BACKEND) {
      await BACKEND.init({ defaultProducts: window.PAVIA_DEFAULT_PRODUCTS || [] });
      await loadBackendPublicConfig();
      await syncCatalog();
      subscribeCatalog();
      BACKEND.settings?.subscribe?.(async () => {
        await loadBackendPublicConfig();
        applySiteConfig();
        renderCart();
      });
      void BACKEND.analytics.recordSessionVisit();
    } else {
      await syncCatalog();
    }
    applySiteConfig();
    renderCategories();
    if (painted) {
      // Cache already painted; patch in the revalidated catalog immediately.
      renderProducts();
      renderRecent();
      applyHeroImages();
    } else {
      // Stagger the first render so the skeletons get a moment to breathe.
      setTimeout(() => {
        renderProducts();
        renderRecent();
        applyHeroImages();
        signalReady();
      }, 250);
    }
    signalReady(); // safety: never let the splash outlive a completed init
    renderCart();
    renderWishlist();
    bindEvents();
    openDeepLinkedProduct(); // honor a shared/bookmarked ?product= link
    setupRevealObserver();
    registerServiceWorker();
    updateStructuredData();
    updateSocialImage();
    updateOnlineStatus();
    window.addEventListener('online', onReconnect);
    window.addEventListener('offline', () => setOfflineBanner(true));
  }

  // ---------- Event bindings ----------
  function bindEvents() {
    // Any product image that fails to load (e.g. a flaky Drive URL) falls back to
    // the elegant placeholder. `error` doesn't bubble, so listen in capture phase.
    document.addEventListener('error', (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || img.dataset.placeheld) return;
      if (img.dataset.managedRetry) return; // loadImg owns retry/fallback for this image
      if (img.src.startsWith('data:')) return; // placeholder itself can't fail
      img.dataset.placeheld = '1';
      img.src = placeholderImage(img.alt || img.closest('[data-product-id]')?.dataset.productId || 'pavia');
    }, true);

    // Header scroll state + subtle hero parallax (GPU transform only, rAF-batched,
    // direction-agnostic since it derives from scrollY, disabled for reduced motion).
    const heroCopy = $('.hero-copy');
    const heroVisual = $('[data-hero-visual]');
    const allowParallax = heroVisual && !prefersReducedMotion();
    let scrollTicking = false;
    const onScrollFrame = () => {
      scrollTicking = false;
      const y = window.scrollY;
      n.header.classList.toggle('is-scrolled', y > 8);
      if (n.toolbar) n.toolbar.classList.toggle('is-stuck', y > 280);
      // Only run the parallax math while the hero is plausibly on screen.
      if (allowParallax && y < 900) {
        heroVisual.style.transform = `translate3d(0, ${(y * 0.09).toFixed(1)}px, 0)`;
        if (heroCopy) heroCopy.style.transform = `translate3d(0, ${(y * -0.04).toFixed(1)}px, 0)`;
      }
    };
    window.addEventListener('scroll', () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(onScrollFrame);
    }, { passive: true });

    // Search & filters (debounced for smoothness). Any filter change resets paging.
    const debouncedRender = debounce(() => { resetPaging(); renderProducts(); }, 120);
    n.productSearch?.addEventListener('input', () => {
      n.productSearch.parentElement.classList.toggle('has-value', !!n.productSearch.value);
      debouncedRender();
    });
    n.searchClear?.addEventListener('click', () => {
      n.productSearch.value = '';
      n.productSearch.parentElement.classList.remove('has-value');
      n.productSearch.focus();
      resetPaging();
      renderProducts();
    });
    [n.sizeFilter, n.colorFilter, n.sortFilter, n.priceFilter, n.availFilter].forEach(el => {
      el?.addEventListener('change', () => {
        updateFilterDot();
        resetPaging();
        renderProducts();
      });
    });
    n.clearFilters?.addEventListener('click', clearAllFilters);

    // Load more (reveals the next page of the current result set).
    n.loadMore?.addEventListener('click', () => {
      visibleCount += PAGE_SIZE;
      renderProducts();
      // Keep focus sensible: move to the first newly revealed card.
      requestAnimationFrame(() => {
        const cards = $$('.product-card', n.productGrid);
        cards[Math.max(0, visibleCount - PAGE_SIZE)]?.querySelector('[data-quick-view]')?.focus?.();
      });
    });

    // Hero collage → quick view (selectable floating looks)
    setupHeroCollage();

    // Filter toggle
    n.filterToggle?.addEventListener('click', () => {
      n.filterPanel?.classList.toggle('is-open');
    });

    // Header / mobile nav buttons (multiple may share data-attr)
    $$('[data-open-cart]').forEach(b => b.addEventListener('click', () => openDrawer(n.cartDrawer)));
    $$('[data-open-wishlist]').forEach(b => b.addEventListener('click', () => openDrawer(n.wishlistDrawer)));
    $$('[data-open-search]').forEach(b => b.addEventListener('click', () => {
      document.location.hash = '#shop';
      setTimeout(() => n.productSearch?.focus(), 280);
    }));

    $('[data-close-cart]')?.addEventListener('click', () => closeDrawer(n.cartDrawer));
    $('[data-close-wishlist]')?.addEventListener('click', () => closeDrawer(n.wishlistDrawer));
    $('[data-continue-shopping]')?.addEventListener('click', () => closeDrawer(n.cartDrawer));

    [n.cartDrawer, n.wishlistDrawer].forEach(d => {
      d?.addEventListener('click', e => { if (e.target === d) closeDrawer(d); });
    });

    // Modals
    $('[data-close-modal]')?.addEventListener('click', closeProductModal);
    n.modal?.addEventListener('click', e => { if (e.target === n.modal) closeProductModal(); });
    $('[data-close-checkout]')?.addEventListener('click', closeCheckout);
    n.checkoutModal?.addEventListener('click', e => { if (e.target === n.checkoutModal) closeCheckout(); });

    $('[data-checkout]')?.addEventListener('click', openCheckout);
    n.checkoutForm?.addEventListener('submit', submitCheckout);
    n.checkoutForm?.querySelector('[name="phone"]')?.addEventListener('blur', e => {
      const normalized = normalizeLebanonPhone(e.target.value);
      if (normalized) e.target.value = normalized;
    });

    // ESC closes things
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeProductModal(); closeCheckout();
        closeDrawer(n.cartDrawer); closeDrawer(n.wishlistDrawer);
      }
      // Arrow keys page through the gallery while the quick-view is open.
      if (n.modal?.classList.contains('is-open') && modalGallery.length > 1) {
        if (e.key === 'ArrowRight') { e.preventDefault(); stepGallery(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); stepGallery(-1); }
      }
      trapFocus(e, n.modal);
      trapFocus(e, n.checkoutModal);
      trapFocus(e, n.cartDrawer);
      trapFocus(e, n.wishlistDrawer);
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
  // Populate the hero collage with real featured product imagery (falling back to
  // the elegant placeholder). These three are above the fold, so they load eagerly.
  function applyHeroImages() {
    const slots = $$('[data-hero-image]');
    if (!slots.length || !products.length) return;
    const featured = products.filter(p => p.featured);
    const pool = (featured.length >= slots.length ? featured : products)
      .concat(products);
    const seen = new Set();
    const picks = [];
    for (const p of pool) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      picks.push(p);
      if (picks.length >= slots.length) break;
    }
    slots.forEach((img, i) => {
      const p = picks[i] || picks[picks.length - 1];
      if (!p) return;
      img.src = pickImage(p.image, p.id);
      img.alt = `${p.name}, Pavia`;
      // Turn the collage card into a quick-view trigger for this product.
      const card = img.closest('[data-hero-card]');
      if (card) {
        card.dataset.heroProduct = p.id;
        card.setAttribute('role', 'button');
        card.setAttribute('tabindex', '0');
        card.setAttribute('aria-label', `Quick view ${p.name}`);
      }
    });
  }

  // Wire the hero collage: each floating look opens its quick-view (add-to-cart)
  // modal, with the tapped image morphing into the modal hero. Bound once.
  function setupHeroCollage() {
    const heroVisual = $('[data-hero-visual]');
    if (!heroVisual || heroVisual.dataset.heroWired) return;
    heroVisual.dataset.heroWired = '1';

    const openFromCard = (card) => {
      const id = card?.dataset.heroProduct;
      if (!id) return;
      openProductModal(id, $('img', card));
    };
    heroVisual.addEventListener('click', (e) => {
      const card = e.target.closest('[data-hero-card]');
      if (card) openFromCard(card);
    });
    heroVisual.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-hero-card]');
      if (!card) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFromCard(card); }
    });

    // Subtle 3D pointer-tilt — desktop mouse only, never for touch or reduced motion.
    // Uses the `transform` longhand, which composes with the float (translate/rotate)
    // and the hover (scale) without overwriting them.
    const finePointer = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
    if (!finePointer || prefersReducedMotion()) return;
    $$('[data-hero-card]', heroVisual).forEach((card) => {
      let raf = 0, rx = 0, ry = 0;
      const apply = () => {
        raf = 0;
        card.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      };
      card.addEventListener('pointermove', (e) => {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 .. 0.5
        const py = (e.clientY - r.top) / r.height - 0.5;
        ry = px * 14;    // turn toward the cursor (max ~7deg)
        rx = -py * 14;
        if (!raf) raf = requestAnimationFrame(apply);
      });
      card.addEventListener('pointerleave', () => {
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        card.style.transform = '';   // springs back to the CSS base
      });
    });
  }

  // Keep the selected category pill centered in its horizontal scroller so the
  // active filter is never stuck off-screen after a tap.
  function scrollActivePillIntoView() {
    const pills = n.categoryPills;
    const active = pills && $('.is-active', pills);
    if (!active) return;
    const pr = pills.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    const delta = (ar.left - pr.left) - (pills.clientWidth - active.clientWidth) / 2;
    if (Math.abs(delta) < 2) return;
    // Instant (not smooth): a category tap immediately re-renders the grid via a
    // View Transition, which interrupts an in-flight smooth scroll and can leave
    // the active pill off-screen. An instant snap lands synchronously before the
    // transition captures, so the selected pill is always in view.
    pills.scrollBy({ left: delta, behavior: 'auto' });
  }

  // ---------- Dynamic filter options (scale) ----------
  // Size / color / price options are built from the LIVE catalog so the filters
  // stay correct as products are added in the studio — never a hardcoded list.
  const SIZE_ORDER = ['One size', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL'];
  function sortSizes(sizes) {
    return [...sizes].sort((a, b) => {
      const ia = SIZE_ORDER.indexOf(a);
      const ib = SIZE_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      const na = parseFloat(a);
      const nb = parseFloat(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
  }
  // Three readable price bands derived from the catalog's own distribution
  // (roughly the lower/upper thirds), rounded to tidy increments.
  function priceBrackets() {
    const prices = products.map((p) => Number(p.price) || 0).filter((v) => v > 0).sort((a, b) => a - b);
    if (prices.length < 3) return [];
    const max = prices[prices.length - 1];
    const step = max <= 60 ? 5 : max <= 150 ? 10 : 25;
    const roundTo = (v) => Math.max(step, Math.round(v / step) * step);
    const low = roundTo(prices[Math.floor(prices.length / 3)]);
    const high = roundTo(prices[Math.floor((prices.length * 2) / 3)]);
    const out = [{ value: `0-${low}`, label: `Under ${money(low)}` }];
    if (high > low) {
      out.push({ value: `${low}-${high}`, label: `${money(low)} to ${money(high)}` });
      out.push({ value: `${high}-9999999`, label: `${money(high)} +` });
    } else {
      out.push({ value: `${low}-9999999`, label: `${money(low)} +` });
    }
    return out;
  }
  // Replace a select's options below its first ("All …") option, preserving the
  // current selection when it still exists after the rebuild.
  function fillFilterSelect(select, options) {
    if (!select) return;
    const current = select.value;
    const head = select.querySelector('option');
    select.replaceChildren();
    if (head) select.appendChild(head);
    options.forEach((opt) => {
      const el = document.createElement('option');
      const value = typeof opt === 'string' ? opt : opt.value;
      el.value = value;
      el.textContent = typeof opt === 'string' ? opt : opt.label;
      select.appendChild(el);
    });
    const stillThere = Array.from(select.options).some((o) => o.value === current);
    select.value = stillThere ? current : (head ? head.value : (select.options[0]?.value || 'all'));
  }
  function renderFilterOptions() {
    const sizes = sortSizes([...new Set(
      products.flatMap((p) => (Array.isArray(p.sizes) ? p.sizes : [])).map((s) => String(s).trim()).filter(Boolean),
    )]);
    fillFilterSelect(n.sizeFilter, sizes);

    const colors = [];
    const seenColors = new Set();
    products.forEach((p) => (p.colors || []).forEach((c) => {
      const name = colorObj(c).name;
      const key = norm(name);
      if (name && key && !seenColors.has(key)) { seenColors.add(key); colors.push(name); }
    }));
    colors.sort((a, b) => a.localeCompare(b));
    fillFilterSelect(n.colorFilter, colors);

    fillFilterSelect(n.priceFilter, priceBrackets());
  }

  function renderCategories() {
    renderFilterOptions();
    setHtml(n.categoryPills, html`${categories().map(c => html`
      <button type="button" class="${c === activeCategory ? 'is-active' : ''}" data-category="${c}" aria-pressed="${c === activeCategory ? 'true' : 'false'}">${c}</button>
    `)}`);
    $$('[data-category]', n.categoryPills).forEach(b => {
      b.addEventListener('click', () => {
        activeCategory = b.dataset.category;
        resetPaging();
        renderCategories();
        renderProducts();
      });
    });
    scrollActivePillIntoView();
  }

  function updateFilterDot() {
    const selectActive = [n.sizeFilter, n.colorFilter, n.priceFilter, n.availFilter]
      .some((s) => s && s.value !== 'all');
    const hasActive = selectActive
      || Boolean((n.productSearch?.value || '').trim())
      || (activeCategory && activeCategory !== 'All');
    n.filterToggle?.classList.toggle('has-active', hasActive);
  }

  // Removable chips summarizing every active filter, so a shopper always sees
  // (and can individually clear) what's narrowing the grid. Rendered on every
  // renderProducts so it stays in sync with the controls.
  function renderActiveFilters() {
    if (!n.activeFilters) return;
    const chips = [];
    const q = (n.productSearch?.value || '').trim();
    if (q) chips.push({ key: 'search', label: `“${q}”` });
    if (activeCategory && activeCategory !== 'All') chips.push({ key: 'category', label: activeCategory });
    if (n.sizeFilter && n.sizeFilter.value !== 'all') chips.push({ key: 'size', label: `Size ${n.sizeFilter.value}` });
    if (n.colorFilter && n.colorFilter.value !== 'all') chips.push({ key: 'color', label: n.colorFilter.value });
    if (n.priceFilter && n.priceFilter.value !== 'all') chips.push({ key: 'price', label: n.priceFilter.selectedOptions[0]?.textContent || 'Price' });
    if (n.availFilter && n.availFilter.value !== 'all') chips.push({ key: 'avail', label: n.availFilter.selectedOptions[0]?.textContent || '' });

    n.activeFilters.hidden = chips.length === 0;
    setHtml(n.activeFilters, html`
      ${chips.map((c) => html`<button type="button" class="filter-chip" data-remove-filter="${c.key}">${c.label}<span class="filter-chip-x" aria-hidden="true">×</span></button>`)}
      ${chips.length > 1 ? html`<button type="button" class="filter-chip clear-chip" data-remove-filter="all">Clear all</button>` : ''}
    `);
    $$('[data-remove-filter]', n.activeFilters).forEach((b) => {
      b.addEventListener('click', () => removeFilter(b.dataset.removeFilter));
    });
  }

  function removeFilter(key) {
    if (key === 'all') { clearAllFilters(); return; }
    if (key === 'search' && n.productSearch) {
      n.productSearch.value = '';
      n.productSearch.parentElement?.classList.remove('has-value');
    } else if (key === 'category') {
      activeCategory = 'All';
      renderCategories();
    } else if (key === 'size' && n.sizeFilter) {
      n.sizeFilter.value = 'all';
    } else if (key === 'color' && n.colorFilter) {
      n.colorFilter.value = 'all';
    } else if (key === 'price' && n.priceFilter) {
      n.priceFilter.value = 'all';
    } else if (key === 'avail' && n.availFilter) {
      n.availFilter.value = 'all';
    }
    updateFilterDot();
    resetPaging();
    renderProducts();
  }

  // ---------- Filtering ----------
  function filteredProducts() {
    const q = norm(n.productSearch?.value);
    const size = n.sizeFilter?.value || 'all';
    const color = n.colorFilter?.value || 'all';
    const colorNorm = norm(color);
    const sort = n.sortFilter?.value || 'featured';
    const price = n.priceFilter?.value || 'all';
    const avail = n.availFilter?.value || 'all';

    let result = products.filter(p => {
      // Widened haystack: also match material, color names, and tags.
      const hay = [p.name, p.category, p.description, p.badge, p.material,
        ...(p.colors || []).map((c) => colorObj(c).name), ...(p.tags || [])].map(norm).join(' ');
      if (q && !hay.includes(q)) return false;
      if (activeCategory !== 'All' && p.category !== activeCategory) return false;
      if (size !== 'all' && !p.sizes.includes(size)) return false;
      if (color !== 'all' && !(p.colors || []).some((c) => norm(colorObj(c).name) === colorNorm)) return false;
      if (price !== 'all') {
        // Half-open bands [min, max) so a boundary price lands in exactly one
        // bucket; the open-ended top band carries a sentinel max.
        const [min, max] = price.split('-').map(Number);
        if (max >= 9999999) { if (p.price < min) return false; }
        else if (p.price < min || p.price >= max) return false;
      }
      if (avail === 'featured' && !p.featured) return false;
      return true;
    });

    if (sort === 'price-low')  result.sort((a, b) => a.price - b.price);
    if (sort === 'price-high') result.sort((a, b) => b.price - a.price);
    if (sort === 'newest')     result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (sort === 'featured')   result.sort((a, b) => Number(b.featured) - Number(a.featured));
    if (sort === 'name')       result.sort((a, b) => String(a.name).localeCompare(String(b.name)));

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
      .map(c => html`<span style="background:${safeColor(c.hex)}"></span>`);
    const moreCount = colors.length > 4 ? html`<span class="color-mini-count">+${colors.length - 4}</span>` : '';
    const badges = [];
    if (norm(p.badge) === 'new') badges.push(html`<span class="badge new">${p.badge}</span>`);
    if (!badges.length && p.badge) badges.push(html`<span class="badge">${p.badge}</span>`);

    return html`
      <article class="product-card reveal" data-product-id="${p.id}">
        <div class="product-media">
          <img ${lazyImgAttrs(p.image, p.id || p.name)} alt="${p.name}" decoding="async" width="640" height="800" />
          <div class="badge-stack">${badges}</div>
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
          </div>
          <div class="color-mini">${swatches}${moreCount}</div>
        </div>
      </article>
    `;
  }

  // Reveal a set of freshly inserted cards with a soft, capped stagger. Existing
  // cards are never touched, so loading more (or live updates) doesn't re-fade the
  // whole grid. Reduced-motion users get no stagger.
  function revealCards(cards) {
    const reduce = prefersReducedMotion();
    cards.forEach((el, i) => {
      if (!reduce) el.style.transitionDelay = `${Math.min(i * 40, 320)}ms`;
      requestAnimationFrame(() => el.classList.add('is-visible'));
    });
  }

  // Bind interactions for a specific set of cards (scoped so appended cards can be
  // wired without double-binding the ones already on screen).
  function wireProductCards(cards) {
    cards.forEach((card) => {
      const id = card.dataset.productId;
      // The WHOLE card opens quick view (previously the category/price/swatch
      // area was a dead zone) — except taps on the wish / quick-add controls,
      // which keep their own actions. The card image is handed in as the morph
      // source so the open animation flies it into the modal hero.
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-wish], [data-fast-add]')) return;
        openProductModal(id, $('.product-media img', card));
      });
      // Keyboard activation via the product name (exposed as role="button").
      $('[data-quick-view]', card)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProductModal(id); }
      });
      $('[data-fast-add]', card)?.addEventListener('click', (e) => { e.stopPropagation(); fastAdd(id); popButton(e.currentTarget); });
      const wish = $('[data-wish]', card);
      wish?.addEventListener('click', (e) => {
        e.stopPropagation();
        wish.classList.add('is-pulsing');
        setTimeout(() => wish.classList.remove('is-pulsing'), 500);
        toggleWishlist(id);
      });
    });
  }

  // Full (re)paint of the grid. `stagger` plays the entrance reveal (first paint /
  // appended cards); a silent refresh (data changed but the set didn't) skips it.
  function paintGrid(shown, stagger) {
    // Full repaint replaces every card: drop the observer's stale targets first so
    // detached, never-intersected <img> nodes from the prior set aren't pinned in
    // memory across filter/sort cycles (they only ever self-unobserve on intersect).
    lazyObserver?.disconnect();
    setHtml(n.productGrid, html`${shown.map(productCard)}`);
    const cards = $$('.product-card', n.productGrid);
    observeLazyImages(n.productGrid);
    wireProductCards(cards);
    if (stagger) revealCards(cards);
    else cards.forEach((el) => el.classList.add('is-visible'));
  }

  // Append only the next page of cards; animate just those.
  function appendProductCards(list) {
    if (!list.length) return;
    const before = $$('.product-card', n.productGrid).length;
    n.productGrid.insertAdjacentHTML('beforeend', String(html`${list.map(productCard)}`));
    const fresh = $$('.product-card', n.productGrid).slice(before);
    observeLazyImages(n.productGrid); // idempotent for already-observed images
    wireProductCards(fresh);
    revealCards(fresh);
  }

  function setResultCount(count) {
    if (n.resultCount) n.resultCount.textContent = count;
    if (n.resultNoun) n.resultNoun.textContent = count === 1 ? 'style' : 'styles';
  }

  function renderProducts() {
    renderActiveFilters();
    updateFilterDot();
    // Catalog-level states (error / genuinely empty) take precedence over filter-empty.
    if (!products.length) {
      setResultCount(0);
      lastShownIds = [];
      if (n.loadMoreWrap) n.loadMoreWrap.hidden = true;
      if (loadError) {
        n.productGrid.innerHTML = `
          <div class="empty-state load-error" role="alert">
            <h3>Couldn't load the collection</h3>
            <p>Check your connection and try again.</p>
            <button type="button" class="btn btn-primary" data-retry-load>Retry</button>
          </div>`;
        $('[data-retry-load]', n.productGrid)?.addEventListener('click', () => void retryLoad());
      } else {
        n.productGrid.innerHTML = `
          <div class="empty-state">
            <h3>Collection coming soon</h3>
            <p>New pieces are on their way.</p>
          </div>`;
      }
      return;
    }

    const result = filteredProducts();
    setResultCount(result.length);

    if (!result.length) {
      lastShownIds = [];
      n.productGrid.innerHTML = `
        <div class="empty-state">
          <h3>No styles found</h3>
          <p>Try another search, size, or category.</p>
          <button type="button" class="text-btn" id="emptyClear">Clear all filters</button>
        </div>`;
      $('#emptyClear')?.addEventListener('click', clearAllFilters);
      if (n.loadMoreWrap) n.loadMoreWrap.hidden = true;
      return;
    }

    // Show only the first `visibleCount`; "Load more" reveals the next page.
    visibleCount = Math.min(Math.max(PAGE_SIZE, visibleCount), result.length);
    const shown = result.slice(0, visibleCount);
    const shownIds = shown.map((p) => p.id);
    const remaining = result.length - shown.length;
    if (n.loadMoreWrap) {
      n.loadMoreWrap.hidden = remaining <= 0;
      if (n.loadMore && remaining > 0) {
        n.loadMore.textContent = `Load more styles (${remaining})`;
      }
    }

    const prevIds = lastShownIds;
    const domCount = $$('.product-card', n.productGrid).length;
    const inSyncWithDom = prevIds.length > 0 && domCount === prevIds.length;
    const sameSet = inSyncWithDom
      && shownIds.length === prevIds.length
      && prevIds.every((id, i) => shownIds[i] === id);
    const isExtension = inSyncWithDom
      && shownIds.length > prevIds.length
      && prevIds.every((id, i) => shownIds[i] === id);

    lastShownIds = shownIds;

    if (sameSet) {
      paintGrid(shown, false);          // silent content refresh (price/stock/image)
    } else if (isExtension) {
      appendProductCards(shown.slice(prevIds.length)); // "Load more" — append only
    } else if (prevIds.length && domCount > 0) {
      withViewTransition(() => paintGrid(shown, false), 'vt-grid'); // filter/sort change
    } else {
      paintGrid(shown, true);           // first paint — staggered entrance
    }
  }

  function clearAllFilters() {
    activeCategory = 'All';
    if (n.productSearch) {
      n.productSearch.value = '';
      n.productSearch.parentElement?.classList.remove('has-value');
    }
    if (n.sizeFilter) n.sizeFilter.value = 'all';
    if (n.colorFilter) n.colorFilter.value = 'all';
    if (n.sortFilter) n.sortFilter.value = 'featured';
    if (n.priceFilter) n.priceFilter.value = 'all';
    if (n.availFilter) n.availFilter.value = 'all';
    updateFilterDot();
    resetPaging();
    renderCategories();
    renderProducts();
  }

  // ---------- Product modal ----------
  // ---- Deep-linking & sharing (P-phase3) ----
  // Each product gets a shareable, bookmarkable URL (?product=<slug>). Opening a
  // modal reflects it in the address bar (replaceState — no history spam) and
  // publishes a per-product JSON-LD; closing restores the base URL.
  const productSlug = (p) => String(p?.slug || p?.id || '').trim();
  function productShareUrl(p) {
    const slug = productSlug(p);
    return slug
      ? `${location.origin}${location.pathname}?product=${encodeURIComponent(slug)}`
      : location.href;
  }
  // Pre-filled WhatsApp "let me know when it's back" message for a sold-out item.
  // Reuses the store's existing manual/WhatsApp confirmation flow — no new backend
  // write path, no anonymous-write DB rule, no email infrastructure.
  function syncProductUrl(p) {
    if (!history.replaceState) return;
    try { history.replaceState(null, '', productShareUrl(p)); } catch { /* noop */ }
  }
  function clearProductUrl() {
    if (!history.replaceState) return;
    try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* noop */ }
  }
  function setProductJsonLd(p) {
    const data = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.name,
      description: p.description || '',
      category: p.category || '',
      image: /^https:\/\//i.test(p.image) ? p.image : undefined,
      offers: {
        '@type': 'Offer',
        price: Number(p.price) || 0,
        priceCurrency: SITE_CONFIG.currency || 'USD',
        availability: 'https://schema.org/InStock',
        url: productShareUrl(p),
      },
    };
    let script = document.querySelector('script[data-product-detail-jsonld]');
    if (!script) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.setAttribute('data-product-detail-jsonld', '');
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(data);
  }
  function clearProductJsonLd() {
    document.querySelector('script[data-product-detail-jsonld]')?.remove();
  }
  async function shareProduct(p) {
    const url = productShareUrl(p);
    if (navigator.share) {
      try {
        await navigator.share({ title: `${p.name} · ${SITE_CONFIG.siteTitle || 'Pavia'}`, text: p.name, url });
        return;
      } catch { /* cancelled or unsupported → fall back to copy */ }
    }
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch { toast('Could not copy the link', 'error'); }
  }
  // Open the product named in ?product=<slug> on load (shared/bookmarked link).
  function openDeepLinkedProduct() {
    const slug = new URLSearchParams(location.search).get('product');
    if (!slug) return;
    const match = products.find((x) => productSlug(x) === slug) || getProduct(slug);
    if (match) openProductModal(match.id);
  }

  async function openProductModal(id, sourceImg = null) {
    const p = getProduct(id);
    if (!p) return;
    modalProduct = p;
    syncProductUrl(p);
    setProductJsonLd(p);
    selectedSize = p.sizes[0] || '';
    selectedColor = (p.colors[0] && p.colors[0].name) || '';
    selectedQty = 1;
    modalGallery = [p.image];
    selectedImage = p.image;
    lastFocusedElement = document.activeElement;
    addToRecent(id);
    void BACKEND?.analytics.recordEvent('product_view');

    const revealModal = () => {
      renderProductModal();
      const modalWasOpen = n.modal.classList.contains('is-open');
      n.modal.classList.add('is-open');
      n.modal.setAttribute('aria-hidden', 'false');
      if (!modalWasOpen) lockBodyScroll();
      syncBackgroundInert();
      requestAnimationFrame(() => $('[data-modal-add]', n.modalContent)?.focus());
    };

    // Shared-element morph: fly the tapped card image into the modal hero image.
    // Only one element may carry the name in each captured state, so we move it
    // off the card and onto the rendered hero inside the update callback.
    if (sourceImg && supportsViewTransition() && !prefersReducedMotion()) {
      sourceImg.style.viewTransitionName = 'product-hero';
      const clearNames = () => {
        sourceImg.style.viewTransitionName = '';
        const heroImg = $('[data-modal-zoom]', n.modalContent);
        if (heroImg) heroImg.style.viewTransitionName = '';
      };
      const transition = withViewTransition(() => {
        sourceImg.style.viewTransitionName = '';
        revealModal();
        const heroImg = $('[data-modal-zoom]', n.modalContent);
        if (heroImg) heroImg.style.viewTransitionName = 'product-hero';
      }, 'vt-modal');
      if (transition) transition.finished.finally(clearNames);
      else clearNames();
    } else {
      revealModal();
    }

    // Resolve gallery images only now (modal open) — keeps Drive requests off the grid.
    try {
      const urls = await resolveGalleryUrls(p);
      // Guard against a late resolve after the modal was closed (or a different
      // product opened): only patch in the gallery if this product is still shown.
      if (modalProduct === p && n.modal.classList.contains('is-open') && urls.length > 1) {
        modalGallery = urls;
        renderProductModal();
      }
    } catch (error) {
      /* gallery is best-effort; main image already shows */
    }
  }

  // Switch the modal hero image in place (no full re-render): swap the main img,
  // move the selected thumbnail, and update the counter. Resets any active zoom.
  function selectGalleryImage(url) {
    if (!url || url === selectedImage) return;
    selectedImage = url;
    const heroImg = $('[data-modal-zoom]', n.modalContent);
    if (heroImg) {
      heroImg.classList.remove('is-zoomed');
      heroImg.style.transformOrigin = '';
      heroImg.src = pickImage(url, modalProduct?.id);
    }
    $$('[data-gallery-src]', n.modalContent).forEach((b) => {
      b.classList.toggle('is-selected', b.dataset.gallerySrc === url);
    });
    const counter = $('[data-gallery-counter]', n.modalContent);
    if (counter) {
      const g = modalGallery.length ? modalGallery : [selectedImage];
      counter.textContent = `${g.indexOf(url) + 1} / ${g.length}`;
    }
  }
  // Page through the gallery (keyboard arrows / swipe), wrapping at the ends.
  function stepGallery(dir) {
    const g = modalGallery.length ? modalGallery : [];
    if (g.length < 2) return;
    const cur = Math.max(0, g.indexOf(selectedImage));
    selectGalleryImage(g[(cur + dir + g.length) % g.length]);
  }

  function renderProductModal() {
    const p = modalProduct;
    const colors = (p.colors || []).map(colorObj);
    const inBagTotal = cartProductQty(p.id);
    const maxQty = Math.max(0, MAX_QTY_PER_ITEM - inBagTotal);
    const gallery = modalGallery.length ? modalGallery : [p.image];
    selectedQty = Math.min(Math.max(1, selectedQty), Math.max(1, maxQty));

    setHtml(n.modalContent, html`
      <div class="modal-product">
        <div class="image-wrap">
          <img src="${pickImage(selectedImage || p.image, p.id)}" alt="${p.name}" decoding="async" width="720" height="780" data-modal-zoom />
          ${gallery.length > 1 ? html`<div class="modal-counter" data-gallery-counter>${gallery.indexOf(selectedImage) + 1} / ${gallery.length}</div>` : ''}
          ${gallery.length > 1 ? html`
            <div class="modal-gallery" aria-label="Product images">
              ${gallery.map((src, index) => html`
                <button type="button" class="${src === selectedImage ? 'is-selected' : ''}" data-gallery-src="${safeImg(src)}" aria-label="View image ${index + 1}">
                  <img ${lazyImgAttrs(src, `${p.id}-${index}`)} alt="" width="64" height="80" decoding="async" />
                </button>
              `)}
            </div>
          ` : ''}
        </div>
        <div class="modal-details">
          <span class="eyebrow">${p.category}${p.badge ? html` · ${p.badge}` : ''}</span>
          <div class="modal-title-row">
            <h2 id="modalTitle">${p.name}</h2>
            <button type="button" class="modal-share" data-modal-share aria-label="Share this product">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/></svg>
              <span>Share</span>
            </button>
          </div>
          <p class="muted modal-desc">${p.description}</p>
          <div class="modal-price-row">
            <span class="now">${money(p.price)}</span>
          </div>

          <div class="option-group">
            <div class="label"><span>Size</span><span>${selectedSize}</span></div>
            <div class="size-options">
              ${p.sizes.map(s => html`<button type="button" class="${s === selectedSize ? 'is-selected' : ''}" data-size="${s}">${s}</button>`)}
            </div>
          </div>

          <div class="option-group">
            <div class="label"><span>Color</span><span>${selectedColor}</span></div>
            <div class="color-swatches">
              ${colors.map(c => html`
                <button type="button" class="${c.name === selectedColor ? 'is-selected' : ''}" data-color="${c.name}">
                  <span class="color-dot" style="background:${safeColor(c.hex)}"></span>${c.name}
                </button>
              `)}
            </div>
          </div>

          <div class="qty-add-row">
            <div class="qty-control" aria-label="Quantity">
              <button type="button" data-modal-qty="minus" aria-label="Decrease quantity">−</button>
              <span>${selectedQty}</span>
              <button type="button" data-modal-qty="plus" aria-label="Increase quantity" ${selectedQty >= maxQty ? 'disabled' : ''}>+</button>
            </div>
            <button class="btn btn-primary" data-modal-add ${maxQty <= 0 ? 'disabled' : ''}>
              Add to bag · ${money(p.price * selectedQty)}
            </button>
          </div>

          <p class="stock-note">${inBagTotal ? `${inBagTotal} already in your bag.` : 'Ready to add.'}</p>

          <div class="modal-meta">
            <div>
              <svg viewBox="0 0 24 24"><path d="M5 8h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8z"/></svg>
              <span>Delivery across Lebanon</span>
            </div>
            <div>
              <svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>
              <span>Flat ${money(DELIVERY_FEE)} delivery · pay cash or Whish</span>
            </div>
            <div>
              <svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.2-5.6A8.4 8.4 0 1 1 21 11.5Z"/></svg>
              <span>We confirm every order by WhatsApp or phone</span>
            </div>
          </div>
        </div>
      </div>
    `);

    const modalAddButton = $('[data-modal-add]', n.modalContent);
    if (modalAddButton) {
      modalAddButton.textContent = maxQty <= 0
        ? 'Already in bag'
        : `Add to bag - ${money(p.price * selectedQty)}`;
    }
    eagerLoadLazyImages(n.modalContent);
    $('[data-modal-share]', n.modalContent)?.addEventListener('click', () => shareProduct(p));
    // Tap-to-zoom the main image toward the click point; tap again to reset.
    const zoomImg = $('[data-modal-zoom]', n.modalContent);
    zoomImg?.addEventListener('click', (event) => {
      const zoomed = zoomImg.classList.toggle('is-zoomed');
      if (zoomed) {
        const rect = zoomImg.getBoundingClientRect();
        const ox = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
        const oy = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
        zoomImg.style.transformOrigin = `${ox}% ${oy}%`;
      } else {
        zoomImg.style.transformOrigin = '';
      }
    });
    $$('[data-gallery-src]', n.modalContent).forEach(b => b.addEventListener('click', () => selectGalleryImage(b.dataset.gallerySrc)));
    // Swipe the hero image left/right to page through the gallery (touch).
    const imageWrap = $('.image-wrap', n.modalContent);
    if (imageWrap && modalGallery.length > 1) {
      let swipeX = 0;
      let swipeY = 0;
      imageWrap.addEventListener('touchstart', (event) => {
        const touch = event.changedTouches[0];
        swipeX = touch.clientX;
        swipeY = touch.clientY;
      }, { passive: true });
      imageWrap.addEventListener('touchend', (event) => {
        const touch = event.changedTouches[0];
        const dx = touch.clientX - swipeX;
        const dy = touch.clientY - swipeY;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) stepGallery(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
    $$('[data-size]', n.modalContent).forEach(b => b.addEventListener('click', () => { selectedSize = b.dataset.size; renderProductModal(); }));
    $$('[data-color]', n.modalContent).forEach(b => b.addEventListener('click', () => { selectedColor = b.dataset.color; renderProductModal(); }));
    $$('[data-modal-qty]', n.modalContent).forEach(b => b.addEventListener('click', () => {
      const available = Math.max(0, MAX_QTY_PER_ITEM - cartProductQty(modalProduct.id));
      selectedQty = b.dataset.modalQty === 'plus'
        ? Math.min(available, selectedQty + 1)
        : Math.max(1, selectedQty - 1);
      renderProductModal();
    }));
    modalAddButton?.addEventListener('click', () => {
      addToCart(modalProduct, selectedSize, selectedColor, selectedQty);
      closeProductModal();
      openDrawer(n.cartDrawer);
    });
  }

  function closeProductModal() {
    if (!n.modal.classList.contains('is-open')) return;
    n.modal.classList.remove('is-open');
    n.modal.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
    syncBackgroundInert();
    clearProductUrl();
    clearProductJsonLd();
    lastFocusedElement?.focus?.();
    // Release the open-product reference so a late gallery resolve can't re-render
    // a closed modal and fire Drive image requests for it.
    modalProduct = null;
    modalGallery = [];
  }

  // ---------- Cart ----------
  function fastAdd(id) {
    const p = getProduct(id);
    if (!p) return;
    const firstColor = (p.colors[0] && p.colors[0].name) || '';
    addToCart(p, p.sizes[0], firstColor, 1);
  }

  function addToCart(product, size, color, qty) {
    if (!product) {
      toast('This style is no longer available.', 'error');
      return;
    }
    const key = `${product.id}-${size}-${color}`;
    const existing = cart.find(i => i.key === key);
    const currentQty = existing ? Number(existing.qty || 0) : 0;
    // Cap against the product's TOTAL across every option already in the bag, so a
    // single product never exceeds the per-item limit.
    const addQty = Math.min(
      Number(qty) || 1,
      Math.max(0, MAX_QTY_PER_ITEM - cartProductQty(product.id)),
      Math.max(0, MAX_QTY_PER_ITEM - currentQty),
    );
    if (addQty <= 0) {
      toast(`You can add up to ${MAX_QTY_PER_ITEM} of one item.`, 'error');
      return;
    }
    if (existing) {
      existing.qty = currentQty + addQty;
      existing.price = product.price;
      existing.image = product.imageSource || product.image;
      existing.imageVersion = product.imageVersion || '';
    }
    else cart.push({
      key,
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.imageSource || product.image,
      imageVersion: product.imageVersion || '',
      size,
      color,
      qty: addQty
    });
    saveCart();
    void BACKEND?.analytics.recordEvent('add_to_cart');
    bumpCounter('[data-cart-count]');
    toast(`${product.name} added to bag.`);
  }

  function saveCart() { writeJSON(STORE_KEYS.cart, cart); renderCart(); }

  // Reflect the store's "Checkout enabled" setting (publicStoreSettings.checkoutEnabled)
  // in the cart's Checkout button. When ordering is paused the button is disabled and
  // relabelled; openCheckout() also hard-blocks as a backstop.
  function applyCheckoutState() {
    const enabled = SITE_CONFIG.checkoutEnabled !== false;
    const btn = $('[data-checkout]');
    if (!btn) return;
    btn.disabled = !enabled;
    btn.textContent = enabled ? 'Checkout' : 'Ordering paused';
    btn.title = enabled ? '' : 'Online ordering is paused right now.';
  }

  function renderCart() {
    applyCheckoutState();
    const qty = cartQty();
    n.cartCounts.forEach(c => {
      c.textContent = qty;
      c.classList.toggle('is-visible', qty > 0);
    });

    const subtotal = cartSubtotal();
    const delivery = cart.length ? DELIVERY_FEE : 0;
    const total = subtotal + delivery;

    n.subtotalEl.textContent = money(subtotal);
    n.totalEl.textContent = money(total);
    if (n.deliveryEl) n.deliveryEl.textContent = money(DELIVERY_FEE);

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

    setHtml(n.cartItems, html`${cart.map(i => html`
      <article class="cart-row" data-key="${i.key}">
        <img src="${pickImage(getProduct(i.id)?.image || i.image, i.id)}" alt="${i.name}" loading="lazy" decoding="async" width="76" height="96" />
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
    `)}`);

    $$('[data-cart-change]').forEach(b => b.addEventListener('click', () => changeCartQty(b.dataset.cartChange, b.dataset.direction)));
    $$('[data-remove]').forEach(b => b.addEventListener('click', () => {
      const row = b.closest('.cart-row');
      row.classList.add('is-removing');
      // Don't make reduced-motion users wait on an animation they won't see.
      setTimeout(() => removeFromCart(b.dataset.remove), prefersReducedMotion() ? 0 : 320);
    }));
  }

  function changeCartQty(key, dir) {
    const item = cart.find(r => r.key === key);
    if (!item) return;
    if (dir === 'plus') {
      // A product can leave the catalog (deleted) while it sits in the bag; only the
      // increment needs the live record, so guard just this branch and still let the
      // shopper decrement or remove an orphaned line below.
      const product = getProduct(item.id);
      if (!product) {
        toast('This style is no longer available.', 'error');
        return;
      }
      if (num(item.qty) >= MAX_QTY_PER_ITEM) {
        toast(`You can add up to ${MAX_QTY_PER_ITEM} of one item.`, 'error');
        return;
      }
      item.qty = num(item.qty) + 1;
    } else {
      item.qty = num(item.qty) - 1;
    }
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
    setHtml(n.wishlistItems, html`${items.map(p => html`
      <article class="cart-row">
        <img src="${productImage(p)}" alt="${p.name}" loading="lazy" decoding="async" width="76" height="96" />
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
    `)}`);

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
    setHtml(n.recentList, html`${items.map(p => html`
      <div class="recent-card" data-recent-view="${p.id}">
        <img src="${productImage(p)}" alt="${p.name}" loading="lazy" decoding="async" width="140" height="154" />
        <div>
          <strong>${p.name}</strong>
          <span>${money(p.price)}</span>
        </div>
      </div>
    `)}`);
    $$('[data-recent-view]').forEach(c => c.addEventListener('click', () => openProductModal(c.dataset.recentView)));
  }

  // ---------- Drawers ----------
  function openDrawer(d) {
    if (!d || d.classList.contains('is-open')) return;
    lastDrawerFocus = document.activeElement;
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    lockBodyScroll();
    syncBackgroundInert();
    requestAnimationFrame(() => focusableElements(d)[0]?.focus());
  }
  function closeDrawer(d) {
    if (!d) return;
    const wasOpen = d.classList.contains('is-open');
    d.classList.remove('is-open');
    d.setAttribute('aria-hidden', 'true');
    if (wasOpen) unlockBodyScroll();
    syncBackgroundInert();
    if (wasOpen) lastDrawerFocus?.focus?.();
  }

  // ---------- Checkout ----------
  function deliveryFee() {
    if (CORE.calculateDelivery) return CORE.calculateDelivery({ deliveryFee: DELIVERY_FEE });
    return Math.max(0, DELIVERY_FEE);
  }

  function openCheckout() {
    if (SITE_CONFIG.checkoutEnabled === false) { toast('Online ordering is paused right now.', 'info'); return; }
    if (!cart.length) { toast('Your bag is empty. Add an item first.', 'error'); return; }
    revalidateCart({ notify: true });
    if (!cart.length) { toast('Your bag is empty.', 'error'); return; }
    void BACKEND?.analytics.recordEvent('checkout_started');
    closeDrawer(n.cartDrawer);
    renderCheckoutSummary();
    n.checkoutForm?.classList.remove('is-confirmed');
    if (n.checkoutSuccess) {
      n.checkoutSuccess.classList.add('is-hidden');
      n.checkoutSuccess.classList.remove('is-visible');
      n.checkoutSuccess.innerHTML = '';
    }
    const checkoutWasOpen = n.checkoutModal.classList.contains('is-open');
    n.checkoutModal.classList.add('is-open');
    n.checkoutModal.setAttribute('aria-hidden', 'false');
    if (!checkoutWasOpen) lockBodyScroll();
    syncBackgroundInert();
    lastFocusedElement = document.activeElement;
    requestAnimationFrame(() => n.checkoutForm?.querySelector('[name="name"]')?.focus());
  }
  function closeCheckout() {
    if (!n.checkoutModal.classList.contains('is-open')) return;
    n.checkoutModal.classList.remove('is-open');
    n.checkoutModal.setAttribute('aria-hidden', 'true');
    unlockBodyScroll();
    syncBackgroundInert();
    lastFocusedElement?.focus?.();
  }

  function renderCheckoutSummary() {
    const subtotal = cartSubtotal();
    const delivery = deliveryFee();
    const total = subtotal + delivery;
    setHtml(n.checkoutSummary, html`
      ${cart.map(i => html`
        <div class="summary-line">
          <span>${i.qty}× ${i.name}<br><small style="color:var(--muted)">${i.size} · ${i.color}</small></span>
          <strong>${money(i.price * i.qty)}</strong>
        </div>`)}
      <div class="summary-line"><span>Subtotal</span><strong>${money(subtotal)}</strong></div>
      <div class="summary-line"><span>Delivery</span><strong>${money(delivery)}</strong></div>
      <div class="summary-line total"><span>Total</span><strong>${money(total)}</strong></div>
    `);
  }

  // Floor between real place-order attempts. The submit button is already disabled
  // mid-request; this just spaces retries so a frantic or scripted tap-storm can't
  // fire a burst of order writes. Validation bounces below do not start the clock.
  const ORDER_SUBMIT_COOLDOWN_MS = 1500;
  let lastOrderSubmitAt = 0;
  async function submitCheckout(e) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const phoneInput = e.currentTarget.querySelector('[name="phone"]');
    const normalizedPhone = normalizeLebanonPhone(formData.get('phone'));
    if (!normalizedPhone) {
      phoneInput?.focus();
      toast('Enter a valid Lebanese phone number.', 'error');
      return;
    }
    phoneInput.value = normalizedPhone;
    formData.set('phone', normalizedPhone);
    if (!revalidateCart({ notify: true })) {
      renderCheckoutSummary();
      return;
    }
    const nowMs = Date.now();
    if (nowMs - lastOrderSubmitAt < ORDER_SUBMIT_COOLDOWN_MS) {
      toast('One moment, still finishing your last try.', 'info');
      return;
    }
    lastOrderSubmitAt = nowMs;
    const subtotal = cartSubtotal();
    const delivery = deliveryFee();
    const total = subtotal + delivery;
    // Reuse a pending order identity across retries (e.g. after a dropped
    // connection) so the backend dedupes instead of creating a duplicate. A
    // brand-new submission gets fresh ids; we clear this once the order lands.
    const pending = readJSON(STORE_KEYS.pendingOrder, null);
    const requestId = pending?.requestId || makeRequestId();
    const orderId = pending?.orderId || `order-${Date.now()}`;
    const orderNumber = pending?.orderNumber || `PAV-${Date.now().toString().slice(-6)}`;
    writeJSON(STORE_KEYS.pendingOrder, { requestId, orderId, orderNumber });
    const order = {
      id: orderId,
      requestId,
      orderNumber,
      date: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      items: cart.map((item) => ({
        id: item.id,
        name: item.name,
        qty: Number(item.qty || 1),
        price: Number(item.price || 0),
        size: item.size || '',
        color: item.color || '',
      })),
      customer: Object.fromEntries(formData.entries()),
      subtotal,
      discount: 0,
      delivery,
      status: 'pending',
      paymentStatus: 'awaiting_confirmation',
      paymentMethod: formData.get('payment') === 'Whish Money' ? 'whish_money' : 'cash_on_delivery',
      source: 'web',
      total
    };
    const submitButton = e.currentTarget.querySelector('[type="submit"]');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.classList.add('is-loading');
      submitButton.dataset.originalText = submitButton.textContent.trim();
      submitButton.textContent = 'Placing order...';
    }
    try {
      if (submitButton) submitButton.textContent = 'Placing order...';
      if (BACKEND) {
        const createdOrder = await BACKEND.orders.create(order);
        if (createdOrder?.orderNumber) order.orderNumber = createdOrder.orderNumber;
      } else {
        const orders = readJSON(STORE_KEYS.orders, []);
        orders.push(order);
        writeJSON(STORE_KEYS.orders, orders);
      }
    } catch (error) {
      console.warn('Order creation is unavailable.', error);
      toast('We could not place your order right now. Your bag is the same, so please try again.', 'error');
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.classList.remove('is-loading');
        submitButton.textContent = submitButton.dataset.originalText || 'Place order';
      }
      return;
    }
    void BACKEND?.analytics.recordEvent('order_created');

    // Order landed — retire the pending identity so the next order gets fresh ids.
    writeJSON(STORE_KEYS.pendingOrder, null);

    // Order is saved. Show a clean confirmation — no automatic WhatsApp redirect.
    const customerName = String(formData.get('name') || '').trim().split(/\s+/)[0] || '';
    showOrderConfirmation(order.orderNumber || orderNumber, customerName);
    toast(`Order ${order.orderNumber || orderNumber} sent.`);

    // Clear the bag now that the order is recorded.
    cart = [];
    writeJSON(STORE_KEYS.cart, cart);
    renderCart();
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.classList.remove('is-loading');
      submitButton.textContent = submitButton.dataset.originalText || 'Review and place order';
    }
  }

  // Animated "Order sent — we'll contact you" confirmation with the order
  // reference and an optional (non-forced) WhatsApp link.
  function showOrderConfirmation(orderNumber, customerName) {
    if (!n.checkoutSuccess) return;
    const waHref = `https://wa.me/${String(WHATSAPP_NUMBER).replace(/\D/g, '')}`;
    const greeting = customerName ? `Thank you, ${customerName}!` : 'Thank you!';
    setHtml(n.checkoutSuccess, html`
      <div class="order-confirm">
        <span class="order-confirm-check" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5L20 7"/></svg>
        </span>
        <h3>Order sent</h3>
        <p class="order-confirm-ref">Reference <strong>${orderNumber}</strong></p>
        <p class="order-confirm-text">${greeting} We'll message you on WhatsApp or call you to confirm your order and set up delivery.</p>
        <a class="order-confirm-wa" href="${safeUrl(waHref, 'https://wa.me/')}" target="_blank" rel="noreferrer">Questions? Message us on WhatsApp</a>
        <button type="button" class="btn btn-primary full" data-confirm-done>Continue shopping</button>
      </div>
    `);
    n.checkoutSuccess.classList.remove('is-hidden');
    // Collapse the form/summary/submit/copy so only the confirmation remains.
    n.checkoutForm?.classList.add('is-confirmed');
    requestAnimationFrame(() => n.checkoutSuccess.classList.add('is-visible'));
    $('[data-confirm-done]', n.checkoutSuccess)?.addEventListener('click', () => {
      n.checkoutSuccess.classList.add('is-hidden');
      n.checkoutSuccess.classList.remove('is-visible');
      n.checkoutForm?.classList.remove('is-confirmed');
      closeCheckout();
    });
    $('[data-confirm-done]', n.checkoutSuccess)?.focus();
  }

  // ---------- Counter bump animation ----------
  function bumpCounter(selector) {
    $$(selector).forEach(el => {
      el.classList.remove('is-bumping');
      void el.offsetWidth;
      el.classList.add('is-bumping');
    });
  }

  // A quick press-pop on an add-to-bag button for tactile success feedback.
  function popButton(btn) {
    if (!btn) return;
    btn.classList.remove('is-added');
    void btn.offsetWidth; // force reflow so the animation replays on rapid re-adds
    btn.classList.add('is-added');
    setTimeout(() => btn.classList.remove('is-added'), 500);
  }

  // ---------- Toast ----------
  // tone: 'success' (default) | 'error' | 'info' — drives the leading badge glyph/color.
  function toast(msg, tone = 'success') {
    const el = document.createElement('div');
    el.className = 'toast ' + (tone === 'error' ? 'is-error' : tone === 'info' ? 'is-info' : 'is-success');
    el.textContent = msg;
    n.toastRegion.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 320);
    }, 2800);
  }

  // ---------- Service worker ----------
  // Surface a non-intrusive "update available -> reload" prompt so app-code
  // updates apply without a manual hard refresh. A new SW installs but waits;
  // accepting the prompt tells it to activate, then controllerchange reloads.
  function showUpdateReady(worker) {
    const banner = $('[data-update-banner]');
    if (!banner || !worker) return;
    banner.hidden = false;
    requestAnimationFrame(() => banner.classList.add('is-visible'));
    const reloadBtn = $('[data-update-reload]', banner);
    if (reloadBtn && !reloadBtn.dataset.bound) {
      reloadBtn.dataset.bound = '1';
      reloadBtn.addEventListener('click', () => {
        reloadBtn.disabled = true;
        worker.postMessage('SKIP_WAITING');
      });
    }
    $('[data-update-dismiss]', banner)?.addEventListener('click', () => {
      banner.hidden = true;
      banner.classList.remove('is-visible');
    }, { once: true });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

    const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    if (isLocal) {
      navigator.serviceWorker.getRegistrations()
        .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
        .catch(() => null);
      if ('caches' in window) {
        caches.keys()
          .then(keys => Promise.all(keys.filter(key => key.startsWith('pavia-')).map(key => caches.delete(key))))
          .catch(() => null);
      }
      return;
    }

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    // updateViaCache: 'none' stops the browser from serving service-worker.js
    // itself from the HTTP cache, so a new SW (and its fresh caches) is detected
    // promptly instead of lingering for up to 24h. update() forces an immediate
    // check on every load.
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then((registration) => {
      registration.update().catch(() => null);
      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdateReady(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          // "installed" with an existing controller == a pending update.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateReady(registration.waiting || installing);
          }
        });
      });
    }).catch(() => null);
  }

  init().catch((error) => {
    console.error('Storefront initialization failed.', error);
    products = (window.PAVIA_DEFAULT_PRODUCTS || []).map(normalizeProduct).filter(product => product.active);
    indexProducts();
    renderCategories();
    renderProducts();
    renderCart();
    renderWishlist();
    bindEvents();
    signalReady(); // even on failure, reveal the (fallback) site
  });
})();
