import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

let vscodeExecutablePathPromise: Promise<string> | undefined;

export interface IsolatedVsCodeDirs {
  userDataDir: string;
  extensionsDir: string;
}

export interface ExtensionTestRunOptions {
  vscodeExecutablePath: string;
  extensionDevelopmentPath: string;
  extensionTestsPath: string;
  workspacePath: string;
  isolatedDirs: IsolatedVsCodeDirs;
  extensionTestsEnv?: Record<string, string>;
}

export async function getVSCodeExecutablePath(): Promise<string> {
  vscodeExecutablePathPromise ??= downloadAndUnzipVSCode();
  return await vscodeExecutablePathPromise;
}

export async function makeTempDir(prefix: string): Promise<string> {
  return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function createIsolatedVsCodeDirs(prefix: string): Promise<IsolatedVsCodeDirs> {
  return {
    userDataDir: await makeTempDir(`${prefix}-user-`),
    extensionsDir: await makeTempDir(`${prefix}-ext-`),
  };
}

export function buildCommonVsCodeLaunchArgs(isolatedDirs: IsolatedVsCodeDirs): string[] {
  return [
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--user-data-dir',
    isolatedDirs.userDataDir,
    '--extensions-dir',
    isolatedDirs.extensionsDir,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
  ];
}

export async function runExtensionTests(options: ExtensionTestRunOptions): Promise<void> {
  await withSanitizedVsCodeLaunchEnv(async () => runTests({
    vscodeExecutablePath: options.vscodeExecutablePath,
    extensionDevelopmentPath: options.extensionDevelopmentPath,
    extensionTestsPath: options.extensionTestsPath,
    extensionTestsEnv: options.extensionTestsEnv,
    launchArgs: [
      options.workspacePath,
      ...buildCommonVsCodeLaunchArgs(options.isolatedDirs),
    ],
  }));
}

export async function withSanitizedVsCodeLaunchEnv<T>(operation: () => Promise<T>): Promise<T> {
  const savedEntries = new Map<string, string | undefined>();
  const inheritedNames = Object.keys(process.env).filter((name) => name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_'));
  for (const name of inheritedNames) {
    savedEntries.set(name, process.env[name]);
    delete process.env[name];
  }

  try {
    return await operation();
  } finally {
    for (const name of inheritedNames) {
      const savedValue = savedEntries.get(name);
      if (savedValue === undefined) {
        delete process.env[name];
        continue;
      }
      process.env[name] = savedValue;
    }
  }
}

export async function removeDirectoryWithRetries(targetPath: string): Promise<void> {
  await fs.promises.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}

export async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
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
