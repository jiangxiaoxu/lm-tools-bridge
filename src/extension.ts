import * as vscode from 'vscode';
import * as http from 'node:http';
import { TextDecoder } from 'node:util';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';

const OUTPUT_CHANNEL_NAME = 'LM Tools';
const LOG_CHANNEL_NAME = 'LM Tools MCP';
const DUMP_COMMAND_ID = 'lm-tools-dump';
const START_COMMAND_ID = 'lm-tools-mcp.start';
const STOP_COMMAND_ID = 'lm-tools-mcp.stop';
const TAKE_OVER_COMMAND_ID = 'lm-tools-mcp.takeOver';
const CONFIG_SECTION = 'lmToolsMcp';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48123;
const CONTROL_STOP_PATH = '/mcp-control/stop';
const HEALTH_PATH = '/mcp/health';
const ALLOWED_TOOL_NAMES = new Set([
  'copilot_searchCodebase',
  'copilot_searchWorkspaceSymbols',
  'copilot_listCodeUsages',
  'copilot_getVSCodeAPI',
  'copilot_findFiles',
  'copilot_findTextInFiles',
  'copilot_readFile',
  'copilot_listDirectory',
  'copilot_getErrors',
  'copilot_readProjectStructure',
  'copilot_getChangedFiles',
  'copilot_testFailure',
  'copilot_findTestFiles',
  'copilot_getDocInfo',
  'copilot_getSearchResults',
  'get_terminal_output',
  'terminal_selection',
  'terminal_last_command',
]);

type ChatRole = 'system' | 'user' | 'assistant';
type ToolAction = 'listTools' | 'getToolInfo' | 'invokeTool';
type ToolDetail = 'names' | 'summary' | 'full';

interface ChatMessageInput {
  role: ChatRole;
  content: string;
  name?: string;
}

interface ChatToolInput {
  messages: ChatMessageInput[];
  modelId?: string;
  modelFamily?: string;
  maxIterations?: number;
  toolMode?: 'auto' | 'required';
  justification?: string;
  modelOptions?: Record<string, unknown>;
}

interface ToolkitInput {
  action: ToolAction;
  name?: string;
  detail?: ToolDetail;
  input?: unknown;
  includeBinary?: boolean;
}

interface ChatConfig {
  modelId?: string;
  modelFamily?: string;
  maxIterations: number;
}

interface ChatRunOptions {
  maxIterations: number;
  toolMode: vscode.LanguageModelChatToolMode;
  justification?: string;
  modelOptions?: Record<string, unknown>;
}

interface ServerConfig {
  autoStart: boolean;
  host: string;
  port: number;
}

interface McpServerState {
  server: http.Server;
  host: string;
  port: number;
}

type OwnershipState = 'owner' | 'inUse' | 'off';

let serverState: McpServerState | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let logChannel: vscode.LogOutputChannel | undefined;
let globalState: vscode.Memento | undefined;
let toolInvocationTokenRequired = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  logChannel = vscode.window.createOutputChannel(LOG_CHANNEL_NAME, { log: true });
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  globalState = context.globalState;
  toolInvocationTokenRequired = new Set(
    globalState.get<string[]>('lmToolsMcp.toolInvocationTokenRequired', []),
  );
  const dumpCommand = vscode.commands.registerCommand(DUMP_COMMAND_ID, () => {
    outputChannel.clear();
    outputChannel.show(true);
    dumpLmTools(outputChannel);
  });
  const startCommand = vscode.commands.registerCommand(START_COMMAND_ID, () => {
    void startMcpServer(outputChannel);
  });
  const stopCommand = vscode.commands.registerCommand(STOP_COMMAND_ID, () => {
    void stopMcpServer(outputChannel);
  });
  const takeOverCommand = vscode.commands.registerCommand(TAKE_OVER_COMMAND_ID, () => {
    void handleTakeOverCommand(outputChannel);
  });
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration(CONFIG_SECTION)) {
      return;
    }

    void reconcileServerState(outputChannel);
  });

  context.subscriptions.push(
    outputChannel,
    logChannel,
    statusBarItem,
    dumpCommand,
    startCommand,
    stopCommand,
    takeOverCommand,
    configWatcher,
    { dispose: () => { void stopMcpServer(outputChannel); } },
  );

  const config = getServerConfig();
  if (config.autoStart) {
    void startMcpServer(outputChannel);
  }

  void refreshStatusBar();
  logInfo('Extension activated.');
}

export function deactivate(): void {
  if (serverState) {
    try {
      serverState.server.close();
    } catch {
      // Ignore shutdown errors.
    }
    serverState = undefined;
  }
}

function dumpLmTools(channel: vscode.OutputChannel): void {
  const tools = getAllAllowedToolsSnapshot();
  if (tools.length === 0) {
    channel.appendLine('No tools found in vscode.lm.tools.');
    return;
  }

  channel.appendLine(`Found ${tools.length} tool(s):`);
  channel.appendLine('');

  for (let i = 0; i < tools.length; i += 1) {
    const tool = tools[i];
    channel.appendLine(`Tool ${i + 1}:`);
    channel.appendLine(`  name: ${tool.name}`);
    channel.appendLine(`  description: ${tool.description}`);
    channel.appendLine(`  tags: ${formatTags(tool.tags)}`);
    channel.appendLine('  inputSchema:');
    channel.appendLine(indentLines(formatSchema(tool.inputSchema), 4));

    if (i < tools.length - 1) {
      channel.appendLine('');
    }
  }
}

function getServerConfig(): ServerConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    autoStart: config.get<boolean>('server.autoStart', true),
    host: config.get<string>('server.host', DEFAULT_HOST),
    port: config.get<number>('server.port', DEFAULT_PORT),
  };
}


async function takeOverMcpServer(channel: vscode.OutputChannel): Promise<void> {
  const config = getServerConfig();
  if (serverState && serverState.host === config.host && serverState.port === config.port) {
    void vscode.window.showInformationMessage('MCP server is already running in this VS Code instance.');
    return;
  }

  const stopResult = await requestRemoteStop(config.host, config.port);
  if (!stopResult) {
    logWarn('No remote MCP server responded to stop request (or it is not updated yet).');
  }

  const started = await startMcpServerWithRetry(channel, config.host, config.port, 6, 400);
  if (!started) {
    void vscode.window.showWarningMessage('Failed to take over MCP server. Port may still be in use.');
  }
}

async function handleTakeOverCommand(channel: vscode.OutputChannel): Promise<void> {
  const state = await getOwnershipState();
  if (state === 'owner') {
    void vscode.window.showInformationMessage('This VS Code instance already owns the MCP server.');
    return;
  }

  const selection = await vscode.window.showWarningMessage(
    'This VS Code instance does not own the MCP server. Take over control?',
    { modal: true },
    'Take Over',
  );
  if (selection !== 'Take Over') {
    return;
  }

  await takeOverMcpServer(channel);
}

async function reconcileServerState(channel: vscode.OutputChannel): Promise<void> {
  const config = getServerConfig();
  if (!config.autoStart) {
    await stopMcpServer(channel);
    await refreshStatusBar();
    return;
  }

  if (!serverState) {
    await startMcpServer(channel);
    await refreshStatusBar();
    return;
  }

  if (serverState.host !== config.host || serverState.port !== config.port) {
    await stopMcpServer(channel);
    await startMcpServer(channel);
    await refreshStatusBar();
  }
}

async function startMcpServer(channel: vscode.OutputChannel, override?: { host: string; port: number }): Promise<boolean> {
  if (serverState) {
    logInfo(`MCP server already running at http://${serverState.host}:${serverState.port}/mcp`);
    updateStatusBar('owner');
    return true;
  }

  const config = override ?? getServerConfig();
  const { host, port } = config;
  const server = http.createServer((req, res) => {
    void handleMcpHttpRequest(req, res, channel);
  });

  const started = await new Promise<boolean>((resolve) => {
    server.once('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        logWarn(`Port ${port} is already in use. Another VS Code instance may be hosting MCP.`);
        logWarn('Use "LM Tools MCP: Take Over Server" to reclaim the port.');
        updateStatusBar('inUse');
      } else {
        logError(`Failed to start MCP server: ${String(error)}`);
        updateStatusBar('off');
      }
      try {
        server.close();
      } catch {
        // Ignore close errors.
      }
      resolve(false);
    });
    server.listen(port, host, () => {
      serverState = { server, host, port };
      logInfo(`MCP server listening at http://${host}:${port}/mcp`);
      updateStatusBar('owner');
      resolve(true);
    });
  });

  return started;
}

async function stopMcpServer(channel: vscode.OutputChannel): Promise<void> {
  if (!serverState) {
    return;
  }

  const { server, host, port } = serverState;
  serverState = undefined;
  await new Promise<void>((resolve) => {
    server.close(() => {
      logInfo(`MCP server stopped at http://${host}:${port}/mcp`);
      resolve();
    });
  });
  await refreshStatusBar();
}

async function handleMcpHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  channel: vscode.OutputChannel,
): Promise<void> {
  const requestUrl = getRequestUrl(req);
  if (!requestUrl) {
    respondJson(res, 400, { error: 'Bad Request' });
    return;
  }
  logInfo(`MCP HTTP ${req.method ?? 'UNKNOWN'} ${requestUrl.pathname} from ${req.socket.remoteAddress ?? 'unknown'}`);

  if (requestUrl.pathname === CONTROL_STOP_PATH) {
    await handleControlStop(req, res, channel);
    return;
  }

  if (requestUrl.pathname === HEALTH_PATH) {
    await handleHealth(req, res);
    return;
  }

  if (requestUrl.pathname !== '/mcp') {
    respondJson(res, 404, { error: 'Not Found' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  const server = createMcpServer(channel);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  transport.onerror = (error) => {
    logError(`MCP transport error: ${String(error)}`);
  };

  try {
    await server.connect(transport);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  } catch (error) {
    logError(`MCP request failed: ${String(error)}`);
    if (!res.headersSent) {
      respondJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

async function handleControlStop(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  channel: vscode.OutputChannel,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  respondJson(res, 200, { ok: true });
  logInfo('Received MCP take-over request, shutting down server.');
  setImmediate(() => {
    void stopMcpServer(channel);
  });
}

async function startMcpServerWithRetry(
  channel: vscode.OutputChannel,
  host: string,
  port: number,
  attempts: number,
  delayMs: number,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = await startMcpServer(channel, { host, port });
    if (started) {
      return true;
    }
    await delay(delayMs);
  }

  return false;
}

function requestRemoteStop(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host,
        port,
        path: CONTROL_STOP_PATH,
        method: 'POST',
      },
      (response) => {
        response.resume();
        const ok = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300;
        resolve(ok);
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, 1500);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createMcpServer(channel: vscode.OutputChannel): McpServer {
  const server = new McpServer(
    {
      name: 'vscode-lm-chat',
      version: '0.1.0',
    },
    {
      capabilities: { logging: {} },
    },
  );

  const toolActionSchema = z.enum(['listTools', 'getToolInfo', 'invokeTool'])
    .describe('Action for vscodeLmToolkit only. Valid values: listTools | getToolInfo | invokeTool.');
  const toolDetailSchema = z.enum(['names', 'summary', 'full'])
    .describe('Detail level for listTools/getToolInfo.');
  const toolkitSchema: z.ZodTypeAny = z.object({
    action: toolActionSchema,
    name: z.string()
      .describe('Target tool name. Required for getToolInfo/invokeTool.')
      .optional(),
    detail: toolDetailSchema.optional(),
    input: z.object({}).passthrough()
      .describe('Target tool input object. See lm-tools://schema/{name}.')
      .optional(),
    includeBinary: z.boolean()
      .describe('Include base64 for binary data parts in tool results.')
      .optional(),
  }).strict().describe('Toolkit wrapper for listing/inspecting/invoking copilot_ tools.');

  // @ts-expect-error TS2589: Deep instantiation from SDK tool generics.
  server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
    'vscodeLmToolkit',
    {
      description: 'List, inspect, and invoke copilot_ tools from vscode.lm.tools.',
      inputSchema: toolkitSchema,
    },
    async (args: ToolkitInput) => {
      try {
        logInfo(`vscodeLmToolkit request: ${formatLogPayload(args)}`);
        const lm = getLanguageModelNamespace();
        if (!lm) {
          return toolErrorResult('vscode.lm is not available in this VS Code version.');
        }

        const tools = getAllAllowedToolsSnapshot();
        const detail: ToolDetail = args.detail ?? 'summary';

        if (args.action === 'listTools') {
          logInfo(`vscodeLmToolkit action=listTools detail=${detail}`);
          return toolSuccessResult(listToolsPayload(tools, detail));
        }

        if (!args.name) {
          return toolErrorResult('Tool name is required for this action. Valid actions: listTools | getToolInfo | invokeTool.');
        }

        const tool = tools.find((candidate) => candidate.name === args.name);
        if (!tool) {
          return toolErrorResult(`Tool not found or disabled: ${args.name}`);
        }

        if (args.action === 'getToolInfo') {
          logInfo(`vscodeLmToolkit action=getToolInfo name=${tool.name} detail=${detail}`);
          return toolSuccessResult(toolInfoPayload(tool, detail));
        }

        const input = args.input ?? {};
        if (!isPlainObject(input)) {
          return toolErrorResultPayload({
            error: 'Tool input must be an object (not a JSON string). Use lm-tools://schema/{name} for the expected shape.',
            name: tool.name,
            inputSchema: tool.inputSchema ?? null,
          });
        }
        logInfo(`vscodeLmToolkit invoking tool ${tool.name} with input: ${formatLogPayload(input)}`);
        const result = await lm.invokeTool(tool.name, {
          input,
          toolInvocationToken: undefined,
        });
        const includeBinary = args.includeBinary ?? false;
        const serialized = serializeToolResult(result, { includeBinary });
        logInfo(`vscodeLmToolkit tool result (${tool.name}): ${formatLogPayload(serialized)}`);

        return toolSuccessResult({
          name: tool.name,
          result: serialized,
        });
      } catch (error) {
        const message = String(error);
        logError(`Toolkit tool error: ${message}`);
        if (message.includes('toolInvocationToken')) {
          markToolRequiresToken(args.name);
          return toolErrorResultPayload({
            error: message,
            name: args.name,
            requiresToolInvocationToken: true,
            hint: 'This tool requires a chat toolInvocationToken and cannot be invoked directly via vscodeLmToolkit.',
            inputSchema: args.name
              ? getAllAllowedToolsSnapshot().find((tool) => tool.name === args.name)?.inputSchema ?? null
              : null,
          });
        }
        return toolErrorResultPayload({
          error: message,
          name: args.name,
          inputSchema: args.name
            ? getAllAllowedToolsSnapshot().find((tool) => tool.name === args.name)?.inputSchema ?? null
            : null,
        });
      }
    },
  );

  const messageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
    name: z.string().optional(),
  });
  const toolModeSchema = z.enum(['auto', 'required']);
  const chatSchema: z.ZodTypeAny = z.object({
    messages: z.array(messageSchema).min(1),
    modelId: z.string().optional(),
    modelFamily: z.string().optional(),
    maxIterations: z.number().int().min(1).max(20).optional(),
    toolMode: toolModeSchema.optional(),
    justification: z.string().optional(),
    modelOptions: z.record(z.unknown()).optional(),
  });

  server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
    'vscodeLmChat',
    {
      description: 'Run a chat request via VS Code Language Model API with tool calling.',
      inputSchema: chatSchema,
    },
    async (args: ChatToolInput) => {
      try {
        logInfo(`vscodeLmChat request: ${formatChatLogPayload(args)}`);
        const lm = getLanguageModelNamespace();
        if (!lm) {
          return toolErrorResult('vscode.lm is not available in this VS Code version.');
        }

        const chatModel = await selectChatModel(lm, args.modelId, args.modelFamily);
        if (!chatModel) {
          return toolErrorResult('No matching chat model found. Check modelId/modelFamily settings.');
        }
        logInfo(`vscodeLmChat using model id=${chatModel.id} family=${chatModel.family}`);

        const messages = args.messages.map((message) => {
          const role = message.role === 'assistant'
            ? vscode.LanguageModelChatMessageRole.Assistant
            : vscode.LanguageModelChatMessageRole.User;
          const name = message.role === 'system' ? message.name ?? 'system' : message.name;
          return new vscode.LanguageModelChatMessage(role, message.content, name);
        });
        const maxIterations = args.maxIterations ?? getChatConfig().maxIterations;
        const toolMode = vscode.LanguageModelChatToolMode.Auto;
        const tools = getAllAllowedToolsSnapshot();
        logInfo(`vscodeLmChat tools available (${tools.length}): ${tools.map((tool) => tool.name).join(', ')}`);

        const result = await runChatWithTools(lm, chatModel, messages, tools, {
          maxIterations,
          toolMode,
          justification: args.justification,
          modelOptions: args.modelOptions,
        });

        logInfo(`vscodeLmChat result: ${formatLogPayload(result)}`);
        return toolSuccessResult(result);
      } catch (error) {
        logError(`Chat tool error: ${String(error)}`);
        return toolErrorResult(`Chat execution failed: ${String(error)}`);
      }
    },
  );

  server.registerResource(
    'lmToolsNames',
    'lm-tools://names',
    { description: 'List exposed tool names.' },
    async () => {
      logInfo('Resource read: lm-tools://names');
      return resourceJson('lm-tools://names', listToolsPayload(getAllAllowedToolsSnapshot(), 'names'));
    },
  );

  server.registerResource(
    'lmToolsList',
    'lm-tools://list',
    { description: 'List exposed tools with descriptions.' },
    async () => {
      logInfo('Resource read: lm-tools://list');
      return resourceJson('lm-tools://list', listToolsPayload(getAllAllowedToolsSnapshot(), 'summary'));
    },
  );

  const toolTemplate = new ResourceTemplate('lm-tools://tool/{name}', {
    list: () => {
      logInfo('Resource list: lm-tools://tool/{name}');
      return {
        resources: getAllAllowedToolsSnapshot().map((tool) => ({
          uri: `lm-tools://tool/${tool.name}`,
          name: tool.name,
          title: tool.name,
          description: tool.description,
        })),
      };
    },
    complete: {
      name: (value) => {
        logInfo(`Resource complete: lm-tools://tool/{name} value=${value}`);
        return getAllAllowedToolsSnapshot()
          .map((tool) => tool.name)
          .filter((name) => name.startsWith(value));
      },
    },
  });

  server.registerResource(
    'lmToolsTool',
    toolTemplate,
    { description: 'Read a tool definition by name.' },
    async (uri, variables) => {
      const name = readTemplateVariable(variables, 'name');
      logInfo(`Resource read: ${uri.toString()} name=${name ?? ''}`);
      if (!name) {
        return resourceJson(uri.toString(), { error: 'Tool name is required.' });
      }
      const tool = getAllAllowedToolsSnapshot().find((candidate) => candidate.name === name);
      if (!tool) {
        return resourceJson(uri.toString(), { error: `Tool not found or disabled: ${name}` });
      }
      return resourceJson(uri.toString(), toolInfoPayload(tool, 'full'));
    },
  );

  const schemaTemplate = new ResourceTemplate('lm-tools://schema/{name}', {
    list: () => {
      logInfo('Resource list: lm-tools://schema/{name}');
      return {
        resources: getAllAllowedToolsSnapshot().map((tool) => ({
          uri: `lm-tools://schema/${tool.name}`,
          name: tool.name,
          title: tool.name,
          description: 'Input schema',
        })),
      };
    },
    complete: {
      name: (value) => {
        logInfo(`Resource complete: lm-tools://schema/{name} value=${value}`);
        return getAllAllowedToolsSnapshot()
          .map((tool) => tool.name)
          .filter((name) => name.startsWith(value));
      },
    },
  });

  server.registerResource(
    'lmToolsSchema',
    schemaTemplate,
    { description: 'Read tool input schema by name.' },
    async (uri, variables) => {
      const name = readTemplateVariable(variables, 'name');
      logInfo(`Resource read: ${uri.toString()} name=${name ?? ''}`);
      if (!name) {
        return resourceJson(uri.toString(), { error: 'Tool name is required.' });
      }
      const tool = getAllAllowedToolsSnapshot().find((candidate) => candidate.name === name);
      if (!tool) {
        return resourceJson(uri.toString(), { error: `Tool not found or disabled: ${name}` });
      }
      return resourceJson(uri.toString(), { name: tool.name, inputSchema: tool.inputSchema ?? null });
    },
  );

  return server;
}

async function handleHealth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  try {
    const ownership = await getOwnershipState();
    const toolsSnapshot = getAllAllowedToolsSnapshot();
    const toolsCount = toolsSnapshot.length;
    const toolNames = toolsSnapshot.map((tool) => tool.name);
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    })) ?? [];

    respondJson(res, 200, {
      ok: true,
      ownership,
      tools: toolsCount,
      toolNames,
      workspaceFolders,
      host: serverState?.host ?? null,
      port: serverState?.port ?? null,
    });
  } catch (error) {
    respondJson(res, 500, { ok: false, error: String(error) });
  }
}

function toolSuccessResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function toolErrorResult(message: string) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: message,
      },
    ],
  };
}

function toolErrorResultPayload(payload: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload),
      },
    ],
  };
}

function resourceJson(uri: string, payload: Record<string, unknown>) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function listToolsPayload(tools: readonly vscode.LanguageModelToolInformation[], detail: ToolDetail) {
  if (detail === 'names') {
    return { tools: tools.map((tool) => tool.name) };
  }

  if (detail === 'summary') {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        tags: tool.tags,
        toolUri: getToolUri(tool.name),
        schemaUri: getSchemaUri(tool.name),
        usageHint: getToolUsageHint(tool),
      })),
    };
  }

  return {
    tools: tools.map((tool) => toolInfoPayload(tool, 'full')),
  };
}

function toolInfoPayload(tool: vscode.LanguageModelToolInformation, detail: ToolDetail) {
  if (detail === 'summary') {
    return {
      name: tool.name,
      description: tool.description,
      tags: tool.tags,
      toolUri: getToolUri(tool.name),
      schemaUri: getSchemaUri(tool.name),
      usageHint: getToolUsageHint(tool),
    };
  }

  if (detail === 'names') {
    return {
      name: tool.name,
    };
  }

  return {
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    inputSchema: tool.inputSchema ?? null,
    toolUri: getToolUri(tool.name),
    schemaUri: getSchemaUri(tool.name),
    usageHint: getToolUsageHint(tool),
  };
}

function serializeToolResult(
  result: vscode.LanguageModelToolResult,
  options: { includeBinary: boolean },
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push({
        type: 'text',
        text: part.value,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelPromptTsxPart) {
      const plain = extractPromptTsxText(part.value);
      const plainValue = plain.trim().length > 0 ? plain : safeStringify(part.value);

      parts.push({
        type: 'prompt-tsx',
        text: plainValue,
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const payload: Record<string, unknown> = {
        type: 'data',
        mimeType: part.mimeType,
        byteLength: part.data.byteLength,
      };

      const decodedText = decodeTextData(part);
      if (decodedText !== undefined) {
        payload.text = decodedText;
      }

      if (options.includeBinary) {
        payload.dataBase64 = Buffer.from(part.data).toString('base64');
      }

      parts.push(payload);
      continue;
    }

    const serialized = safeStringify(part);
    parts.push({
      type: 'unknown',
      text: serialized,
    });
  }

  return parts;
}

function decodeTextData(part: vscode.LanguageModelDataPart): string | undefined {
  if (part.mimeType.startsWith('text/') || part.mimeType === 'application/json') {
    return new TextDecoder('utf-8').decode(part.data);
  }

  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function getToolUri(name: string): string {
  return `lm-tools://tool/${name}`;
}

function getSchemaUri(name: string): string {
  return `lm-tools://schema/${name}`;
}

function getToolUsageHint(tool: vscode.LanguageModelToolInformation): Record<string, unknown> {
  const combined = `${tool.name} ${(tool.description ?? '')}`.toLowerCase();
  const requiresObjectInput = schemaRequiresObjectInput(tool.inputSchema);
  const toolkitInputNote = requiresObjectInput
    ? 'vscodeLmToolkit input must be an object (not a JSON string).'
    : undefined;
  if (combined.includes('do not use') || combined.includes('placeholder')) {
    return {
      mode: 'do-not-use',
      reason: 'Heuristic: description indicates do-not-use/placeholder.',
      toolkitInputNote,
    };
  }

  const requiresToken = toolInvocationTokenRequired.has(tool.name);
  if (requiresToken) {
    return {
      mode: 'chat',
      reason: 'Heuristic: toolInvocationToken required; use vscodeLmChat.',
      requiresToolInvocationToken: true,
      toolkitInputNote,
    };
  }

  if (tool.tags.some((tag) => tag.includes('codesearch'))) {
    return {
      mode: 'toolkit',
      reason: 'Heuristic: codesearch tag; use vscodeLmToolkit.',
      toolkitInputNote,
    };
  }

  return {
    mode: 'unknown',
    reason: 'Heuristic: no token requirement; check schema and prefer vscodeLmChat if invocation fails.',
    requiresObjectInput: requiresObjectInput || undefined,
    toolkitInputNote,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function markToolRequiresToken(name: string | undefined): void {
  if (!name) {
    return;
  }
  if (toolInvocationTokenRequired.has(name)) {
    return;
  }
  toolInvocationTokenRequired.add(name);
  if (globalState) {
    void globalState.update(
      'lmToolsMcp.toolInvocationTokenRequired',
      Array.from(toolInvocationTokenRequired),
    );
  }
}

function schemaRequiresObjectInput(schema: object | undefined): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }

  const record = schema as Record<string, unknown>;
  if (record.type === 'object' || typeof record.properties === 'object') {
    return true;
  }
  const properties = record.properties && typeof record.properties === 'object'
    ? Object.values(record.properties as Record<string, unknown>)
    : [];
  for (const propSchema of properties) {
    if (schemaHasObject(propSchema)) {
      return true;
    }
  }

  return false;
}

function schemaHasObject(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }

  const record = schema as Record<string, unknown>;
  if (record.type === 'object' || typeof record.properties === 'object') {
    return true;
  }
  if (record.type === 'array' && record.items) {
    return schemaHasObject(record.items);
  }
  if (Array.isArray(record.anyOf) && record.anyOf.some(schemaHasObject)) {
    return true;
  }
  if (Array.isArray(record.oneOf) && record.oneOf.some(schemaHasObject)) {
    return true;
  }

  return false;
}

function formatLogPayload(value: unknown): string {
  return safeStringify(value);
}

function formatChatLogPayload(args: ChatToolInput): string {
  const messages = args.messages.map((message) => ({
    role: message.role,
    name: message.name,
    content: message.content,
  }));
  const payload = {
    messages,
    modelId: args.modelId,
    modelFamily: args.modelFamily,
    maxIterations: args.maxIterations,
    toolMode: args.toolMode,
    justification: args.justification,
    modelOptions: args.modelOptions,
  };
  return formatLogPayload(payload);
}

function extractPromptTsxText(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') {
      parts.push(record.text);
    }
    if (record.node !== undefined) {
      visit(record.node);
    }
    if (record.children !== undefined) {
      visit(record.children);
    }
  };

  visit(value);
  return parts.join('');
}

function readTemplateVariable(
  variables: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const value = variables[name];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function normalizeConfigString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getChatConfig(): ChatConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const modelId = normalizeConfigString(config.get<string>('chat.modelId'));
  const modelFamily = normalizeConfigString(config.get<string>('chat.modelFamily'));
  const maxIterations = clampNumber(config.get<number>('chat.maxIterations', 6), 1, 20);
  return {
    modelId,
    modelFamily,
    maxIterations,
  };
}

async function selectChatModel(
  lm: typeof vscode.lm,
  preferredModelId?: string,
  preferredModelFamily?: string,
): Promise<vscode.LanguageModelChat | undefined> {
  const config = getChatConfig();
  const modelId = normalizeConfigString(preferredModelId ?? config.modelId);
  const modelFamily = normalizeConfigString(preferredModelFamily ?? config.modelFamily);

  if (modelId) {
    const byId = await lm.selectChatModels({ id: modelId });
    if (byId.length > 0) {
      return byId[0];
    }
    logWarn(`Chat model id "${modelId}" not found.`);
  }

  if (modelFamily) {
    const byFamily = await lm.selectChatModels({ family: modelFamily });
    if (byFamily.length > 0) {
      return byFamily[0];
    }
    logWarn(`Chat model family "${modelFamily}" not found.`);
  }

  return undefined;
}

async function runChatWithTools(
  lm: typeof vscode.lm,
  model: vscode.LanguageModelChat,
  initialMessages: vscode.LanguageModelChatMessage[],
  tools: readonly vscode.LanguageModelChatTool[],
  options: ChatRunOptions,
): Promise<Record<string, unknown>> {
  const messages = [...initialMessages];
  const toolCalls: Array<{ name: string; callId: string }> = [];
  let combinedText = '';
  let stopReason: 'completed' | 'maxIterations' | 'error' = 'completed';
  let iterations = 0;

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    iterations = iteration + 1;
    const response = await model.sendRequest(
      messages,
      {
        tools: tools.length > 0 ? Array.from(tools) : undefined,
        toolMode: options.toolMode,
        justification: options.justification,
        modelOptions: options.modelOptions,
      },
    );

    const assistantParts: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart
    > = [];
    const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
    let unknownPartCount = 0;
    const unknownPartTypes = new Set<string>();

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        assistantParts.push(part);
        combinedText += part.value;
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        assistantParts.push(part);
        toolCallParts.push(part);
        toolCalls.push({ name: part.name, callId: part.callId });
        logInfo(`vscodeLmChat tool call: ${part.name} id=${part.callId} input=${formatLogPayload(part.input)}`);
        continue;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        assistantParts.push(part);
        continue;
      }

      unknownPartCount += 1;
      unknownPartTypes.add(describeResponsePart(part));
    }

    if (unknownPartCount > 0) {
      const types = Array.from(unknownPartTypes).join(', ');
      logWarn(`Ignored ${unknownPartCount} unknown LanguageModel response part(s): ${types}`);
    }

    if (toolCallParts.length === 0) {
      stopReason = 'completed';
      break;
    }

    if (iteration >= options.maxIterations - 1) {
      stopReason = 'maxIterations';
      break;
    }

    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const toolCall of toolCallParts) {
      try {
        const result = await lm.invokeTool(toolCall.name, {
          input: toolCall.input,
          toolInvocationToken: undefined,
        });
        logInfo(`vscodeLmChat tool result (${toolCall.name}): ${formatLogPayload(result.content)}`);
        toolResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, result.content));
      } catch (error) {
        logError(`Tool invocation failed (${toolCall.name}): ${String(error)}`);
        const errorPart = new vscode.LanguageModelTextPart(
          `Tool invocation failed (${toolCall.name}): ${String(error)}`,
        );
        toolResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [errorPart]));
      }
    }

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
  }

  const payload: Record<string, unknown> = {
    text: combinedText,
    iterations,
    stopReason,
    model: {
      id: model.id,
      family: model.family,
    },
  };

  if (toolCalls.length > 0) {
    payload.toolCalls = toolCalls;
  }

  return payload;
}

function describeResponsePart(part: unknown): string {
  if (part && typeof part === 'object' && 'constructor' in part) {
    const ctor = (part as { constructor?: { name?: string } }).constructor;
    if (ctor && typeof ctor.name === 'string' && ctor.name.length > 0) {
      return ctor.name;
    }
  }

  return typeof part;
}


function getRequestUrl(req: http.IncomingMessage): URL | undefined {
  const host = req.headers.host ?? 'localhost';
  const urlValue = req.url ?? '/';
  try {
    return new URL(urlValue, `http://${host}`);
  } catch {
    return undefined;
  }
}

function respondJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (res.headersSent) {
    return;
  }

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}


function getLanguageModelNamespace(): typeof vscode.lm | undefined {
  const possibleLm = (vscode as { lm?: typeof vscode.lm }).lm;
  return possibleLm;
}

function getAllAllowedToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    return [];
  }

  return lm.tools.filter((tool) => ALLOWED_TOOL_NAMES.has(tool.name));
}

async function getOwnershipState(): Promise<OwnershipState> {
  if (serverState) {
    return 'owner';
  }

  const config = getServerConfig();
  const available = await isPortAvailable(config.host, config.port);
  return available ? 'off' : 'inUse';
}

function updateStatusBar(state: OwnershipState): void {
  if (!statusBarItem) {
    return;
  }

  const config = getServerConfig();
  statusBarItem.command = TAKE_OVER_COMMAND_ID;
  if (state === 'owner') {
    statusBarItem.text = '$(debug-disconnect) MCP: Owner';
    statusBarItem.tooltip = `This VS Code instance owns MCP (${config.host}:${config.port}).`;
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
  } else if (state === 'inUse') {
    statusBarItem.text = '$(lock) MCP: In Use';
    statusBarItem.tooltip = `MCP port is in use (${config.host}:${config.port}). Click to take over.`;
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  } else {
    statusBarItem.text = '$(circle-slash) MCP: Off';
    statusBarItem.tooltip = `MCP server is not running (${config.host}:${config.port}). Click to take over.`;
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

function logInfo(message: string): void {
  if (logChannel) {
    logChannel.info(message);
    return;
  }
  console.info(message);
}

function logWarn(message: string): void {
  if (logChannel) {
    logChannel.warn(message);
    return;
  }
  console.warn(message);
}

function logError(message: string): void {
  if (logChannel) {
    logChannel.error(message);
    logChannel.show(true);
    return;
  }
  console.error(message);
}

async function refreshStatusBar(): Promise<void> {
  const state = await getOwnershipState();
  updateStatusBar(state);
}

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const tester = http.createServer();
    tester.once('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

function formatTags(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(', ') : '(none)';
}

function formatSchema(schema: object | undefined): string {
  if (!schema) {
    return '(none)';
  }

  return JSON.stringify(schema, null, 2);
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split(/\r?\n/u)
    .map((line) => `${pad}${line}`)
    .join('\n');
}
