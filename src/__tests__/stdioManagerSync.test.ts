import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  BUNDLED_STDIO_MANAGER_BANNER,
  BUNDLED_STDIO_MANAGER_RUNTIME_BANNER,
  computeSha256,
  resolveStdioManagerSyncPaths,
  STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
  STDIO_MANAGER_SYNC_FILENAME,
  syncBundledStdioManager,
  tryAcquirePipeLock,
} from '../stdioManagerSync';

interface ControlRequest {
  op: 'generationChanged';
  protocolVersion: 1;
  generation: number;
}

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeBundledManager(filePath: string, body: string): Promise<string> {
  const content = `${BUNDLED_STDIO_MANAGER_BANNER}\n${body}\n`;
  await fs.promises.writeFile(filePath, content, 'utf8');
  return content;
}

async function writeBundledRuntime(filePath: string, body: string): Promise<string> {
  const content = `${BUNDLED_STDIO_MANAGER_RUNTIME_BANNER}\n${body}\n`;
  await fs.promises.writeFile(filePath, content, 'utf8');
  return content;
}

async function createLiveRegistryEntry(
  managersDir: string,
  sessionId: string,
  options?: {
    responseDelayMs?: number;
    respond?: boolean;
    appliedGeneration?: number;
  },
) {
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\lm-tools-bridge-sync-test.${sessionId}`
    : path.join(os.tmpdir(), `lm-tools-bridge-sync-test.${sessionId}.sock`);
  const requests: ControlRequest[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      const parsed = JSON.parse(line) as ControlRequest;
      requests.push(parsed);
      if (options?.respond === false) {
        return;
      }
      const writeResponse = () => {
        socket.end(`${JSON.stringify({
          ok: true,
          protocolVersion: 1,
          generationApplied: options?.appliedGeneration ?? parsed.generation,
          bindingInvalidated: true,
        })}\n`);
      };
      if ((options?.responseDelayMs ?? 0) > 0) {
        setTimeout(writeResponse, options?.responseDelayMs);
        return;
      }
      writeResponse();
    });
  });
  await fs.promises.mkdir(managersDir, { recursive: true });
  await new Promise<void>((resolve) => {
    server.listen(pipePath, () => {
      resolve();
    });
  });
  const registryPath = path.join(managersDir, `${sessionId}.json`);
  await fs.promises.writeFile(
    registryPath,
    `${JSON.stringify({
      protocolVersion: 1,
      sessionId,
      pid: process.pid,
      startedAt: Date.now(),
      controlPipePath: pipePath,
    }, null, 2)}\n`,
    'utf8',
  );
  return {
    requests,
    registryPath,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (process.platform !== 'win32') {
        await fs.promises.rm(pipePath, { force: true }).catch(() => undefined);
      }
    },
  };
}

test('syncBundledStdioManager writes manager, runtime, and generation metadata when missing', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '1.2.3',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.generation, 1);
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const syncedContent = await fs.promises.readFile(paths.targetPath!, 'utf8');
  const syncedRuntimeContent = await fs.promises.readFile(paths.runtimePath!, 'utf8');
  assert.equal(syncedContent, bundledContent);
  assert.equal(syncedRuntimeContent, bundledRuntimeContent);
  const metadata = JSON.parse(await fs.promises.readFile(paths.metadataPath!, 'utf8')) as {
    generation?: number;
    extensionVersion?: string;
    managerFileName?: string;
    runtimeFileName?: string;
    managerSha256?: string;
    runtimeSha256?: string;
    syncedAt?: string;
  };
  assert.equal(metadata.generation, 1);
  assert.equal(metadata.extensionVersion, '1.2.3');
  assert.equal(metadata.managerFileName, STDIO_MANAGER_SYNC_FILENAME);
  assert.equal(metadata.runtimeFileName, STDIO_MANAGER_RUNTIME_SYNC_FILENAME);
  assert.equal(metadata.managerSha256, computeSha256(bundledContent));
  assert.equal(metadata.runtimeSha256, computeSha256(bundledRuntimeContent));
  assert.equal(typeof metadata.syncedAt, 'string');
});

test('syncBundledStdioManager skips overwrite when source and target hashes match and metadata is current', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("same runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  await fs.promises.writeFile(paths.runtimePath!, bundledRuntimeContent, 'utf8');
  await fs.promises.writeFile(
    paths.metadataPath!,
    `${JSON.stringify({
      generation: 7,
      extensionVersion: '9.9.9',
      managerFileName: STDIO_MANAGER_SYNC_FILENAME,
      runtimeFileName: STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
      managerSha256: computeSha256(bundledContent),
      runtimeSha256: computeSha256(bundledRuntimeContent),
      syncedAt: '2026-03-14T00:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  );
  const originalManagerStat = await fs.promises.stat(paths.targetPath!);
  const originalRuntimeStat = await fs.promises.stat(paths.runtimePath!);

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '9.9.9',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.generation, 7);
  const currentManagerStat = await fs.promises.stat(paths.targetPath!);
  const currentRuntimeStat = await fs.promises.stat(paths.runtimePath!);
  assert.equal(currentManagerStat.mtimeMs, originalManagerStat.mtimeMs);
  assert.equal(currentRuntimeStat.mtimeMs, originalRuntimeStat.mtimeMs);
});

test('syncBundledStdioManager does not bump generation when only extensionVersion changes', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("same runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  await fs.promises.writeFile(paths.runtimePath!, bundledRuntimeContent, 'utf8');
  await fs.promises.writeFile(
    paths.metadataPath!,
    `${JSON.stringify({
      generation: 7,
      extensionVersion: '1.0.0',
      managerFileName: STDIO_MANAGER_SYNC_FILENAME,
      runtimeFileName: STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
      managerSha256: computeSha256(bundledContent),
      runtimeSha256: computeSha256(bundledRuntimeContent),
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
    bundledRuntimePath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.generation, 7);
  const metadata = JSON.parse(await fs.promises.readFile(paths.metadataPath!, 'utf8')) as { extensionVersion?: string };
  assert.equal(metadata.extensionVersion, '1.0.0');
});

test('syncBundledStdioManager republishes metadata when synced artifacts already exist but metadata is missing', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("same runtime");');
  const recoveryGeneration = 1_712_345_678_901;
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  await fs.promises.writeFile(paths.runtimePath!, bundledRuntimeContent, 'utf8');

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => recoveryGeneration);

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.generation, recoveryGeneration);
  const metadata = JSON.parse(await fs.promises.readFile(paths.metadataPath!, 'utf8')) as {
    generation?: number;
    managerSha256?: string;
    runtimeSha256?: string;
  };
  assert.equal(metadata.generation, recoveryGeneration);
  assert.equal(metadata.managerSha256, computeSha256(bundledContent));
  assert.equal(metadata.runtimeSha256, computeSha256(bundledRuntimeContent));
});

test('syncBundledStdioManager recovers when only the manager artifact exists and metadata is missing', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("same runtime");');
  const recoveryGeneration = 1_712_345_678_902;
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => recoveryGeneration);

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.generation, recoveryGeneration);
  assert.equal(await fs.promises.readFile(paths.targetPath!, 'utf8'), bundledContent);
  assert.equal(await fs.promises.readFile(paths.runtimePath!, 'utf8'), bundledRuntimeContent);
});

test('syncBundledStdioManager recovers when only the runtime artifact exists and metadata is invalid', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("same");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("same runtime");');
  const recoveryGeneration = 1_712_345_678_903;
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.runtimePath!, bundledRuntimeContent, 'utf8');
  await fs.promises.writeFile(paths.metadataPath!, '{"generation": "broken"}\n', 'utf8');

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => recoveryGeneration);

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.generation, recoveryGeneration);
  assert.equal(await fs.promises.readFile(paths.targetPath!, 'utf8'), bundledContent);
  assert.equal(await fs.promises.readFile(paths.runtimePath!, 'utf8'), bundledRuntimeContent);
});

test('syncBundledStdioManager migrates legacy metadata instead of skipping publish', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const bundledContent = await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  const bundledRuntimeContent = await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, bundledContent, 'utf8');
  await fs.promises.writeFile(
    paths.metadataPath!,
    `${JSON.stringify({
      extensionVersion: '1.0.162',
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
    bundledRuntimePath,
    extensionVersion: '1.0.164',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.generation, 1);
  assert.equal(await fs.promises.readFile(paths.targetPath!, 'utf8'), bundledContent);
  assert.equal(await fs.promises.readFile(paths.runtimePath!, 'utf8'), bundledRuntimeContent);
  const metadata = JSON.parse(await fs.promises.readFile(paths.metadataPath!, 'utf8')) as {
    generation?: number;
    runtimeFileName?: string;
    managerSha256?: string;
    runtimeSha256?: string;
  };
  assert.equal(metadata.generation, 1);
  assert.equal(metadata.runtimeFileName, STDIO_MANAGER_RUNTIME_SYNC_FILENAME);
  assert.equal(metadata.managerSha256, computeSha256(bundledContent));
  assert.equal(metadata.runtimeSha256, computeSha256(bundledRuntimeContent));
});

test('syncBundledStdioManager increments generation when content changes', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  await writeBundledManager(bundledManagerPath, 'console.log("updated");');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("updated runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.targetDir!, { recursive: true });
  await fs.promises.writeFile(paths.targetPath!, 'stale', 'utf8');
  await fs.promises.writeFile(paths.runtimePath!, 'stale-runtime', 'utf8');
  await fs.promises.writeFile(
    paths.metadataPath!,
    `${JSON.stringify({
      generation: 3,
      extensionVersion: '1.0.0',
      managerFileName: STDIO_MANAGER_SYNC_FILENAME,
      runtimeFileName: STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
      managerSha256: 'old',
      runtimeSha256: 'old',
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
    bundledRuntimePath,
    extensionVersion: '2.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.generation, 4);
  const metadataText = await fs.promises.readFile(paths.metadataPath!, 'utf8');
  assert.match(metadataText, /"generation": 4/u);
});

test('syncBundledStdioManager skips non-bundled manager artifacts', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  await fs.promises.writeFile(bundledManagerPath, 'console.log("not bundled");\n', 'utf8');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const warnings: string[] = [];

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
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
  await assert.rejects(fs.promises.access(paths.runtimePath!));
  await assert.rejects(fs.promises.access(paths.metadataPath!));
});

test('syncBundledStdioManager removes stale manager registry entries when control pipes are unreachable', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  await fs.promises.mkdir(paths.managersDir!, { recursive: true });
  const staleEntryPath = path.join(paths.managersDir!, 'stale.json');
  await fs.promises.writeFile(
    staleEntryPath,
    `${JSON.stringify({
      protocolVersion: 1,
      sessionId: 'stale',
      pid: 123,
      startedAt: Date.now(),
      controlPipePath: '\\\\.\\pipe\\lm-tools-bridge-stale-entry',
    }, null, 2)}\n`,
    'utf8',
  );

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '1.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  await assert.rejects(fs.promises.access(staleEntryPath));
});

test('syncBundledStdioManager notifies live managers after publishing a new generation', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const liveEntry = await createLiveRegistryEntry(paths.managersDir!, 'live-manager');

  t.after(async () => {
    await liveEntry.close();
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '1.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.notifiedManagers, 1);
  assert.deepEqual(liveEntry.requests.map((request) => request.generation), [1]);
});

test('syncBundledStdioManager skips managers whose registry entries were removed before publish', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const liveEntry = await createLiveRegistryEntry(paths.managersDir!, 'fatal-manager');
  await fs.promises.rm(liveEntry.registryPath, { force: true });

  t.after(async () => {
    await liveEntry.close();
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '1.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.notifiedManagers, 0);
  assert.deepEqual(liveEntry.requests, []);
});

test('syncBundledStdioManager keeps live registry entries when notify times out', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const liveEntry = await createLiveRegistryEntry(paths.managersDir!, 'slow-manager', {
    responseDelayMs: 3500,
  });

  t.after(async () => {
    await liveEntry.close();
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
    extensionVersion: '1.0.0',
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(result.notifiedManagers, 0);
  await fs.promises.access(liveEntry.registryPath);
  assert.deepEqual(liveEntry.requests.map((request) => request.generation), [1]);
});

test('syncBundledStdioManager keeps live registry entries when notify applies the wrong generation', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const bundledManagerPath = path.join(sourceDir, 'stdioManager.js');
  const bundledRuntimePath = path.join(sourceDir, 'stdioManagerRuntime.js');
  const warnings: string[] = [];
  await writeBundledManager(bundledManagerPath, 'console.log("manager");');
  await writeBundledRuntime(bundledRuntimePath, 'console.log("runtime");');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const liveEntry = await createLiveRegistryEntry(paths.managersDir!, 'mismatch-manager', {
    appliedGeneration: 0,
  });

  t.after(async () => {
    await liveEntry.close();
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await syncBundledStdioManager({
    bundledManagerPath,
    bundledRuntimePath,
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

  assert.equal(result.status, 'synced');
  assert.equal(result.notifiedManagers, 0);
  await fs.promises.access(liveEntry.registryPath);
  assert.deepEqual(liveEntry.requests.map((request) => request.generation), [1]);
  assert.ok(warnings.some((message) => message.includes("stayed on 0")));
});

test('syncBundledStdioManager serializes concurrent publishers with the publish lock', async (t) => {
  const sourceDir = await makeTempDir('lm-tools-bridge-sync-src-');
  const sourceDirB = await makeTempDir('lm-tools-bridge-sync-src-b-');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-sync-localappdata-');
  const managerPathA = path.join(sourceDir, 'stdioManager.js');
  const runtimePathA = path.join(sourceDir, 'stdioManagerRuntime.js');
  const managerPathB = path.join(sourceDirB, 'stdioManager.js');
  const runtimePathB = path.join(sourceDirB, 'stdioManagerRuntime.js');
  const managerContentA = await writeBundledManager(managerPathA, 'console.log("manager-a");');
  const runtimeContentA = await writeBundledRuntime(runtimePathA, 'console.log("runtime-a");');
  const managerContentB = await writeBundledManager(managerPathB, 'console.log("manager-b");');
  const runtimeContentB = await writeBundledRuntime(runtimePathB, 'console.log("runtime-b");');

  t.after(async () => {
    await fs.promises.rm(sourceDir, { recursive: true, force: true });
    await fs.promises.rm(sourceDirB, { recursive: true, force: true });
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const [resultA, resultB] = await Promise.all([
    syncBundledStdioManager({
      bundledManagerPath: managerPathA,
      bundledRuntimePath: runtimePathA,
      extensionVersion: '1.0.0',
      env: {
        ...process.env,
        LOCALAPPDATA: localAppDataDir,
      },
    }),
    syncBundledStdioManager({
      bundledManagerPath: managerPathB,
      bundledRuntimePath: runtimePathB,
      extensionVersion: '2.0.0',
      env: {
        ...process.env,
        LOCALAPPDATA: localAppDataDir,
      },
    }),
  ]);

  assert.equal(resultA.status, 'synced');
  assert.equal(resultB.status, 'synced');
  const paths = resolveStdioManagerSyncPaths({ LOCALAPPDATA: localAppDataDir });
  const finalManagerContent = await fs.promises.readFile(paths.targetPath!, 'utf8');
  const finalRuntimeContent = await fs.promises.readFile(paths.runtimePath!, 'utf8');
  const metadata = JSON.parse(await fs.promises.readFile(paths.metadataPath!, 'utf8')) as { generation?: number; managerSha256?: string; runtimeSha256?: string };
  assert.equal(metadata.generation, 2);
  assert.ok(
    (
      finalManagerContent === managerContentA
      && finalRuntimeContent === runtimeContentA
      && metadata.managerSha256 === computeSha256(managerContentA)
      && metadata.runtimeSha256 === computeSha256(runtimeContentA)
    )
    || (
      finalManagerContent === managerContentB
      && finalRuntimeContent === runtimeContentB
      && metadata.managerSha256 === computeSha256(managerContentB)
      && metadata.runtimeSha256 === computeSha256(runtimeContentB)
    ),
    'Expected final sync artifacts and metadata hashes to be self-consistent.',
  );
});

test('tryAcquirePipeLock preserves live unix sockets and recovers stale ones', {
  skip: process.platform === 'win32',
}, async (t) => {
  const pipeName = `lm-tools-bridge-unix-lock-${process.pid}-${Date.now()}`;
  const socketPath = path.join(os.tmpdir(), `${pipeName}.sock`);
  const liveServer = net.createServer((socket) => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => {
    liveServer.listen(socketPath, () => {
      resolve();
    });
  });

  t.after(async () => {
    await new Promise<void>((resolve) => {
      try {
        liveServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    await fs.promises.rm(socketPath, { force: true }).catch(() => undefined);
  });

  const liveRelease = await tryAcquirePipeLock(pipeName, 'linux');
  assert.equal(liveRelease, undefined);
  assert.equal(await fs.promises.stat(socketPath).then(() => true, () => false), true);

  await new Promise<void>((resolve) => {
    liveServer.close(() => resolve());
  });
  assert.equal(await fs.promises.stat(socketPath).then(() => true, () => false), true);

  const staleRelease = await tryAcquirePipeLock(pipeName, 'linux');
  assert.equal(typeof staleRelease, 'function');
  await staleRelease?.();
});
