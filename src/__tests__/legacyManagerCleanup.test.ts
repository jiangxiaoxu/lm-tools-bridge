import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  cleanupLegacyManagerInstancesDir,
  resolveLegacyManagerInstancesDir,
} from '../legacyManagerCleanup';

async function makeTempDir(prefix: string): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('resolveLegacyManagerInstancesDir returns undefined without LOCALAPPDATA', () => {
  assert.equal(resolveLegacyManagerInstancesDir({}), undefined);
});

test('cleanupLegacyManagerInstancesDir skips when LOCALAPPDATA is unavailable', async () => {
  const result = await cleanupLegacyManagerInstancesDir({
    env: {},
  });

  assert.equal(result.status, 'skipped');
  assert.match(result.reason ?? '', /LOCALAPPDATA/u);
});

test('cleanupLegacyManagerInstancesDir reports missing when the legacy directory does not exist', async (t) => {
  const localAppDataDir = await makeTempDir('lm-tools-bridge-legacy-cleanup-');

  t.after(async () => {
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await cleanupLegacyManagerInstancesDir({
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'missing');
  assert.equal(result.targetDir, path.join(localAppDataDir, 'lm-tools-bridge', 'instances'));
});

test('cleanupLegacyManagerInstancesDir removes the legacy instances directory recursively', async (t) => {
  const localAppDataDir = await makeTempDir('lm-tools-bridge-legacy-cleanup-');
  const targetDir = path.join(localAppDataDir, 'lm-tools-bridge', 'instances');
  await fs.promises.mkdir(path.join(targetDir, 'nested'), { recursive: true });
  await fs.promises.writeFile(path.join(targetDir, 'nested', 'record.json'), '{"ok":true}\n', 'utf8');

  t.after(async () => {
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await cleanupLegacyManagerInstancesDir({
    env: {
      ...process.env,
      LOCALAPPDATA: localAppDataDir,
    },
  });

  assert.equal(result.status, 'removed');
  await assert.rejects(fs.promises.access(targetDir));
});

test('cleanupLegacyManagerInstancesDir logs and skips when stat fails unexpectedly', async (t) => {
  const localAppDataDir = await makeTempDir('lm-tools-bridge-legacy-cleanup-');
  const warnings: string[] = [];
  const originalStat = fs.promises.stat;
  t.mock.method(fs.promises, 'stat', async () => {
    throw new Error('stat failed');
  });

  t.after(async () => {
    fs.promises.stat = originalStat;
    await fs.promises.rm(localAppDataDir, { recursive: true, force: true });
  });

  const result = await cleanupLegacyManagerInstancesDir({
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
  assert.ok(warnings.some((message) => message.includes('Failed to inspect legacy manager instances directory')));
});
