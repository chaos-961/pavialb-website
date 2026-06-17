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
  'js/drive-images.js',
  'js/store-core.js',
  'js/products.js',
  'assets/logo.svg',
  'assets/products/blue-pearl-blouse.svg',
  'assets/placeholders/pavia-look-01.svg',
];

const forbidden = [
  'admin/dashboard.html',
  'admin/dashboard.js',
  'AGENT.md',
  'LAUNCH-STATUS.md',
  'PHASE-01-BASELINE.md',
  'README.md',
  'masterprompt.txt',
  'progress.txt',
  'database.rules.json',
  'firebase.json',
  'playwright.config.mjs',
  'package.json',
  'package-lock.json',
  '.env',
  '.firebaserc',
  '.gitignore',
  '.github',
  'docs',
  'scripts',
  'tests',
];

const forbiddenSuffixes = [
  '.log',
  '.map',
  '.md',
  '.ps1',
];

async function walk(relativeDir = '') {
  const absoluteDir = path.join(outDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name).replaceAll(path.sep, '/');
    if (entry.isDirectory()) {
      files.push(relativePath);
      files.push(...await walk(relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

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

for (const file of await walk()) {
  if (forbiddenSuffixes.some((suffix) => file.endsWith(suffix))) {
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
