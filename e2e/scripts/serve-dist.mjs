// Tiny dependency-free static server with SPA fallback, used by playwright.layout.config.ts.
//   DIST_DIR  directory to serve (default apps/mobile/dist-mock, relative to the repo root or absolute)
//   PORT      listen port (default 4173)
// Unknown paths without a file extension (client-side routes such as /dashboard) fall back to index.html;
// a missing file with an extension (a stale asset) is a real 404.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = resolve(repoRoot, process.env.DIST_DIR || 'apps/mobile/dist-mock');
const port = Number(process.env.PORT || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function fileIn(p) {
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const abs = normalize(join(root, rel));
  if (abs !== root && !abs.startsWith(root + sep)) return null; // path traversal
  const direct = fileIn(abs) || fileIn(join(abs, 'index.html'));
  if (direct) return direct;
  if (extname(rel)) return null; // a missing asset is a real 404
  return fileIn(join(root, 'index.html')); // SPA fallback
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url || '/', 'http://localhost');
  const file = req.method === 'GET' || req.method === 'HEAD' ? resolveFile(pathname) : null;
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
});

server.listen(port, () => {
  console.log(`serve-dist: ${root} on http://localhost:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
