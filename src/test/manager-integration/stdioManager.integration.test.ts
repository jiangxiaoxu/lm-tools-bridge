import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK,
  QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED,
} from '../../qgrepTextQuery';
import {
  computeSha256,
  STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
  STDIO_MANAGER_SYNC_DIRNAME,
  STDIO_MANAGER_SYNC_FILENAME,
} from '../../stdioManagerSync';
import {
  buildCommonVsCodeLaunchArgs,
  copyDirectory,
  createIsolatedVsCodeDirs,
  getVSCodeExecutablePath,
  makeTempDir,
  removeDirectoryWithRetries,
} from '../integration/vscodeTestUtils';

const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.bindWorkspace';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callBridgedTool';
const GUIDE_RESOURCE_URI = 'lm-tools://guide';
const QGREP_STATUS_TOOL_NAME = 'lm_qgrepGetStatus';
const QGREP_TEXT_TOOL_NAME = 'lm_qgrepSearchText';
const QGREP_FILES_TOOL_NAME = 'lm_qgrepSearchFiles';
const HANDSHAKE_TIMEOUT_MS = 180_000;
const FILE_QUERY = 'Game/Source/**/*.Target.cs';
const TEXT_QUERY = 'AvatarCharacter';
const TEXT_PIPE_QUERY = 'AvatarCharacter|AvatarHealthComponent';
const TEXT_SPACE_PIPE_QUERY = 'AvatarSpacePipeLeft | AvatarSpacePipeRight';
const TEXT_DROPPED_SPACE_PIPE_QUERY = 'BrokenPipeSpaceDrop| |LiteralSpaceDrop';
const TEXT_FALLBACK_PIPE_QUERY = 'BrokenPipe||Literal';
const TEXT_PATH_SCOPE = 'Game/Source/GameRuntime/**/*.{h,cpp}';
const TEXT_CONTEXT_CLAMP_BEFORE = 80;
const TEXT_CONTEXT_CLAMP_AFTER = 8;

interface ManagerConnection {
  client: Client;
  close: () => Promise<void>;
  getStderr: () => string;
}

interface AutoStartWorkspace {
  rootDir: string;
  workspaceFile: string;
  nestedCwd: string;
}

interface CodeWrapper {
  wrapperDir: string;
  pidFile: string;
  logFile: string;
}

interface QgrepTextMatch {
  workspacePath: string;
  absolutePath: string;
  line: number;
  preview: string;
}

interface ManagerRegistryEntry {
  protocolVersion: 1;
  sessionId: string;
  pid: number;
  startedAt: number;
  controlPipePath: string;
}

interface GenerationChangedResponse {
  ok: true;
  protocolVersion: 1;
  generationApplied: number;
  bindingInvalidated: boolean;
}

function getRepoPackageVersion(): string {
  const parsed = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
  ) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : 'unknown';
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/');
}

function normalizeWindowsComparablePath(pathValue: string): string {
  return normalizePath(path.resolve(pathValue)).toLowerCase();
}

function createPipeEnv(prefixSeed: string): Record<string, string> {
  const seed = `${prefixSeed}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    .replace(/[^a-z0-9._-]/giu, '_');
  return {
    LM_TOOLS_BRIDGE_DISCOVERY_PIPE_PREFIX: `lm-tools-bridge-test.discovery.${seed}.`,
    LM_TOOLS_BRIDGE_LAUNCH_LOCK_PIPE_PREFIX: `lm-tools-bridge-test.lock.${seed}.`,
  };
}

function getToolNames(result: Awaited<ReturnType<Client['listTools']>>): string[] {
  return result.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
}

function getFirstText(result: unknown): string {
  assert.ok(result && typeof result === 'object', 'Expected tool result to be an object.');
  const resultObject = result as { content?: unknown };
  assert.ok(Array.isArray(resultObject.content), 'Expected tool result content to be an array.');
  const first = resultObject.content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, 'text');
  assert.equal(typeof first?.text, 'string');
  return first.text as string;
}

function createInvalidRuntimeModuleText(): string {
  return '\'use strict\';\nthrow new Error("broken runtime module");\n';
}

function assertTextIncludes(text: string, expected: string, label: string, ignoreCase = false): void {
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const needle = ignoreCase ? expected.toLowerCase() : expected;
  assert.ok(haystack.includes(needle), `Expected ${label} to include '${expected}'.\nActual text:\n${text}`);
}

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${String(timeoutMs)}ms while ${label}.`));
        }, timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function formatQgrepMatchLine(match: QgrepTextMatch): string {
  return `${String(match.line)}:    ${match.preview}`;
}

async function writeAutoStartWorkspaceFile(workspaceFile: string): Promise<void> {
  const parsed = JSON.parse(await fs.promises.readFile(workspaceFile, 'utf8')) as {
    folders?: unknown[];
    settings?: Record<string, unknown>;
  };
  const settings = parsed.settings ?? {};
  settings['lmToolsBridge.debug'] = 'off';
  parsed.settings = settings;
  await fs.promises.writeFile(workspaceFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

async function createAutoStartWorkspace(repoRoot: string): Promise<AutoStartWorkspace> {
  const fixtureSource = path.join(repoRoot, 'src', 'test', 'fixtures', 'multi-root');
  const rootDir = await makeTempDir('lm-tools-bridge-manager-it-');
  await copyDirectory(fixtureSource, rootDir);
  const workspaceFile = path.join(rootDir, 'multi-root.code-workspace');
  await writeAutoStartWorkspaceFile(workspaceFile);
  return {
    rootDir,
    workspaceFile,
    nestedCwd: path.join(rootDir, 'game', 'Source', 'GameRuntime', 'Private'),
  };
}

async function createCodeWrapper(args: {
  vscodeExecutablePath: string;
  extensionDevelopmentPath: string;
  isolatedDirs: { userDataDir: string; extensionsDir: string };
}): Promise<CodeWrapper> {
  const wrapperDir = await makeTempDir('lm-tools-bridge-code-wrapper-');
  const pidFile = path.join(wrapperDir, 'vscode.pid');
  const logFile = path.join(wrapperDir, 'launcher.log');
  const wrapperScriptPath = path.join(wrapperDir, 'code-wrapper.js');
  const wrapperCommandPath = path.join(wrapperDir, 'code.cmd');
  const wrapperSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const vscodeExecutablePath = ${JSON.stringify(args.vscodeExecutablePath)};`,
    `const pidFile = ${JSON.stringify(pidFile)};`,
    `const logFile = ${JSON.stringify(logFile)};`,
    `const fixedArgs = ${JSON.stringify([
      '--extensionDevelopmentPath',
      args.extensionDevelopmentPath,
      ...buildCommonVsCodeLaunchArgs(args.isolatedDirs),
    ])};`,
    'function appendLog(message) {',
    "  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\\n`, 'utf8');",
    '}',
    'appendLog(`wrapper args=${JSON.stringify(process.argv.slice(2))}`);',
    'const child = spawn(vscodeExecutablePath, [...process.argv.slice(2), ...fixedArgs], {',
    '  detached: true,',
    "  stdio: 'ignore',",
    '  windowsHide: true,',
    '  env: process.env,',
    '});',
    'child.once(\'error\', (error) => {',
    '  appendLog(`spawn error=${error instanceof Error ? error.stack ?? error.message : String(error)}`);',
    '  process.exitCode = 1;',
    '});',
    'child.once(\'spawn\', () => {',
    "  fs.writeFileSync(pidFile, String(child.pid), 'utf8');",
    '  appendLog(`spawned pid=${String(child.pid)}`);',
    '  child.unref();',
    '});',
  ].join('\n');
  await fs.promises.writeFile(wrapperScriptPath, wrapperSource, 'utf8');
  await fs.promises.writeFile(
    wrapperCommandPath,
    `@echo off\r\n"${process.execPath}" "%~dp0code-wrapper.js" %*\r\n`,
    'utf8',
  );
  return {
    wrapperDir,
    pidFile,
    logFile,
  };
}

async function connectStdioManager(managerEntryPath: string, extraEnv: Record<string, string>): Promise<ManagerConnection> {
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [managerEntryPath],
    env: {
      ...process.env,
      ...extraEnv,
    } as Record<string, string>,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderrChunks.push(chunk.toString());
  });

  const client = new Client(
    { name: 'stdio-manager-real-vscode-test', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    async close() {
      await withTimeout('closing stdio manager client', client.close(), 10_000).catch(async (error) => {
        if (process.platform === 'win32' && transport.pid) {
          await killProcessTree(transport.pid);
        }
        throw error;
      });
    },
    getStderr() {
      return stderrChunks.join('');
    },
  };
}

async function prepareSyncedManagerArtifacts(localAppDataDir: string): Promise<{
  managerPath: string;
  runtimePath: string;
  managersDir: string;
  managerContent: string;
  runtimeContent: string;
}> {
  const syncDir = path.join(localAppDataDir, STDIO_MANAGER_SYNC_DIRNAME);
  const managerPath = path.join(syncDir, 'stdioManager.js');
  const runtimePath = path.join(syncDir, 'stdioManagerRuntime.js');
  await fs.promises.mkdir(syncDir, { recursive: true });
  await fs.promises.copyFile(path.join(process.cwd(), 'out', 'stdioManager.js'), managerPath);
  await fs.promises.copyFile(path.join(process.cwd(), 'out', 'stdioManagerRuntime.js'), runtimePath);
  const managerContent = await fs.promises.readFile(managerPath, 'utf8');
  const runtimeContent = await fs.promises.readFile(runtimePath, 'utf8');
  await writeSyncMetadata({
    directory: syncDir,
    managerContent,
    runtimeContent,
    generation: 1,
    extensionVersion: getRepoPackageVersion(),
  });
  return {
    managerPath,
    runtimePath,
    managersDir: path.join(syncDir, 'managers'),
    managerContent,
    runtimeContent,
  };
}

async function writeSyncMetadata(args: {
  directory: string;
  managerContent: string;
  runtimeContent: string;
  generation: number;
  extensionVersion?: string;
}): Promise<void> {
  const payload = {
    generation: args.generation,
    extensionVersion: args.extensionVersion ?? '1.0.0',
    managerFileName: STDIO_MANAGER_SYNC_FILENAME,
    runtimeFileName: STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
    managerSha256: computeSha256(args.managerContent),
    runtimeSha256: computeSha256(args.runtimeContent),
    syncedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(args.directory, 'metadata.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
}

async function waitForRegistryEntry(managersDir: string, timeoutMs = 15000): Promise<ManagerRegistryEntry> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const entries = await fs.promises.readdir(managersDir);
      for (const entryName of entries) {
        if (!entryName.toLowerCase().endsWith('.json')) {
          continue;
        }
        const parsed = JSON.parse(
          await fs.promises.readFile(path.join(managersDir, entryName), 'utf8'),
        ) as Partial<ManagerRegistryEntry>;
        if (
          parsed.protocolVersion === 1
          && typeof parsed.sessionId === 'string'
          && typeof parsed.pid === 'number'
          && typeof parsed.startedAt === 'number'
          && typeof parsed.controlPipePath === 'string'
        ) {
          return parsed as ManagerRegistryEntry;
        }
      }
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for manager registry entry under '${managersDir}'.`);
}

async function sendGenerationChanged(controlPipePath: string, generation: number): Promise<GenerationChangedResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPipePath);
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for control-pipe response from '${controlPipePath}'.`));
    }, 3000);

    const finish = (response?: GenerationChangedResponse, error?: unknown) => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      if (!response) {
        reject(new Error(`Control pipe '${controlPipePath}' returned no response.`));
        return;
      }
      resolve(response);
    };

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({
        op: 'generationChanged',
        protocolVersion: 1,
        generation,
      })}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      try {
        const parsed = JSON.parse(buffer.slice(0, newlineIndex).trim()) as Partial<GenerationChangedResponse>;
        if (
          parsed.ok !== true
          || parsed.protocolVersion !== 1
          || typeof parsed.generationApplied !== 'number'
          || typeof parsed.bindingInvalidated !== 'boolean'
        ) {
          finish(undefined, new Error(`Invalid control-pipe response: ${JSON.stringify(parsed)}`));
          return;
        }
        finish(parsed as GenerationChangedResponse);
      } catch (error) {
        finish(undefined, error);
      }
    });

    socket.once('error', (error) => {
      finish(undefined, error);
    });

    socket.once('close', () => {
      if (buffer.length === 0) {
        finish(undefined, new Error(`Control pipe '${controlPipePath}' closed before responding.`));
      }
    });
  });
}

function getResourceText(result: Awaited<ReturnType<Client['readResource']>>): string {
  const first = result.contents[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

async function waitForPidFile(pidFile: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const text = (await fs.promises.readFile(pidFile, 'utf8')).trim();
      const pid = Number.parseInt(text, 10);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || process.platform !== 'win32') {
    return;
  }
  await new Promise<void>((resolve) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timeoutId = setTimeout(() => {
      child.kill();
      resolve();
    }, 15_000);
    timeoutId.unref?.();
    child.once('error', () => {
      clearTimeout(timeoutId);
      resolve();
    });
    child.once('exit', () => {
      clearTimeout(timeoutId);
      resolve();
    });
  });
}

function isBestEffortCleanupError(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError.code === 'EBUSY' || nodeError.code === 'ENOTEMPTY' || nodeError.code === 'EPERM';
}

async function removeDirectoryBestEffort(targetPath: string): Promise<void> {
  try {
    await removeDirectoryWithRetries(targetPath);
  } catch (error) {
    if (!isBestEffortCleanupError(error)) {
      throw error;
    }
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function collectExpectedTextMatches(rootDir: string, queries: readonly string[]): Promise<QgrepTextMatch[]> {
  const searchRoot = path.join(rootDir, 'game', 'Source', 'GameRuntime');
  const matches: QgrepTextMatch[] = [];
  const useCaseInsensitive = queries.every((query) => !/[A-Z]/u.test(query));
  const normalizedQueries = useCaseInsensitive ? queries.map((query) => query.toLowerCase()) : [...queries];

  async function visit(currentPath: string): Promise<void> {
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (extension !== '.h' && extension !== '.cpp') {
        continue;
      }
      const text = await fs.promises.readFile(entryPath, 'utf8');
      const lines = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const candidate = useCaseInsensitive ? line.toLowerCase() : line;
        if (!normalizedQueries.some((query) => candidate.includes(query))) {
          continue;
        }
        matches.push({
          workspacePath: `Game/${normalizePath(path.relative(path.join(rootDir, 'game'), entryPath))}`,
          absolutePath: normalizePath(path.resolve(entryPath)),
          line: index + 1,
          preview: line,
        });
      }
    }
  }

  await visit(searchRoot);
  matches.sort((left, right) => {
    const pathResult = left.workspacePath.localeCompare(right.workspacePath);
    if (pathResult !== 0) {
      return pathResult;
    }
    return left.line - right.line;
  });
  return matches;
}

test('stdio manager auto-starts real VS Code and proxies qgrep tools', {
  skip: process.platform !== 'win32',
  timeout: 300_000,
}, async () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pipeEnv = createPipeEnv('manager-it');
  const workspace = await createAutoStartWorkspace(repoRoot);
  const isolatedDirs = await createIsolatedVsCodeDirs('lm-tools-bridge-real');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-real-localappdata-');
  const syncedManager = await prepareSyncedManagerArtifacts(localAppDataDir);
  const vscodeExecutablePath = await getVSCodeExecutablePath();
  const wrapper = await createCodeWrapper({
    vscodeExecutablePath,
    extensionDevelopmentPath: repoRoot,
    isolatedDirs,
  });
  const expectedAvatarMatches = await collectExpectedTextMatches(workspace.rootDir, [TEXT_QUERY]);
  const expectedPipeMatches = await collectExpectedTextMatches(workspace.rootDir, [
    'AvatarCharacter',
    'AvatarHealthComponent',
  ]);
  const expectedSpacePipeMatches = await collectExpectedTextMatches(workspace.rootDir, [
    'AvatarSpacePipeLeft ',
    ' AvatarSpacePipeRight',
  ]);
  const expectedDroppedSpacePipeMatches = await collectExpectedTextMatches(workspace.rootDir, [
    'BrokenPipeSpaceDrop',
    'LiteralSpaceDrop',
  ]);
  const expectedFallbackPipeMatches = await collectExpectedTextMatches(workspace.rootDir, [TEXT_FALLBACK_PIPE_QUERY]);
  const expectedTargetFiles = [
    normalizePath(path.join(workspace.rootDir, 'game', 'Source', 'Game.Target.cs')),
    normalizePath(path.join(workspace.rootDir, 'game', 'Source', 'GameEditor.Target.cs')),
  ];
  let manager: ManagerConnection | undefined;
  let launchedPid: number | undefined;

  try {
    manager = await connectStdioManager(syncedManager.managerPath, {
      ...pipeEnv,
      PATH: `${wrapper.wrapperDir};${process.env.PATH ?? ''}`,
      LOCALAPPDATA: localAppDataDir,
      LM_TOOLS_BRIDGE_HANDSHAKE_WAIT_TIMEOUT_MS: String(HANDSHAKE_TIMEOUT_MS),
    });

    const toolsBeforeHandshake = getToolNames(await withTimeout(
      'listing tools before handshake',
      manager.client.listTools(),
      30_000,
    ));
    assert.deepEqual(
      toolsBeforeHandshake,
      [DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD].sort((left, right) => left.localeCompare(right)),
    );

    const handshake = await withTimeout('binding workspace for qgrep integration', manager.client.callTool({
      name: REQUEST_WORKSPACE_METHOD,
      arguments: {
        cwd: workspace.nestedCwd,
      },
    }), 180_000);
    const handshakePayload = handshake.structuredContent as {
      ok?: boolean;
      target?: {
        workspaceFile?: unknown;
      };
      discovery?: {
        bridgedTools?: Array<{ name?: unknown }>;
      };
    } | undefined;
    assert.equal(handshakePayload?.ok, true);
    assert.equal(
      normalizeWindowsComparablePath(String(handshakePayload?.target?.workspaceFile ?? '')),
      normalizeWindowsComparablePath(workspace.workspaceFile),
    );
    assert.ok(handshakePayload?.discovery, 'Expected handshake to include discovery metadata.');

    launchedPid = await waitForPidFile(wrapper.pidFile, 30_000);
    assert.ok(launchedPid, `Expected VS Code wrapper to record a PID. Wrapper log:\n${await readOptionalFile(wrapper.logFile)}`);

    const filesResult = await withTimeout('calling qgrep files through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_FILES_TOOL_NAME,
        arguments: {
          query: FILE_QUERY,
          maxResults: 20,
        },
      },
    }), 60_000);
    const filesText = getFirstText(filesResult);
    assertTextIncludes(filesText, 'Qgrep files', 'qgrep files summary');
    assertTextIncludes(filesText, `query: ${FILE_QUERY}`, 'qgrep files summary');
    assertTextIncludes(filesText, `count: ${String(expectedTargetFiles.length)}/${String(expectedTargetFiles.length)}`, 'qgrep files summary');
    for (const expectedFile of expectedTargetFiles) {
      assertTextIncludes(filesText, expectedFile, 'qgrep files summary', true);
    }

    const statusResult = await withTimeout('calling qgrep status through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_STATUS_TOOL_NAME,
        arguments: {},
      },
    }), 60_000);
    const statusText = getFirstText(statusResult);
    assertTextIncludes(statusText, 'Qgrep status', 'qgrep status summary');
    assertTextIncludes(statusText, 'binary: ok', 'qgrep status summary');
    assert.ok(
      /workspaces: total=2, initialized=2, watching=\d+/u.test(statusText),
      `Expected qgrep status summary to report 2 initialized workspaces.\nActual text:\n${statusText}`,
    );

    const textResult = await withTimeout('calling literal qgrep search through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_QUERY,
          pathScope: TEXT_PATH_SCOPE,
          maxResults: 300,
        },
      },
    }), 60_000);
    const textSummary = getFirstText(textResult);
    assertTextIncludes(textSummary, 'Qgrep search', 'qgrep search summary');
    assertTextIncludes(textSummary, `query: ${TEXT_QUERY}`, 'qgrep search summary');
    assertTextIncludes(textSummary, 'querySemanticsApplied: literal', 'qgrep search summary');
    assertTextIncludes(textSummary, 'case: smart-case/sensitive', 'qgrep search summary');
    assertTextIncludes(textSummary, `scope: ${TEXT_PATH_SCOPE}`, 'qgrep search summary');
    assertTextIncludes(
      textSummary,
      `count: ${String(expectedAvatarMatches.length)}/${String(expectedAvatarMatches.length)}`,
      'qgrep search summary',
    );
    for (const absolutePath of [...new Set(expectedAvatarMatches.map((match) => match.absolutePath))]) {
      assertTextIncludes(textSummary, absolutePath, 'qgrep search summary', true);
    }
    for (const match of expectedAvatarMatches.slice(0, 5)) {
      assertTextIncludes(textSummary, formatQgrepMatchLine(match), 'qgrep search summary');
    }

    const pipeTextResult = await withTimeout('calling union qgrep search through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_PIPE_QUERY,
          pathScope: TEXT_PATH_SCOPE,
          maxResults: 300,
        },
      },
    }), 60_000);
    const pipeTextSummary = getFirstText(pipeTextResult);
    assertTextIncludes(pipeTextSummary, 'Qgrep search', 'literal union qgrep search summary');
    assertTextIncludes(pipeTextSummary, `query: ${TEXT_PIPE_QUERY}`, 'literal union qgrep search summary');
    assertTextIncludes(pipeTextSummary, 'querySemanticsApplied: literal', 'literal union qgrep search summary');
    assertTextIncludes(pipeTextSummary, 'case: smart-case/sensitive', 'literal union qgrep search summary');
    assertTextIncludes(pipeTextSummary, `scope: ${TEXT_PATH_SCOPE}`, 'literal union qgrep search summary');
    assert.equal(
      pipeTextSummary.includes('queryHint:'),
      false,
      `Expected literal union qgrep search summary not to include query hints.\nActual text:\n${pipeTextSummary}`,
    );
    assertTextIncludes(
      pipeTextSummary,
      `count: ${String(expectedPipeMatches.length)}/${String(expectedPipeMatches.length)}`,
      'literal union qgrep search summary',
    );
    for (const absolutePath of [...new Set(expectedPipeMatches.map((match) => match.absolutePath))]) {
      assertTextIncludes(pipeTextSummary, absolutePath, 'literal union qgrep search summary', true);
    }
    for (const match of expectedPipeMatches.slice(0, 5)) {
      assertTextIncludes(pipeTextSummary, formatQgrepMatchLine(match), 'literal union qgrep search summary');
    }

    const spacePipeTextResult = await withTimeout('calling whitespace union qgrep search through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_SPACE_PIPE_QUERY,
          pathScope: TEXT_PATH_SCOPE,
          maxResults: 300,
        },
      },
    }), 60_000);
    const spacePipeTextSummary = getFirstText(spacePipeTextResult);
    assertTextIncludes(spacePipeTextSummary, 'Qgrep search', 'whitespace literal union qgrep search summary');
    assertTextIncludes(spacePipeTextSummary, `query: ${TEXT_SPACE_PIPE_QUERY}`, 'whitespace literal union qgrep search summary');
    assertTextIncludes(spacePipeTextSummary, 'querySemanticsApplied: literal', 'whitespace literal union qgrep search summary');
    assertTextIncludes(spacePipeTextSummary, 'case: smart-case/sensitive', 'whitespace literal union qgrep search summary');
    assertTextIncludes(spacePipeTextSummary, `scope: ${TEXT_PATH_SCOPE}`, 'whitespace literal union qgrep search summary');
    assert.equal(
      spacePipeTextSummary.includes('queryHint:'),
      false,
      `Expected whitespace literal union qgrep search summary not to include query hints.\nActual text:\n${spacePipeTextSummary}`,
    );
    assertTextIncludes(
      spacePipeTextSummary,
      `count: ${String(expectedSpacePipeMatches.length)}/${String(expectedSpacePipeMatches.length)}`,
      'whitespace literal union qgrep search summary',
    );
    for (const absolutePath of [...new Set(expectedSpacePipeMatches.map((match) => match.absolutePath))]) {
      assertTextIncludes(spacePipeTextSummary, absolutePath, 'whitespace literal union qgrep search summary', true);
    }
    for (const match of expectedSpacePipeMatches.slice(0, 5)) {
      assertTextIncludes(spacePipeTextSummary, formatQgrepMatchLine(match), 'whitespace literal union qgrep search summary');
    }

    const droppedSpacePipeTextResult = await withTimeout('calling dropped-branch qgrep search through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_DROPPED_SPACE_PIPE_QUERY,
          pathScope: TEXT_PATH_SCOPE,
          maxResults: 300,
        },
      },
    }), 60_000);
    const droppedSpacePipeTextSummary = getFirstText(droppedSpacePipeTextResult);
    assertTextIncludes(droppedSpacePipeTextSummary, 'Qgrep search', 'dropped whitespace pipe qgrep search summary');
    assertTextIncludes(droppedSpacePipeTextSummary, `query: ${TEXT_DROPPED_SPACE_PIPE_QUERY}`, 'dropped whitespace pipe qgrep search summary');
    assertTextIncludes(droppedSpacePipeTextSummary, 'querySemanticsApplied: literal', 'dropped whitespace pipe qgrep search summary');
    assertTextIncludes(droppedSpacePipeTextSummary, 'case: smart-case/sensitive', 'dropped whitespace pipe qgrep search summary');
    assertTextIncludes(droppedSpacePipeTextSummary, `scope: ${TEXT_PATH_SCOPE}`, 'dropped whitespace pipe qgrep search summary');
    assertTextIncludes(
      droppedSpacePipeTextSummary,
      `queryHint: ${QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED}`,
      'dropped whitespace pipe qgrep search summary',
    );
    assertTextIncludes(
      droppedSpacePipeTextSummary,
      `count: ${String(expectedDroppedSpacePipeMatches.length)}/${String(expectedDroppedSpacePipeMatches.length)}`,
      'dropped whitespace pipe qgrep search summary',
    );
    for (const absolutePath of [...new Set(expectedDroppedSpacePipeMatches.map((match) => match.absolutePath))]) {
      assertTextIncludes(droppedSpacePipeTextSummary, absolutePath, 'dropped whitespace pipe qgrep search summary', true);
    }
    for (const match of expectedDroppedSpacePipeMatches.slice(0, 5)) {
      assertTextIncludes(droppedSpacePipeTextSummary, formatQgrepMatchLine(match), 'dropped whitespace pipe qgrep search summary');
    }

    const fallbackPipeTextResult = await withTimeout('calling fallback qgrep search through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_FALLBACK_PIPE_QUERY,
          pathScope: TEXT_PATH_SCOPE,
          maxResults: 300,
        },
      },
    }), 60_000);
    const fallbackPipeTextSummary = getFirstText(fallbackPipeTextResult);
    assertTextIncludes(fallbackPipeTextSummary, 'Qgrep search', 'literal fallback qgrep search summary');
    assertTextIncludes(fallbackPipeTextSummary, `query: ${TEXT_FALLBACK_PIPE_QUERY}`, 'literal fallback qgrep search summary');
    assertTextIncludes(fallbackPipeTextSummary, 'querySemanticsApplied: literal-fallback', 'literal fallback qgrep search summary');
    assertTextIncludes(fallbackPipeTextSummary, 'case: smart-case/sensitive', 'literal fallback qgrep search summary');
    assertTextIncludes(fallbackPipeTextSummary, `scope: ${TEXT_PATH_SCOPE}`, 'literal fallback qgrep search summary');
    assertTextIncludes(
      fallbackPipeTextSummary,
      `queryHint: ${QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK}`,
      'literal fallback qgrep search summary',
    );
    assertTextIncludes(
      fallbackPipeTextSummary,
      `count: ${String(expectedFallbackPipeMatches.length)}/${String(expectedFallbackPipeMatches.length)}`,
      'literal fallback qgrep search summary',
    );
    for (const absolutePath of [...new Set(expectedFallbackPipeMatches.map((match) => match.absolutePath))]) {
      assertTextIncludes(fallbackPipeTextSummary, absolutePath, 'literal fallback qgrep search summary', true);
    }
    for (const match of expectedFallbackPipeMatches.slice(0, 5)) {
      assertTextIncludes(fallbackPipeTextSummary, formatQgrepMatchLine(match), 'literal fallback qgrep search summary');
    }

    const contextClampTextResult = await withTimeout('calling context-clamped qgrep search through bridged tool', manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_QUERY,
          pathScope: TEXT_PATH_SCOPE,
          beforeContextLines: TEXT_CONTEXT_CLAMP_BEFORE,
          afterContextLines: TEXT_CONTEXT_CLAMP_AFTER,
          maxResults: 300,
        },
      },
    }), 60_000);
    const contextClampTextSummary = getFirstText(contextClampTextResult);
    assertTextIncludes(contextClampTextSummary, 'Qgrep search', 'context clamp qgrep search summary');
    assertTextIncludes(contextClampTextSummary, 'context: before=50, after=8', 'context clamp qgrep search summary');
    assertTextIncludes(
      contextClampTextSummary,
      'contextRequested: before=80, after=8 (capped to 50)',
      'context clamp qgrep search summary',
    );

  } catch (error) {
    const diagnostics = [
      manager ? `Manager stderr:\n${manager.getStderr().trim() || '<empty>'}` : '',
      `Wrapper log:\n${await readOptionalFile(wrapper.logFile).then((value) => value.trim() || '<empty>')}`,
    ].filter((entry) => entry.length > 0).join('\n\n');
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${message}\n\n${diagnostics}`);
  } finally {
    if (manager) {
      await withTimeout(
        'closing manager after qgrep integration test',
        manager.close().catch(() => undefined),
        15_000,
      ).catch(() => undefined);
    }
    await killProcessTree(launchedPid ?? await waitForPidFile(wrapper.pidFile, 2_000));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await removeDirectoryBestEffort(wrapper.wrapperDir);
    await removeDirectoryBestEffort(isolatedDirs.userDataDir);
    await removeDirectoryBestEffort(isolatedDirs.extensionsDir);
    await removeDirectoryBestEffort(localAppDataDir);
    await removeDirectoryBestEffort(workspace.rootDir);
  }
});

test('stdio manager applies notified and lazy runtime generations without reconnecting stdio transport', {
  skip: process.platform !== 'win32',
  timeout: 300_000,
}, async () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const pipeEnv = createPipeEnv('manager-generation-it');
  const workspace = await createAutoStartWorkspace(repoRoot);
  const isolatedDirs = await createIsolatedVsCodeDirs('lm-tools-bridge-generation');
  const localAppDataDir = await makeTempDir('lm-tools-bridge-generation-localappdata-');
  const syncedManager = await prepareSyncedManagerArtifacts(localAppDataDir);
  const vscodeExecutablePath = await getVSCodeExecutablePath();
  const wrapper = await createCodeWrapper({
    vscodeExecutablePath,
    extensionDevelopmentPath: repoRoot,
    isolatedDirs,
  });
  let manager: ManagerConnection | undefined;
  let launchedPid: number | undefined;

  try {
    manager = await connectStdioManager(syncedManager.managerPath, {
      ...pipeEnv,
      PATH: `${wrapper.wrapperDir};${process.env.PATH ?? ''}`,
      LOCALAPPDATA: localAppDataDir,
      LM_TOOLS_BRIDGE_HANDSHAKE_WAIT_TIMEOUT_MS: String(HANDSHAKE_TIMEOUT_MS),
    });

    await withTimeout('binding workspace before generation cutover test', manager.client.callTool({
      name: REQUEST_WORKSPACE_METHOD,
      arguments: {
        cwd: workspace.nestedCwd,
      },
    }), 180_000);

    launchedPid = await withTimeout(
      'waiting for VS Code wrapper pid file',
      waitForPidFile(wrapper.pidFile, 30_000),
      35_000,
    );
    assert.ok(launchedPid, `Expected VS Code wrapper to record a PID. Wrapper log:\n${await readOptionalFile(wrapper.logFile)}`);

    const guideBeforeCutover = await withTimeout('reading guide before generation cutover', manager.client.readResource({
      uri: GUIDE_RESOURCE_URI,
    }), 30_000);
    assert.match(getResourceText(guideBeforeCutover), /Workspace bridge guide/u);

    const registry = await withTimeout(
      'waiting for stdio manager registry entry',
      waitForRegistryEntry(syncedManager.managersDir),
      20_000,
    );
    const notifiedRuntimeText = syncedManager.runtimeContent.replace(
      'Workspace bridge guide',
      'Workspace bridge guide manager integration',
    );
    await fs.promises.writeFile(syncedManager.runtimePath, notifiedRuntimeText, 'utf8');
    await writeSyncMetadata({
      directory: path.dirname(syncedManager.managerPath),
      managerContent: syncedManager.managerContent,
      runtimeContent: notifiedRuntimeText,
      generation: 2,
      extensionVersion: getRepoPackageVersion(),
    });

    const notifiedResponse = await withTimeout(
      'sending notified generation change',
      sendGenerationChanged(registry.controlPipePath, 2),
      10_000,
    );
    assert.equal(notifiedResponse.generationApplied, 2);
    assert.equal(notifiedResponse.bindingInvalidated, true);

    const guideAfterNotify = await withTimeout('reading guide after notified cutover', manager.client.readResource({
      uri: GUIDE_RESOURCE_URI,
    }), 30_000);
    assert.match(getResourceText(guideAfterNotify), /Workspace bridge guide manager integration/u);

    const toolsAfterNotify = getToolNames(await withTimeout(
      'listing tools after notified cutover',
      manager.client.listTools(),
      30_000,
    ));
    assert.deepEqual(
      toolsAfterNotify,
      [DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD].sort((left, right) => left.localeCompare(right)),
    );

    const lazyRuntimeText = notifiedRuntimeText.replace(
      'Workspace bridge guide manager integration',
      'Workspace bridge guide manager integration lazy',
    );
    await fs.promises.writeFile(syncedManager.runtimePath, lazyRuntimeText, 'utf8');
    await writeSyncMetadata({
      directory: path.dirname(syncedManager.managerPath),
      managerContent: syncedManager.managerContent,
      runtimeContent: lazyRuntimeText,
      generation: 3,
      extensionVersion: getRepoPackageVersion(),
    });

    const guideAfterLazyCutover = await withTimeout('reading guide after lazy cutover', manager.client.readResource({
      uri: GUIDE_RESOURCE_URI,
    }), 30_000);
    assert.match(getResourceText(guideAfterLazyCutover), /Workspace bridge guide manager integration lazy/u);
    await withTimeout('rebinding after lazy cutover before broken-runtime test', manager.client.callTool({
      name: REQUEST_WORKSPACE_METHOD,
      arguments: {
        cwd: workspace.nestedCwd,
      },
    }), 180_000);

    const brokenRuntimeText = createInvalidRuntimeModuleText();
    await fs.promises.writeFile(syncedManager.runtimePath, brokenRuntimeText, 'utf8');
    await writeSyncMetadata({
      directory: path.dirname(syncedManager.managerPath),
      managerContent: syncedManager.managerContent,
      runtimeContent: brokenRuntimeText,
      generation: 4,
      extensionVersion: getRepoPackageVersion(),
    });

    const failedResponse = await withTimeout(
      'sending broken-runtime generation change',
      sendGenerationChanged(registry.controlPipePath, 4),
      10_000,
    );
    assert.equal(failedResponse.generationApplied, 3);
    assert.equal(failedResponse.bindingInvalidated, false);

    const connectedManager = manager;
    assert.ok(connectedManager, 'Expected manager connection to stay alive.');
    const guideWhileReloadFailed = await withTimeout('reading guide while runtime reload failed', connectedManager.client.readResource({
      uri: GUIDE_RESOURCE_URI,
    }), 30_000);
    assert.match(getResourceText(guideWhileReloadFailed), /Workspace bridge guide manager integration lazy/u);

    const recoveredRuntimeText = lazyRuntimeText.replace(
      'Workspace bridge guide manager integration lazy',
      'Workspace bridge guide manager integration recovered',
    );
    await fs.promises.writeFile(syncedManager.runtimePath, recoveredRuntimeText, 'utf8');

    await withTimeout('rebinding after runtime recovery', manager.client.callTool({
      name: REQUEST_WORKSPACE_METHOD,
      arguments: {
        cwd: workspace.nestedCwd,
      },
    }), 180_000);
    const guideAfterRecovery = await withTimeout('reading guide after runtime recovery', manager.client.readResource({
      uri: GUIDE_RESOURCE_URI,
    }), 30_000);
    assert.match(getResourceText(guideAfterRecovery), /Workspace bridge guide manager integration recovered/u);
  } catch (error) {
    const diagnostics = [
      manager ? `Manager stderr:\n${manager.getStderr().trim() || '<empty>'}` : '',
      `Wrapper log:\n${await readOptionalFile(wrapper.logFile).then((value) => value.trim() || '<empty>')}`,
    ].filter((entry) => entry.length > 0).join('\n\n');
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${message}\n\n${diagnostics}`);
  } finally {
    if (manager) {
      await withTimeout(
        'closing manager after generation cutover test',
        manager.close().catch(() => undefined),
        15_000,
      ).catch(() => undefined);
    }
    await killProcessTree(launchedPid ?? await waitForPidFile(wrapper.pidFile, 2_000));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await removeDirectoryBestEffort(wrapper.wrapperDir);
    await removeDirectoryBestEffort(isolatedDirs.userDataDir);
    await removeDirectoryBestEffort(isolatedDirs.extensionsDir);
    await removeDirectoryBestEffort(localAppDataDir);
    await removeDirectoryBestEffort(workspace.rootDir);
  }
});
