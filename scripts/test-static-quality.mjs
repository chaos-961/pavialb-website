import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const root = new URL('../', import.meta.url);

test('runtime files do not use excluded Firebase products or auth providers', async () => {
  const runtimeFiles = [
    'index.html',
    'admin/index.html',
    'js/backend-firebase.js',
    'js/firebase-config.js',
    'js/backend-config.js',
    'js/app.js',
    'js/admin.js',
    'js/drive-images.js',
    'admin/dashboard.js',
  ];
  const forbiddenPatterns = [
    /firestore/i,
    /firebase-storage/i,
    /getStorage|uploadBytes|ref\(.*storage/i,
    /signInWithEmailAndPassword|createUserWithEmailAndPassword|GoogleAuthProvider|PhoneAuthProvider/i,
    /customClaims|getIdTokenResult/i,
  ];

  for (const file of runtimeFiles) {
    const source = await text(file);
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${file} matched forbidden pattern ${pattern}`);
    }
  }
});

async function runtimeFiles(dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', '.git', '_site', 'coverage', 'test-results'].includes(entry.name)) continue;
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      files.push(...await runtimeFiles(full));
    } else if (/\.(?:js|json|html|css|md|txt|yml|yaml)$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test('repository does not contain Google credential-shaped secrets', async () => {
  const forbiddenSecretShapes = [
    /"type"\s*:\s*"service_account"/i,
    /-----BEGIN PRIVATE KEY-----/,
    /"private_key"\s*:\s*"[^"]{20,}"/i,
    /"client_secret"\s*:\s*"[^"]{12,}"/i,
    /"refresh_token"\s*:\s*"[^"]{20,}"/i,
    /\bya29\.[0-9A-Za-z_-]{20,}\b/,
  ];
  for (const fileUrl of await runtimeFiles()) {
    const source = await readFile(fileUrl, 'utf8');
    const relative = path.relative(new URL('../', import.meta.url).pathname, fileUrl.pathname);
    for (const pattern of forbiddenSecretShapes) {
      assert.equal(pattern.test(source), false, `${relative} matched credential-shaped secret pattern ${pattern}`);
    }
  }
});

test('Google Drive adapter uses the narrow drive.file scope and stores no secrets', async () => {
  const adapter = await text('js/drive-images.js');
  const config = await text('js/backend-config.js');
  // The adapter must request the least-broad Drive scope.
  assert.match(adapter, /www\.googleapis\.com\/auth\/drive\.file/);
  // No OAuth client secret, service account, refresh token, or long-lived token may appear.
  for (const source of [adapter, config]) {
    assert.equal(/client_secret|clientSecret/i.test(source), false, 'must not contain an OAuth client secret');
    assert.equal(/service_account|serviceAccount/i.test(source), false, 'must not contain a service account');
    assert.equal(/refresh_token|refreshToken/i.test(source), false, 'must not contain a refresh token');
    assert.equal(/\bya29\.[0-9A-Za-z_-]{10,}/.test(source), false, 'must not contain an access token literal');
  }
});

test('admin unlock cannot be bypassed with browser-stored verifier/session keys', async () => {
  const adminFiles = [
    'admin/index.html',
    'admin/payload.js',
    'js/admin.js',
    'admin/dashboard.js',
  ];
  const forbiddenPatterns = [
    /PAVIA_ADMIN_HASH/i,
    /PAVIA_ADMIN_SESSION/i,
    /DEFAULT_PASS_HASH/i,
    /localStorage\.(?:setItem|getItem)\([^)]*(?:ADMIN|PASSWORD|UNLOCK|SESSION|HASH)/i,
    /sessionStorage\.(?:setItem|getItem)\([^)]*(?:ADMIN|PASSWORD|UNLOCK|SESSION|HASH)/i,
  ];

  for (const file of adminFiles) {
    const source = await text(file);
    for (const pattern of forbiddenPatterns) {
      assert.equal(pattern.test(source), false, `${file} matched forbidden admin bypass pattern ${pattern}`);
    }
  }
});

test('admin public gate is password-only with fixed internal username', async () => {
  const adminHtml = await text('admin/index.html');
  const adminShell = await text('js/admin.js');
  const generator = await text('scripts/encrypt-admin.mjs');
  assert.equal(adminHtml.includes('id="loginUser"'), false, 'admin gate should not render a username input');
  assert.equal(adminHtml.includes('autocomplete="username"'), false, 'admin gate should not ask for username autocomplete');
  assert.match(adminShell, /ADMIN_USERNAME\s*=\s*'admin'/);
  assert.equal(generator.includes('PAVIA_ADMIN_USERNAME'), false, 'payload generator should not accept a runtime username override');
});

test('encrypted admin payload does not expose dashboard source in plaintext', async () => {
  const payload = await text('admin/payload.js');
  const plaintextMarkers = [
    '<section id="overview"',
    'function renderOverview',
    'Products',
    'Orders',
    'Settings',
    'Promos',
  ];

  for (const marker of plaintextMarkers) {
    assert.equal(payload.includes(marker), false, `admin/payload.js exposes plaintext marker ${marker}`);
  }
});

test('Realtime Database rules keep critical paths gated and parse as JSON', async () => {
  const rulesText = await text('database.rules.json');
  const rules = JSON.parse(rulesText);
  assert.equal(rules.rules['.read'], false);
  assert.equal(rules.rules['.write'], false);
  // P12 password-only model: writes require any signed-in user; the UID allowlist was removed.
  assert.equal(rulesText.includes('adminUids'), false, 'rules should no longer reference the removed adminUids allowlist');
  assert.match(rules.rules.products['.read'], /auth != null/);
  assert.match(rules.rules.publicProducts['.read'], /auth != null/);
  assert.match(rules.rules.orders['.read'], /auth != null/);
  assert.match(rules.rules.subscribers.$subscriberId['.validate'], /consent/);
  assert.match(rules.rules.products.$productId['.validate'], /google_drive/);
  assert.match(rules.rules.products.$productId['.validate'], /clientSecret/);
});

test('storefront-facing rules reject markup and bound the order discount (P13)', async () => {
  const rules = JSON.parse(await text('database.rules.json'));
  // Angle brackets are rejected in product name (private + public projection).
  assert.match(rules.rules.products.$productId['.validate'], /name'\)\.val\(\)\.matches\(\/\[<>\]\//);
  assert.match(rules.rules.publicProducts.$productId['.validate'], /name'\)\.val\(\)\.matches\(\/\[<>\]\//);
  // Previously-unvalidated storefront projections now have content validation.
  assert.ok(rules.rules.publicStoreSettings['.validate'], 'publicStoreSettings must have a .validate');
  assert.match(rules.rules.publicStoreSettings['.validate'], /matches\(\/\[<>\]\//);
  assert.match(rules.rules.publicStoreSettings['.validate'], /instagramUrl'\)\.val\(\)\.beginsWith\('https:\/\//);
  assert.ok(rules.rules.publicPromoCodes.$code['.validate'], 'publicPromoCodes/$code must have a .validate');
  assert.match(rules.rules.publicPromoCodes.$code['.validate'], /matches\(\/\[<>\]\//);
  // Order totals cannot be forged with a discount larger than the subtotal.
  assert.match(rules.rules.orders.$orderId['.validate'], /discount'\)\.val\(\) <= newData\.child\('subtotal'\)\.val\(\)/);
});

test('revision-aware cache is wired into rules and script order (P14)', async () => {
  const rules = JSON.parse(await text('database.rules.json'));
  assert.ok(rules.rules.publicCatalogManifest, 'rules must expose publicCatalogManifest');
  assert.match(rules.rules.publicCatalogManifest['.read'], /auth != null/);
  assert.match(rules.rules.publicCatalogManifest.catalogRev['.validate'], /isNumber/);
  assert.match(rules.rules.publicCatalogManifest.products.$productId['.validate'], /isNumber/);
  // rev is an allowed numeric field on products + the public projection.
  assert.match(rules.rules.products.$productId['.validate'], /rev'\)\.isNumber/);
  assert.match(rules.rules.publicProducts.$productId['.validate'], /rev'\)\.isNumber/);

  const html = await text('index.html');
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  const idx = (needle) => scripts.findIndex((script) => script.includes(needle));
  assert.ok(idx('js/catalog-cache.js') > -1, 'index.html loads catalog-cache.js');
  assert.ok(idx('js/store-core.js') < idx('js/catalog-cache.js'), 'store-core loads before catalog-cache');
  assert.ok(idx('js/catalog-cache.js') < idx('js/app.js'), 'catalog-cache loads before app.js');
});

test('storefront ships a strict Content-Security-Policy meta (P13)', async () => {
  const html = await text('index.html');
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(match, 'index.html must declare a CSP meta');
  const csp = match[1];
  // The storefront loads no inline/admin Google Identity scripts, so script-src stays strict.
  assert.match(csp, /script-src 'self' https:\/\/www\.gstatic\.com/);
  assert.equal(/script-src[^;]*'unsafe-eval'/.test(csp), false, 'script-src must not allow unsafe-eval');
  assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, 'script-src must stay free of unsafe-inline');
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /connect-src[^;]*firebasedatabase\.app/);
  assert.match(csp, /img-src[^;]*drive\.google\.com/);
  // The storefront must not pull Google Identity Services (admin-only).
  assert.equal(html.includes('accounts.google.com/gsi/client'), false, 'storefront must not load GIS');
});

test('HTML references existing script assets in execution order', async () => {
  const htmlFiles = ['index.html', 'admin/index.html'];
  for (const file of htmlFiles) {
    const html = await text(file);
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(scripts.some((script) => script.includes('js/store-core.js')), `${file} loads store-core.js`);
    assert.ok(
      scripts.findIndex((script) => script.includes('js/store-core.js')) < scripts.findIndex((script) => script.includes('js/backend-firebase.js')),
      `${file} loads store-core before backend-firebase`,
    );
    if (file === 'admin/index.html') {
      assert.ok(scripts.some((script) => script.includes('js/drive-images.js')), 'admin loads the Drive image adapter');
      assert.equal(scripts.some((script) => script.includes('accounts.google.com/gsi/client')), false, 'admin does not load GIS before Drive connect');
    }
    for (const script of scripts) {
      const normalized = script.replace(/^\.\.\//, '').replace(/\?.*$/, '');
      await text(normalized);
    }
  }
});

test('admin dashboard ships the P15 UX features', async () => {
  const dashboardHtml = await text('admin/dashboard.html');
  const dashboardJs = await text('admin/dashboard.js');

  // Markup: sort controls, bulk bar, inline status, draft banner, optimized preview.
  for (const marker of ['id="productSort"', 'id="orderSort"', 'id="bulkBar"', 'data-bulk="delete"',
    'id="productFormStatus"', 'id="draftBanner"', 'id="imageOptimizedPreview"']) {
    assert.ok(dashboardHtml.includes(marker), `dashboard.html should include ${marker}`);
  }

  // Behavior: dedup, bulk/inline/reorder, save feedback, unsaved-changes guard.
  for (const marker of ['shouldReuseImage', 'quickEditProduct', 'runBulkAction', 'reorderProducts',
    'setButtonLoading', 'compareProducts', 'beforeunload', 'DRAFT_KEY']) {
    assert.ok(dashboardJs.includes(marker), `dashboard.js should reference ${marker}`);
  }

  assert.doesNotMatch(dashboardJs, /Revenue est\.|Browser\/order snapshot estimate/,
    'admin overview should not show a revenue estimate');

  // The product draft must not be persisted under an admin-flagged storage key.
  assert.equal(/DRAFT_KEY\s*=\s*'[^']*(?:ADMIN|PASSWORD|UNLOCK|SESSION|HASH)/i.test(dashboardJs), false,
    'draft storage key must avoid admin/credential-flagged names');
});

test('storefront ships P16 perf / a11y / SEO / PWA improvements', async () => {
  const html = await text('index.html');
  const css = await text('css/styles.css');
  const appJs = await text('js/app.js');
  const manifest = JSON.parse(await text('manifest.webmanifest'));

  // CLS: product-card images carry loading + decoding + explicit dimensions.
  assert.match(appJs, /loading="lazy" decoding="async" width="640" height="800"/);
  // Reduced motion is suppressed beyond just .reveal.
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation-duration:\s*0\.001ms\s*!important/);
  // Resilient loading: offline banner + retry state + structured-data injection.
  assert.match(html, /data-offline-banner/);
  assert.match(html, /name="twitter:image"/);
  assert.match(appJs, /updateStructuredData/);
  assert.match(appJs, /data-retry-load/);
  // PWA installability: standalone display + at least one maskable icon.
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1, 'manifest must declare icons');
  assert.ok(manifest.icons.some((icon) => String(icon.purpose || '').includes('maskable')), 'manifest needs a maskable icon');
});

test('Pages hygiene keeps planning docs and legacy local product images out of the artifact (P17)', async () => {
  const buildScript = await text('scripts/build-pages-artifact.mjs');
  const checkScript = await text('scripts/check-pages-artifact.mjs');
  const imageCatalog = await text('js/image-catalog.js');
  const serviceWorker = await text('service-worker.js');

  assert.equal(buildScript.includes("cp(path.join(root, 'assets')"), false, 'Pages build must not copy all assets');
  assert.match(buildScript, /assets\/logo\.svg/);
  assert.match(checkScript, /'planning'/);
  assert.match(checkScript, /'docs'/);
  assert.match(checkScript, /'assets\/placeholders'/);
  assert.match(checkScript, /'assets\/products'/);
  assert.match(imageCatalog, /PAVIA_IMAGE_CATALOG = Object\.freeze\(\{\}\)/);
  assert.equal(serviceWorker.includes('assets/placeholders/'), false, 'service worker must not precache pruned placeholders');
});

test('storefront keeps launch-critical accessibility and SEO markers', async () => {
  const html = await text('index.html');
  assert.match(html, /<a class="skip-link"/);
  assert.match(html, /name="description"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /name="twitter:card"/);
  assert.match(html, /type="application\/ld\+json"/);
  assert.match(html, /data-product-grid/);
  assert.match(html, /data-checkout-form/);
  assert.match(html, /data-newsletter/);
});
