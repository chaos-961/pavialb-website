window.PAVIA_BACKEND_CONFIG = Object.freeze({
  provider: 'local',
  schemaVersion: 1,
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
