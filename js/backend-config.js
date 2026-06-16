(() => {
  const localhostNames = new Set(['localhost', '127.0.0.1', '::1', '']);
  const localHost = localhostNames.has(window.location.hostname);

  window.PAVIA_BACKEND_CONFIG = Object.freeze({
    provider: localHost ? 'local' : 'firebase',
    fallbackToLocal: localHost,
    schemaVersion: 2,
    namespace: 'pavia',
    analytics: Object.freeze({
      enabled: true,
      sessionKey: 'PAVIA_VISIT_RECORDED',
    }),
    images: Object.freeze({
      format: 'image/webp',
      quality: 0.82,
      maxWidth: 1600,
      maxHeight: 2000,
      maxInputBytes: 15 * 1024 * 1024,
    }),
  });
})();
