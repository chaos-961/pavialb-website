import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '_site');

const files = [
  ['index.html', 'index.html'],
  ['manifest.webmanifest', 'manifest.webmanifest'],
  ['service-worker.js', 'service-worker.js'],
  ['.nojekyll', '.nojekyll'],
  ['admin/index.html', 'admin/index.html'],
  ['admin/payload.js', 'admin/payload.js'],
  ['css/styles.css', 'css/styles.css'],
  ['css/admin.css', 'css/admin.css'],
  ['js/app.js', 'js/app.js'],
  ['js/admin.js', 'js/admin.js'],
  ['js/backend.js', 'js/backend.js'],
  ['js/backend-config.js', 'js/backend-config.js'],
  ['js/backend-firebase.js', 'js/backend-firebase.js'],
  ['js/firebase-config.js', 'js/firebase-config.js'],
  ['js/config.js', 'js/config.js'],
  ['js/image-catalog.js', 'js/image-catalog.js'],
  ['js/products.js', 'js/products.js'],
];

if (!outDir.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Refusing to write outside the project root: ${outDir}`);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await cp(path.join(root, 'assets'), path.join(outDir, 'assets'), { recursive: true });

for (const [source, destination] of files) {
  const target = path.join(outDir, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, source), target);
}

console.log(`Built GitHub Pages artifact at ${path.relative(root, outDir)}`);
