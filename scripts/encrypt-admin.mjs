import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const username = String(process.env.PAVIA_ADMIN_USERNAME || 'admin').trim().toLowerCase();
const password = process.env.PAVIA_ADMIN_PASSWORD || '';
const iterations = Number(process.env.PAVIA_ADMIN_PBKDF2_ITERATIONS || 600000);
const minimumPasswordLength = Number(process.env.PAVIA_ADMIN_MIN_PASSWORD_LENGTH || 8);

if (!password) {
  throw new Error('PAVIA_ADMIN_PASSWORD is required to generate the encrypted admin payload.');
}
if (password.length < minimumPasswordLength) {
  throw new Error(`PAVIA_ADMIN_PASSWORD must be at least ${minimumPasswordLength} characters for payload generation.`);
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

const htmlPath = path.join(projectRoot, 'admin/dashboard.html');
const codePath = path.join(projectRoot, 'admin/dashboard.js');
const outputPath = path.join(projectRoot, 'admin/payload.js');
const html = (await fs.readFile(htmlPath, 'utf8')).replace(/`n/g, '\n');
const code = await fs.readFile(codePath, 'utf8');
const plaintext = Buffer.from(JSON.stringify({
  generatedAt: new Date().toISOString(),
  html,
  code,
}), 'utf8');

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(`${username}\u0000${password}`, salt, iterations, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
cipher.setAAD(Buffer.from(`pavia-admin:${username}:v1`, 'utf8'));
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();
const payload = {
  version: 1,
  kdf: 'PBKDF2-SHA-256',
  cipher: 'AES-256-GCM',
  iterations,
  salt: b64(salt),
  iv: b64(iv),
  ciphertext: b64(Buffer.concat([ciphertext, tag])),
  lockAfterMinutes: Number(process.env.PAVIA_ADMIN_LOCK_MINUTES || 15),
};

await fs.writeFile(
  outputPath,
  `window.PAVIA_ADMIN_PAYLOAD = Object.freeze(${JSON.stringify(payload, null, 2)});\n`,
  'utf8',
);

console.log('Encrypted Pavia admin payload generated.');
