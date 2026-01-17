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
const CONFIGURE_BLACKLIST_COMMAND_ID = 'lm-tools-bridge.configureBlacklist';
const STATUS_MENU_COMMAND_ID = 'lm-tools-bridge.statusMenu';
const HELP_COMMAND_ID = 'lm-tools-bridge.openHelp';
const CONFIG_SECTION = 'lmToolsBridge';
const CONFIG_ENABLED_TOOLS = 'tools.enabled';
const CONFIG_BLACKLIST = 'tools.blacklist';
const CONFIG_RESPONSE_FORMAT = 'tools.responseFormat';
const CONFIG_DEBUG = 'debug';
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
  'copilot_getErrors',
  'copilot_readProjectStructure',
  'copilot_getChangedFiles',
  'copilot_testFailure',
  'copilot_findTestFiles',
  'copilot_getSearchResults',
  'get_terminal_output',
  'terminal_selection',
  'terminal_last_command',
];
const DEFAULT_BLACKLISTED_TOOL_NAMES = [
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
  'copilot_getDocInfo',
  'copilot_listDirectory',
  'runSubagent',
  'vscode_get_confirmation',
  'inline_chat_exit',
];

const BUILTIN_SCHEMA_DEFAULTS: Record<string, unknown> = {
  maxResults: 1000,
};

type ToolAction = 'listTools' | 'getToolInfo' | 'invokeTool';
type ToolDetail = 'names' | 'full';
type ResponseFormat = 'text' | 'structured' | 'both';
type DebugLevel = 'off' | 'simple' | 'detail';

interface ToolkitInput {
  action: ToolAction;
  name?: string;
  detail?: ToolDetail;
  input?: unknown;
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

type OwnershipState = 'current-owner' | 'other-owner' | 'off';
interface OwnershipInfo {
  state: OwnershipState;
  ownerWorkspacePath?: string;
}

let serverState: McpServerState | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let logChannel: vscode.LogOutputChannel | undefined;
let helpUrl: string | undefined;
let statusRefreshTimer: NodeJS.Timeout | undefined;
let lastOwnershipState: OwnershipState | undefined;
let lastOwnerWorkspacePath: string | undefined;
let lastRemoteStatusResult: 'success' | 'failure' | undefined;
let lastStatusLogMessage: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  logChannel = outputChannel as vscode.LogOutputChannel;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  helpUrl = resolveHelpUrl(context);
  const startCommand = vscode.commands.registerCommand(START_COMMAND_ID, () => {
    void startMcpServer(outputChannel);
  });
  const stopCommand = vscode.commands.registerCommand(STOP_COMMAND_ID, () => {
    void stopMcpServer(outputChannel);
  });
  const configureCommand = vscode.commands.registerCommand(CONFIGURE_COMMAND_ID, () => {
    void configureExposedTools();
  });
  const configureBlacklistCommand = vscode.commands.registerCommand(CONFIGURE_BLACKLIST_COMMAND_ID, () => {
    void configureBlacklistedTools();
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
  const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (serverState) {
      serverState.ownerWorkspacePath = getOwnerWorkspacePath();
    }
    void refreshStatusBar();
  });

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    startCommand,
    stopCommand,
    configureCommand,
    configureBlacklistCommand,
    helpCommand,
    statusMenuCommand,
    takeOverCommand,
    configWatcher,
    workspaceWatcher,
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
  logStatusInfo('Extension activated.');
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
    host: DEFAULT_HOST,
    port: config.get<number>('server.port', DEFAULT_PORT),
  };
}

function getConfigurationResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getToolsConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION, getConfigurationResource());
}

function getWorkspaceFolderForResource(resource?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  if (resource) {
    const folder = vscode.workspace.getWorkspaceFolder(resource);
    if (folder) {
      return folder;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

async function hasWorkspaceSettingsFile(resource?: vscode.Uri): Promise<boolean> {
  const folder = getWorkspaceFolderForResource(resource);
  if (!folder) {
    return false;
  }
  const settingsUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json');
  try {
    await vscode.workspace.fs.stat(settingsUri);
    return true;
  } catch {
    return false;
  }
}

async function resolveToolsConfigTarget(resource?: vscode.Uri): Promise<vscode.ConfigurationTarget> {
  const hasWorkspaceSettings = await hasWorkspaceSettingsFile(resource);
  if (!hasWorkspaceSettings) {
    return vscode.ConfigurationTarget.Global;
  }
  if (vscode.workspace.workspaceFile) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return vscode.ConfigurationTarget.Workspace;
}

function getEnabledToolsSetting(): string[] {
  const config = getToolsConfiguration();
  const enabled = config.get<string[]>(CONFIG_ENABLED_TOOLS, DEFAULT_ENABLED_TOOL_NAMES);
  return Array.isArray(enabled) ? enabled.filter((name) => typeof name === 'string') : [];
}

function getBlacklistedToolsSetting(): string[] {
  const config = getToolsConfiguration();
  const blacklisted = config.get<string[]>(CONFIG_BLACKLIST, DEFAULT_BLACKLISTED_TOOL_NAMES);
  return Array.isArray(blacklisted) ? blacklisted.filter((name) => typeof name === 'string') : [];
}

function isToolBlacklisted(name: string, blacklistedSet: ReadonlySet<string>): boolean {
  return blacklistedSet.has(name);
}

async function setEnabledTools(enabled: string[]): Promise<void> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  await config.update(CONFIG_ENABLED_TOOLS, enabled, target);
}

async function setBlacklistedTools(blacklisted: string[]): Promise<boolean> {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const target = await resolveToolsConfigTarget(resource);
  await config.update(CONFIG_BLACKLIST, blacklisted, target);
  const enabled = getEnabledToolsSetting();
  const blacklistedSet = new Set(blacklisted);
  const filtered = enabled.filter((name) => !blacklistedSet.has(name));
  if (filtered.length !== enabled.length) {
    await setEnabledTools(filtered);
    return true;
  }
  return false;
}

async function resetEnabledTools(): Promise<void> {
  await setEnabledTools([...DEFAULT_ENABLED_TOOL_NAMES]);
}

async function resetBlacklistedTools(): Promise<boolean> {
  return setBlacklistedTools([...DEFAULT_BLACKLISTED_TOOL_NAMES]);
}

async function configureExposedTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const allTools = getAllLmToolsSnapshot();
  if (allTools.length === 0) {
    void vscode.window.showInformationMessage('No tools found in vscode.lm.tools.');
    return;
  }
  const tools = getVisibleToolsSnapshot();
  if (tools.length === 0) {
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

  for (const tool of tools) {
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

async function configureBlacklistedTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const tools = getAllLmToolsSnapshot();
  if (tools.length === 0) {
    void vscode.window.showInformationMessage('No tools found in vscode.lm.tools.');
    return;
  }

  const blacklistedSet = new Set(getBlacklistedToolsSetting());
  const items: Array<vscode.QuickPickItem & { toolName?: string; isReset?: boolean }> = [];

  items.push({
    label: '$(refresh) Reset (default blacklist)',
    description: 'Restore the default blacklist',
    alwaysShow: true,
    isReset: true,
  });
  items.push({ label: 'Tools', kind: vscode.QuickPickItemKind.Separator });

  for (const tool of tools) {
    items.push({
      label: tool.name,
      description: tool.description,
      detail: tool.tags.length > 0 ? tool.tags.join(', ') : undefined,
      picked: blacklistedSet.has(tool.name),
      toolName: tool.name,
    });
  }

  const selections = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Configure blacklisted LM tools',
    placeHolder: 'Select tools to hide/disable',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selections) {
    return;
  }

  const shouldReset = selections.some((item) => item.isReset);
  if (shouldReset) {
    const removed = await resetBlacklistedTools();
    const message = removed
      ? 'Blacklisted tools reset to defaults and removed from enabled list.'
      : 'Blacklisted tools reset to defaults.';
    void vscode.window.showInformationMessage(message);
    return;
  }

  const selectedNames = new Set(
    selections
      .map((item) => item.toolName)
      .filter((name): name is string => typeof name === 'string'),
  );

  const removed = await setBlacklistedTools(Array.from(selectedNames));
  const message = removed
    ? `Blacklisted ${selectedNames.size} tool(s) and removed them from enabled list.`
    : `Blacklisted ${selectedNames.size} tool(s).`;
  void vscode.window.showInformationMessage(message);
}

async function takeOverMcpServer(channel: vscode.OutputChannel): Promise<void> {
  const config = getServerConfig();
  if (serverState && serverState.host === config.host && serverState.port === config.port) {
    void vscode.window.showInformationMessage('MCP server is already running in this VS Code instance.');
    return;
  }

  logStatusInfo(`Take over MCP server (${config.host}:${config.port})`);
  const stopResult = await requestRemoteStop(config.host, config.port);
  if (!stopResult) {
    logStatusWarn('No remote MCP server responded to stop request (or it is not updated yet).');
  }

  const started = await startMcpServerWithRetry(channel, config.host, config.port, 6, 400);
  if (!started) {
    void vscode.window.showWarningMessage('Failed to take over MCP server. Port may still be in use.');
  }
}

async function handleTakeOverCommand(channel: vscode.OutputChannel): Promise<void> {
  const state = await getOwnershipState();
  if (state.state === 'current-owner') {
    void vscode.window.showInformationMessage('This VS Code instance is the current-owner of the MCP server.');
    return;
  }

  const selection = await vscode.window.showWarningMessage(
    'This VS Code instance is not the current-owner of the MCP server. Take over control?',
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

async function startMcpServer(
  channel: vscode.OutputChannel,
  override?: { host: string; port: number; suppressPortInUseLog?: boolean },
): Promise<boolean> {
  if (serverState) {
    logStatusInfo(`MCP server already running at http://${serverState.host}:${serverState.port}/mcp`);
    updateStatusBar({ state: 'current-owner', ownerWorkspacePath: serverState.ownerWorkspacePath });
    return true;
  }

  const config = override ?? getServerConfig();
  const { host, port } = config;
  const suppressPortInUseLog = override?.suppressPortInUseLog ?? false;
  const ownerWorkspacePath = getOwnerWorkspacePath();
  const server = http.createServer((req, res) => {
    void handleMcpHttpRequest(req, res, channel);
  });

  const started = await new Promise<boolean>((resolve) => {
    server.once('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        if (!suppressPortInUseLog) {
          logStatusWarn(`Port ${port} is already in use. Another VS Code instance may be hosting MCP.`);
          logStatusWarn('Use "LM Tools Bridge: Take Over Server" to reclaim the port.');
        }
        updateStatusBar({ state: 'other-owner' });
      } else {
        logStatusError(`Failed to start MCP server: ${String(error)}`);
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
      logStatusInfo(`MCP server listening at http://${host}:${port}/mcp`);
      updateStatusBar({ state: 'current-owner', ownerWorkspacePath });
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
      logStatusInfo(`MCP server stopped at http://${host}:${port}/mcp`);
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
  transport.onerror = () => {
    // Swallow per-request transport errors to avoid noisy logs.
  };

  try {
    await server.connect(transport);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req, res);
  } catch (error) {
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
  logStatusInfo('Received MCP take-over request, shutting down server.');
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
    const started = await startMcpServer(channel, { host, port, suppressPortInUseLog: true });
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
            if (lastRemoteStatusResult !== 'failure') {
              logStatusWarn(`Port status read failed (${host}:${port})`);
              lastRemoteStatusResult = 'failure';
            }
            resolve(undefined);
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(text) as { ownerWorkspacePath?: string | null };
            lastRemoteStatusResult = 'success';
            resolve({
              ownerWorkspacePath: parsed.ownerWorkspacePath ?? undefined,
            });
          } catch {
            if (lastRemoteStatusResult !== 'failure') {
              logStatusWarn(`Port status read failed (${host}:${port})`);
              lastRemoteStatusResult = 'failure';
            }
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
      if (lastRemoteStatusResult !== 'failure') {
        logStatusWarn(`Port status read failed (${host}:${port})`);
        lastRemoteStatusResult = 'failure';
      }
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
      const debugLevel = getDebugLevel();
      const requestStartTime = Date.now();
      let debugInput: unknown = args;
      let debugOutputText: string | undefined;
      let debugStructuredOutput: unknown;
      let debugInvokeInput: Record<string, unknown> | undefined;
      let debugError: unknown;
      try {
        const lm = getLanguageModelNamespace();
        if (!lm) {
          return toolErrorResult('vscode.lm is not available in this VS Code version.');
        }

        const tools = getExposedToolsSnapshot();
        const detail: ToolDetail = args.detail ?? 'names';

        if (args.action === 'listTools') {
          const payload = listToolsPayload(tools, detail);
          const text = detail === 'full'
            ? tools.map((tool) => formatToolInfoText(toolInfoPayload(tool, 'full'))).join('\n\n')
            : formatToolNameList(tools);
          debugInput = { action: 'listTools', detail };
          debugOutputText = text;
          debugStructuredOutput = payload;
          return buildToolResult(payload, false, text);
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
          const payload = toolInfoPayload(tool, 'full');
          const text = formatToolInfoText(payload);
          debugInput = { action: 'getToolInfo', name: tool.name };
          debugOutputText = text;
          debugStructuredOutput = payload;
          return buildToolResult(payload, false, text);
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
        debugInvokeInput = normalizedInput;
        let outputText: string | undefined;
        let structuredOutput: { blocks: unknown[] } | undefined;
        try {
          const result = await lm.invokeTool(tool.name, {
            input: normalizedInput,
            toolInvocationToken: undefined,
          });
          const serialized = serializeToolResult(result);
          outputText = tool.name === 'copilot_findTextInFiles'
            ? normalizeFindTextInFilesText(serializedToolResultToText(serialized))
            : serializedToolResultToText(serialized);
          structuredOutput = { blocks: toolResultToStructuredBlocks(serialized) };
          debugOutputText = outputText;
          debugStructuredOutput = structuredOutput;
          return buildToolResult(structuredOutput, false, outputText);
        } catch (error) {
          debugError = error;
          throw error;
        }
      } catch (error) {
        const message = String(error);
        debugError = error;
        return toolErrorResultPayload({
          error: message,
          name: args.name,
          inputSchema: args.name
            ? getExposedToolsSnapshot().find((tool) => tool.name === args.name)?.inputSchema ?? null
            : null,
        });
      } finally {
        const durationMs = Date.now() - requestStartTime;
        if (debugLevel !== 'off') {
          if (args.action === 'invokeTool') {
            logInfo(`vscodeLmToolkit invokeTool name=${args.name ?? ''} input=${formatLogPayload(debugInvokeInput ?? {})} durationMs=${durationMs}`);
          } else {
            logInfo(`vscodeLmToolkit ${args.action} input=${formatLogPayload(debugInput)} durationMs=${durationMs}`);
          }
        }
        if (debugLevel === 'detail') {
          if (debugError) {
            logInfo(`vscodeLmToolkit ${args.action} error: ${String(debugError)}`);
          } else {
            logInfo(`vscodeLmToolkit ${args.action} output: ${debugOutputText ?? ''}`);
            if (getResponseFormat() !== 'text') {
              logInfo(`vscodeLmToolkit ${args.action} structured output: ${formatLogPayload(debugStructuredOutput)}`);
            }
          }
        }
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
    async () => toolTextResult(formatWorkspaceInfoText({
      ownerWorkspacePath: getOwnerWorkspacePath(),
      workspaceFolders: getWorkspaceFoldersInfo(),
    })),
  );

  server.registerResource(
    'lmToolsNames',
    'lm-tools://names',
    { description: 'List exposed tool names.' },
    async () => {
      logDebugDetail('Resource read: lm-tools://names');
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
      logDebugDetail('Resource read: lm-tools://policy');
      return resourceJson('lm-tools://policy', policyPayload);
    },
  );

  const mcpToolTemplate = new ResourceTemplate('lm-tools://mcp-tool/{name}', {
    list: () => {
      logDebugDetail('Resource list: lm-tools://mcp-tool/{name}');
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
        logDebugDetail(`Resource complete: lm-tools://mcp-tool/{name} value=${value}`);
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
      logDebugDetail(`Resource read: ${uri.toString()} name=${name ?? ''}`);
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
      logDebugDetail('Resource list: lm-tools://tool/{name}');
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
        logDebugDetail(`Resource complete: lm-tools://tool/{name} value=${value}`);
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
      logDebugDetail(`Resource read: ${uri.toString()} name=${name ?? ''}`);
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
      logDebugDetail('Resource list: lm-tools://schema/{name}');
      return { resources: [] };
    },
    complete: {
      name: (value) => {
        logDebugDetail(`Resource complete: lm-tools://schema/{name} value=${value}`);
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
      logDebugDetail(`Resource read: ${uri.toString()} name=${name ?? ''}`);
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

function toolSuccessResult(payload: unknown) {
  return buildToolResult(payload, false);
}

function toolTextResult(text: string) {
  return buildToolResult(text, false, text);
}

function toolErrorResult(message: string) {
  return buildToolResult({ error: message }, true, message);
}

function toolErrorResultPayload(payload: unknown) {
  const textOverride = isPlainObject(payload) ? formatToolErrorText(payload) : undefined;
  return buildToolResult(payload, true, textOverride);
}

function buildToolResult(payload: unknown, isError: boolean, textOverride?: string) {
  const responseFormat = getResponseFormat();
  const text = textOverride ?? payloadToText(payload);
  const structuredContent = responseFormat === 'text'
    ? undefined
    : (isPlainObject(payload) ? payload : { text });

  if (responseFormat === 'structured') {
    return {
      content: [],
      structuredContent,
      ...(isError ? { isError: true } : {}),
    };
  }

  if (responseFormat === 'both') {
    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
      structuredContent,
      ...(isError ? { isError: true } : {}),
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function payloadToText(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (Array.isArray(payload)) {
    const segments = payload.map(payloadToText).filter((segment) => segment.length > 0);
    return joinPromptTsxTextParts(segments);
  }
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (Array.isArray(record.textParts)) {
      const textParts = record.textParts.filter((part): part is string => typeof part === 'string');
      if (textParts.length > 0) {
        return joinPromptTsxTextParts(textParts);
      }
    }
    if (Array.isArray(record.result)) {
      const text = serializedToolResultToText(record.result);
      if (text.length > 0) {
        return text;
      }
    }
    if (Array.isArray(record.tools)) {
      const toolText = toolListToText(record.tools);
      if (toolText.length > 0) {
        return toolText;
      }
    }
    if (Array.isArray(record.content)) {
      const contentText = toolResultContentToText(record.content);
      if (contentText.length > 0) {
        return contentText;
      }
    }
    return unescapeNewlines(safePrettyStringify(record));
  }
  return String(payload);
}

function toolListToText(tools: readonly unknown[]): string {
  const entries: string[] = [];
  for (const tool of tools) {
    if (typeof tool === 'string') {
      entries.push(tool);
      continue;
    }
    if (tool && typeof tool === 'object') {
      const record = tool as Record<string, unknown>;
      if (typeof record.name === 'string') {
        if (typeof record.description === 'string' && record.description.length > 0) {
          entries.push(`${record.name}: ${record.description}`);
        } else {
          entries.push(record.name);
        }
      }
    }
  }
  return entries.join('\n');
}

function formatToolNameList(tools: readonly vscode.LanguageModelToolInformation[]): string {
  const orderedTools = prioritizeTool(tools, 'getVSCodeWorkspace');
  return orderedTools.map((tool) => tool.name).join('\n');
}

function formatToolInfoText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name) {
    lines.push(`name: ${name}`);
  }
  const description = typeof payload.description === 'string' ? payload.description : '';
  if (description) {
    lines.push(`description: ${description}`);
  }
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  if (tags.length > 0) {
    lines.push('tags:');
    for (const tag of tags) {
      lines.push(`  - ${tag}`);
    }
  }
  if (payload.inputSchema !== undefined) {
    lines.push('inputSchema:');
    lines.push(indentLines(formatSchema(payload.inputSchema as object | undefined), 2));
  }
  const toolUri = typeof payload.toolUri === 'string' ? payload.toolUri : '';
  if (toolUri) {
    lines.push(`toolUri: ${toolUri}`);
  }
  const schemaUri = typeof payload.schemaUri === 'string' ? payload.schemaUri : '';
  if (schemaUri) {
    lines.push(`schemaUri: ${schemaUri}`);
  }
  if (payload.usageHint !== undefined) {
    lines.push('usageHint:');
    lines.push(indentLines(safePrettyStringify(payload.usageHint), 2));
  }
  return lines.join('\n');
}

function formatToolErrorText(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const error = typeof payload.error === 'string' ? payload.error : 'Unknown error';
  lines.push(`error: ${error}`);
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name) {
    lines.push(`name: ${name}`);
  }
  const requiresToken = payload.requiresToolInvocationToken === true;
  if (requiresToken) {
    lines.push('requiresToolInvocationToken: true');
  }
  const hint = typeof payload.hint === 'string' ? payload.hint : '';
  if (hint) {
    lines.push(`hint: ${hint}`);
  }
  if (payload.inputSchema !== undefined) {
    lines.push('inputSchema:');
    lines.push(indentLines(formatSchema(payload.inputSchema as object | undefined), 2));
  }
  return lines.join('\n');
}

function formatWorkspaceInfoText(payload: {
  ownerWorkspacePath?: string;
  workspaceFolders: Array<{ name: string; path: string }>;
}): string {
  const lines: string[] = [];
  if (payload.ownerWorkspacePath) {
    lines.push(`ownerWorkspacePath: ${payload.ownerWorkspacePath}`);
  }
  if (payload.workspaceFolders.length > 0) {
    lines.push('workspaceFolders:');
    for (const folder of payload.workspaceFolders) {
      lines.push(`  - name: ${folder.name}`);
      lines.push(`    path: ${folder.path}`);
    }
  }
  return lines.join('\n');
}

function resourceJson(uri: string, payload: unknown) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text,
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

function patchFindTextInFilesSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return schema;
  }
  const propRecord = properties as Record<string, unknown>;
  const querySchema = propRecord.query;
  if (!querySchema || typeof querySchema !== 'object' || Array.isArray(querySchema)) {
    return schema;
  }
  const queryCopy = { ...(querySchema as Record<string, unknown>) };
  const description = typeof queryCopy.description === 'string' ? queryCopy.description : '';
  if (!description || description.includes('case-sensitive')) {
    return schema;
  }
  queryCopy.description = `${description} If you need case-sensitive matching, use a regex pattern with an inline case-sensitivity flag.`;
  return {
    ...record,
    properties: {
      ...propRecord,
      query: queryCopy,
    },
  };
}

function toolInfoPayload(tool: vscode.LanguageModelToolInformation, detail: ToolDetail) {
  if (detail === 'names') {
    return {
      name: tool.name,
    };
  }
  const inputSchema = applySchemaDefaults(tool.inputSchema ?? null);

  return {
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    inputSchema: tool.name === 'copilot_findTextInFiles' ? patchFindTextInFilesSchema(inputSchema) : inputSchema,
    toolUri: getToolUri(tool.name),
    schemaUri: getSchemaUri(tool.name),
    usageHint: getToolUsageHint(tool),
  };
}

function serializeToolResult(result: vscode.LanguageModelToolResult): Array<Record<string, unknown>> {
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
      parts.push({
        type: 'prompt-tsx',
        value: part.value,
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

function serializedToolResultToText(parts: readonly Record<string, unknown>[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    const text = serializedToolResultPartToText(part);
    if (text.length > 0) {
      segments.push(text);
    }
  }
  return joinPromptTsxTextParts(segments);
}

function normalizeFindTextInFilesText(text: string): string {
  const matchRegex = /<match\s+path="([^"]+)"\s+line="?(\d+)"?\s*>\s*([\s\S]*?)<\/match>/gi;
  const summaryRegex = /(\d{1,5})\s+matches?\b[^\r\n]*?\bmaxResults\s+capped\s+at\s+(\d{1,5})\b/i;

  const matches: Array<{ key: string; raw: string }> = [];
  const seen = new Set<string>();
  let totalCount = 0;
  const firstMatchIndex = text.search(/<match\b/i);
  const prefix = firstMatchIndex === -1 ? text : text.slice(0, firstMatchIndex);
  let summaryCount: number | null = null;
  let summaryCap: number | null = null;
  const summaryMatch = summaryRegex.exec(prefix);
  if (summaryMatch) {
    const countValue = Number(summaryMatch[1]);
    const capValue = Number(summaryMatch[2]);
    if (
      !Number.isNaN(countValue)
      && !Number.isNaN(capValue)
      && countValue >= 0
      && capValue >= 0
      && countValue <= 10000
      && capValue <= 10000
    ) {
      summaryCount = countValue;
      summaryCap = capValue;
    }
  }
  let match: RegExpExecArray | null;
  while ((match = matchRegex.exec(text)) !== null) {
    totalCount += 1;
    const path = match[1];
    const line = match[2];
    const snippet = match[3]?.replace(/\r\n/g, '\n').trimEnd() ?? '';
    const key = `${path}:${line}:${snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push({ key, raw: match[0].trimStart() });
  }

  if (matches.length === 0) {
    return text;
  }

  let capped: number | null = null;
  if (summaryCount !== null && summaryCap !== null && summaryCount >= summaryCap) {
    capped = summaryCap;
  }

  const lines: string[] = [];
  if (capped !== null) {
    lines.push('Results capped by VS Code tools, more results are available, output may be incomplete.');
  }
  lines.push(`Unique matches: ${matches.length}, total matches: ${totalCount}.`);
  return [...lines, ...matches.map((item) => item.raw)].join('\n');
}

function toolResultToStructuredBlocks(
  parts: readonly Record<string, unknown>[],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === 'data' && typeof part.text !== 'string') {
      continue;
    }
    blocks.push(part);
  }
  return blocks;
}

function serializedToolResultPartToText(part: Record<string, unknown>): string {
  if (part.type === 'text' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'prompt-tsx') {
    if (Array.isArray(part.textParts)) {
      const textParts = part.textParts.filter((item): item is string => typeof item === 'string');
      if (textParts.length > 0) {
        return joinPromptTsxTextParts(textParts);
      }
    }
    const value = part.value;
    if (value && typeof value === 'object') {
      const textParts = extractPromptTsxText(value as Record<string, unknown>);
      if (textParts.length > 0) {
        return joinPromptTsxTextParts(textParts);
      }
    }
    return '';
  }
  if (part.type === 'data' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'unknown' && typeof part.text === 'string') {
    return part.text;
  }
  return '';
}

function toolResultContentToText(content: readonly unknown[]): string {
  const parts: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (item instanceof vscode.LanguageModelTextPart) {
      parts.push({ type: 'text', text: item.value });
      continue;
    }
    if (item instanceof vscode.LanguageModelPromptTsxPart) {
      const textParts = extractPromptTsxText(item.value);
      parts.push({ type: 'prompt-tsx', textParts });
      continue;
    }
    if (item instanceof vscode.LanguageModelDataPart) {
      const decodedText = decodeTextData(item);
      if (decodedText !== undefined) {
        parts.push({ type: 'data', text: decodedText });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      if (typeof record.type === 'string') {
        parts.push(record);
      }
    }
  }
  return serializedToolResultToText(parts);
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

function safePrettyStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n');
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

  if (tool.tags.some((tag) => tag.includes('codesearch'))) {
    return {
      mode: 'toolkit',
      reason: 'Heuristic: codesearch tag; use vscodeLmToolkit.',
      toolkitInputNote,
    };
  }

  return {
    mode: 'toolkit',
    reason: 'Heuristic: default to vscodeLmToolkit.',
    requiresObjectInput: requiresObjectInput || undefined,
    toolkitInputNote,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeWorkspacePath(value: string | undefined): string {
  if (!value) {
    return 'No workspace open';
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'No workspace open';
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

function getAllLmToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const lm = getLanguageModelNamespace();
  return lm ? lm.tools : [];
}

function getVisibleToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const blacklistedSet = new Set(getBlacklistedToolsSetting());
  return getAllLmToolsSnapshot().filter((tool) => {
    return !isToolBlacklisted(tool.name, blacklistedSet);
  });
}

function getExposedToolsSnapshot(): readonly vscode.LanguageModelToolInformation[] {
  const enabledSet = new Set(getEnabledToolsSetting());
  const blacklistedSet = new Set(getBlacklistedToolsSetting());
  return getAllLmToolsSnapshot().filter((tool) => {
    if (isToolBlacklisted(tool.name, blacklistedSet)) {
      return false;
    }
    return enabledSet.has(tool.name);
  });
}

async function getOwnershipState(): Promise<OwnershipInfo> {
  if (serverState) {
    return {
      state: 'current-owner',
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
    state: 'other-owner',
    ownerWorkspacePath: remote?.ownerWorkspacePath,
  };
}

function updateStatusBar(info: OwnershipInfo): void {
  if (!statusBarItem) {
    return;
  }

  const config = getServerConfig();
  const ownerWorkspacePath = normalizeWorkspacePath(info.ownerWorkspacePath);
  const stateLabel = info.state === 'current-owner'
    ? 'current-owner'
    : (info.state === 'other-owner' ? 'other-owner' : 'off');
  let summary = `State: ${stateLabel} (${config.host}:${config.port})`;
  if (info.state === 'other-owner' && info.ownerWorkspacePath === undefined) {
    summary = '';
  } else if (info.state !== 'off') {
    summary = `${summary} workspace=${ownerWorkspacePath}`;
  }
  if (summary && summary !== lastStatusLogMessage) {
    logStatusInfo(summary);
    lastStatusLogMessage = summary;
    lastOwnershipState = info.state;
    lastOwnerWorkspacePath = ownerWorkspacePath;
  }
  const tooltip = buildStatusTooltip(info.ownerWorkspacePath, config.host, config.port);
  statusBarItem.command = STATUS_MENU_COMMAND_ID;
  if (info.state === 'current-owner') {
    statusBarItem.text = '$(lock) LM Tools Bridge: Current-owner';
    statusBarItem.tooltip = tooltip;
    statusBarItem.color = undefined;
  } else if (info.state === 'other-owner') {
    statusBarItem.text = '$(debug-disconnect) LM Tools Bridge: Other-owner';
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
  const items: Array<vscode.QuickPickItem & { action?: 'takeOver' | 'configure' | 'configureBlacklist' | 'dump' | 'help' | 'reload' }> = [
    {
      label: '$(debug-disconnect) Take Over MCP',
      description: ownership.state === 'current-owner' ? 'Already the current-owner of the MCP server' : 'Acquire current-owner control of the MCP port',
      action: 'takeOver',
    },
    {
      label: '$(settings-gear) Configure Exposed Tools',
      description: 'Enable/disable tools exposed via MCP',
      action: 'configure',
    },
    {
      label: '$(settings-gear) Configure Blacklisted Tools',
      description: 'Hide/disable tools before exposure',
      action: 'configureBlacklist',
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

  if (selection.action === 'configureBlacklist') {
    await configureBlacklistedTools();
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

function logStatusInfo(message: string): void {
  logInfo(message);
}

function logStatusWarn(message: string): void {
  logWarn(message);
}

function logStatusError(message: string): void {
  logError(message);
}

function logDebugDetail(message: string): void {
  if (getDebugLevel() === 'detail') {
    logInfo(message);
  }
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

function getResponseFormat(): ResponseFormat {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawValue = normalizeConfigString(config.get<string>(CONFIG_RESPONSE_FORMAT));
  const value = rawValue ? rawValue.toLowerCase() : '';
  if (value === 'structured' || value === 'both') {
    return value;
  }
  return 'text';
}

function getDebugLevel(): DebugLevel {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawValue = normalizeConfigString(config.get<string>(CONFIG_DEBUG));
  const value = rawValue ? rawValue.toLowerCase() : '';
  if (value === 'detail' || value === 'simple') {
    return value;
  }
  return 'off';
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
