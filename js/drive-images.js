/* Google Drive product-image pipeline for Pavia.
 * The admin connects Google Drive with an in-browser Google Identity Services
 * token (drive.file scope), the optimized image is uploaded to the configured
 * Drive folder, made public-readable, and its HTTPS URL + Drive file ID are
 * stored in Realtime Database. No service-account JSON, OAuth client secret,
 * refresh token, or long-lived token is used or stored; the access token lives
 * in memory only and is forgotten on lock/disconnect.
 */
((root, factory) => {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.PaviaDriveImages = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, (root) => {
  'use strict';

  const DEFAULT_TARGET_BYTES = 300 * 1024;
  const MAX_DETAIL_BYTES = 500 * 1024;
  const DEFAULT_LONG_EDGE = 1600;
  const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size';

  let tokenClient = null;
  let pendingTokenCallback = null;
  let pendingTokenError = null;
  let pendingConnect = null;
  let accessTokenValue = '';
  let tokenExpiry = 0;
  let gisLoading = null;

  function config() {
    return root.PAVIA_BACKEND_CONFIG?.driveImages || {};
  }

  function configured() {
    const cfg = config();
    return Boolean(cfg.clientId && cfg.folderId);
  }

  function accessToken() {
    return accessTokenValue && Date.now() < tokenExpiry ? accessTokenValue : '';
  }

  function disconnect() {
    if (accessTokenValue && root.google?.accounts?.oauth2?.revoke) {
      try {
        root.google.accounts.oauth2.revoke(accessTokenValue, () => {});
      } catch (error) {
        /* best effort */
      }
    }
    accessTokenValue = '';
    tokenExpiry = 0;
  }

  function driveImageUrl(fileId, size = 1600) {
    const id = String(fileId || '').trim();
    if (!id) return '';
    const width = Number(size) || 1600;
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${width}`;
  }

  function sanitizeFilename(name) {
    return String(name || 'pavia-product-image')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'pavia-product-image';
  }

  function extensionForMime(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/png') return 'png';
    return 'webp';
  }

  function imageVersion() {
    return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Image compression failed.'))),
        type,
        quality,
      );
    });
  }

  function loadImageSource(file) {
    if (root.createImageBitmap) return root.createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const image = new root.Image();
      const url = root.URL.createObjectURL(file);
      image.onload = () => {
        root.URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        root.URL.revokeObjectURL(url);
        reject(new Error('The selected image could not be opened.'));
      };
      image.src = url;
    });
  }

  async function digestHex(blob) {
    if (!root.crypto?.subtle) return '';
    const digest = await root.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  async function encodeCanvas(canvas, preferredType, targetBytes, initialQuality) {
    const types = preferredType === 'image/jpeg' ? ['image/jpeg'] : ['image/webp', 'image/jpeg'];
    let best = null;
    for (const type of types) {
      for (let quality = initialQuality; quality >= 0.48; quality -= 0.06) {
        const blob = await canvasToBlob(canvas, type, Number(quality.toFixed(2)));
        if (!best || blob.size < best.size) best = blob;
        if (blob.type === type && blob.size <= targetBytes) return blob;
      }
    }
    return best;
  }

  async function optimizeImage(file, overrides = {}) {
    if (!root.document?.createElement) {
      throw new Error('Image optimization requires a browser canvas.');
    }
    if (!(file instanceof root.Blob) || !String(file.type || '').startsWith('image/')) {
      throw new Error('Choose a JPEG, PNG, or WebP image.');
    }
    const cfg = { ...config(), ...overrides };
    const maxInputBytes = Number(cfg.maxInputBytes) || 20 * 1024 * 1024;
    if (file.size > maxInputBytes) throw new Error('Image is too large. Choose a file smaller than 20 MB.');
    const bitmap = await loadImageSource(file);
    const longEdge = Math.max(800, Number(cfg.longEdge) || DEFAULT_LONG_EDGE);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, longEdge / Math.max(1, longest));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = root.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const targetBytes = Math.min(
      Number(cfg.maxDetailBytes) || MAX_DETAIL_BYTES,
      Number(cfg.targetBytes) || DEFAULT_TARGET_BYTES,
    );
    const blob = await encodeCanvas(canvas, 'image/webp', targetBytes, Number(cfg.quality) || 0.82);
    const version = imageVersion();
    const hash = await digestHex(blob);
    const optimizedName = `${sanitizeFilename(file.name)}-${version}.${extensionForMime(blob.type || 'image/webp')}`;
    return {
      blob,
      metadata: {
        provider: 'google_drive',
        originalName: String(file.name || 'product-image').slice(0, 120),
        optimizedName,
        mimeType: blob.type || 'image/webp',
        width,
        height,
        byteSize: blob.size,
        bytes: blob.size,
        originalBytes: file.size,
        targetBytes,
        contentHash: hash,
        imageVersion: version,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  function loadGis() {
    if (root.google?.accounts?.oauth2) return Promise.resolve();
    if (gisLoading) return gisLoading;
    if (!root.document?.createElement) {
      return Promise.reject(new Error('Google Identity Services requires a browser.'));
    }
    gisLoading = new Promise((resolve, reject) => {
      const script = root.document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load Google Identity Services.'));
      root.document.head.appendChild(script);
    }).finally(() => { gisLoading = null; });
    return gisLoading;
  }

  // Turn an OAuth token-error response into an owner-friendly, actionable line.
  // `access_denied` is what Google returns when the chosen account isn't allowed
  // — almost always the wrong account was auto-picked, or the app is still in
  // "Testing" mode and that account isn't a registered test user.
  function describeOAuthError(response) {
    const code = response?.error || '';
    if (code === 'access_denied') {
      return 'Google denied access for that account. Pick the Google account that owns the Drive folder. If this app is still in Google "Testing" mode, that account must also be added as a test user in the Google Cloud console.';
    }
    if (code === 'admin_policy_enforced') {
      return 'A Google Workspace admin policy blocked Drive access for that account. Use an account that is allowed to grant Drive access.';
    }
    return response?.error_description || code || 'Google Drive authorization was cancelled.';
  }

  // GIS reports popup problems (user closed it, browser blocked it) through a
  // separate error_callback — the normal token callback never fires for these,
  // so without handling them the connect promise would hang and the UI would sit
  // stuck on "Connecting…".
  function describePopupError(error) {
    const type = error?.type || '';
    if (type === 'popup_closed') {
      return 'The Google sign-in window was closed before finishing. Click Connect Google Drive to try again.';
    }
    if (type === 'popup_failed_to_open') {
      return 'The browser blocked the Google sign-in window. Allow pop-ups for this site, then click Connect Google Drive again.';
    }
    return error?.message || 'Google sign-in did not complete. Please try again.';
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    const cfg = config();
    tokenClient = root.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: cfg.scope || DEFAULT_SCOPE,
      callback: (response) => {
        const handler = pendingTokenCallback;
        pendingTokenCallback = null;
        pendingTokenError = null;
        handler?.(response);
      },
      error_callback: (error) => {
        const handler = pendingTokenError;
        pendingTokenCallback = null;
        pendingTokenError = null;
        handler?.(error);
      },
    });
    return tokenClient;
  }

  async function connect() {
    // Already hold a live token — nothing to do, and never pop a window needlessly.
    if (accessToken()) return { connected: true };
    // Collapse concurrent connect attempts (e.g. button + an upload firing at
    // once) onto a single popup and a single shared promise.
    if (pendingConnect) return pendingConnect;
    if (!configured()) {
      throw new Error('Google Drive is not configured. Add the OAuth client ID and Drive folder ID.');
    }
    // A leftover (expired) token means this account already granted access, so we
    // can refresh it silently. A genuine first-time connect forces BOTH the
    // account chooser and the consent screen: `select_account` stops Google from
    // silently reusing the first signed-in account (the cause of the wrong-account
    // "access denied"), so the owner can pick the account that owns the folder.
    const silentRefresh = Boolean(accessTokenValue);
    pendingConnect = (async () => {
      await loadGis();
      const client = ensureTokenClient();
      return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (message) => {
          if (settled) return;
          settled = true;
          pendingTokenCallback = null;
          pendingTokenError = null;
          // Drop any stale token so the next attempt is a clean, interactive one
          // (a failed silent refresh must not loop forever).
          accessTokenValue = '';
          tokenExpiry = 0;
          reject(new Error(message));
        };
        const succeed = (response) => {
          if (settled) return;
          settled = true;
          pendingTokenCallback = null;
          pendingTokenError = null;
          accessTokenValue = response.access_token;
          tokenExpiry = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 60000;
          resolve({ connected: true });
        };
        pendingTokenCallback = (response) => {
          if (!response || response.error) { fail(describeOAuthError(response)); return; }
          if (!response.access_token) { fail('Google Drive did not return an access token. Please try again.'); return; }
          succeed(response);
        };
        pendingTokenError = (error) => fail(describePopupError(error));
        try {
          client.requestAccessToken({ prompt: silentRefresh ? '' : 'consent select_account' });
        } catch (error) {
          fail(error?.message || 'Could not start Google authorization.');
        }
      });
    })().finally(() => { pendingConnect = null; });
    return pendingConnect;
  }

  function verifyImageUrl(url) {
    if (!root.Image) return Promise.resolve(true);
    return new Promise((resolve) => {
      const image = new root.Image();
      const timer = root.setTimeout(() => {
        image.src = '';
        resolve(false);
      }, 12000);
      image.onload = () => {
        root.clearTimeout(timer);
        resolve(true);
      };
      image.onerror = () => {
        root.clearTimeout(timer);
        resolve(false);
      };
      image.referrerPolicy = 'no-referrer';
      image.src = url;
    });
  }

  async function uploadOptimizedImage(optimized) {
    if (!accessToken()) await connect();
    if (!accessToken()) throw new Error('Connect Google Drive before uploading.');
    const cfg = config();
    const metadata = {
      name: optimized.metadata.optimizedName,
      parents: [cfg.folderId],
      appProperties: {
        paviaImageVersion: String(optimized.metadata.imageVersion || '').slice(0, 40),
        paviaContentHash: String(optimized.metadata.contentHash || '').slice(0, 80),
      },
    };
    const form = new root.FormData();
    form.append('metadata', new root.Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', optimized.blob);

    const uploadResponse = await root.fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessTokenValue}` },
      body: form,
    });
    if (!uploadResponse.ok) {
      if (uploadResponse.status === 401) disconnect();
      throw new Error(`Google Drive upload failed (HTTP ${uploadResponse.status}).`);
    }
    const file = await uploadResponse.json();
    if (!file?.id) throw new Error('Google Drive did not return a file ID.');

    const permissionResponse = await root.fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/permissions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessTokenValue}`, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      },
    );
    if (!permissionResponse.ok) {
      throw new Error(`Uploaded to Drive but could not make it public (HTTP ${permissionResponse.status}).`);
    }

    const imageUrl = driveImageUrl(file.id);
    const reachable = await verifyImageUrl(imageUrl);
    if (!reachable) {
      throw new Error('Uploaded to Drive, but the public image URL did not load. Check folder sharing and try again.');
    }
    return {
      imageUrl,
      imageProvider: 'google_drive',
      imageVersion: optimized.metadata.imageVersion,
      driveFileId: file.id,
      imageMeta: {
        ...optimized.metadata,
        provider: 'google_drive',
        driveFileId: file.id,
        publicUrl: imageUrl,
      },
    };
  }

  // List the images this app created in the configured Drive folder. The
  // drive.file scope only ever returns files the app itself uploaded, so this is
  // exactly the Pavia image library (never the owner's whole Drive).
  async function listFiles({ pageSize = 100 } = {}) {
    if (!configured()) throw new Error('Google Drive is not configured.');
    if (!accessToken()) await connect();
    if (!accessToken()) throw new Error('Connect Google Drive before browsing the library.');
    const cfg = config();
    const query = `'${cfg.folderId}' in parents and trashed = false and mimeType contains 'image/'`;
    const params = new root.URLSearchParams({
      q: query,
      pageSize: String(Math.min(1000, Math.max(1, pageSize))),
      orderBy: 'createdTime desc',
      fields: 'files(id,name,mimeType,size,createdTime,appProperties,imageMediaMetadata(width,height))',
      spaces: 'drive',
    });
    const files = [];
    let pageToken = '';
    do {
      if (pageToken) params.set('pageToken', pageToken);
      const response = await root.fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessTokenValue}` },
      });
      if (!response.ok) {
        if (response.status === 401) disconnect();
        throw new Error(`Could not list Drive images (HTTP ${response.status}).`);
      }
      const data = await response.json();
      (data.files || []).forEach((file) => {
        const fallbackVersion = String(file.createdTime || '').replace(/[-:.TZ]/g, '').slice(0, 14);
        files.push({
          id: file.id,
          name: file.name || '',
          mimeType: file.mimeType || '',
          size: Number(file.size) || 0,
          createdTime: file.createdTime || '',
          width: Number(file.imageMediaMetadata?.width) || 0,
          height: Number(file.imageMediaMetadata?.height) || 0,
          imageUrl: driveImageUrl(file.id),
          imageVersion: String(file.appProperties?.paviaImageVersion || fallbackVersion).slice(0, 40),
          contentHash: String(file.appProperties?.paviaContentHash || '').replace(/[^a-f0-9]/gi, '').slice(0, 80),
        });
      });
      pageToken = data.nextPageToken || '';
    } while (pageToken && files.length < 1000);
    return files;
  }

  async function deleteFile(fileId) {
    const id = String(fileId || '').trim();
    if (!id) throw new Error('No Drive file specified.');
    if (!accessToken()) await connect();
    if (!accessToken()) throw new Error('Connect Google Drive before deleting images.');
    const response = await root.fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessTokenValue}` },
    });
    if (!response.ok && response.status !== 404) {
      if (response.status === 401) disconnect();
      throw new Error(`Could not delete the Drive image (HTTP ${response.status}).`);
    }
    return true;
  }

  return Object.freeze({
    configured,
    config,
    connect,
    disconnect,
    accessToken,
    optimizeImage,
    uploadOptimizedImage,
    driveImageUrl,
    verifyImageUrl,
    sanitizeFilename,
    listFiles,
    deleteFile,
  });
});
