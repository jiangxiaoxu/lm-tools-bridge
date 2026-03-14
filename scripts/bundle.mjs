import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(rootDir, 'out');
const requestedTargets = new Set(process.argv.slice(2));

const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: false,
    external: ['vscode'],
};

if (shouldBuildTarget('extension')) {
    await build({
        ...shared,
        entryPoints: [path.join(rootDir, 'src', 'extension.ts')],
        outfile: path.join(outDir, 'extension.js'),
        tsconfig: path.join(rootDir, 'tsconfig.json'),
    });
}

if (shouldBuildTarget('stdioManager')) {
    await build({
        ...shared,
        banner: {
            js: '/* lm-tools-bridge bundled stdioManager */',
        },
        entryPoints: [path.join(rootDir, 'src', 'stdioManager.ts')],
        outfile: path.join(outDir, 'stdioManager.js'),
        tsconfig: path.join(rootDir, 'tsconfig.json'),
    });
}

await Promise.all([
    fs.promises.unlink(path.join(outDir, 'manager.js')).catch(() => undefined),
    fs.promises.unlink(path.join(outDir, 'manager.js.map')).catch(() => undefined),
]);

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

function shouldBuildTarget(name) {
    return requestedTargets.size === 0 || requestedTargets.has(name);
}
