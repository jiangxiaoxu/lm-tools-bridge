import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  computeSha256,
  STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
  STDIO_MANAGER_SYNC_FILENAME,
} from '../stdioManagerSync';
import {
  resolveWorkspaceDiscoveryTargetFromWindow,
  WorkspaceDiscoveryPublisher,
} from '../workspaceDiscovery';

const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.bindWorkspace';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callBridgedTool';
const GUIDE_RESOURCE_URI = 'lm-tools://guide';
const ECHO_TOOL_NAME = 'lm_testEcho';

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

async function makeTempDir(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createPipeEnv(prefixSeed: string): Record<string, string> {
  const seed = `${prefixSeed}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    .replace(/[^a-z0-9._-]/giu, '_');
  return {
    LM_TOOLS_BRIDGE_DISCOVERY_PIPE_PREFIX: `lm-tools-bridge-test.discovery.${seed}.`,
    LM_TOOLS_BRIDGE_LAUNCH_LOCK_PIPE_PREFIX: `lm-tools-bridge-test.lock.${seed}.`,
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function respondJson(res: http.ServerResponse, payload: unknown): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function startFakeWorkspaceServer(args: {
  pipeEnv: Record<string, string>;
  workspaceFolders: string[];
  toolsListDelayMs?: number;
  resourceReadDelayMs?: number;
  toolCallDelayMs?: number;
}) {
  const target = resolveWorkspaceDiscoveryTargetFromWindow(
    args.workspaceFolders,
    undefined,
    { env: args.pipeEnv },
  );
  assert.ok(target && !('code' in target), 'Expected a supported discovery target.');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/mcp/health') {
      respondJson(res, { ok: true });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const message = await readJsonBody(req) as { id?: unknown; method?: string; params?: Record<string, unknown> };
    const id = message?.id ?? null;
    if (message?.method === 'tools/list') {
      if ((args.toolsListDelayMs ?? 0) > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, args.toolsListDelayMs);
        });
      }
      respondJson(res, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: ECHO_TOOL_NAME,
              description: 'Echo back the provided value.',
              inputSchema: {
                type: 'object',
                properties: {
                  value: { type: 'string' },
                },
              },
            },
          ],
        },
      });
      return;
    }
    if (message?.method === 'resources/read' && message.params?.uri === `lm-tools://tool/${ECHO_TOOL_NAME}`) {
      if ((args.resourceReadDelayMs ?? 0) > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, args.resourceReadDelayMs);
        });
      }
      respondJson(res, {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: `lm-tools://tool/${ECHO_TOOL_NAME}`,
              mimeType: 'application/json',
              text: JSON.stringify({
                name: ECHO_TOOL_NAME,
                description: 'Echo back the provided value.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    value: { type: 'string' },
                  },
                },
              }),
            },
          ],
        },
      });
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name === ECHO_TOOL_NAME) {
      if ((args.toolCallDelayMs ?? 0) > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, args.toolCallDelayMs);
        });
      }
      const value = typeof message.params?.arguments === 'object' && message.params.arguments !== null
        ? (message.params.arguments as { value?: unknown }).value
        : undefined;
      respondJson(res, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `echo:${String(value ?? '')}`,
            },
          ],
          structuredContent: {
            value,
          },
        },
      });
      return;
    }
    respondJson(res, {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${String(message?.method ?? '')}`,
      },
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address === 'object');

  const publisher = new WorkspaceDiscoveryPublisher({
    serverSessionId: `workspace-session-${process.pid}-${address.port}`,
    getAdvertisement: () => ({
      target,
      host: '127.0.0.1',
      port: address.port,
    }),
  });
  await publisher.start();

  return {
    async stop() {
      await publisher.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function createInvalidRuntimeModuleText(): string {
  return '\'use strict\';\nthrow new Error("broken runtime module");\n';
}

async function connectStdioManager(managerEntryPath: string, extraEnv?: Record<string, string>) {
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
    { name: 'stdio-manager-runtime-reload-test', version: '1.0.0' },
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

function getResourceText(result: Awaited<ReturnType<Client['readResource']>>): string {
  const first = result.contents[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

function getToolNames(result: Awaited<ReturnType<Client['listTools']>>): string[] {
  return result.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
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

async function waitForRegistryEntry(managersDir: string, timeoutMs = 15000): Promise<{ filePath: string; entry: ManagerRegistryEntry }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const entries = await fs.promises.readdir(managersDir);
      for (const entryName of entries) {
        if (!entryName.toLowerCase().endsWith('.json')) {
          continue;
        }
        const filePath = path.join(managersDir, entryName);
        const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Partial<ManagerRegistryEntry>;
        if (
          parsed.protocolVersion === 1
          && typeof parsed.sessionId === 'string'
          && typeof parsed.pid === 'number'
          && typeof parsed.startedAt === 'number'
          && typeof parsed.controlPipePath === 'string'
        ) {
          return {
            filePath,
            entry: parsed as ManagerRegistryEntry,
          };
        }
      }
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for manager registry entry under '${managersDir}'.`);
}

async function waitForMissingFile(filePath: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await fs.promises.access(filePath);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for file to disappear: ${filePath}`);
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

test('stdio manager invalidates binding on control notification and requires rebind', async (t) => {
  const pipeEnv = createPipeEnv('runtime-reload');
  const rootDir = await makeTempDir('lm-tools-bridge-runtime-reload-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const runtimeDir = path.join(rootDir, 'manager');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  const managersDir = path.join(runtimeDir, 'managers');
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  const sourceManagerPath = path.join(process.cwd(), 'out', 'stdioManager.js');
  const sourceRuntimePath = path.join(process.cwd(), 'out', 'stdioManagerRuntime.js');
  const copiedManagerPath = path.join(runtimeDir, 'stdioManager.js');
  const copiedRuntimePath = path.join(runtimeDir, 'stdioManagerRuntime.js');
  await fs.promises.copyFile(sourceManagerPath, copiedManagerPath);
  await fs.promises.copyFile(sourceRuntimePath, copiedRuntimePath);
  const copiedManagerText = await fs.promises.readFile(copiedManagerPath, 'utf8');
  const originalRuntimeText = await fs.promises.readFile(copiedRuntimePath, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: originalRuntimeText,
    generation: 1,
  });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
  });
  const manager = await connectStdioManager(copiedManagerPath, pipeEnv);

  t.after(async () => {
    await manager.close().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const registry = await waitForRegistryEntry(managersDir);
  assert.equal(registry.entry.protocolVersion, 1);

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  const beforeReload = await manager.client.readResource({
    uri: GUIDE_RESOURCE_URI,
  });
  assert.match(getResourceText(beforeReload), /Workspace bridge guide/u);

  const reloadedRuntimeText = originalRuntimeText.replace(
    'Workspace bridge guide',
    'Workspace bridge guide reloaded',
  );
  assert.notEqual(reloadedRuntimeText, originalRuntimeText);
  await fs.promises.writeFile(copiedRuntimePath, reloadedRuntimeText, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: reloadedRuntimeText,
    generation: 2,
  });

  const controlResponse = await sendGenerationChanged(registry.entry.controlPipePath, 2);
  assert.equal(controlResponse.generationApplied, 2);
  assert.equal(controlResponse.bindingInvalidated, true);

  const afterReload = await manager.client.readResource({
    uri: GUIDE_RESOURCE_URI,
  });
  assert.match(getResourceText(afterReload), /Workspace bridge guide reloaded/u);

  const toolsAfterReload = await manager.client.listTools();
  assert.deepEqual(getToolNames(toolsAfterReload), [DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD].sort((left, right) => left.localeCompare(right)));

  await assert.rejects(
    () => manager.client.callTool({
      name: ECHO_TOOL_NAME,
      arguments: {
        value: 'stale-bind',
      },
    }),
    /Workspace not matched\..*Next step: call lmToolsBridge\.bindWorkspace/u,
  );

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  const reboundCall = await manager.client.callTool({
    name: ECHO_TOOL_NAME,
    arguments: {
      value: 'after-rebind',
    },
  });
  assert.equal((reboundCall.structuredContent as { value?: string }).value, 'after-rebind');
});

test('stdio manager rejects a bind that races with a generation cutover', async (t) => {
  const pipeEnv = createPipeEnv('runtime-bind-race');
  const rootDir = await makeTempDir('lm-tools-bridge-runtime-race-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const runtimeDir = path.join(rootDir, 'manager');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  const managersDir = path.join(runtimeDir, 'managers');
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  const sourceManagerPath = path.join(process.cwd(), 'out', 'stdioManager.js');
  const sourceRuntimePath = path.join(process.cwd(), 'out', 'stdioManagerRuntime.js');
  const copiedManagerPath = path.join(runtimeDir, 'stdioManager.js');
  const copiedRuntimePath = path.join(runtimeDir, 'stdioManagerRuntime.js');
  await fs.promises.copyFile(sourceManagerPath, copiedManagerPath);
  await fs.promises.copyFile(sourceRuntimePath, copiedRuntimePath);
  const copiedManagerText = await fs.promises.readFile(copiedManagerPath, 'utf8');
  const originalRuntimeText = await fs.promises.readFile(copiedRuntimePath, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: originalRuntimeText,
    generation: 1,
  });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
    toolsListDelayMs: 1000,
  });
  const manager = await connectStdioManager(copiedManagerPath, pipeEnv);

  t.after(async () => {
    await manager.close().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const registry = await waitForRegistryEntry(managersDir);
  const bindPromise = manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });

  const reloadedRuntimeText = originalRuntimeText.replace(
    'Workspace bridge guide',
    'Workspace bridge guide bind-race',
  );
  await fs.promises.writeFile(copiedRuntimePath, reloadedRuntimeText, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: reloadedRuntimeText,
    generation: 2,
  });

  await sendGenerationChanged(registry.entry.controlPipePath, 2);

  await assert.rejects(
    async () => bindPromise,
    /Workspace not matched\..*Next step: call lmToolsBridge\.bindWorkspace/u,
  );

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });
  const reboundCall = await manager.client.callTool({
    name: ECHO_TOOL_NAME,
    arguments: {
      value: 'bind-race-recovered',
    },
  });
  assert.equal((reboundCall.structuredContent as { value?: string }).value, 'bind-race-recovered');
});

test('stdio manager rejects a bridged tool call that races with a generation cutover', async (t) => {
  const pipeEnv = createPipeEnv('runtime-tool-call-race');
  const rootDir = await makeTempDir('lm-tools-bridge-runtime-tool-call-race-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const runtimeDir = path.join(rootDir, 'manager');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  const managersDir = path.join(runtimeDir, 'managers');
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  const sourceManagerPath = path.join(process.cwd(), 'out', 'stdioManager.js');
  const sourceRuntimePath = path.join(process.cwd(), 'out', 'stdioManagerRuntime.js');
  const copiedManagerPath = path.join(runtimeDir, 'stdioManager.js');
  const copiedRuntimePath = path.join(runtimeDir, 'stdioManagerRuntime.js');
  await fs.promises.copyFile(sourceManagerPath, copiedManagerPath);
  await fs.promises.copyFile(sourceRuntimePath, copiedRuntimePath);
  const copiedManagerText = await fs.promises.readFile(copiedManagerPath, 'utf8');
  const originalRuntimeText = await fs.promises.readFile(copiedRuntimePath, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: originalRuntimeText,
    generation: 1,
  });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
    toolCallDelayMs: 1000,
  });
  const manager = await connectStdioManager(copiedManagerPath, pipeEnv);

  t.after(async () => {
    await manager.close().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const registry = await waitForRegistryEntry(managersDir);
  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  const toolCallPromise = manager.client.callTool({
    name: ECHO_TOOL_NAME,
    arguments: {
      value: 'cutover-race',
    },
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });

  const reloadedRuntimeText = originalRuntimeText.replace(
    'Workspace bridge guide',
    'Workspace bridge guide tool-call-race',
  );
  await fs.promises.writeFile(copiedRuntimePath, reloadedRuntimeText, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: reloadedRuntimeText,
    generation: 2,
  });

  await sendGenerationChanged(registry.entry.controlPipePath, 2);

  await assert.rejects(
    () => toolCallPromise,
    /Workspace not matched\..*Next step: call lmToolsBridge\.bindWorkspace/u,
  );

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });
  const reboundCall = await manager.client.callTool({
    name: ECHO_TOOL_NAME,
    arguments: {
      value: 'tool-call-race-recovered',
    },
  });
  assert.equal((reboundCall.structuredContent as { value?: string }).value, 'tool-call-race-recovered');
});

test('stdio manager rejects a bridged resource read that races with a generation cutover', async (t) => {
  const pipeEnv = createPipeEnv('runtime-resource-read-race');
  const rootDir = await makeTempDir('lm-tools-bridge-runtime-resource-read-race-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const runtimeDir = path.join(rootDir, 'manager');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  const managersDir = path.join(runtimeDir, 'managers');
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  const sourceManagerPath = path.join(process.cwd(), 'out', 'stdioManager.js');
  const sourceRuntimePath = path.join(process.cwd(), 'out', 'stdioManagerRuntime.js');
  const copiedManagerPath = path.join(runtimeDir, 'stdioManager.js');
  const copiedRuntimePath = path.join(runtimeDir, 'stdioManagerRuntime.js');
  await fs.promises.copyFile(sourceManagerPath, copiedManagerPath);
  await fs.promises.copyFile(sourceRuntimePath, copiedRuntimePath);
  const copiedManagerText = await fs.promises.readFile(copiedManagerPath, 'utf8');
  const originalRuntimeText = await fs.promises.readFile(copiedRuntimePath, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: originalRuntimeText,
    generation: 1,
  });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
    resourceReadDelayMs: 1000,
  });
  const manager = await connectStdioManager(copiedManagerPath, pipeEnv);

  t.after(async () => {
    await manager.close().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const registry = await waitForRegistryEntry(managersDir);
  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  const resourceReadPromise = manager.client.readResource({
    uri: `lm-tools://tool/${ECHO_TOOL_NAME}`,
  });

  await new Promise((resolve) => {
    setTimeout(resolve, 200);
  });

  const reloadedRuntimeText = originalRuntimeText.replace(
    'Workspace bridge guide',
    'Workspace bridge guide resource-read-race',
  );
  await fs.promises.writeFile(copiedRuntimePath, reloadedRuntimeText, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: reloadedRuntimeText,
    generation: 2,
  });

  await sendGenerationChanged(registry.entry.controlPipePath, 2);

  await assert.rejects(
    () => resourceReadPromise,
    /Active workspace binding required before reading bridged discovery resources\..*Next step: call lmToolsBridge\.bindWorkspace/u,
  );

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });
  const reboundResource = await manager.client.readResource({
    uri: `lm-tools://tool/${ECHO_TOOL_NAME}`,
  });
  assert.match(getResourceText(reboundResource), /"name": "lm_testEcho"/u);
});

test('stdio manager retries the same generation after a runtime load failure', async (t) => {
  const pipeEnv = createPipeEnv('runtime-load-retry');
  const rootDir = await makeTempDir('lm-tools-bridge-runtime-retry-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const runtimeDir = path.join(rootDir, 'manager');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  const managersDir = path.join(runtimeDir, 'managers');
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  const sourceManagerPath = path.join(process.cwd(), 'out', 'stdioManager.js');
  const sourceRuntimePath = path.join(process.cwd(), 'out', 'stdioManagerRuntime.js');
  const copiedManagerPath = path.join(runtimeDir, 'stdioManager.js');
  const copiedRuntimePath = path.join(runtimeDir, 'stdioManagerRuntime.js');
  await fs.promises.copyFile(sourceManagerPath, copiedManagerPath);
  await fs.promises.copyFile(sourceRuntimePath, copiedRuntimePath);
  const copiedManagerText = await fs.promises.readFile(copiedManagerPath, 'utf8');
  const originalRuntimeText = await fs.promises.readFile(copiedRuntimePath, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: originalRuntimeText,
    generation: 1,
  });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
  });
  const manager = await connectStdioManager(copiedManagerPath, pipeEnv);

  t.after(async () => {
    await manager.close().catch(() => undefined);
    await workspace.stop().catch(() => undefined);
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const registry = await waitForRegistryEntry(managersDir);
  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  await fs.promises.writeFile(copiedRuntimePath, createInvalidRuntimeModuleText(), 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: createInvalidRuntimeModuleText(),
    generation: 2,
  });

  const failedResponse = await sendGenerationChanged(registry.entry.controlPipePath, 2);
  assert.equal(failedResponse.generationApplied, 1);
  assert.equal(failedResponse.bindingInvalidated, false);

  await assert.rejects(
    () => manager.client.callTool({
      name: REQUEST_WORKSPACE_METHOD,
      arguments: {},
    }),
    /Invalid params: expected params\.cwd \(string\)\./u,
  );

  await assert.rejects(
    () => manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {},
    }),
    /Invalid params: expected arguments\.name \(string\)\./u,
  );

  await assert.rejects(
    () => manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: ECHO_TOOL_NAME,
        arguments: 'invalid-shape',
      },
    }),
    /Invalid params: expected arguments\.arguments \(object\)\./u,
  );

  const guideWhileReloadFailed = await manager.client.readResource({
    uri: GUIDE_RESOURCE_URI,
  });
  assert.match(getResourceText(guideWhileReloadFailed), /Workspace bridge guide/u);

  const toolWhileReloadFailed = await manager.client.callTool({
    name: DIRECT_TOOL_CALL_NAME,
    arguments: {
      name: ECHO_TOOL_NAME,
      arguments: {
        value: 'still-alive',
      },
    },
  });
  assert.match(JSON.stringify(toolWhileReloadFailed.structuredContent ?? {}), /still-alive/u);

  const recoveredRuntimeText = originalRuntimeText.replace(
    'Workspace bridge guide',
    'Workspace bridge guide recovered',
  );
  await fs.promises.writeFile(copiedRuntimePath, recoveredRuntimeText, 'utf8');

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });
  const guideAfterRecovery = await manager.client.readResource({
    uri: GUIDE_RESOURCE_URI,
  });
  assert.match(getResourceText(guideAfterRecovery), /Workspace bridge guide recovered/u);
});

test('stdio manager lazily applies generation changes and cleans up registry on exit', async (t) => {
  const pipeEnv = createPipeEnv('runtime-lazy-reload');
  const rootDir = await makeTempDir('lm-tools-bridge-runtime-lazy-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const runtimeDir = path.join(rootDir, 'manager');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  const managersDir = path.join(runtimeDir, 'managers');
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.mkdir(runtimeDir, { recursive: true });

  const sourceManagerPath = path.join(process.cwd(), 'out', 'stdioManager.js');
  const sourceRuntimePath = path.join(process.cwd(), 'out', 'stdioManagerRuntime.js');
  const copiedManagerPath = path.join(runtimeDir, 'stdioManager.js');
  const copiedRuntimePath = path.join(runtimeDir, 'stdioManagerRuntime.js');
  await fs.promises.copyFile(sourceManagerPath, copiedManagerPath);
  await fs.promises.copyFile(sourceRuntimePath, copiedRuntimePath);
  const copiedManagerText = await fs.promises.readFile(copiedManagerPath, 'utf8');
  const originalRuntimeText = await fs.promises.readFile(copiedRuntimePath, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: originalRuntimeText,
    generation: 1,
  });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
  });
  const manager = await connectStdioManager(copiedManagerPath, pipeEnv);

  const registry = await waitForRegistryEntry(managersDir);

  t.after(async () => {
    await workspace.stop().catch(() => undefined);
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });

  const lazyRuntimeText = originalRuntimeText.replace(
    'Workspace bridge guide',
    'Workspace bridge guide lazy-reloaded',
  );
  await fs.promises.writeFile(copiedRuntimePath, lazyRuntimeText, 'utf8');
  await writeSyncMetadata({
    directory: runtimeDir,
    managerContent: copiedManagerText,
    runtimeContent: lazyRuntimeText,
    generation: 2,
  });

  const guideAfterLazyReload = await manager.client.readResource({
    uri: GUIDE_RESOURCE_URI,
  });
  assert.match(getResourceText(guideAfterLazyReload), /Workspace bridge guide lazy-reloaded/u);

  await assert.rejects(
    () => manager.client.callTool({
      name: ECHO_TOOL_NAME,
      arguments: {
        value: 'needs-rebind',
      },
    }),
    /Workspace not matched\..*Next step: call lmToolsBridge\.bindWorkspace/u,
  );

  await manager.close();
  await waitForMissingFile(registry.filePath);
});
