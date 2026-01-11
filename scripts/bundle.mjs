import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(rootDir, 'out');

const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    external: ['vscode'],
};

await build({
    ...shared,
    entryPoints: {
        extension: path.join(rootDir, 'src', 'extension.ts'),
    },
    outdir: outDir,
    tsconfig: path.join(rootDir, 'tsconfig.json'),
});