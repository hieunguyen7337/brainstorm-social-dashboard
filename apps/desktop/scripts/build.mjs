import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  // react-native: reached only through autoRead/runner.ts's lazy require('./trace'), which falls back without it.
  external: ['electron', 'react-native'],
  alias: { '@': path.resolve(root, '../mobile') },
  sourcemap: true,
  logLevel: 'info',
};

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(root, 'dist/main.js') }),
  build({ ...common, entryPoints: [path.join(root, 'src/preload/app.ts')], outfile: path.join(root, 'dist/preload-app.js') }),
  build({ ...common, entryPoints: [path.join(root, 'src/preload/social.ts')], outfile: path.join(root, 'dist/preload-social.js') }),
]);
