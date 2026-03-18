import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildCommonVsCodeLaunchArgs,
  copyDirectory,
  createIsolatedVsCodeDirs,
  getVSCodeExecutablePath,
  makeTempDir,
  removeDirectoryWithRetries,
} from '../integration/vscodeTestUtils';

const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.requestWorkspaceMCPServer';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callTool';
const QGREP_STATUS_TOOL_NAME = 'lm_qgrepGetStatus';
const QGREP_TEXT_TOOL_NAME = 'lm_qgrepSearchText';
const QGREP_FILES_TOOL_NAME = 'lm_qgrepSearchFiles';
const HANDSHAKE_TIMEOUT_MS = 180_000;
const FILE_QUERY = 'Game/Source/**/*.Target.cs';
const TEXT_QUERY = 'AvatarCharacter';
const TEXT_PIPE_QUERY = 'AvatarCharacter|AvatarHealthComponent';
const TEXT_PIPE_EFFECTIVE_QUERY = '{AvatarCharacter,AvatarHealthComponent}';
const TEXT_INCLUDE_PATTERN = 'Game/Source/GameRuntime/**/*.{h,cpp}';

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

function assertTextIncludes(text: string, expected: string, label: string, ignoreCase = false): void {
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const needle = ignoreCase ? expected.toLowerCase() : expected;
  assert.ok(haystack.includes(needle), `Expected ${label} to include '${expected}'.\nActual text:\n${text}`);
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

async function connectStdioManager(extraEnv: Record<string, string>): Promise<ManagerConnection> {
  const stderrChunks: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), 'out', 'stdioManager.js')],
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
      await client.close();
    },
    getStderr() {
      return stderrChunks.join('');
    },
  };
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
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
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
  const expectedTargetFiles = [
    normalizePath(path.join(workspace.rootDir, 'game', 'Source', 'Game.Target.cs')),
    normalizePath(path.join(workspace.rootDir, 'game', 'Source', 'GameEditor.Target.cs')),
  ];
  let manager: ManagerConnection | undefined;
  let launchedPid: number | undefined;

  try {
    manager = await connectStdioManager({
      ...pipeEnv,
      PATH: `${wrapper.wrapperDir};${process.env.PATH ?? ''}`,
      LOCALAPPDATA: localAppDataDir,
      LM_TOOLS_BRIDGE_HANDSHAKE_WAIT_TIMEOUT_MS: String(HANDSHAKE_TIMEOUT_MS),
    });

    const toolsBeforeHandshake = getToolNames(await manager.client.listTools());
    assert.deepEqual(toolsBeforeHandshake, [DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD]);

    const handshake = await manager.client.callTool({
      name: REQUEST_WORKSPACE_METHOD,
      arguments: {
        cwd: workspace.nestedCwd,
      },
    });
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

    const filesResult = await manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_FILES_TOOL_NAME,
        arguments: {
          query: FILE_QUERY,
          maxResults: 20,
        },
      },
    });
    const filesText = getFirstText(filesResult);
    assertTextIncludes(filesText, 'Qgrep files', 'qgrep files summary');
    assertTextIncludes(filesText, `query: ${FILE_QUERY}`, 'qgrep files summary');
    assertTextIncludes(filesText, `count: ${String(expectedTargetFiles.length)}/${String(expectedTargetFiles.length)}`, 'qgrep files summary');
    for (const expectedFile of expectedTargetFiles) {
      assertTextIncludes(filesText, expectedFile, 'qgrep files summary', true);
    }

    const statusResult = await manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_STATUS_TOOL_NAME,
        arguments: {},
      },
    });
    const statusText = getFirstText(statusResult);
    assertTextIncludes(statusText, 'Qgrep status', 'qgrep status summary');
    assertTextIncludes(statusText, 'binary: ok', 'qgrep status summary');
    assert.ok(
      /workspaces: total=2, initialized=2, watching=\d+/u.test(statusText),
      `Expected qgrep status summary to report 2 initialized workspaces.\nActual text:\n${statusText}`,
    );

    const textResult = await manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_QUERY,
          includePattern: TEXT_INCLUDE_PATTERN,
          maxResults: 300,
        },
      },
    });
    const textSummary = getFirstText(textResult);
    assertTextIncludes(textSummary, 'Qgrep search', 'qgrep search summary');
    assertTextIncludes(textSummary, `query: ${TEXT_QUERY}`, 'qgrep search summary');
    assertTextIncludes(textSummary, 'querySemanticsApplied: glob', 'qgrep search summary');
    assertTextIncludes(textSummary, 'case: smart-case/sensitive', 'qgrep search summary');
    assertTextIncludes(textSummary, `scope: ${TEXT_INCLUDE_PATTERN}`, 'qgrep search summary');
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

    const pipeTextResult = await manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: QGREP_TEXT_TOOL_NAME,
        arguments: {
          query: TEXT_PIPE_QUERY,
          includePattern: TEXT_INCLUDE_PATTERN,
          maxResults: 300,
        },
      },
    });
    const pipeTextSummary = getFirstText(pipeTextResult);
    assertTextIncludes(pipeTextSummary, 'Qgrep search', 'normalized qgrep search summary');
    assertTextIncludes(pipeTextSummary, `query: ${TEXT_PIPE_QUERY}`, 'normalized qgrep search summary');
    assertTextIncludes(
      pipeTextSummary,
      `query was implicitly converted from '${TEXT_PIPE_QUERY}' to '${TEXT_PIPE_EFFECTIVE_QUERY}' because querySyntax='glob'.`,
      'normalized qgrep search summary',
    );
    assertTextIncludes(
      pipeTextSummary,
      `effectiveQuery: ${TEXT_PIPE_EFFECTIVE_QUERY}`,
      'normalized qgrep search summary',
    );
    assertTextIncludes(pipeTextSummary, 'querySemanticsApplied: glob', 'normalized qgrep search summary');
    assertTextIncludes(pipeTextSummary, 'case: smart-case/sensitive', 'normalized qgrep search summary');
    assertTextIncludes(pipeTextSummary, `scope: ${TEXT_INCLUDE_PATTERN}`, 'normalized qgrep search summary');
    assertTextIncludes(
      pipeTextSummary,
      `count: ${String(expectedPipeMatches.length)}/${String(expectedPipeMatches.length)}`,
      'normalized qgrep search summary',
    );
    for (const absolutePath of [...new Set(expectedPipeMatches.map((match) => match.absolutePath))]) {
      assertTextIncludes(pipeTextSummary, absolutePath, 'normalized qgrep search summary', true);
    }
    for (const match of expectedPipeMatches.slice(0, 5)) {
      assertTextIncludes(pipeTextSummary, formatQgrepMatchLine(match), 'normalized qgrep search summary');
    }
  } catch (error) {
    const diagnostics = [
      manager ? `Manager stderr:\n${manager.getStderr().trim() || '<empty>'}` : '',
      `Wrapper log:\n${await readOptionalFile(wrapper.logFile).then((value) => value.trim() || '<empty>')}`,
    ].filter((entry) => entry.length > 0).join('\n\n');
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${message}\n\n${diagnostics}`);
  } finally {
    if (manager) {
      await manager.close().catch(() => undefined);
    }
    await killProcessTree(launchedPid ?? await waitForPidFile(wrapper.pidFile, 2_000));
    await removeDirectoryWithRetries(wrapper.wrapperDir);
    await removeDirectoryWithRetries(isolatedDirs.userDataDir);
    await removeDirectoryWithRetries(isolatedDirs.extensionsDir);
    await removeDirectoryWithRetries(localAppDataDir);
    await removeDirectoryWithRetries(workspace.rootDir);
  }
});
