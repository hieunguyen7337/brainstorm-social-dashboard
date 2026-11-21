import path from 'node:path';

/** Content types for the files an Expo web export contains. */
export const CONTENT_TYPES: Record<string, string> = {
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Extension-less paths are client routes (expo-router): serve index.html. */
export function needsSpaFallback(urlPath: string): boolean {
  const last = urlPath.split('/').pop() ?? '';
  return path.extname(last) === '';
}

/**
 * Map a request path to a file under `root`, or null when it would escape the root.
 * Extension-less paths resolve to `<root>/index.html` (SPA fallback).
 */
export function resolveRendererPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rootAbs = path.resolve(root);
  const rel = needsSpaFallback(decoded) ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(rootAbs, rel);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
  return full;
}
