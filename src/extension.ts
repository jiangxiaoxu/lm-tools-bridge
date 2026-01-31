import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  ensureManagerRunning,
  initManagerClient,
  requestManagerPortAllocation,
  restartManagerFromMenu,
  startManagerHeartbeat,
  stopManagerHeartbeat,
} from './managerClient';
import { CONFIG_SECTION, getConfigValue, setConfigurationWarningLogger } from './configuration';
import {
  buildToolInputSchema,
  configureBlacklistedTools,
  configureExposedTools,
  getDebugLevel,
  getExposedToolsSnapshot,
  listToolsPayload,
  prioritizeTool,
  registerExposedTools,
  setToolingLogger,
  showEnabledToolsDump,
  toolInfoPayload,
} from './tooling';

const OUTPUT_CHANNEL_NAME = 'lm-tools-bridge';
const START_COMMAND_ID = 'lm-tools-bridge.start';
const STOP_COMMAND_ID = 'lm-tools-bridge.stop';
const CONFIGURE_COMMAND_ID = 'lm-tools-bridge.configureTools';
const CONFIGURE_BLACKLIST_COMMAND_ID = 'lm-tools-bridge.configureBlacklist';
const STATUS_MENU_COMMAND_ID = 'lm-tools-bridge.statusMenu';
const HELP_COMMAND_ID = 'lm-tools-bridge.openHelp';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48123;
const HEALTH_PATH = '/mcp/health';
const STATUS_REFRESH_INTERVAL_MS = 3000;
const PORT_RETRY_LIMIT = 50;
const PORT_MIN_VALUE = 1;
const PORT_MAX_VALUE = 65535;

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
  requestedPort: number;
}

type ServerStatusState = 'running' | 'off' | 'port-in-use';
interface ServerStatusInfo {
  state: ServerStatusState;
  ownerWorkspacePath?: string;
  host?: string;
  port?: number;
}

let serverState: McpServerState | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let logChannel: vscode.LogOutputChannel | undefined;
let helpUrl: string | undefined;
let statusRefreshTimer: NodeJS.Timeout | undefined;
let lastServerStatus: ServerStatusState | undefined;
let lastOwnerWorkspacePath: string | undefined;
let lastStatusLogMessage: string | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
  logChannel = outputChannel as vscode.LogOutputChannel;
  setConfigurationWarningLogger(logWarn);
  setToolingLogger({
    info: logInfo,
    warn: logWarn,
    error: logError,
  });
  initManagerClient({
    getExtensionContext: () => extensionContext,
    getServerState: () => (serverState ? { host: serverState.host, port: serverState.port } : undefined),
    getConfigValue,
    isValidPort,
    logStatusInfo,
    logStatusWarn,
    logStatusError,
  });
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
  void stopManagerHeartbeat();
  if (serverState) {
    try {
      serverState.server.close();
    } catch {
      // Ignore shutdown errors.
    }
    serverState = undefined;
  }
}

function getServerConfig(): ServerConfig {
  return {
    autoStart: getConfigValue<boolean>('server.autoStart', true),
    host: DEFAULT_HOST,
    port: getConfigValue<number>('server.port', DEFAULT_PORT),
  };
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= PORT_MIN_VALUE
    && value <= PORT_MAX_VALUE;
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

  if (serverState.host !== config.host || serverState.requestedPort !== config.port) {
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
    updateStatusBar({
      state: 'running',
      ownerWorkspacePath: serverState.ownerWorkspacePath,
      host: serverState.host,
      port: serverState.port,
    });
    return true;
  }

  const config = override ?? getServerConfig();
  const { host } = config;
  const suppressPortInUseLog = override?.suppressPortInUseLog ?? false;
  const ownerWorkspacePath = getOwnerWorkspacePath();
  const preferredPort = config.port;
  let nextPort = preferredPort;
  let managerAvailable = await ensureManagerRunning();
  let lastError: NodeJS.ErrnoException | undefined;
  let lastTriedPort = preferredPort;

  for (let attempt = 0; attempt < PORT_RETRY_LIMIT; attempt += 1) {
    if (nextPort > PORT_MAX_VALUE) {
      break;
    }
    let portToTry = nextPort;
    if (managerAvailable) {
      const managerPort = await requestManagerPortAllocation(
        preferredPort,
        attempt === 0 ? undefined : nextPort,
      );
      if (managerPort !== undefined) {
        portToTry = managerPort;
      } else {
        managerAvailable = false;
      }
    }
    lastTriedPort = portToTry;

    const server = http.createServer((req, res) => {
      void handleMcpHttpRequest(req, res, channel);
    });

    const started = await new Promise<{ ok: boolean; error?: NodeJS.ErrnoException }>((resolve) => {
      server.once('error', (error) => {
        resolve({ ok: false, error: error as NodeJS.ErrnoException });
      });
      server.listen(portToTry, host, () => {
        resolve({ ok: true });
      });
    });

    if (started.ok) {
      serverState = {
        server,
        host,
        port: portToTry,
        ownerWorkspacePath,
        requestedPort: preferredPort,
      };
      if (portToTry !== preferredPort) {
        logStatusInfo(`MCP server auto-selected port ${portToTry} (requested ${preferredPort}).`);
      }
      logStatusInfo(`MCP server listening at http://${host}:${portToTry}/mcp`);
      updateStatusBar({ state: 'running', ownerWorkspacePath, host, port: portToTry });
      await startManagerHeartbeat();
      return true;
    }

    const error = started.error;
    lastError = error;
    if (error?.code !== 'EADDRINUSE') {
      logStatusError(`Failed to start MCP server: ${String(error)}`);
      updateStatusBar({ state: 'off', host, port: portToTry });
      try {
        server.close();
      } catch {
        // Ignore close errors.
      }
      return false;
    }

    if (!suppressPortInUseLog) {
      logDebugDetail(`Port ${portToTry} is already in use. Trying next port.`);
    }
    try {
      server.close();
    } catch {
      // Ignore close errors.
    }
    nextPort = portToTry + 1;
  }

  if (lastError?.code === 'EADDRINUSE' && !suppressPortInUseLog) {
    logStatusWarn(`Port ${lastTriedPort} is already in use. Another VS Code instance may be hosting MCP.`);
    updateStatusBar({ state: 'port-in-use', host, port: lastTriedPort });
  } else {
    updateStatusBar({ state: 'off', host, port: lastTriedPort });
  }
  return false;
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
  await stopManagerHeartbeat();
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

  registerExposedTools(server);

  server.registerResource(
    'lmToolsNames',
    'lm-tools://names',
    { description: 'List exposed tool names.' },
    async () => {
      logDebugDetail('Resource read: lm-tools://names');
      return resourceJson('lm-tools://names', listToolsPayload(getExposedToolsSnapshot(), 'names'));
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
        throw new McpError(ErrorCode.InvalidParams, 'Tool name is required.');
      }
      const tool = getExposedToolsSnapshot().find((candidate) => candidate.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found or disabled: ${name}`);
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
        throw new McpError(ErrorCode.InvalidParams, 'Tool name is required.');
      }
      const tool = getExposedToolsSnapshot().find((candidate) => candidate.name === name);
      if (!tool) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found or disabled: ${name}`);
      }
      return resourceJson(uri.toString(), { name: tool.name, inputSchema: buildToolInputSchema(tool) });
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
    const status = await getServerStatus();
    const toolsSnapshot = getExposedToolsSnapshot();
    const toolsCount = toolsSnapshot.length;
    const toolNames = toolsSnapshot.map((tool) => tool.name);
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath,
    })) ?? [];

    respondJson(res, 200, {
      ok: true,
      status,
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


function normalizeWorkspacePath(value: string | undefined): string {
  if (!value) {
    return 'No workspace open';
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'No workspace open';
}

function getWorkspaceTooltipLines(ownerWorkspacePath: string | undefined): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return [
      'Workspace folders:',
      ...folders.map((folder) => `- ${folder.name}: ${folder.uri.fsPath}`),
    ];
  }
  const normalized = normalizeWorkspacePath(ownerWorkspacePath);
  return [`Workspace: ${normalized}`];
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


async function getServerStatus(): Promise<ServerStatusInfo> {
  if (serverState) {
    return {
      state: 'running',
      ownerWorkspacePath: serverState.ownerWorkspacePath,
      host: serverState.host,
      port: serverState.port,
    };
  }
  return { state: 'off' };
}

function updateStatusBar(info: ServerStatusInfo): void {
  if (!statusBarItem) {
    return;
  }

  const config = getServerConfig();
  const host = info.host ?? config.host;
  const port = info.port ?? config.port;
  const ownerWorkspacePath = normalizeWorkspacePath(info.ownerWorkspacePath);
  const workspaceLines = getWorkspaceTooltipLines(info.ownerWorkspacePath);
  const workspaceText = workspaceLines.length > 0 ? `\n${workspaceLines.join('\n')}` : '';
  const workspaceSuffix = ` (${ownerWorkspacePath})`;
  const stateLabel = info.state;
  let summary = `State: ${stateLabel} (${host}:${port})`;
  if (info.state !== 'off') {
    summary = `${summary} workspace=${ownerWorkspacePath}`;
  }
  if (summary && summary !== lastStatusLogMessage) {
    logStatusInfo(summary);
    lastStatusLogMessage = summary;
    lastServerStatus = info.state;
    lastOwnerWorkspacePath = ownerWorkspacePath;
  }
  statusBarItem.command = STATUS_MENU_COMMAND_ID;
  if (info.state === 'running') {
    statusBarItem.text = '$(play-circle) LM Tools Bridge: Running';
    statusBarItem.tooltip = `LM Tools Bridge server is running (${host}:${port})${workspaceText}`;
    statusBarItem.color = undefined;
  } else if (info.state === 'port-in-use') {
    statusBarItem.text = '$(warning) LM Tools Bridge: Port In Use';
    statusBarItem.tooltip = `Port ${port} is already in use (${host}).${workspaceText}`;
    statusBarItem.color = undefined;
  } else {
    statusBarItem.text = '$(circle-slash) LM Tools Bridge: Off';
    statusBarItem.tooltip = `LM Tools Bridge server is not running (${host}:${port}).${workspaceText}`;
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

async function showStatusMenu(channel: vscode.OutputChannel): Promise<void> {
  const items: Array<vscode.QuickPickItem & { action?: 'configure' | 'configureBlacklist' | 'dump' | 'help' | 'restartManager' }> = [
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
      label: '$(sync) Restart Manager',
      description: 'Restart the manager process',
      action: 'restartManager',
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

  if (selection.action === 'restartManager') {
    await restartManagerFromMenu();
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
  const info = await getServerStatus();
  updateStatusBar(info);
}

function getOwnerWorkspacePath(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return 'No workspace open';
  }
  return folders.map((folder) => folder.uri.fsPath).join('; ');
}

function resolveHelpUrl(context: vscode.ExtensionContext): string | undefined {
  const packageJson = context.extension.packageJSON as { homepage?: string };
  const homepage = packageJson?.homepage?.trim();
  return homepage && homepage.length > 0 ? homepage : undefined;
}

async function openHelpDoc(): Promise<void> {
  const url = helpUrl;
  if (!url) {
    void vscode.window.showWarningMessage('No help URL is configured.');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}



