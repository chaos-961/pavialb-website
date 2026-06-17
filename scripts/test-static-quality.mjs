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
