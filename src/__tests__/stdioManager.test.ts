import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  resolveWorkspaceDiscoveryTargetFromWindow,
  WorkspaceDiscoveryPublisher,
} from '../workspaceDiscovery';

const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.requestWorkspaceMCPServer';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callTool';
const ECHO_TOOL_NAME = 'lm_testEcho';
const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'string' },
  },
  required: ['value'],
};

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
  workspaceFile?: string;
}) {
  const target = resolveWorkspaceDiscoveryTargetFromWindow(
    args.workspaceFolders,
    args.workspaceFile,
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
              },
            },
          ],
        },
      });
      return;
    }
    if (message?.method === 'resources/read' && message.params?.uri === `lm-tools://tool/${ECHO_TOOL_NAME}`) {
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
                inputSchema: TOOL_INPUT_SCHEMA,
              }),
            },
          ],
        },
      });
      return;
    }
    if (message?.method === 'tools/call' && message.params?.name === ECHO_TOOL_NAME) {
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
    host: '127.0.0.1',
    port: address.port,
    async stop() {
      await publisher.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function connectStdioManager(extraEnv?: Record<string, string>) {
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
    { name: 'stdio-manager-test', version: '1.0.0' },
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

function getToolNames(result: Awaited<ReturnType<Client['listTools']>>): string[] {
  return result.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
}

function getResourceText(result: Awaited<ReturnType<Client['readResource']>>): string {
  const first = result.contents[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

function getHandshakeStatusPayload(text: string): Record<string, unknown> {
  const marker = 'Status snapshot:\n';
  const index = text.indexOf(marker);
  assert.notEqual(index, -1, `Expected handshake resource text to include "${marker.trim()}".`);
  return JSON.parse(text.slice(index + marker.length)) as Record<string, unknown>;
}

async function waitForFile(filePath: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.promises.access(filePath);
      return;
    } catch {
      // Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

test('stdio manager handshakes to a running workspace and proxies workspace tools', async (t) => {
  const pipeEnv = createPipeEnv('running');
  const rootDir = await makeTempDir('lm-tools-bridge-stdio-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Feature');
  await fs.promises.mkdir(nestedPath, { recursive: true });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
  });
  const manager = await connectStdioManager(pipeEnv);

  t.after(async () => {
    await manager.close();
    await workspace.stop();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const beforeTools = await manager.client.listTools();
  assert.deepEqual(getToolNames(beforeTools), [DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD]);

  const pathScopeSpec = await manager.client.readResource({
    uri: 'lm-tools://spec/pathScope',
  });
  assert.match(getResourceText(pathScopeSpec), /^Shared pathScope syntax/mu);
  const resourceTemplates = await manager.client.listResourceTemplates();
  assert.deepEqual(
    resourceTemplates.resourceTemplates.map((entry) => entry.uriTemplate),
    ['lm-tools://tool/{name}'],
  );

  const handshake = await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });
  const handshakePayload = handshake.structuredContent as {
    ok?: boolean;
    target?: { workspaceFolders?: string[]; workspaceFile?: string | null };
    discovery?: {
      bridgedTools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
    };
  } | undefined;
  assert.equal(handshakePayload?.ok, true);
  assert.deepEqual(handshakePayload?.target?.workspaceFolders, [workspaceRoot]);
  assert.equal(handshakePayload?.target?.workspaceFile ?? null, null);
  assert.deepEqual(handshakePayload?.discovery?.bridgedTools, [
    {
      name: ECHO_TOOL_NAME,
      description: 'Echo back the provided value.',
    },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload ?? {}, 'mcpSessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload?.target ?? {}, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload?.target ?? {}, 'host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload?.target ?? {}, 'port'), false);

  const handshakeResource = await manager.client.readResource({
    uri: 'lm-tools-bridge://handshake',
  });
  assert.match(getResourceText(handshakeResource), /lm-tools:\/\/spec\/pathScope/u);
  const handshakeStatus = getHandshakeStatusPayload(getResourceText(handshakeResource));
  const statusTarget = handshakeStatus.target as Record<string, unknown> | null;
  assert.deepEqual(statusTarget?.workspaceFolders, [workspaceRoot]);
  assert.equal(statusTarget?.workspaceFile ?? null, null);
  assert.equal(Object.prototype.hasOwnProperty.call(statusTarget ?? {}, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(statusTarget ?? {}, 'host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(statusTarget ?? {}, 'port'), false);

  const afterTools = await manager.client.listTools();
  assert.deepEqual(getToolNames(afterTools), [ECHO_TOOL_NAME, DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD]);

  const toolDefinition = await manager.client.readResource({
    uri: `lm-tools://tool/${ECHO_TOOL_NAME}`,
  });
  const toolDefinitionPayload = JSON.parse(getResourceText(toolDefinition)) as Record<string, unknown>;
  assert.match(getResourceText(toolDefinition), /"value"/u);
  assert.equal(Object.prototype.hasOwnProperty.call(toolDefinitionPayload, 'toolUri'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(toolDefinitionPayload, 'usageHint'), false);

  const directCall = await manager.client.callTool({
    name: ECHO_TOOL_NAME,
    arguments: {
      value: 'hello',
    },
  });
  assert.equal((directCall.structuredContent as { value?: string }).value, 'hello');

  const bridgeCall = await manager.client.callTool({
    name: DIRECT_TOOL_CALL_NAME,
    arguments: {
      name: ECHO_TOOL_NAME,
      arguments: {
        value: 'world',
      },
    },
  });
  assert.equal((bridgeCall.structuredContent as { value?: string }).value, 'world');
});

test('stdio manager clears bound tools when the workspace server goes offline', async (t) => {
  const pipeEnv = createPipeEnv('offline');
  const rootDir = await makeTempDir('lm-tools-bridge-stdio-');
  const workspaceRoot = path.join(rootDir, 'workspace');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });

  const workspace = await startFakeWorkspaceServer({
    pipeEnv,
    workspaceFolders: [workspaceRoot],
  });
  const manager = await connectStdioManager(pipeEnv);

  t.after(async () => {
    await manager.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: workspaceRoot,
    },
  });
  await workspace.stop();

  await assert.rejects(
    () => manager.client.callTool({
      name: ECHO_TOOL_NAME,
      arguments: {
        value: 'offline',
      },
    }),
    /offline|unreachable/iu,
  );

  const toolsAfterOffline = await manager.client.listTools();
  assert.deepEqual(getToolNames(toolsAfterOffline), [DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD]);
});

test('stdio manager auto-starts VS Code via PATH during handshake on Windows', {
  skip: process.platform !== 'win32' ? 'Windows-only auto-start test.' : false,
}, async (t) => {
  const pipeEnv = createPipeEnv('autostart');
  const rootDir = await makeTempDir('lm-tools-bridge-autostart-');
  const toolDir = path.join(rootDir, 'tools');
  const parentWorkspaceFile = path.join(rootDir, 'root.code-workspace');
  const workspaceRoot = path.join(rootDir, 'workspace-root');
  const nestedPath = path.join(workspaceRoot, 'Source', 'Nested');
  const openPathFile = path.join(rootDir, 'open-path.txt');
  const pidFile = path.join(rootDir, 'fake-vscode.pid');
  await fs.promises.mkdir(toolDir, { recursive: true });
  await fs.promises.mkdir(path.join(workspaceRoot, '.vscode'), { recursive: true });
  await fs.promises.mkdir(nestedPath, { recursive: true });
  await fs.promises.writeFile(parentWorkspaceFile, '{}', 'utf8');

  const launcherPath = path.join(toolDir, 'fake-code-launcher.js');
  const launcherScript = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { resolveWorkspaceDiscoveryTargetFromWindow, WorkspaceDiscoveryPublisher } = require(${JSON.stringify(path.join(process.cwd(), 'out', 'workspaceDiscovery.js'))});
const toolName = ${JSON.stringify(ECHO_TOOL_NAME)};
const toolInputSchema = ${JSON.stringify(TOOL_INPUT_SCHEMA)};
const openPath = process.argv[process.argv.length - 1];
const workspaceRoot = openPath.toLowerCase().endsWith('.code-workspace') ? path.dirname(openPath) : openPath;
const workspaceFile = openPath.toLowerCase().endsWith('.code-workspace') ? openPath : undefined;
const pipeEnv = {
  LM_TOOLS_BRIDGE_DISCOVERY_PIPE_PREFIX: process.env.LM_TOOLS_BRIDGE_DISCOVERY_PIPE_PREFIX,
  LM_TOOLS_BRIDGE_LAUNCH_LOCK_PIPE_PREFIX: process.env.LM_TOOLS_BRIDGE_LAUNCH_LOCK_PIPE_PREFIX,
};
fs.writeFileSync(process.env.LM_TOOLS_BRIDGE_TEST_OPEN_PATH_FILE, openPath, 'utf8');
let publisher;
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/mcp/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.statusCode = 404;
    res.end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const id = message.id ?? null;
  if (message.method === 'tools/list') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: toolName,
            description: 'Echo back the provided value.',
            inputSchema: { type: 'object' },
          },
        ],
      },
    }));
    return;
  }
  if (message.method === 'resources/read' && message.params?.uri === 'lm-tools://tool/' + toolName) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        contents: [
          {
            uri: 'lm-tools://tool/' + toolName,
            mimeType: 'application/json',
            text: JSON.stringify({
              name: toolName,
              description: 'Echo back the provided value.',
              inputSchema: toolInputSchema,
            }),
          },
        ],
      },
    }));
    return;
  }
  if (message.method === 'tools/call' && message.params?.name === toolName) {
    const value = message.params?.arguments?.value;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: 'echo:' + String(value ?? '') }],
        structuredContent: { value },
      },
    }));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found' },
  }));
});
server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const target = resolveWorkspaceDiscoveryTargetFromWindow([workspaceRoot], workspaceFile, { env: pipeEnv });
  publisher = new WorkspaceDiscoveryPublisher({
    serverSessionId: 'launched-session-' + process.pid,
    getAdvertisement: () => ({
      target,
      host: '127.0.0.1',
      port: address.port,
    }),
  });
  await publisher.start();
  fs.writeFileSync(process.env.LM_TOOLS_BRIDGE_TEST_PID_FILE, String(process.pid), 'utf8');
});
async function shutdown() {
  if (publisher) {
    await publisher.stop();
  }
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
`;
  await fs.promises.writeFile(launcherPath, launcherScript, 'utf8');

  const codeCmdPath = path.join(toolDir, 'code.cmd');
  const codeCmdText = `@echo off\r\n"${process.execPath}" "${launcherPath}" %*\r\n`;
  await fs.promises.writeFile(codeCmdPath, codeCmdText, 'utf8');

  const manager = await connectStdioManager({
    ...pipeEnv,
    PATH: `${toolDir};${process.env.PATH ?? ''}`,
    LM_TOOLS_BRIDGE_TEST_OPEN_PATH_FILE: openPathFile,
    LM_TOOLS_BRIDGE_TEST_PID_FILE: pidFile,
  });

  t.after(async () => {
    try {
      const pidText = await fs.promises.readFile(pidFile, 'utf8');
      const pid = Number.parseInt(pidText.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid);
      }
    } catch {
      // Ignore cleanup failures.
    }
    await manager.close();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  const handshake = await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: nestedPath,
    },
  });
  const handshakePayload = handshake.structuredContent as { ok?: boolean } | undefined;
  assert.equal(handshakePayload?.ok, true);

  await waitForFile(openPathFile);
  const launchedOpenPath = await fs.promises.readFile(openPathFile, 'utf8');
  assert.equal(path.resolve(launchedOpenPath.trim()).toLowerCase(), path.resolve(workspaceRoot).toLowerCase());

  const toolsAfterHandshake = await manager.client.listTools();
  assert.deepEqual(getToolNames(toolsAfterHandshake), [ECHO_TOOL_NAME, DIRECT_TOOL_CALL_NAME, REQUEST_WORKSPACE_METHOD]);
});
