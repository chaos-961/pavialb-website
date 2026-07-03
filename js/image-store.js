/* imgbb product-image pipeline for Pavia.
 *
 * The Studio optimizes each image in the browser and uploads it to imgbb with a
 * public API key (imgbb keys are not account credentials — worst case someone
 * uploads to your imgbb library). Shoppers load images from imgbb's CDN
 * (i.ibb.co). Chosen because it is free, needs no card, and is reachable from
 * Lebanon (Cloudinary and similar enterprise hosts geo-block it).
 *
 * A static site has no server to hold a secret, so listing and hard-deleting via
 * imgbb are not done here: the Studio's saved library index (Firebase RTDB) is
 * the source of truth for browsing, and "delete" removes an image from that index
 * (the file stays on imgbb; each upload also returns a delete_url for manual use).
 *
 * Exposes the shared provider interface via window.PaviaImageStore. Product
 * records store a vendor-neutral imageProvider:'external' + the imgbb id as
 * storageKey, so switching image hosts later never touches the database rules.
 */
((root, factory) => {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.PaviaImageStore = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, (root) => {
  'use strict';

  const DEFAULT_TARGET_BYTES = 300 * 1024;
  const MAX_DETAIL_BYTES = 500 * 1024;
  const DEFAULT_LONG_EDGE = 1600;
  const UPLOAD_ENDPOINT = 'https://api.imgbb.com/1/upload';

  function config() {
    return root.PAVIA_BACKEND_CONFIG?.imgbb || {};
  }

  function configured() {
    return Boolean(config().apiKey);
  }

  // imgbb uploads need no auth handshake, so the Studio is always "connected"
  // once configured. These no-op token helpers keep the shared provider interface
  // (and js/admin.js) working without special-casing.
  function needsConnect() { return false; }
  function connected() { return configured(); }
  function connect() {
    if (!configured()) {
      return Promise.reject(new Error('Image storage is not configured. Add your imgbb API key in js/backend-config.js.'));
    }
    return Promise.resolve({ connected: true });
  }
  function disconnect() { /* nothing to forget — the key lives in config, not memory */ }
  function setToken() { /* imgbb uses a config API key; no in-memory token */ }
  function token() { return ''; }
  function canList() { return false; }
  function canDelete() { return false; }

  function publicUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? url : '';
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
      image.onload = () => { root.URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { root.URL.revokeObjectURL(url); reject(new Error('The selected image could not be opened.')); };
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

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read the image for upload.'));
      reader.readAsDataURL(blob);
    });
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
        provider: 'imgbb',
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

  function verifyImageUrl(url) {
    if (!root.Image) return Promise.resolve(true);
    return new Promise((resolve) => {
      const image = new root.Image();
      const timer = root.setTimeout(() => { image.src = ''; resolve(false); }, 12000);
      image.onload = () => { root.clearTimeout(timer); resolve(true); };
      image.onerror = () => { root.clearTimeout(timer); resolve(false); };
      image.referrerPolicy = 'no-referrer';
      image.src = url;
    });
  }

  async function uploadOptimizedImage(optimized) {
    if (!configured()) {
      throw new Error('Image storage is not configured. Add your imgbb API key in js/backend-config.js.');
    }
    const cfg = config();
    const base64 = await blobToBase64(optimized.blob);
    const form = new root.FormData();
    form.append('image', base64);
    form.append('name', String(optimized.metadata.optimizedName || 'pavia-image').replace(/\.[^.]+$/, ''));

    let response;
    try {
      response = await root.fetch(`${UPLOAD_ENDPOINT}?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST',
        body: form,
      });
    } catch {
      throw new Error('Could not reach imgbb. Check your connection and try again.');
    }
    let json = null;
    try { json = await response.json(); } catch { /* handled below */ }
    if (!response.ok || !json?.success || !json?.data) {
      const message = json?.error?.message || '';
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new Error(message || 'imgbb rejected the upload. Check that the API key is correct.');
      }
      throw new Error(message || `imgbb upload failed (HTTP ${response.status}).`);
    }
    const data = json.data;
    const imageUrl = String(data.url || data.display_url || data.image?.url || '');
    if (!imageUrl) throw new Error('imgbb did not return an image URL.');
    const reachable = await verifyImageUrl(imageUrl);
    if (!reachable) {
      throw new Error('Uploaded to imgbb, but the image URL did not load. Please try again.');
    }
    const storageKey = String(data.id || '');
    return {
      imageUrl,
      imageProvider: 'external',
      imageVersion: optimized.metadata.imageVersion,
      storageKey,
      imageMeta: {
        ...optimized.metadata,
        provider: 'imgbb',
        storageKey,
        publicUrl: imageUrl,
      },
    };
  }

  // No server = no way to hold the account session = no imgbb list/delete API
  // from the browser. The Studio browses from its RTDB library index instead,
  // and these reject/resolve clearly so the Library UI falls back to that index.
  function listFiles() {
    return Promise.reject(new Error('Listing is handled by the saved library index, not imgbb.'));
  }
  function deleteFile() {
    // Nothing to delete remotely; the caller removes the record from the RTDB
    // library index. Resolve so that flow completes.
    return Promise.resolve(true);
  }

  return Object.freeze({
    configured,
    config,
    needsConnect,
    connected,
    connect,
    disconnect,
    setToken,
    token,
    canList,
    canDelete,
    optimizeImage,
    uploadOptimizedImage,
    publicUrl,
    verifyImageUrl,
    sanitizeFilename,
    listFiles,
    deleteFile,
  });
});
