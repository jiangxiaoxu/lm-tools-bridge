import * as vscode from 'vscode';
import * as http from 'node:http';
import { TextDecoder } from 'node:util';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';

const OUTPUT_CHANNEL_NAME = 'lm-tools-bridge';
const START_COMMAND_ID = 'lm-tools-bridge.start';
const STOP_COMMAND_ID = 'lm-tools-bridge.stop';
const TAKE_OVER_COMMAND_ID = 'lm-tools-bridge.takeOver';
const CONFIGURE_COMMAND_ID = 'lm-tools-bridge.configureTools';
const STATUS_MENU_COMMAND_ID = 'lm-tools-bridge.statusMenu';
const HELP_COMMAND_ID = 'lm-tools-bridge.openHelp';
const CONFIG_SECTION = 'lmToolsBridge';
const CONFIG_ENABLED_TOOLS = 'tools.enabled';
const CONFIG_BLACKLIST = 'tools.blacklist';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48123;
const CONTROL_STOP_PATH = '/mcp-control/stop';
const CONTROL_STATUS_PATH = '/mcp-control/status';
const HEALTH_PATH = '/mcp/health';
const STATUS_REFRESH_INTERVAL_MS = 3000;
const DEFAULT_ENABLED_TOOL_NAMES = [
  'copilot_searchCodebase',
  'copilot_searchWorkspaceSymbols',
  'copilot_listCodeUsages',
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
  'getVSCodeWorkspace',
];
const INTERNAL_BLACKLIST = new Set([
  'copilot_applyPatch',
  'copilot_insertEdit',
  'copilot_replaceString',
  'copilot_multiReplaceString',
  'copilot_createFile',
  'copilot_createDirectory',
  'copilot_createNewJupyterNotebook',
  'copilot_editNotebook',
  'copilot_runNotebookCell',
  'copilot_createNewWorkspace',
  'copilot_getVSCodeAPI',
  'copilot_installExtension',
  'copilot_runVscodeCommand',
  'create_and_run_task',
  'run_in_terminal',
  'manage_todo_list',
  'copilot_memory',
  'copilot_getNotebookSummary',
  'copilot_fetchWebPage',
  'copilot_openSimpleBrowser',
  'copilot_editFiles',
  'copilot_getProjectSetupInfo',
  'runSubagent',
  'vscode_get_confirmation',
  'inline_chat_exit',
]);

const BUILTIN_SCHEMA_DEFAULTS: Record<string, unknown> = {
  maxResults: 1000,
};

type ChatRole = 'system' | 'user' | 'assistant';
type ToolAction = 'listTools' | 'getToolInfo' | 'invokeTool';
type ToolDetail = 'names' | 'full';

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
  ownerWorkspacePath: string;
}

type OwnershipState = 'owner' | 'nonOwner' | 'off';
interface OwnershipInfo {
  state: OwnershipState;
  ownerWorkspacePath?: string;
}

let serverState: McpServerState | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let logChannel: vscode.LogOutputChannel | undefined;
let globalState: vscode.Memento | undefined;
let toolInvocationTokenRequired = new Set<string>();
let helpUrl: string | undefined;
let statusRefreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  logChannel = outputChannel as vscode.LogOutputChannel;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  globalState = context.globalState;
  helpUrl = resolveHelpUrl(context);
  toolInvocationTokenRequired = new Set(
    globalState.get<string[]>('lmToolsBridge.toolInvocationTokenRequired', []),
  );
  const startCommand = vscode.commands.registerCommand(START_COMMAND_ID, () => {
    void startMcpServer(outputChannel);
  });
  const stopCommand = vscode.commands.registerCommand(STOP_COMMAND_ID, () => {
    void stopMcpServer(outputChannel);
  });
  const configureCommand = vscode.commands.registerCommand(CONFIGURE_COMMAND_ID, () => {
    void configureExposedTools();
  });
  const helpCommand = vscode.commands.registerCommand(HELP_COMMAND_ID, () => {
    void openHelpDoc();
  });
  const statusMenuCommand = vscode.commands.registerCommand(STATUS_MENU_COMMAND_ID, () => {
    void showStatusMenu(outputChannel);
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
    statusBarItem,
    startCommand,
    stopCommand,
    configureCommand,
    helpCommand,
    statusMenuCommand,
    takeOverCommand,
    configWatcher,
    { dispose: () => { void stopMcpServer(outputChannel); } },
  );

  const config = getServerConfig();
  void (async () => {
    if (config.autoStart) {
      await startMcpServer(outputChannel);
    }
    await refreshStatusBar();
    if (!statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        void refreshStatusBar();
      }, STATUS_REFRESH_INTERVAL_MS);
    }
  })();
  logInfo('Extension activated.');
  void vscode.commands.executeCommand('setContext', 'lmToolsBridge.statusBar', true);
}

export function deactivate(): void {
  if (statusRefreshTimer) {
    clearInterval(statusRefreshTimer);
    statusRefreshTimer = undefined;
  }
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
  const tools = getExposedToolsSnapshot();
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

function showEnabledToolsDump(channel: vscode.OutputChannel): void {
  channel.clear();
  channel.show(true);
  dumpLmTools(channel);
}

function getServerConfig(): ServerConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    autoStart: config.get<boolean>('server.autoStart', true),
    host: config.get<string>('server.host', DEFAULT_HOST),
    port: config.get<number>('server.port', DEFAULT_PORT),
  };
}

function getEnabledToolsSetting(): string[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const enabled = config.get<string[]>(CONFIG_ENABLED_TOOLS, DEFAULT_ENABLED_TOOL_NAMES);
  return Array.isArray(enabled) ? enabled.filter((name) => typeof name === 'string') : [];
}

function getBlacklistPatterns(): string[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<string>(CONFIG_BLACKLIST, '');
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.toLowerCase());
}

function isToolBlacklisted(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const lowered = name.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

function isToolInternallyBlacklisted(name: string): boolean {
  return INTERNAL_BLACKLIST.has(name);
}

async function setEnabledTools(enabled: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(CONFIG_ENABLED_TOOLS, enabled, vscode.ConfigurationTarget.Global);
}

async function resetEnabledTools(): Promise<void> {
  await setEnabledTools([...DEFAULT_ENABLED_TOOL_NAMES]);
}

async function configureExposedTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const tools = lm.tools;
  if (tools.length === 0) {
    void vscode.window.showInformationMessage('No tools found in vscode.lm.tools.');
    return;
  }

  const blacklistPatterns = getBlacklistPatterns();
  const visibleTools = tools.filter((tool) => {
    if (isToolInternallyBlacklisted(tool.name)) {
      return false;
    }
    return !isToolBlacklisted(tool.name, blacklistPatterns);
  });
  if (visibleTools.length === 0) {
    void vscode.window.showWarningMessage('All tools are hidden by the blacklist configuration.');
    return;
  }

  const enabledSet = new Set(getEnabledToolsSetting());
  const items: Array<vscode.QuickPickItem & { toolName?: string; isReset?: boolean }> = [];

  items.push({
    label: '$(refresh) Reset (default enabled list)',
    description: 'Restore the default enabled tool list',
    alwaysShow: true,
    isReset: true,
  });
  items.push({ label: 'Tools', kind: vscode.QuickPickItemKind.Separator });

  for (const tool of visibleTools) {
    items.push({
      label: tool.name,
      description: tool.description,
      detail: tool.tags.length > 0 ? tool.tags.join(', ') : undefined,
      picked: enabledSet.has(tool.name),
      toolName: tool.name,
    });
  }

  const selections = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Configure exposed LM tools',
    placeHolder: 'Select tools to expose to MCP',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selections) {
    return;
  }

  const shouldReset = selections.some((item) => item.isReset);
  if (shouldReset) {
    await resetEnabledTools();
    void vscode.window.showInformationMessage('Enabled tools reset to defaults.');
    return;
  }

  const selectedNames = new Set(
    selections
      .map((item) => item.toolName)
      .filter((name): name is string => typeof name === 'string'),
  );

  await setEnabledTools(Array.from(selectedNames));
  void vscode.window.showInformationMessage(`Enabled ${selectedNames.size} tool(s) for MCP.`);
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
  if (state.state === 'owner') {
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
    updateStatusBar({ state: 'owner', ownerWorkspacePath: serverState.ownerWorkspacePath });
    return true;
  }

  const config = override ?? getServerConfig();
  const { host, port } = config;
  const ownerWorkspacePath = getOwnerWorkspacePath();
  const server = http.createServer((req, res) => {
    void handleMcpHttpRequest(req, res, channel);
  });

  const started = await new Promise<boolean>((resolve) => {
    server.once('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        logWarn(`Port ${port} is already in use. Another VS Code instance may be hosting MCP.`);
        logWarn('Use "LM Tools Bridge: Take Over Server" to reclaim the port.');
        updateStatusBar({ state: 'nonOwner' });
      } else {
        logError(`Failed to start MCP server: ${String(error)}`);
        updateStatusBar({ state: 'off' });
      }
      try {
        server.close();
      } catch {
        // Ignore close errors.
      }
      resolve(false);
    });
    server.listen(port, host, () => {
      serverState = {
        server,
        host,
        port,
        ownerWorkspacePath,
      };
      logInfo(`MCP server listening at http://${host}:${port}/mcp`);
      updateStatusBar({ state: 'owner', ownerWorkspacePath });
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

  if (requestUrl.pathname === CONTROL_STATUS_PATH) {
    await handleControlStatus(req, res);
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
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) => (
    originalSend(stripMcpEnvelopeFields(message), options)
  );
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

async function handleControlStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  respondJson(res, 200, {
    ownerWorkspacePath: serverState?.ownerWorkspacePath ?? null,
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

function requestRemoteStatus(host: string, port: number): Promise<{ ownerWorkspacePath?: string } | undefined> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host,
        port,
        path: CONTROL_STATUS_PATH,
        method: 'GET',
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            resolve(undefined);
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(text) as { ownerWorkspacePath?: string | null };
            resolve({
              ownerWorkspacePath: parsed.ownerWorkspacePath ?? undefined,
            });
          } catch {
            resolve(undefined);
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, 1500);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve(undefined);
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

  const toolDetailSchema = z.enum(['names', 'full'])
    .describe('Detail level for listTools only. Use full to get complete tool info if needed.');
  const listToolsSchema = z.object({
    action: z.literal('listTools'),
    detail: toolDetailSchema.optional(),
  }).strict().describe('List tools with optional detail. Only "action" (must be "listTools") and optional "detail" are allowed.');
  const getToolInfoSchema = z.object({
    action: z.literal('getToolInfo'),
    name: z.string()
      .describe('Target tool name. Required for getToolInfo.'),
  }).strict().describe('Get tool info. Always returns full detail including inputSchema.');
  const invokeToolSchema = z.object({
    action: z.literal('invokeTool'),
    name: z.string()
      .describe('Target tool name. Required for invokeTool.'),
    input: z.object({}).passthrough()
      .describe('Target tool input object. See lm-tools://schema/{name}.')
      .optional(),
    includeBinary: z.boolean()
      .describe('Include base64 for binary data parts in tool results.')
      .optional(),
  }).strict().describe('Invoke a tool with input.');
  const toolkitSchema: z.ZodTypeAny = z.discriminatedUnion('action', [
    listToolsSchema,
    getToolInfoSchema,
    invokeToolSchema,
  ]).describe('Toolkit wrapper for listing/inspecting/invoking tools. listTools only supports action/detail; getToolInfo always returns full detail.');

  // @ts-expect-error TS2589: Deep instantiation from SDK tool generics.
  server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
    'vscodeLmToolkit',
    {
      description: [
        'List, inspect, and invoke tools from vscode.lm.tools.',
        'Valid actions: "listTools" | "getToolInfo" | "invokeTool".',
        '• listTools only allows { action, detail? } and defaults to detail="names". Use detail="full" when you need all tool info.',
        '• getToolInfo requires { action:"getToolInfo", name } and always returns full detail (no detail parameter).',
        '• invokeTool requires { action:"invokeTool", name, input? } and the input must be an object.',
        'Use lm-tools://schema/{name} for tool input shapes before invoking.',
      ].join('\n'),
      inputSchema: toolkitSchema,
    },
    async (args: ToolkitInput) => {
      try {
        logInfo(`vscodeLmToolkit request: ${formatLogPayload(args)}`);
        const lm = getLanguageModelNamespace();
        if (!lm) {
          return toolErrorResult('vscode.lm is not available in this VS Code version.');
        }

        const tools = getExposedToolsSnapshot();
        const detail: ToolDetail = args.detail ?? 'names';

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
          if (args.detail !== undefined) {
            return toolErrorResult('detail is not supported for getToolInfo; full detail is always returned.');
          }
          logInfo(`vscodeLmToolkit action=getToolInfo name=${tool.name} detail=full`);
          return toolSuccessResult(toolInfoPayload(tool, 'full'));
        }

        const input = args.input ?? {};
        if (!isPlainObject(input)) {
          return toolErrorResultPayload({
            error: 'Tool input must be an object (not a JSON string). Use lm-tools://schema/{name} for the expected shape.',
            name: tool.name,
            inputSchema: tool.inputSchema ?? null,
          });
        }
        const normalizedInput = applyInputDefaultsToToolInput(input, tool.inputSchema);
        logInfo(`vscodeLmToolkit invoking tool ${tool.name} with input: ${formatLogPayload(normalizedInput)}`);
        const result = await lm.invokeTool(tool.name, {
          input: normalizedInput,
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
              ? getExposedToolsSnapshot().find((tool) => tool.name === args.name)?.inputSchema ?? null
              : null,
          });
        }
        return toolErrorResultPayload({
          error: message,
          name: args.name,
          inputSchema: args.name
            ? getExposedToolsSnapshot().find((tool) => tool.name === args.name)?.inputSchema ?? null
            : null,
        });
      }
    },
  );

  const getWorkspaceDescription = 'getVSCodeWorkspace: Get current VS Code workspace paths. Input schema is an empty object. Before using other tools, call getVSCodeWorkspace to verify the workspace. If it does not match, ask the user to confirm.';
  const getWorkspaceSchema: z.ZodTypeAny = z.object({}).strict().describe('No input.');

  server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
    'getVSCodeWorkspace',
    {
      description: getWorkspaceDescription,
      inputSchema: getWorkspaceSchema,
    },
    async () => toolSuccessResult({
      ownerWorkspacePath: getOwnerWorkspacePath(),
      workspaceFolders: getWorkspaceFoldersInfo(),
    }),
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
      description: 'Run a chat request via VS Code Language Model API with tool calling. Input schema: { messages: [{ role, content, name? }], modelId?, modelFamily?, maxIterations?, toolMode?, justification?, modelOptions? }.',
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
        const tools = getExposedToolsSnapshot();
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
      return resourceJson('lm-tools://names', listToolsPayload(getExposedToolsSnapshot(), 'names'));
    },
  );

  const policyPayload = {
    order: [
      'lm-tools://mcp-tool/getVSCodeWorkspace',
      'lm-tools://schema/{name}',
      'invokeTool (see lm-tools://tool/{name})',
    ],
    schemaUriFormat: 'lm-tools://schema/{name}',
    schemaUriNote: 'Replace {name} with the exact tool name (e.g., lm-tools://schema/copilot_readFile).',
    workspaceUri: 'lm-tools://mcp-tool/getVSCodeWorkspace',
    toolUriFormat: 'lm-tools://tool/{name}',
    note: 'Use getVSCodeWorkspace to verify the workspace, then read the target tool schema before invoking any tool.',
  };

  server.registerResource(
    'lmToolsPolicy',
    'lm-tools://policy',
    { description: 'Call order policy: use getVSCodeWorkspace (lm-tools://mcp-tool/getVSCodeWorkspace) to verify workspace, then read tool schema (lm-tools://schema/{name}), then invokeTool (see lm-tools://tool/{name}).' },
    async () => {
      logInfo('Resource read: lm-tools://policy');
      return resourceJson('lm-tools://policy', policyPayload);
    },
  );

  const mcpToolTemplate = new ResourceTemplate('lm-tools://mcp-tool/{name}', {
    list: () => {
      logInfo('Resource list: lm-tools://mcp-tool/{name}');
      return {
        resources: [
          {
            uri: 'lm-tools://mcp-tool/getVSCodeWorkspace',
            name: 'getVSCodeWorkspace',
            description: getWorkspaceDescription,
          },
        ],
      };
    },
    complete: {
      name: (value) => {
        logInfo(`Resource complete: lm-tools://mcp-tool/{name} value=${value}`);
        return ['getVSCodeWorkspace'].filter((name) => name.startsWith(value));
      },
    },
  });

  server.registerResource(
    'mcpTools',
    mcpToolTemplate,
    { description: 'Read MCP-native tool definition by name. Supported: getVSCodeWorkspace. Call it first to verify the workspace; if it does not match, ask the user to confirm.' },
    async (uri, variables) => {
      const name = readTemplateVariable(variables, 'name');
      logInfo(`Resource read: ${uri.toString()} name=${name ?? ''}`);
      if (!name) {
        return resourceJson(uri.toString(), { error: 'Tool name is required.' });
      }
      if (name !== 'getVSCodeWorkspace') {
        return resourceJson(uri.toString(), { error: `Tool not found: ${name}` });
      }
      return resourceJson(uri.toString(), {
        name: 'getVSCodeWorkspace',
        description: getWorkspaceDescription,
        inputSchema: {},
      });
    },
  );

  const toolTemplate = new ResourceTemplate('lm-tools://tool/{name}', {
    list: () => {
      logInfo('Resource list: lm-tools://tool/{name}');
      return {
        resources: prioritizeTool(getExposedToolsSnapshot(), 'getVSCodeWorkspace').map((tool) => ({
          uri: `lm-tools://tool/${tool.name}`,
          name: tool.name,
          description: tool.description,
        })),
      };
    },
    complete: {
      name: (value) => {
        logInfo(`Resource complete: lm-tools://tool/{name} value=${value}`);
        return getExposedToolsSnapshot()
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
      const tool = getExposedToolsSnapshot().find((candidate) => candidate.name === name);
      if (!tool) {
        return resourceJson(uri.toString(), { error: `Tool not found or disabled: ${name}` });
      }
      return resourceJson(uri.toString(), toolInfoPayload(tool, 'full'));
    },
  );

  const schemaTemplate = new ResourceTemplate('lm-tools://schema/{name}', {
    list: () => {
      logInfo('Resource list: lm-tools://schema/{name}');
      return { resources: [] };
    },
    complete: {
      name: (value) => {
        logInfo(`Resource complete: lm-tools://schema/{name} value=${value}`);
        return getExposedToolsSnapshot()
          .map((tool) => tool.name)
          .filter((name) => name.startsWith(value));
      },
    },
  });

  server.registerResource(
    'lmToolsSchema',
    schemaTemplate,
    { description: 'Read tool input schema by name. Call it before invoking the tool to satisfy the validator.' },
    async (uri, variables) => {
      const name = readTemplateVariable(variables, 'name');
      logInfo(`Resource read: ${uri.toString()} name=${name ?? ''}`);
      if (!name) {
        return resourceJson(uri.toString(), { error: 'Tool name is required.' });
      }
      const tool = getExposedToolsSnapshot().find((candidate) => candidate.name === name);
      if (!tool) {
        return resourceJson(uri.toString(), { error: `Tool not found or disabled: ${name}` });
      }
      return resourceJson(uri.toString(), { name: tool.name, inputSchema: applySchemaDefaults(tool.inputSchema ?? null) });
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
    const toolsSnapshot = getExposedToolsSnapshot();
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
  const orderedTools = prioritizeTool(tools, 'getVSCodeWorkspace');
  if (detail === 'names') {
    return { tools: orderedTools.map((tool) => tool.name) };
  }

  return {
    tools: orderedTools.map((tool) => toolInfoPayload(tool, 'full')),
  };
}

function toolInfoPayload(tool: vscode.LanguageModelToolInformation, detail: ToolDetail) {
  if (detail === 'names') {
    return {
      name: tool.name,
    };
  }

  return {
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    inputSchema: applySchemaDefaults(tool.inputSchema ?? null),
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
      const textParts = extractPromptTsxText(part.value);
      parts.push({
        type: 'prompt-tsx',
        textParts,
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
      'lmToolsBridge.toolInvocationTokenRequired',
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

function extractPromptTsxText(value: unknown): string[] {
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
  return parts;
}

function joinPromptTsxTextParts(parts: readonly string[]): string {
  let result = '';
  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }
    if (result.length === 0) {
      result = part;
      continue;
    }

    const prevChar = result[result.length - 1];
    const nextChar = part[0];
    if (prevChar && nextChar && !/\s/u.test(prevChar) && !/\s/u.test(nextChar)) {
      if (startsWithWindowsAbsolutePath(part) || startsWithListMarker(part)) {
        result += '\n';
      } else if (isWordChar(prevChar) && isWordChar(nextChar)) {
        result += ' ';
      }
    }

    result += part;
  }

  return result;
}

function startsWithWindowsAbsolutePath(text: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(text) || text.startsWith('\\\\');
}

function startsWithListMarker(text: string): boolean {
  return /^(\d+[.)]\s+|[-*•]\s+)/u.test(text);
}

function isWordChar(char: string): boolean {
  return /[0-9A-Za-z_]/u.test(char);
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
        let input = toolCall.input;
        if (isPlainObject(input)) {
          const toolSchema = tools.find((tool) => tool.name === toolCall.name)?.inputSchema;
          input = applyInputDefaultsToToolInput(input, toolSchema ?? null);
        }
        const result = await lm.invokeTool(toolCall.name, {
          input,
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

function stripMcpEnvelopeFields<T>(message: T): T {
  if (Array.isArray(message)) {
    return message.map((entry) => stripMcpEnvelopeFields(entry)) as T;
  }
  if (!isPlainObject(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const result = record.result;
  if (!isPlainObject(result)) {
    return message;
  }
  if (!('raw' in result) && !('structuredContent' in result)) {
    return message;
  }
  const { raw: _raw, structuredContent: _structuredContent, ...rest } = result;
  return {
    ...record,
    result: rest,
  } as T;
}


function getLanguageModelNamespace(): typeof vscode.lm | undefined {
  const possibleLm = (vscode as { lm?: typeof vscode.lm }).lm;
  return possibleLm;
}

function getAllLmToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const lm = getLanguageModelNamespace();
  return lm ? lm.tools : [];
}

function getVisibleToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const blacklistPatterns = getBlacklistPatterns();
  return getAllLmToolsSnapshot().filter((tool) => {
    if (isToolInternallyBlacklisted(tool.name)) {
      return false;
    }
    return !isToolBlacklisted(tool.name, blacklistPatterns);
  });
}

function getExposedToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const enabledSet = new Set(getEnabledToolsSetting());
  const blacklistPatterns = getBlacklistPatterns();
  return getAllLmToolsSnapshot().filter((tool) => {
    if (isToolInternallyBlacklisted(tool.name)) {
      return false;
    }
    if (isToolBlacklisted(tool.name, blacklistPatterns)) {
      return false;
    }
    return enabledSet.has(tool.name);
  });
}

async function getOwnershipState(): Promise<OwnershipInfo> {
  if (serverState) {
    return {
      state: 'owner',
      ownerWorkspacePath: serverState.ownerWorkspacePath,
    };
  }

  const config = getServerConfig();
  const available = await isPortAvailable(config.host, config.port);
  if (available) {
    return { state: 'off' };
  }

  const remote = await requestRemoteStatus(config.host, config.port);
  return {
    state: 'nonOwner',
    ownerWorkspacePath: remote?.ownerWorkspacePath,
  };
}

function updateStatusBar(info: OwnershipInfo): void {
  if (!statusBarItem) {
    return;
  }

  const config = getServerConfig();
  const tooltip = buildStatusTooltip(info.ownerWorkspacePath, config.host, config.port);
  statusBarItem.command = STATUS_MENU_COMMAND_ID;
  if (info.state === 'owner') {
    statusBarItem.text = '$(lock) LM Tools Bridge: Owner';
    statusBarItem.tooltip = tooltip;
    statusBarItem.color = undefined;
  } else if (info.state === 'nonOwner') {
    statusBarItem.text = '$(debug-disconnect) LM Tools Bridge: Non-owner';
    statusBarItem.tooltip = `${tooltip}\nClick to take over.`;
    statusBarItem.color = undefined;
  } else {
    statusBarItem.text = '$(circle-slash) LM Tools Bridge: Off';
    statusBarItem.tooltip = `LM Tools Bridge server is not running (${config.host}:${config.port}). Click to take over.`;
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

async function showStatusMenu(channel: vscode.OutputChannel): Promise<void> {
  const ownership = await getOwnershipState();
  const items: Array<vscode.QuickPickItem & { action?: 'takeOver' | 'configure' | 'dump' | 'help' | 'reload' }> = [
    {
      label: '$(debug-disconnect) Take Over MCP',
      description: ownership.state === 'owner' ? 'Already owning the MCP server' : 'Acquire ownership of the MCP port',
      action: 'takeOver',
    },
    {
      label: '$(settings-gear) Configure Exposed Tools',
      description: 'Enable/disable tools exposed via MCP',
      action: 'configure',
    },
    {
      label: '$(list-unordered) Dump Enabled Tools',
      description: 'Show enabled tool descriptions in Output',
      action: 'dump',
    },
    {
      label: '$(refresh) Reload Window',
      description: 'Reload VS Code window',
      action: 'reload',
    },
    { label: 'Help', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(book) Help',
      description: 'Open README on GitHub',
      action: 'help',
    },
  ];

  const selection = await vscode.window.showQuickPick(items, {
    title: 'LM Tools Bridge',
    placeHolder: 'Select an action',
  });
  if (!selection || !selection.action) {
    return;
  }

  if (selection.action === 'takeOver') {
    await handleTakeOverCommand(channel);
    return;
  }

  if (selection.action === 'configure') {
    await configureExposedTools();
    return;
  }

  if (selection.action === 'dump') {
    showEnabledToolsDump(channel);
    return;
  }

  if (selection.action === 'help') {
    await openHelpDoc();
    return;
  }

  if (selection.action === 'reload') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
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
  const info = await getOwnershipState();
  updateStatusBar(info);
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

function getOwnerWorkspacePath(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return 'No workspace open';
  }
  return folders.map((folder) => folder.uri.fsPath).join('; ');
}

function prioritizeTool(
  tools: readonly vscode.LanguageModelToolInformation[],
  preferredName: string,
): vscode.LanguageModelToolInformation[] {
  const ordered = [...tools];
  ordered.sort((left, right) => {
    if (left.name === preferredName) {
      return -1;
    }
    if (right.name === preferredName) {
      return 1;
    }
    return 0;
  });
  return ordered;
}

function extractSchemaPropertyNames(schema: unknown): Set<string> | undefined {
  const names = new Set<string>();
  collectSchemaPropertyNames(schema, names);
  return names.size > 0 ? names : undefined;
}

function collectSchemaPropertyNames(schema: unknown, out: Set<string>): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      collectSchemaPropertyNames(entry, out);
    }
    return;
  }
  const record = schema as Record<string, unknown>;
  const props = record.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>)) {
      out.add(key);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectSchemaPropertyNames(entry, out);
      }
    }
  }
}

function extractSchemaRequiredNames(schema: unknown): Set<string> | undefined {
  const requiredNames = new Set<string>();
  collectSchemaRequiredNames(schema, requiredNames);
  return requiredNames.size > 0 ? requiredNames : undefined;
}

function collectSchemaRequiredNames(schema: unknown, out: Set<string>): void {
  if (!schema || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      collectSchemaRequiredNames(entry, out);
    }
    return;
  }
  const record = schema as Record<string, unknown>;
  const required = extractRequired(record);
  if (required) {
    for (const name of required) {
      out.add(name);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectSchemaRequiredNames(entry, out);
      }
    }
  }
}

function getWorkspaceFoldersInfo(): Array<{ name: string; path: string }> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }
  return folders.map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
  }));
}

function resolveHelpUrl(context: vscode.ExtensionContext): string | undefined {
  const packageJson = context.extension.packageJSON as { homepage?: string };
  const homepage = packageJson?.homepage?.trim();
  return homepage && homepage.length > 0 ? homepage : undefined;
}

function applySchemaDefaults(schema: unknown): unknown {
  const overrides = getSchemaDefaultOverrides();
  return applySchemaDefaultsInternal(schema, overrides, undefined);
}

function applyInputDefaultsToToolInput(
  input: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  const overrides = getSchemaDefaultOverrides();
  const allowed = extractSchemaPropertyNames(schema);
  const required = extractSchemaRequiredNames(schema);
  const result: Record<string, unknown> = { ...input };
  for (const [name, value] of Object.entries(overrides)) {
    if (name in result && result[name] !== undefined) {
      continue;
    }
    if (!allowed || !allowed.has(name)) {
      continue;
    }
    if (required && required.has(name)) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function applySchemaDefaultsInternal(
  schema: unknown,
  overrides: Record<string, unknown>,
  requiredNames: Set<string> | undefined,
): unknown {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => applySchemaDefaultsInternal(item, overrides, undefined));
  }

  const record = schema as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  const currentRequired = extractRequired(record) ?? requiredNames;

  for (const [key, value] of Object.entries(record)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = value as Record<string, unknown>;
      const newProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(props)) {
        if (propSchema && typeof propSchema === 'object') {
          const propCopy = { ...(propSchema as Record<string, unknown>) };
          const defaultValue = resolveSchemaDefault(propName, overrides);
          const isRequired = currentRequired?.has(propName) ?? false;
          if (defaultValue !== undefined && !isRequired && !('default' in propCopy)) {
            propCopy.default = defaultValue;
          }
          newProps[propName] = applySchemaDefaultsInternal(propCopy, overrides, extractRequired(propCopy));
        } else {
          newProps[propName] = applySchemaDefaultsInternal(propSchema, overrides, undefined);
        }
      }
      copy[key] = newProps;
      continue;
    }

    if (key === 'items') {
      copy[key] = applySchemaDefaultsInternal(value, overrides, undefined);
      continue;
    }

    if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
      copy[key] = value.map((entry) => applySchemaDefaultsInternal(entry, overrides, undefined));
      continue;
    }

    copy[key] = applySchemaDefaultsInternal(value, overrides, undefined);
  }

  return copy;
}

function extractRequired(schemaRecord: Record<string, unknown>): Set<string> | undefined {
  const required = schemaRecord.required;
  if (Array.isArray(required) && required.every((item) => typeof item === 'string')) {
    return new Set(required as string[]);
  }
  return undefined;
}

function getSchemaDefaultOverrides(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const fromConfig = config.get<unknown>('tools.schemaDefaults', {});
  if (!fromConfig || typeof fromConfig !== 'object' || Array.isArray(fromConfig)) {
    return { ...BUILTIN_SCHEMA_DEFAULTS };
  }
  return { ...BUILTIN_SCHEMA_DEFAULTS, ...(fromConfig as Record<string, unknown>) };
}

function resolveSchemaDefault(name: string, overrides: Record<string, unknown>): unknown {
  if (name in overrides) {
    return overrides[name];
  }
  return undefined;
}

async function openHelpDoc(): Promise<void> {
  const url = helpUrl;
  if (!url) {
    void vscode.window.showWarningMessage('No help URL is configured.');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

function buildStatusTooltip(ownerWorkspacePath: string | undefined, host: string, port: number): string {
  const pathValue = ownerWorkspacePath ?? 'unknown';
  const paths = pathValue
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const pathLines = paths.length > 0 ? paths.map((entry) => `- ${entry}`).join('\n') : '- unknown';
  return `Owner workspace:\n${pathLines}\nurl = "http://${host}:${port}/mcp"`;
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
