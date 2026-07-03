(() => {
  const localhostNames = new Set(['localhost', '127.0.0.1', '::1', '']);
  const localHost = localhostNames.has(window.location.hostname);

  window.PAVIA_BACKEND_CONFIG = Object.freeze({
    provider: localHost ? 'local' : 'firebase',
    // Always allow the local fallback: while the new Firebase project is being
    // provisioned (or if it is ever unreachable) the storefront must keep
    // serving from the cached/local catalog instead of failing to boot.
    fallbackToLocal: true,
    // Bump to invalidate the IndexedDB catalog/image caches when the stored data
    // shape changes. v0.4.1 renames driveFileId -> storageKey (image host id).
    schemaVersion: 5,
    namespace: 'pavia',
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
    imgbb: Object.freeze({
      // imgbb image hosting (see IMAGES.md). The API key is public-ish — it is not
      // an account login; the worst it allows is uploading images to your imgbb
      // library, so it is acceptable in a static frontend. Get it from
      // https://api.imgbb.com/ and paste it here.
      apiKey: 'REDACTED-IMGBB-KEY',
      longEdge: 1600,
      targetBytes: 300 * 1024,
      maxDetailBytes: 500 * 1024,
      maxInputBytes: 20 * 1024 * 1024,
      quality: 0.82,
    }),
  });
})();
