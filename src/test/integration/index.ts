import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

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
  const userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lm-tools-bridge-user-'));
  const extensionsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lm-tools-bridge-ext-'));
  try {
    console.log(`Running VS Code integration suite: ${run.name}`);
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: run.extensionTestsPath,
      launchArgs: [
        run.workspacePath,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir',
        userDataDir,
        '--extensions-dir',
        extensionsDir,
      ],
    });
  } finally {
    await removeDirectoryWithRetries(userDataDir);
    await removeDirectoryWithRetries(extensionsDir);
  }
}

async function createSmokeRun(repoRoot: string): Promise<IntegrationRun> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lm-tools-bridge-smoke-'));
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
    extensionTestsPath: path.join(repoRoot, 'out/test/integration/extensionHost/smokeRunner'),
    cleanup: async () => {
      await removeDirectoryWithRetries(tempDir);
    },
  };
}

async function createMultiRootRun(repoRoot: string): Promise<IntegrationRun> {
  const sourceDir = path.join(repoRoot, 'src/test/fixtures/multi-root');
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lm-tools-bridge-multi-root-'));
  await copyDirectory(sourceDir, tempDir);
  return {
    name: 'multi-root',
    workspacePath: path.join(tempDir, 'multi-root.code-workspace'),
    extensionTestsPath: path.join(repoRoot, 'out/test/integration/extensionHost/multiRootRunner'),
    cleanup: async () => {
      await removeDirectoryWithRetries(tempDir);
    },
  };
}

async function removeDirectoryWithRetries(targetPath: string): Promise<void> {
  await fs.promises.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
