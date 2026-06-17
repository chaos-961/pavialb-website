// Legacy preset assets no longer ship with the storefront. Existing old records
// that still contain preset IDs resolve to the neutral logo until they are
// replaced with Google Drive HTTPS image URLs.
window.PAVIA_IMAGE_CATALOG = Object.freeze({});
window.PAVIA_IMAGE_PLACEHOLDER = 'assets/logo.svg';

window.PaviaImages = Object.freeze({
  resolve(value) {
    const key = String(value || '').trim();
    const catalog = window.PAVIA_IMAGE_CATALOG || {};
    const fallback = window.PAVIA_IMAGE_PLACEHOLDER || 'assets/logo.svg';

    if (!key) return fallback;
    if (catalog[key]) return catalog[key];
    if (/^(https?:|data:|blob:|\/|\.\/|\.\.\/|assets\/)/i.test(key)) return key;

    return fallback;
  },

  idFor(value) {
    const key = String(value || '').trim();
    const catalog = window.PAVIA_IMAGE_CATALOG || {};
    if (catalog[key]) return key;
    return Object.entries(catalog).find(([, path]) => path === key)?.[0] || '';
  },
});
