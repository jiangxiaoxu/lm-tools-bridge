import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkspaceDiscoveryTarget,
  getUntitledMultiRootUnsupportedMessage,
  requestWorkspaceDiscovery,
  resolveWorkspaceDiscoveryTargetFromWindow,
  tryAcquireLaunchLock,
  WorkspaceDiscoveryPublisher,
} from '../workspaceDiscovery';

function createTestEnv(prefixSeed: string): NodeJS.ProcessEnv {
  const seed = `${prefixSeed}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    ...process.env,
    LM_TOOLS_BRIDGE_DISCOVERY_PIPE_PREFIX: `lm-tools-bridge-test.discovery.${seed}.`,
    LM_TOOLS_BRIDGE_LAUNCH_LOCK_PIPE_PREFIX: `lm-tools-bridge-test.lock.${seed}.`,
  };
}

async function waitForDiscoveryPort(
  target: ReturnType<typeof createWorkspaceDiscoveryTarget>,
  expectedPort: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const discovered = await requestWorkspaceDiscovery(target, `manager-${process.pid}`);
    if (discovered?.port === expectedPort) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for discovery target to publish port ${String(expectedPort)}.`);
}

test('workspace discovery identity distinguishes folder and workspace file targets', () => {
  const env = createTestEnv('identity');
  const folderTarget = createWorkspaceDiscoveryTarget('folder', 'G:\\Project\\Demo', { env });
  const workspaceFileTarget = createWorkspaceDiscoveryTarget('workspace-file', 'G:\\Project\\Demo\\demo.code-workspace', { env });

  assert.notEqual(folderTarget.canonicalIdentity, workspaceFileTarget.canonicalIdentity);
  assert.notEqual(folderTarget.discoveryPipePath, workspaceFileTarget.discoveryPipePath);
  assert.notEqual(folderTarget.launchLockPipePath, workspaceFileTarget.launchLockPipePath);
});

test('untitled multi-root workspace is rejected for discovery publishing', () => {
  const result = resolveWorkspaceDiscoveryTargetFromWindow(
    ['G:\\Project\\WorkspaceA', 'G:\\Project\\WorkspaceB'],
    undefined,
  );

  assert.ok(result && 'code' in result);
  assert.equal(result.code, 'UNTITLED_MULTI_ROOT_UNSUPPORTED');
  assert.equal(result.message, getUntitledMultiRootUnsupportedMessage());
});

test('workspace discovery publisher supports single owner with standby takeover', async () => {
  const env = createTestEnv('takeover');
  const target = createWorkspaceDiscoveryTarget('folder', 'G:\\Project\\Demo', { env });
  const firstPublisher = new WorkspaceDiscoveryPublisher({
    serverSessionId: 'publisher-a',
    retryIntervalMs: 50,
    getAdvertisement: () => ({
      target,
      host: '127.0.0.1',
      port: 48123,
    }),
  });
  const secondPublisher = new WorkspaceDiscoveryPublisher({
    serverSessionId: 'publisher-b',
    retryIntervalMs: 50,
    getAdvertisement: () => ({
      target,
      host: '127.0.0.1',
      port: 48124,
    }),
  });

  await firstPublisher.start();
  await secondPublisher.start();

  try {
    await waitForDiscoveryPort(target, 48123);
    await firstPublisher.stop();
    await waitForDiscoveryPort(target, 48124);
  } finally {
    await secondPublisher.stop();
    await firstPublisher.stop();
  }
});

test('launch lock pipe is exclusive per workspace identity', async () => {
  const env = createTestEnv('lock');
  const target = createWorkspaceDiscoveryTarget('folder', 'G:\\Project\\Demo', { env });

  const releaseFirst = await tryAcquireLaunchLock(target);
  assert.ok(releaseFirst, 'Expected the first launch lock acquisition to succeed.');

  try {
    const releaseSecond = await tryAcquireLaunchLock(target);
    assert.equal(releaseSecond, undefined);
  } finally {
    await releaseFirst?.();
  }

  const releaseThird = await tryAcquireLaunchLock(target);
  assert.ok(releaseThird, 'Expected the launch lock to become available again after release.');
  await releaseThird?.();
});
