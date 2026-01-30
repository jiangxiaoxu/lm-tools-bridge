import { build } from 'esbuild';
import fs from 'node:fs';
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
        manager: path.join(rootDir, 'src', 'manager.ts'),
    },
    outdir: outDir,
    tsconfig: path.join(rootDir, 'tsconfig.json'),
});

const ripgrepBinDir = path.join(rootDir, 'node_modules', '@vscode', 'ripgrep', 'bin');
const targetBinDir = path.join(rootDir, 'bin');
try {
    await fs.promises.mkdir(targetBinDir, { recursive: true });
    const entries = await fs.promises.readdir(ripgrepBinDir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile()) {
            return;
        }
        const sourcePath = path.join(ripgrepBinDir, entry.name);
        const targetPath = path.join(targetBinDir, entry.name);
        await fs.promises.copyFile(sourcePath, targetPath);
    }));
} catch (error) {
    console.warn('Failed to copy ripgrep binaries:', error);
}
