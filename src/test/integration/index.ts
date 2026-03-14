import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  copyDirectory,
  createIsolatedVsCodeDirs,
  getVSCodeExecutablePath,
  makeTempDir,
  removeDirectoryWithRetries,
  runExtensionTests,
} from './vscodeTestUtils';

interface IntegrationRun {
  name: string;
  workspacePath: string;
  extensionTestsPath: string;
  cleanup: () => Promise<void>;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('Skipping VS Code integration tests on non-Windows platforms.');
    return;
  }

  const repoRoot = path.resolve(__dirname, '../../..');
  const runs = await Promise.all([
    createSmokeRun(repoRoot),
    createMultiRootRun(repoRoot),
    createMultiRootBraceRun(repoRoot),
  ]);

  try {
    for (const run of runs) {
      await executeIntegrationRun(repoRoot, run);
    }
  } finally {
    for (const run of runs) {
      await run.cleanup();
    }
  }
}

async function executeIntegrationRun(repoRoot: string, run: IntegrationRun): Promise<void> {
  const isolatedDirs = await createIsolatedVsCodeDirs('lm-tools-bridge');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-localappdata-');
  try {
    console.log(`Running VS Code integration suite: ${run.name}`);
    const vscodeExecutablePath = await getVSCodeExecutablePath();
    await runExtensionTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: run.extensionTestsPath,
      workspacePath: run.workspacePath,
      isolatedDirs,
      extensionTestsEnv: {
        LOCALAPPDATA: localAppDataDir,
        LM_TOOLS_BRIDGE_TEST_NODE_PATH: process.execPath,
      },
    });
    console.log(`Completed VS Code integration suite: ${run.name}`);
  } finally {
    await removeDirectoryWithRetries(isolatedDirs.userDataDir);
    await removeDirectoryWithRetries(isolatedDirs.extensionsDir);
    await removeDirectoryWithRetries(localAppDataDir);
  }
}

async function createSmokeRun(repoRoot: string): Promise<IntegrationRun> {
  const tempDir = await makeTempDir('lm-tools-bridge-smoke-');
  const workspacePath = path.join(tempDir, 'smoke.code-workspace');
  const workspacePayload = {
    folders: [
      {
        name: 'lm-tools-bridge',
        path: repoRoot,
      },
    ],
    settings: {
      'lmToolsBridge.server.autoStart': false,
      'lmToolsBridge.debug': 'off',
    },
  };
  await fs.promises.writeFile(workspacePath, `${JSON.stringify(workspacePayload, null, 2)}\n`, 'utf8');
  return {
    name: 'smoke',
    workspacePath,
    extensionTestsPath: path.join(repoRoot, 'out/test/integration/extensionHost/smokeRunner.js'),
    cleanup: async () => {
      await removeDirectoryWithRetries(tempDir);
    },
  };
}

async function createMultiRootRun(repoRoot: string): Promise<IntegrationRun> {
  const sourceDir = path.join(repoRoot, 'src/test/fixtures/multi-root');
  const tempDir = await makeTempDir('lm-tools-bridge-multi-root-');
  await copyDirectory(sourceDir, tempDir);
  return {
    name: 'multi-root',
    workspacePath: path.join(tempDir, 'multi-root.code-workspace'),
    extensionTestsPath: path.join(repoRoot, 'out/test/integration/extensionHost/multiRootRunner.js'),
    cleanup: async () => {
      await removeDirectoryWithRetries(tempDir);
    },
  };
}

async function createMultiRootBraceRun(repoRoot: string): Promise<IntegrationRun> {
  const sourceDir = path.join(repoRoot, 'src/test/fixtures/multi-root-brace');
  const tempDir = await makeTempDir('lm-tools-bridge-multi-root-brace-');
  await copyDirectory(sourceDir, tempDir);
  return {
    name: 'multi-root-brace',
    workspacePath: path.join(tempDir, 'multi-root-brace.code-workspace'),
    extensionTestsPath: path.join(repoRoot, 'out/test/integration/extensionHost/multiRootBraceRunner.js'),
    cleanup: async () => {
      await removeDirectoryWithRetries(tempDir);
    },
  };
}


void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
