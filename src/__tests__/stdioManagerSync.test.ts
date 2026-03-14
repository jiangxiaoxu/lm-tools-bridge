import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  BUNDLED_STDIO_MANAGER_BANNER,
  resolveStdioManagerSyncPaths,
  STDIO_MANAGER_SYNC_FILENAME,
  syncBundledStdioManager,
} from '../stdioManagerSync';

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeBundledManager(filePath: string, body: string): Promise<string> {
  const content = `${BUNDLED_STDIO_MANAGER_BANNER}\n${body}\n`;
  await fs.promises.writeFile(filePath, content, 'utf8');
  return content;
}

test('syncBundledStdioManager writes manager and metadata when missing', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("manager");');

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '1.2.3',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const syncedContent = await fs.promises.readFile(paths.targetPath!, 'utf8');
  assert.equal(syncedContent, bundledContent);
  const metadata = JSON.parse(await fs.promises.readFile(paths.metadataPath!, 'utf8')) as {
    extensionVersion?: string;
    managerFileName?: string;
    syncedAt?: string;
  };
  assert.equal(metadata.extensionVersion, '1.2.3');
  assert.equal(metadata.managerFileName, STDIO_MANAGER_SYNC_FILENAME);
  assert.equal(typeof metadata.syncedAt, 'string');
});

test('syncBundledStdioManager skips overwrite when source and target hashes match', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  const originalMetadata = {
    extensionVersion: '9.9.9',
    managerFileName: STDIO_MANAGER_SYNC_FILENAME,
    syncedAt: '2026-03-14T00:00:00.000Z',
  };
  await fs.promises.writeFile(paths.metadataPath!, `${JSON.stringify(originalMetadata, null, 2)}\n`, 'utf8');
  const originalManagerStat = await fs.promises.stat(paths.targetPath!);

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '9.9.9',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'unchanged');
  const currentManagerStat = await fs.promises.stat(paths.targetPath!);
  assert.equal(currentManagerStat.mtimeMs, originalManagerStat.mtimeMs);
  assert.equal(await fs.promises.readFile(paths.metadataPath!, 'utf8'), `${JSON.stringify(originalMetadata, null, 2)}\n`);
});

test('syncBundledStdioManager repairs metadata when hashes match but metadata is missing', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  const originalManagerStat = await fs.promises.stat(paths.targetPath!);

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  const currentManagerStat = await fs.promises.stat(paths.targetPath!);
  assert.equal(currentManagerStat.mtimeMs, originalManagerStat.mtimeMs);
  assert.equal(await fs.promises.readFile(paths.targetPath!, 'utf8'), bundledContent);
  const metadataText = await fs.promises.readFile(paths.metadataPath!, 'utf8');
  assert.match(metadataText, /"extensionVersion": "2.0.0"/u);
  assert.doesNotMatch(metadataText, /"sha256"/u);
});

test('syncBundledStdioManager repairs metadata when hashes match but metadata is stale', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  await fs.promises.writeFile(
    paths.metadataPath!,
    `${JSON.stringify({
      extensionVersion: '0.0.1',
      managerFileName: STDIO_MANAGER_SYNC_FILENAME,
      syncedAt: '2026-03-14T00:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  );
  const originalManagerStat = await fs.promises.stat(paths.targetPath!);

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '3.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  const currentManagerStat = await fs.promises.stat(paths.targetPath!);
  assert.equal(currentManagerStat.mtimeMs, originalManagerStat.mtimeMs);
  const metadataText = await fs.promises.readFile(paths.metadataPath!, 'utf8');
  assert.match(metadataText, /"extensionVersion": "3.0.0"/u);
  assert.doesNotMatch(metadataText, /"sha256"/u);
});

test('syncBundledStdioManager rewrites files when source and target hashes differ', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("updated");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, 'stale', 'utf8');
  await fs.promises.writeFile(
    paths.metadataPath!,
    `${JSON.stringify({
      extensionVersion: '1.0.0',
      managerFileName: STDIO_MANAGER_SYNC_FILENAME,
      syncedAt: '2026-03-14T00:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  );

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(await fs.promises.readFile(paths.targetPath!, 'utf8'), bundledContent);
  const metadataText = await fs.promises.readFile(paths.metadataPath!, 'utf8');
  assert.match(metadataText, /"extensionVersion": "2.0.0"/u);
  assert.doesNotMatch(metadataText, /"sha256"/u);
});

test('syncBundledStdioManager skips non-bundled manager artifacts', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  await fs.promises.writeFile(bundledManagerPath, 'console.log("not bundled");\n', 'utf8');
  const warnings: string[] = [];

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '1.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
    logger: {
      warn: (message) => {
        warnings.push(message);
      },
    },
  });

  assert.equal(result.status, 'skipped');
  assert.ok(warnings.some((message) => message.includes('is not a bundled runtime artifact')));
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await assert.rejects(fs.promises.access(paths.targetPath!));
  await assert.rejects(fs.promises.access(paths.metadataPath!));
});

test('syncBundledStdioManager logs and skips when target directory is not writable', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataMarkerFile = path.join(sourceDir, 'not-a-directory.txt');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  await fs.promises.writeFile(localAppDataMarkerFile, 'marker', 'utf8');
  const warnings: string[] = [];

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    extensionVersion: '1.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataMarkerFile,
    },
    logger: {
      warn: (message) => {
        warnings.push(message);
      },
    },
  });

  assert.equal(result.status, 'skipped');
  assert.ok(warnings.some((message) => message.includes('Failed to sync stdio manager')));
});
