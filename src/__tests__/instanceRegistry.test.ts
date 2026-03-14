import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  isCwdMatchingWorkspaceFile,
  isCwdWithinWorkspaceFolders,
  pickBestMatchingInstance,
  readRegisteredInstances,
  removeInstanceAdvertisement,
  writeInstanceAdvertisement,
} from '../instanceRegistry';

async function makeTempDir(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('registry reads back advertised instances and matches nested workspace paths', async () => {
  const registryDir = await makeTempDir('lm-tools-bridge-registry-');
  const workspaceRoot = path.join(registryDir, 'workspace-a');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  await fs.promises.mkdir(nestedPath, { recursive: true });

  await writeInstanceAdvertisement({
    sessionId: 'session-a',
    pid: 100,
    workspaceFolders: [workspaceRoot],
    host: '127.0.0.1',
    port: 48123,
    lastSeen: Date.now(),
    startedAt: Date.now() - 1000,
  }, registryDir);

  const records = await readRegisteredInstances({
    directory: registryDir,
    pruneStale: true,
  });
  assert.equal(records.length, 1);
  assert.equal(isCwdWithinWorkspaceFolders(nestedPath, records[0].workspaceFolders), true);
  const matched = pickBestMatchingInstance(nestedPath, records);
  assert.equal(matched?.sessionId, 'session-a');

  await fs.promises.rm(registryDir, { recursive: true, force: true });
});

test('workspace file exact match wins over folder prefix match', async () => {
  const registryDir = await makeTempDir('lm-tools-bridge-registry-');
  const workspaceRoot = path.join(registryDir, 'workspace-b');
  const workspaceFile = path.join(registryDir, 'demo.code-workspace');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  await fs.promises.writeFile(workspaceFile, '{}', 'utf8');

  await writeInstanceAdvertisement({
    sessionId: 'folder-session',
    pid: 200,
    workspaceFolders: [workspaceRoot],
    host: '127.0.0.1',
    port: 48124,
    lastSeen: Date.now() - 10,
    startedAt: Date.now() - 2000,
  }, registryDir);
  await writeInstanceAdvertisement({
    sessionId: 'workspace-file-session',
    pid: 201,
    workspaceFolders: [workspaceRoot],
    workspaceFile,
    host: '127.0.0.1',
    port: 48125,
    lastSeen: Date.now(),
    startedAt: Date.now() - 1000,
  }, registryDir);

  const records = await readRegisteredInstances({
    directory: registryDir,
    pruneStale: true,
  });
  const matched = pickBestMatchingInstance(workspaceFile, records);
  assert.equal(matched?.sessionId, 'workspace-file-session');
  assert.equal(isCwdMatchingWorkspaceFile(workspaceFile, matched?.workspaceFile), true);

  await fs.promises.rm(registryDir, { recursive: true, force: true });
});

test('stale instance records are pruned on read', async () => {
  const registryDir = await makeTempDir('lm-tools-bridge-registry-');

  await writeInstanceAdvertisement({
    sessionId: 'stale-session',
    pid: 300,
    workspaceFolders: [registryDir],
    host: '127.0.0.1',
    port: 48126,
    lastSeen: Date.now() - 10_000,
    startedAt: Date.now() - 20_000,
  }, registryDir);

  const records = await readRegisteredInstances({
    directory: registryDir,
    ttlMs: 1000,
    pruneStale: true,
  });
  assert.equal(records.length, 0);

  const staleRecordPath = path.join(registryDir, 'stale-session.json');
  assert.equal(await fs.promises.access(staleRecordPath).then(() => true).catch(() => false), false);
  await removeInstanceAdvertisement('stale-session', registryDir);
  await fs.promises.rm(registryDir, { recursive: true, force: true });
});
