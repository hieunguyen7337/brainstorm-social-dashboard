import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'renderer', 'index.html'))) {
  console.error('renderer/index.html is missing: run "npm run renderer" in apps/desktop first (needs npm install in apps/mobile).');
  process.exit(1);
}
