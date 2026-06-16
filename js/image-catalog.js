// Local product image presets.
// Firebase should store imageId and/or a future external image URL, not binary files.
window.PAVIA_IMAGE_CATALOG = Object.freeze({
  'pavia-look-01': 'assets/placeholders/pavia-look-01.svg',
  'pavia-look-02': 'assets/placeholders/pavia-look-02.svg',
  'pavia-look-03': 'assets/placeholders/pavia-look-03.svg',
  'pavia-look-04': 'assets/placeholders/pavia-look-04.svg',
  'pavia-look-05': 'assets/placeholders/pavia-look-05.svg',
  'pavia-look-06': 'assets/placeholders/pavia-look-06.svg',
  'pavia-look-07': 'assets/placeholders/pavia-look-07.svg',
  'pavia-look-08': 'assets/placeholders/pavia-look-08.svg',
  'pavia-look-09': 'assets/placeholders/pavia-look-09.svg',
  'pavia-look-10': 'assets/placeholders/pavia-look-10.svg',
});

window.PAVIA_IMAGE_PLACEHOLDER = 'pavia-look-01';

window.PaviaImages = Object.freeze({
  resolve(value) {
    const key = String(value || '').trim();
    const catalog = window.PAVIA_IMAGE_CATALOG || {};
    const fallback = catalog[window.PAVIA_IMAGE_PLACEHOLDER] || 'assets/logo.svg';

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
