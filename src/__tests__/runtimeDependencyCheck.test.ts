import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWingetInstallLaunchSpec,
  DOWNLOAD_NODE_ACTION,
  ensureNodeRuntimeAvailableOnStartup,
  INSTALL_WITH_WINGET_ACTION,
  NODE_DOWNLOAD_URL,
  NODE_WINGET_PACKAGE_ID,
  probeCommandAvailability,
  resetNodeRuntimeAvailabilityStateForTests,
} from '../runtimeDependencyCheck';

test('probeCommandAvailability reports available for a valid command', async () => {
  const result = await probeCommandAvailability(process.execPath, ['--version'], process.env, 5000);
  assert.equal(result.available, true);
  assert.equal(result.reason, 'available');
});

test('probeCommandAvailability reports missing for an unresolved command', async () => {
  const result = await probeCommandAvailability('lm-tools-bridge-node-missing.exe', ['--version'], process.env, 5000);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'missing');
});

test('probeCommandAvailability reports timeout for a hung command', async () => {
  const result = await probeCommandAvailability(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);'],
    process.env,
    200,
  );
  assert.equal(result.available, false);
  assert.equal(result.reason, 'timeout');
});

test('ensureNodeRuntimeAvailableOnStartup offers winget install and launches external PowerShell', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  const warningCalls: Array<{ message: string; actions: readonly string[] }> = [];
  const launched: Array<{ command: string; args: readonly string[] }> = [];

  await ensureNodeRuntimeAvailableOnStartup({
    platform: 'win32',
    env: process.env,
    probeCommand: async (command) => {
      if (command === 'node') {
        return {
          available: false,
          reason: 'missing',
        };
      }
      return {
        available: true,
        reason: 'available',
      };
    },
    showWarningMessage: async (message, actions) => {
      warningCalls.push({ message, actions });
      return INSTALL_WITH_WINGET_ACTION;
    },
    showErrorMessage: async () => {
      assert.fail('showErrorMessage should not be called when winget launch succeeds.');
    },
    openExternal: async () => {
      assert.fail('openExternal should not be called for the winget action.');
    },
    launchDetachedCommand: async (command, args) => {
      launched.push({ command, args });
    },
  });

  assert.equal(warningCalls.length, 1);
  assert.deepEqual(warningCalls[0].actions, [INSTALL_WITH_WINGET_ACTION, DOWNLOAD_NODE_ACTION, 'Dismiss']);
  assert.match(warningCalls[0].message, /requires Node\.js on PATH/u);
  assert.equal(launched.length, 1);
  const launchSpec = buildWingetInstallLaunchSpec();
  assert.equal(launched[0].command, launchSpec.command);
  assert.deepEqual(launched[0].args, launchSpec.args);
  resetNodeRuntimeAvailabilityStateForTests();
});

test('ensureNodeRuntimeAvailableOnStartup falls back to download when winget is unavailable', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  const openedUrls: string[] = [];

  await ensureNodeRuntimeAvailableOnStartup({
    platform: 'win32',
    env: process.env,
    probeCommand: async () => ({
      available: false,
      reason: 'missing',
    }),
    showWarningMessage: async (_message, actions) => {
      assert.deepEqual(actions, [DOWNLOAD_NODE_ACTION, 'Dismiss']);
      return DOWNLOAD_NODE_ACTION;
    },
    showErrorMessage: async () => {
      assert.fail('showErrorMessage should not be called for the download action.');
    },
    openExternal: async (url) => {
      openedUrls.push(url);
    },
  });

  assert.deepEqual(openedUrls, [NODE_DOWNLOAD_URL]);
  resetNodeRuntimeAvailabilityStateForTests();
});

test('ensureNodeRuntimeAvailableOnStartup prompts only once per extension host lifetime', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  let promptCount = 0;

  const options = {
    platform: 'win32' as const,
    env: process.env,
    probeCommand: async () => ({
      available: false,
      reason: 'missing' as const,
    }),
    showWarningMessage: async () => {
      promptCount += 1;
      return undefined;
    },
    showErrorMessage: async () => undefined,
    openExternal: async () => undefined,
  };

  await ensureNodeRuntimeAvailableOnStartup(options);
  await ensureNodeRuntimeAvailableOnStartup(options);
  assert.equal(promptCount, 1);
  resetNodeRuntimeAvailabilityStateForTests();
});

test('ensureNodeRuntimeAvailableOnStartup skips the prompt when node is already available', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  let promptCount = 0;
  let probeCalls = 0;

  await ensureNodeRuntimeAvailableOnStartup({
    platform: 'win32',
    env: process.env,
    probeCommand: async (command) => {
      probeCalls += 1;
      if (command === 'node') {
        return {
          available: true,
          reason: 'available',
        };
      }
      return {
        available: false,
        reason: 'missing',
      };
    },
    showWarningMessage: async () => {
      promptCount += 1;
      return undefined;
    },
    showErrorMessage: async () => undefined,
    openExternal: async () => undefined,
  });

  assert.equal(probeCalls, 1);
  assert.equal(promptCount, 0);
  resetNodeRuntimeAvailabilityStateForTests();
});

test('ensureNodeRuntimeAvailableOnStartup handles winget launch failures without rejecting', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  const errorMessages: string[] = [];
  const logMessages: string[] = [];

  await ensureNodeRuntimeAvailableOnStartup({
    platform: 'win32',
    env: process.env,
    probeCommand: async (command) => ({
      available: command === 'winget',
      reason: command === 'winget' ? 'available' : 'missing',
    }),
    showWarningMessage: async () => INSTALL_WITH_WINGET_ACTION,
    showErrorMessage: async (message) => {
      errorMessages.push(message);
    },
    openExternal: async () => undefined,
    launchDetachedCommand: async () => {
      throw new Error('spawn failed');
    },
    logger: {
      error: (message) => {
        logMessages.push(message);
      },
    },
  });

  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0], /Failed to launch the external winget installer/u);
  assert.ok(logMessages.some((message) => message.includes('Failed to launch winget install')));
  resetNodeRuntimeAvailabilityStateForTests();
});

test('ensureNodeRuntimeAvailableOnStartup handles download page open failures without rejecting', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  const errorMessages: string[] = [];
  const logMessages: string[] = [];

  await ensureNodeRuntimeAvailableOnStartup({
    platform: 'win32',
    env: process.env,
    probeCommand: async () => ({
      available: false,
      reason: 'missing',
    }),
    showWarningMessage: async () => DOWNLOAD_NODE_ACTION,
    showErrorMessage: async (message) => {
      errorMessages.push(message);
    },
    openExternal: async () => {
      throw new Error('browser unavailable');
    },
    logger: {
      error: (message) => {
        logMessages.push(message);
      },
    },
  });

  assert.equal(errorMessages.length, 1);
  assert.match(errorMessages[0], /Failed to open the Node\.js download page/u);
  assert.ok(logMessages.some((message) => message.includes('Failed to open the Node.js download page')));
  resetNodeRuntimeAvailabilityStateForTests();
});

test('ensureNodeRuntimeAvailableOnStartup handles warning UI failures without rejecting', async () => {
  resetNodeRuntimeAvailabilityStateForTests();
  const logMessages: string[] = [];

  await ensureNodeRuntimeAvailableOnStartup({
    platform: 'win32',
    env: process.env,
    probeCommand: async () => ({
      available: false,
      reason: 'missing',
    }),
    showWarningMessage: async () => {
      throw new Error('warning ui unavailable');
    },
    showErrorMessage: async () => undefined,
    openExternal: async () => undefined,
    logger: {
      error: (message) => {
        logMessages.push(message);
      },
    },
  });

  assert.ok(logMessages.some((message) => message.includes('Failed to show the Node.js dependency warning')));
  resetNodeRuntimeAvailabilityStateForTests();
});

test('buildWingetInstallLaunchSpec uses the official Node.js LTS winget package id', () => {
  const spec = buildWingetInstallLaunchSpec();
  assert.equal(spec.command, 'cmd.exe');
  assert.ok(spec.args.includes('powershell.exe'));
  assert.ok(spec.args.includes('-NoExit'));
  assert.ok(spec.args.includes(`winget install --id ${NODE_WINGET_PACKAGE_ID} -e --accept-package-agreements --accept-source-agreements`));
});
