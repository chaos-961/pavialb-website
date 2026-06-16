import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith('--port='))?.split('=')[1] || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://${host}:${port}`).pathname);
  const relative = normalize(pathname.replace(/^\/+/, ''));
  const target = resolve(root, relative || 'index.html');
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, 'index.html');
  return target;
}

const server = createServer((request, response) => {
  const target = resolveRequestPath(request.url || '/');
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': types[extname(target)] || 'application/octet-stream',
  });
  createReadStream(target).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Pavia static test server listening at http://${host}:${port}/`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
