// Cross-platform version of the Expo web export into apps/desktop/renderer (works in cmd.exe too).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', path.join(root, 'renderer')], {
  cwd: path.resolve(root, '../mobile'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
