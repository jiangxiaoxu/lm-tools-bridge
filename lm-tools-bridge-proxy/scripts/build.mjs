import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(rootDir, 'dist');

await build({
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  entryPoints: [path.join(rootDir, 'src', 'index.ts')],
  outfile: path.join(outDir, 'index.js'),
  sourcemap: false,
});
