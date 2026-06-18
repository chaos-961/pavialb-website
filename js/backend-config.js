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
    admin: Object.freeze({
      // Static admin identity. The browser signs in to Firebase Email/Password
      // with this address (using the unlock password) so the database rules can
      // trust that only this account writes products, settings, promos, and
      // orders. An email is public, not a secret. Must match the email of the
      // Firebase Auth user you create and the address in database.rules.json.
      email: 'paviadata@gmail.com',
    }),
    images: Object.freeze({
      format: 'image/webp',
      quality: 0.82,
      maxWidth: 1600,
      maxHeight: 2000,
      maxInputBytes: 15 * 1024 * 1024,
    }),
    driveImages: Object.freeze({
      // Public, non-secret values. A browser OAuth web client ID is not a secret;
      // never put the OAuth client secret, a service-account JSON, refresh token,
      // or any long-lived token here or anywhere in the frontend.
      clientId: '571393548009-s3b667tgr13pddo9lv7gee8gn34sppe0.apps.googleusercontent.com',
      folderId: '1PnoKTM312CxrOQooeB9sVLo5HLISEtQ3',
      scope: 'https://www.googleapis.com/auth/drive.file',
      longEdge: 1600,
      targetBytes: 300 * 1024,
      maxDetailBytes: 500 * 1024,
      maxInputBytes: 20 * 1024 * 1024,
      quality: 0.82,
    }),
  });
})();
