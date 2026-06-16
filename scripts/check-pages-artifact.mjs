import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '_site');

const required = [
  'index.html',
  'robots.txt',
  'sitemap.xml',
  'admin/index.html',
  'admin/payload.js',
  'service-worker.js',
  'manifest.webmanifest',
  '.nojekyll',
  'css/styles.css',
  'css/admin.css',
  'js/app.js',
  'js/backend.js',
  'js/backend-config.js',
  'js/backend-firebase.js',
  'js/firebase-config.js',
  'js/image-catalog.js',
  'js/store-core.js',
  'js/products.js',
  'assets/logo.svg',
  'assets/products/blue-pearl-blouse.svg',
  'assets/placeholders/pavia-look-01.svg',
];

const forbidden = [
  'admin/dashboard.html',
  'admin/dashboard.js',
  'masterprompt.txt',
  'progress.txt',
  'database.rules.json',
  'firebase.json',
  'package.json',
  'package-lock.json',
  '.github',
  'docs',
  'scripts',
];

async function exists(relativePath) {
  try {
    await access(path.join(outDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

const missing = [];
for (const file of required) {
  if (!(await exists(file))) {
    missing.push(file);
  }
}

const leaked = [];
for (const file of forbidden) {
  if (await exists(file)) {
    leaked.push(file);
  }
}

if (missing.length || leaked.length) {
  if (missing.length) {
    console.error(`Missing from Pages artifact: ${missing.join(', ')}`);
  }
  if (leaked.length) {
    console.error(`Unexpected files in Pages artifact: ${leaked.join(', ')}`);
  }
  process.exit(1);
}

const topLevel = await readdir(outDir);
console.log(`Pages artifact check passed (${topLevel.length} top-level entries).`);
