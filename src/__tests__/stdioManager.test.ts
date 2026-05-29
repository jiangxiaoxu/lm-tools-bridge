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

const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge_bindWorkspace';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge_callBridgedTool';
const GET_TOOL_DEFINITIONS_METHOD = 'lmToolsBridge_getToolDefinitions';
const LEGACY_REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.bindWorkspace';
const LEGACY_DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callBridgedTool';
const LEGACY_GET_TOOL_DEFINITIONS_METHOD = 'lmToolsBridge.getToolDefinitions';
const LEGACY_LM_GET_TOOL_DEFINITIONS_METHOD = 'lm_getToolDefinitions';
const ECHO_TOOL_NAME = 'lm_testEcho';

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
            { name: REQUEST_WORKSPACE_METHOD, description: 'Local helper should be filtered.' },
            { name: DIRECT_TOOL_CALL_NAME, description: 'Local helper should be filtered.' },
            { name: GET_TOOL_DEFINITIONS_METHOD, description: 'Local helper should be filtered.' },
            { name: LEGACY_REQUEST_WORKSPACE_METHOD, description: 'Legacy helper should be filtered.' },
            { name: LEGACY_DIRECT_TOOL_CALL_NAME, description: 'Legacy helper should be filtered.' },
            { name: LEGACY_GET_TOOL_DEFINITIONS_METHOD, description: 'Legacy helper should be filtered.' },
            { name: LEGACY_LM_GET_TOOL_DEFINITIONS_METHOD, description: 'Legacy helper should be filtered.' },
          ],
        },
      });
      return;
    }
    if (message?.method === 'resources/read' && message.params?.uri === 'lm-tools://tool-definitions') {
      respondJson(res, {
        jsonrpc: '2.0',
        id,
        result: {
          contents: [
            {
              uri: 'lm-tools://tool-definitions',
              mimeType: 'application/json',
              text: JSON.stringify({
                tools: [
                  {
                    name: ECHO_TOOL_NAME,
                    description: 'Echo back the provided value.',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        value: {
                          type: 'string',
                          description: 'Value to echo.',
                        },
                      },
                      required: ['value'],
                    },
                  },
                ],
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
      if (value === 'schema-error') {
        respondJson(res, {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Invalid arguments: inputSchema mismatch.',
          },
        });
        return;
      }
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
  assert.deepEqual(
    getToolNames(beforeTools),
    [REQUEST_WORKSPACE_METHOD, DIRECT_TOOL_CALL_NAME, GET_TOOL_DEFINITIONS_METHOD]
      .sort((left, right) => left.localeCompare(right)),
  );
  const requestWorkspaceTool = beforeTools.tools.find((tool) => tool.name === REQUEST_WORKSPACE_METHOD);
  const directCallTool = beforeTools.tools.find((tool) => tool.name === DIRECT_TOOL_CALL_NAME);
  const toolDefinitionsTool = beforeTools.tools.find((tool) => tool.name === GET_TOOL_DEFINITIONS_METHOD);
  assert.match(String(requestWorkspaceTool?.description ?? ''), /vscode-tools-like workspace search, code navigation, diagnostics, or VS Code IDE actions/u);
  assert.match(String(requestWorkspaceTool?.description ?? ''), /Read lm-tools:\/\/guide before first use\./u);
  assert.match(String(requestWorkspaceTool?.description ?? ''), /rebind only when the workspace target changes/u);
  assert.equal(
    (requestWorkspaceTool?.inputSchema as { properties?: { cwd?: { description?: unknown } } } | undefined)
      ?.properties?.cwd?.description,
    'Absolute workspace path to resolve. Use the absolute project root path or the absolute .code-workspace path. Relative paths are invalid.',
  );
  assert.match(String(directCallTool?.description ?? ''), /full ToolDefinition must be known from lmToolsBridge_getToolDefinitions/u);
  assert.match(String(directCallTool?.description ?? ''), /Reuse a known ToolDefinition and do not request it again/u);
  assert.match(String(directCallTool?.description ?? ''), /with names containing only tool names whose ToolDefinitions are unknown/u);
  assert.match(String(toolDefinitionsTool?.description ?? ''), /Read ToolDefinitions for bound bridged workspace tools/u);
  assert.match(String(toolDefinitionsTool?.description ?? ''), /names contains only exact enabled bridged tool names whose full ToolDefinition is unknown/u);
  assert.match(String(toolDefinitionsTool?.description ?? ''), /never guess or infer a ToolDefinition or inputSchema/u);
  assert.deepEqual(
    (toolDefinitionsTool?.inputSchema as { required?: unknown } | undefined)?.required,
    ['names'],
  );
  assert.deepEqual(
    (toolDefinitionsTool?.outputSchema as { required?: unknown } | undefined)?.required,
    ['requested', 'tools', 'missing', 'count', 'missingCount'],
  );
  assert.equal(
    (
      directCallTool?.inputSchema as {
        properties?: {
          name?: { description?: unknown };
          arguments?: { description?: unknown };
        };
      } | undefined
    )?.properties?.name?.description,
    'Bridged tool name to call. Resolve it from discovery.bridgedTools, tools/list, or lm-tools://tool-names.',
  );
  assert.equal(
    (
      directCallTool?.inputSchema as {
        properties?: {
          name?: { description?: unknown };
          arguments?: { description?: unknown };
        };
      } | undefined
    )?.properties?.arguments?.description,
    'Optional arguments object for the bridged tool call. Must match the target tool inputSchema.',
  );

  const resourceTemplates = await manager.client.listResourceTemplates();
  assert.deepEqual(
    resourceTemplates.resourceTemplates.map((entry) => entry.uriTemplate),
    [],
  );
  const resources = await manager.client.listResources();
  const toolNamesResourceDefinition = resources.resources.find((entry) => entry.uri === 'lm-tools://tool-names');
  assert.equal(toolNamesResourceDefinition?.description, 'Bridged workspace tool names.');

  await assert.rejects(
    () => manager.client.callTool({
      name: GET_TOOL_DEFINITIONS_METHOD,
      arguments: {
        names: [ECHO_TOOL_NAME],
      },
    }),
    /Workspace binding required before reading bridged discovery resources/u,
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
      callTool?: { name?: unknown; description?: unknown; inputSchema?: unknown };
      toolDefinitionsTool?: { name?: unknown; description?: unknown; inputSchema?: unknown; outputSchema?: unknown };
      bridgedTools?: Array<{ name?: unknown; inputSchema?: unknown }>;
    };
  } | undefined;
  assert.equal(handshakePayload?.ok, true);
  assert.deepEqual(handshakePayload?.target?.workspaceFolders, [workspaceRoot]);
  assert.equal(handshakePayload?.target?.workspaceFile ?? null, null);
  assert.deepEqual(handshakePayload?.discovery?.bridgedTools, [
    {
      name: ECHO_TOOL_NAME,
    },
  ]);
  assert.equal(handshakePayload?.discovery?.callTool?.name, DIRECT_TOOL_CALL_NAME);
  assert.equal(handshakePayload?.discovery?.toolDefinitionsTool?.name, GET_TOOL_DEFINITIONS_METHOD);
  assert.match(
    String(handshakePayload?.discovery?.toolDefinitionsTool?.description ?? ''),
    /Read ToolDefinitions for bound bridged workspace tools/u,
  );
  assert.deepEqual(
    (handshakePayload?.discovery?.toolDefinitionsTool?.inputSchema as { required?: unknown } | undefined)?.required,
    ['names'],
  );
  assert.deepEqual(
    (handshakePayload?.discovery?.toolDefinitionsTool?.outputSchema as { required?: unknown } | undefined)?.required,
    ['requested', 'tools', 'missing', 'count', 'missingCount'],
  );
  assert.match(
    String(handshakePayload?.discovery?.callTool?.description ?? ''),
    /^Read lm-tools:\/\/guide before first use\./u,
  );
  assert.match(
    String(handshakePayload?.discovery?.callTool?.description ?? ''),
    /full ToolDefinition must be known from lmToolsBridge_getToolDefinitions/u,
  );
  assert.match(
    String(handshakePayload?.discovery?.callTool?.description ?? ''),
    /pathScope, use its parameter description for the compact syntax summary/u,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(handshakePayload?.discovery?.bridgedTools?.[0] ?? {}, 'description'),
    false,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload ?? {}, 'mcpSessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload?.target ?? {}, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload?.target ?? {}, 'host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(handshakePayload?.target ?? {}, 'port'), false);

  const handshakeResource = await manager.client.readResource({
    uri: 'lm-tools://guide',
  });
  assert.match(getResourceText(handshakeResource), /Workspace bridge guide/u);
  assert.match(getResourceText(handshakeResource), /Bind:/u);
  assert.match(getResourceText(handshakeResource), /Tool discovery and calls:/u);
  assert.match(getResourceText(handshakeResource), /Routing and recovery:/u);
  assert.match(getResourceText(handshakeResource), /full ToolDefinition from lmToolsBridge_getToolDefinitions/u);
  assert.match(getResourceText(handshakeResource), /discovery\.bridgedTools names alone are not definitions/u);
  assert.match(getResourceText(handshakeResource), /Use lmToolsBridge_getToolDefinitions only with tool names whose ToolDefinitions are unknown/u);
  assert.match(getResourceText(handshakeResource), /skip the definition lookup entirely/u);
  assert.match(getResourceText(handshakeResource), /Do not guess or infer ToolDefinitions or inputSchemas/u);
  assert.match(getResourceText(handshakeResource), /Build arguments from the known ToolDefinition inputSchema/u);
  assert.match(getResourceText(handshakeResource), /Never perform silent fallback\./u);
  assert.match(getResourceText(handshakeResource), /Shared pathScope syntax/u);
  assert.match(getResourceText(handshakeResource), /Use brace globs, not bare `\|` alternation/u);

  const afterTools = await manager.client.listTools();
  assert.deepEqual(
    getToolNames(afterTools),
    [ECHO_TOOL_NAME, REQUEST_WORKSPACE_METHOD, DIRECT_TOOL_CALL_NAME, GET_TOOL_DEFINITIONS_METHOD]
      .sort((left, right) => left.localeCompare(right)),
  );

  const toolDefinitions = await manager.client.callTool({
    name: GET_TOOL_DEFINITIONS_METHOD,
    arguments: {
      names: [ECHO_TOOL_NAME, 'lm_missingTool'],
    },
  });
  const toolDefinitionsPayload = toolDefinitions.structuredContent as {
    requested?: unknown;
    tools?: Array<{ name?: unknown; inputSchema?: unknown }>;
    missing?: unknown;
    count?: unknown;
    missingCount?: unknown;
  };
  assert.deepEqual(toolDefinitionsPayload.requested, [ECHO_TOOL_NAME, 'lm_missingTool']);
  assert.deepEqual(toolDefinitionsPayload.missing, ['lm_missingTool']);
  assert.equal(toolDefinitionsPayload.count, 1);
  assert.equal(toolDefinitionsPayload.missingCount, 1);
  assert.equal(toolDefinitionsPayload.tools?.[0]?.name, ECHO_TOOL_NAME);
  assert.deepEqual(toolDefinitionsPayload.tools?.[0]?.inputSchema, {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        description: 'Value to echo.',
      },
    },
    required: ['value'],
  });

  for (const forbiddenName of [
    REQUEST_WORKSPACE_METHOD,
    DIRECT_TOOL_CALL_NAME,
    GET_TOOL_DEFINITIONS_METHOD,
    LEGACY_REQUEST_WORKSPACE_METHOD,
    LEGACY_DIRECT_TOOL_CALL_NAME,
    LEGACY_GET_TOOL_DEFINITIONS_METHOD,
    LEGACY_LM_GET_TOOL_DEFINITIONS_METHOD,
  ]) {
    await assert.rejects(
      () => manager.client.callTool({
        name: DIRECT_TOOL_CALL_NAME,
        arguments: {
          name: forbiddenName,
          arguments: {
            names: [ECHO_TOOL_NAME],
          },
        },
      }),
      /Invalid params: tool name is not allowed/u,
    );
  }

  const toolNamesResource = await manager.client.readResource({
    uri: 'lm-tools://tool-names',
  });
  assert.deepEqual(
    JSON.parse(getResourceText(toolNamesResource)),
    { tools: [ECHO_TOOL_NAME] },
  );

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

  await assert.rejects(
    () => manager.client.callTool({
      name: DIRECT_TOOL_CALL_NAME,
      arguments: {
        name: ECHO_TOOL_NAME,
        arguments: {
          value: 'schema-error',
        },
      },
    }),
    /Refresh lm_testEcho's ToolDefinition with lmToolsBridge_getToolDefinitions/u,
  );
});

test('stdio manager requires bind before bridged discovery resources are readable', async (t) => {
  const pipeEnv = createPipeEnv('resource-bind-required');
  const manager = await connectStdioManager(pipeEnv);

  t.after(async () => {
    await manager.close();
  });

  await assert.rejects(
    () => manager.client.readResource({
      uri: 'lm-tools://tool-names',
    }),
    /Workspace binding required before reading bridged discovery resources\..*Next step: call lmToolsBridge_bindWorkspace with params\.cwd, wait for ok=true, then retry once\./u,
  );

  await assert.rejects(
    () => manager.client.readResource({
      uri: `lm-tools://tool/${ECHO_TOOL_NAME}`,
    }),
    /Unknown resource URI: lm-tools:\/\/tool\/lm_testEcho/u,
  );
});

test('stdio manager requires rebind for bridged discovery resources after the workspace goes offline', async (t) => {
  const pipeEnv = createPipeEnv('resource-rebind-required');
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
    () => manager.client.readResource({
      uri: 'lm-tools://tool-names',
    }),
    /Active workspace binding required before reading bridged discovery resources\..*Next step: call lmToolsBridge_bindWorkspace with params\.cwd, wait for ok=true, then retry once\. Bridged discovery resources are available only after a successful bind\./u,
  );
});

test('stdio manager does not expose bridge helper definitions as resources', async (t) => {
  const pipeEnv = createPipeEnv('resource-local-helper');
  const manager = await connectStdioManager(pipeEnv);

  t.after(async () => {
    await manager.close();
  });

  await assert.rejects(
    () => manager.client.readResource({
      uri: `lm-tools://tool/${REQUEST_WORKSPACE_METHOD}`,
    }),
    /Unknown resource URI: lm-tools:\/\/tool\/lmToolsBridge_bindWorkspace/u,
  );
});

test('stdio manager keeps tool definition resources removed after bind', async (t) => {
  const pipeEnv = createPipeEnv('resource-unavailable-after-bind');
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
    await workspace.stop();
    await fs.promises.rm(rootDir, { recursive: true, force: true });
  });

  await manager.client.callTool({
    name: REQUEST_WORKSPACE_METHOD,
    arguments: {
      cwd: workspaceRoot,
    },
  });

  await assert.rejects(
    () => manager.client.readResource({
      uri: 'lm-tools://tool/lm_missingTool',
    }),
    /Unknown resource URI: lm-tools:\/\/tool\/lm_missingTool/u,
  );
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
  assert.deepEqual(
    getToolNames(toolsAfterOffline),
    [REQUEST_WORKSPACE_METHOD, DIRECT_TOOL_CALL_NAME, GET_TOOL_DEFINITIONS_METHOD]
      .sort((left, right) => left.localeCompare(right)),
  );
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
  assert.deepEqual(
    getToolNames(toolsAfterHandshake),
    [ECHO_TOOL_NAME, REQUEST_WORKSPACE_METHOD, DIRECT_TOOL_CALL_NAME, GET_TOOL_DEFINITIONS_METHOD]
      .sort((left, right) => left.localeCompare(right)),
  );
});
