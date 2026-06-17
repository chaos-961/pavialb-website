import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('runtime files do not use excluded Firebase products or auth providers', async () => {
  const runtimeFiles = [
    'index.html',
    'admin/index.html',
    'js/backend-firebase.js',
    'js/firebase-config.js',
    'js/backend-config.js',
    'js/app.js',
    'js/admin.js',
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
  const rules = JSON.parse(await text('database.rules.json'));
  assert.equal(rules.rules['.read'], false);
  assert.equal(rules.rules['.write'], false);
  assert.equal(rules.rules.adminUids.$uid['.write'], false);
  assert.match(rules.rules.products['.read'], /adminUids/);
  assert.match(rules.rules.orders['.read'], /adminUids/);
  assert.match(rules.rules.publicProducts['.read'], /auth != null/);
  assert.match(rules.rules.subscribers.$subscriberId['.validate'], /consent/);
  assert.match(rules.rules.products.$productId['.validate'], /pavia-look-10/);
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
