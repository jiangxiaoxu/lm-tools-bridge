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
  getManagerTooltipStatus,
  type ManagerTooltipInstanceInfo,
  type ManagerRestartUiEvent,
  type ManagerTooltipStatus,
  requestManagerPortAllocation,
  restartManagerFromMenu,
  startManagerHeartbeat,
  stopManagerHeartbeat,
} from './managerClient';
import {
  clearUseWorkspaceSettingsFromUserSettings,
  CONFIG_SECTION,
  CONFIG_USE_WORKSPACE_SETTINGS,
  getConfigScopeDescription,
  getConfigValue,
  getConfigurationResource,
  setConfigurationWarningLogger,
  USE_WORKSPACE_SETTINGS_USER_SCOPE_WARNING,
} from './configuration';
import {
  buildToolInputSchema,
  configureEnabledTools,
  configureExposureTools,
  getDebugLevel,
  getEnabledExposedToolsSnapshot,
  listToolsPayload,
  normalizeToolSelectionState,
  prioritizeTool,
  registerExposedTools,
  setToolingLogger,
  showEnabledToolsDump,
  toolInfoPayload,
} from './tooling';

const OUTPUT_CHANNEL_NAME = 'lm-tools-bridge';
const START_COMMAND_ID = 'lm-tools-bridge.start';
const STOP_COMMAND_ID = 'lm-tools-bridge.stop';
const CONFIGURE_EXPOSURE_COMMAND_ID = 'lm-tools-bridge.configureExposure';
const CONFIGURE_ENABLED_COMMAND_ID = 'lm-tools-bridge.configureEnabled';
const STATUS_MENU_COMMAND_ID = 'lm-tools-bridge.statusMenu';
const HELP_COMMAND_ID = 'lm-tools-bridge.openHelp';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48123;
const HEALTH_PATH = '/mcp/health';
const STATUS_REFRESH_INTERVAL_MS = 3000;
const PORT_RETRY_LIMIT = 50;
const PORT_MIN_VALUE = 1;
const PORT_MAX_VALUE = 65535;
const LEGACY_ENABLED_TOOLS_KEY = 'tools.enabled';
const LEGACY_BLACKLIST_KEY = 'tools.blacklist';
const LEGACY_BLACKLIST_PATTERNS_KEY = 'tools.blacklistPatterns';
const WORKSPACE_ONLY_SETTING_REMOVED_MESSAGE = 'lmToolsBridge.useWorkspaceSettings is workspace-only and has been removed from User settings.';
const MANAGER_TOOLTIP_MAX_LINES = 9;
const MANAGER_TOOLTIP_MAX_CHARS = 420;
const MANAGER_TOOLTIP_OTHER_INSTANCE_LIMIT = 2;
const MANAGER_TOOLTIP_SESSION_ID_PREFIX_LENGTH = 8;
const MANAGER_TOOLTIP_WORKSPACE_MAX_LENGTH = 48;
const MANAGER_RESTART_SUCCESS_SETTLE_MS = 1000;
const MANAGER_RESTART_FAILED_SETTLE_MS = 8000;

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
  managerTooltipModel?: ManagerTooltipModel;
}

type ManagerOwnership = 'current' | 'other' | 'unknown';
interface ManagerTooltipModel {
  managerStatus: ManagerTooltipStatus;
  ownership: ManagerOwnership;
  ownershipReason?: string;
  currentSessionId?: string;
  currentInstance?: ManagerTooltipInstanceInfo;
  otherInstances: ManagerTooltipInstanceInfo[];
}

interface ManagerTooltipLine {
  text: string;
  priority: number;
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
let enforcingWorkspaceOnlySetting = false;
let managerRestartUiState: ManagerRestartUiEvent | undefined;
let managerRestartSettleTimer: NodeJS.Timeout | undefined;

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
  void enforceWorkspaceOnlyUseWorkspaceSettings();
  void cleanupLegacyToolSelectionSettings();
  void normalizeToolSelectionState();
  initManagerClient({
    getExtensionContext: () => extensionContext,
    getServerState: () => (serverState ? { host: serverState.host, port: serverState.port } : undefined),
    getConfigValue,
    isValidPort,
    logStatusInfo,
    logStatusWarn,
    logStatusError,
    onManagerRestartUiEvent: handleManagerRestartUiEvent,
  });
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  helpUrl = resolveHelpUrl(context);
  const startCommand = vscode.commands.registerCommand(START_COMMAND_ID, () => {
    void startMcpServer(outputChannel);
  });
  const stopCommand = vscode.commands.registerCommand(STOP_COMMAND_ID, () => {
    void stopMcpServer(outputChannel);
  });
  const configureExposureCommand = vscode.commands.registerCommand(CONFIGURE_EXPOSURE_COMMAND_ID, () => {
    void configureExposureTools();
  });
  const configureEnabledCommand = vscode.commands.registerCommand(CONFIGURE_ENABLED_COMMAND_ID, () => {
    void configureEnabledTools();
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
    if (
      event.affectsConfiguration(`${CONFIG_SECTION}.tools.exposedDelta`)
      || event.affectsConfiguration(`${CONFIG_SECTION}.tools.unexposedDelta`)
      || event.affectsConfiguration(`${CONFIG_SECTION}.tools.enabledDelta`)
      || event.affectsConfiguration(`${CONFIG_SECTION}.tools.disabledDelta`)
    ) {
      void normalizeToolSelectionState();
    }
    if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_USE_WORKSPACE_SETTINGS}`)) {
      void enforceWorkspaceOnlyUseWorkspaceSettings();
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
    configureExposureCommand,
    configureEnabledCommand,
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
  clearManagerRestartSettleTimer();
  managerRestartUiState = undefined;
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

async function cleanupLegacyToolSelectionSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const keys = [
    LEGACY_ENABLED_TOOLS_KEY,
    LEGACY_BLACKLIST_KEY,
    LEGACY_BLACKLIST_PATTERNS_KEY,
  ] as const;
  const updates: Array<Thenable<void>> = [];
  for (const key of keys) {
    const inspection = config.inspect<unknown>(key);
    if (!inspection) {
      continue;
    }
    if (inspection.globalValue !== undefined) {
      updates.push(config.update(key, undefined, vscode.ConfigurationTarget.Global));
    }
    if (inspection.workspaceValue !== undefined) {
      updates.push(config.update(key, undefined, vscode.ConfigurationTarget.Workspace));
    }
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const folderConfig = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
    for (const key of keys) {
      const folderInspection = folderConfig.inspect<unknown>(key);
      if (folderInspection?.workspaceFolderValue !== undefined) {
        updates.push(folderConfig.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder));
      }
    }
  }
  if (updates.length > 0) {
    await Promise.all(updates);
  }
}

async function enforceWorkspaceOnlyUseWorkspaceSettings(): Promise<void> {
  if (enforcingWorkspaceOnlySetting) {
    return;
  }
  enforcingWorkspaceOnlySetting = true;
  try {
    const removed = await clearUseWorkspaceSettingsFromUserSettings();
    if (!removed) {
      return;
    }
    logWarn(USE_WORKSPACE_SETTINGS_USER_SCOPE_WARNING);
    void vscode.window.showWarningMessage(WORKSPACE_ONLY_SETTING_REMOVED_MESSAGE);
  } finally {
    enforcingWorkspaceOnlySetting = false;
  }
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
      return resourceJson('lm-tools://names', listToolsPayload(getEnabledExposedToolsSnapshot(), 'names'));
    },
  );

  const toolTemplate = new ResourceTemplate('lm-tools://tool/{name}', {
    list: () => {
      logDebugDetail('Resource list: lm-tools://tool/{name}');
      return {
        resources: prioritizeTool(getEnabledExposedToolsSnapshot(), 'getVSCodeWorkspace').map((tool) => ({
          uri: `lm-tools://tool/${tool.name}`,
          name: tool.name,
          description: tool.description,
        })),
      };
    },
    complete: {
      name: (value) => {
        logDebugDetail(`Resource complete: lm-tools://tool/{name} value=${value}`);
        return getEnabledExposedToolsSnapshot()
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
      const tool = getEnabledExposedToolsSnapshot().find((candidate) => candidate.name === name);
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
        return getEnabledExposedToolsSnapshot()
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
      const tool = getEnabledExposedToolsSnapshot().find((candidate) => candidate.name === name);
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
    const toolsSnapshot = getEnabledExposedToolsSnapshot();
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
  const configScopeDescription = getConfigScopeDescription(getConfigurationResource());
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return [
      'Workspace folders:',
      ...folders.map((folder) => `- ${folder.name}: ${folder.uri.fsPath}`),
      `Config scope: ${configScopeDescription}`,
    ];
  }
  const normalized = normalizeWorkspacePath(ownerWorkspacePath);
  return [
    `Workspace: ${normalized}`,
    `Config scope: ${configScopeDescription}`,
  ];
}

function shortSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    return 'n/a';
  }
  return sessionId.slice(0, MANAGER_TOOLTIP_SESSION_ID_PREFIX_LENGTH);
}

function trimMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  const headLength = Math.ceil((maxLength - 3) / 2);
  const tailLength = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, headLength)}...${value.slice(value.length - tailLength)}`;
}

function getInstancePrimaryWorkspace(instance: ManagerTooltipInstanceInfo): string {
  const sources = instance.workspaceFolders.length > 0
    ? instance.workspaceFolders
    : (instance.workspaceFile ? [instance.workspaceFile] : []);
  if (sources.length === 0) {
    return 'n/a';
  }
  const primary = sources[0];
  const baseName = path.basename(primary);
  const label = (baseName && baseName.trim().length > 0) ? baseName : primary;
  const trimmed = trimMiddle(label, MANAGER_TOOLTIP_WORKSPACE_MAX_LENGTH);
  if (sources.length > 1) {
    return `${trimmed} (+${sources.length - 1})`;
  }
  return trimmed;
}

function clearManagerRestartSettleTimer(): void {
  if (!managerRestartSettleTimer) {
    return;
  }
  clearTimeout(managerRestartSettleTimer);
  managerRestartSettleTimer = undefined;
}

function handleManagerRestartUiEvent(event: ManagerRestartUiEvent): void {
  clearManagerRestartSettleTimer();
  managerRestartUiState = event;
  if (event.phase === 'success' || event.phase === 'failed') {
    const settleMs = event.phase === 'success'
      ? MANAGER_RESTART_SUCCESS_SETTLE_MS
      : MANAGER_RESTART_FAILED_SETTLE_MS;
    managerRestartSettleTimer = setTimeout(() => {
      managerRestartUiState = undefined;
      managerRestartSettleTimer = undefined;
      void refreshStatusBar();
    }, settleMs);
  }
  void refreshStatusBar();
}

function deriveOwnership(status: ManagerTooltipStatus): ManagerTooltipModel {
  const currentSessionId = vscode.env.sessionId;
  const currentInstance = currentSessionId
    ? status.instances.find((instance) => instance.sessionId === currentSessionId)
    : undefined;
  const otherInstances = status.instances.filter((instance) => instance.sessionId !== currentSessionId);
  if (!status.online) {
    return {
      managerStatus: status,
      ownership: 'unknown',
      ownershipReason: status.reason ?? 'manager offline',
      currentSessionId,
      currentInstance,
      otherInstances,
    };
  }
  if (currentSessionId && currentInstance) {
    return {
      managerStatus: status,
      ownership: 'current',
      currentSessionId,
      currentInstance,
      otherInstances,
    };
  }
  if (!currentSessionId) {
    return {
      managerStatus: status,
      ownership: 'unknown',
      ownershipReason: 'session unavailable',
      currentSessionId,
      currentInstance,
      otherInstances: status.instances,
    };
  }
  if (status.instances.length > 0) {
    return {
      managerStatus: status,
      ownership: 'other',
      currentSessionId,
      currentInstance,
      otherInstances: status.instances,
    };
  }
  return {
    managerStatus: status,
    ownership: 'unknown',
    ownershipReason: 'no instances',
    currentSessionId,
    currentInstance,
    otherInstances,
  };
}

function fitManagerTooltipLines(lines: ManagerTooltipLine[]): string[] {
  const sorted = [...lines].sort((left, right) => left.priority - right.priority);
  const selected: string[] = [];
  let usedChars = 0;
  for (const line of sorted) {
    if (selected.length >= MANAGER_TOOLTIP_MAX_LINES) {
      break;
    }
    const nextChars = usedChars + (selected.length > 0 ? 1 : 0) + line.text.length;
    if (nextChars > MANAGER_TOOLTIP_MAX_CHARS) {
      break;
    }
    selected.push(line.text);
    usedChars = nextChars;
  }
  const hiddenCount = sorted.length - selected.length;
  if (hiddenCount <= 0) {
    return selected;
  }
  const tail = `... +${hiddenCount} more`;
  if (selected.length < MANAGER_TOOLTIP_MAX_LINES) {
    const nextChars = usedChars + (selected.length > 0 ? 1 : 0) + tail.length;
    if (nextChars <= MANAGER_TOOLTIP_MAX_CHARS) {
      selected.push(tail);
      return selected;
    }
  }
  if (selected.length === 0) {
    return [trimMiddle(tail, MANAGER_TOOLTIP_MAX_CHARS)];
  }
  while (selected.length > 0) {
    const currentChars = selected.join('\n').length;
    if (currentChars + 1 + tail.length <= MANAGER_TOOLTIP_MAX_CHARS) {
      selected[selected.length - 1] = tail;
      return selected;
    }
    selected.pop();
  }
  return [tail];
}

function formatManagerTooltipLines(model: ManagerTooltipModel | undefined): string[] {
  if (!model) {
    return [];
  }
  const lines: ManagerTooltipLine[] = [];
  const managerReason = model.managerStatus.reason ? trimMiddle(model.managerStatus.reason, 90) : undefined;
  if (model.managerStatus.online) {
    lines.push({
      text: managerReason ? `Manager: online(${managerReason})` : 'Manager: online',
      priority: 1,
    });
  } else {
    lines.push({
      text: managerReason ? `Manager: offline(${managerReason})` : 'Manager: offline',
      priority: 1,
    });
  }
  if (model.ownership === 'unknown' && model.ownershipReason) {
    lines.push({
      text: `Ownership: unknown(${model.ownershipReason})`,
      priority: 2,
    });
  } else {
    lines.push({
      text: `Ownership: ${model.ownership}`,
      priority: 2,
    });
  }
  if (model.currentInstance) {
    lines.push({
      text: `Current: pid=${model.currentInstance.pid} sid=${shortSessionId(model.currentInstance.sessionId)} host=${model.currentInstance.host}:${model.currentInstance.port}`,
      priority: 3,
    });
    lines.push({
      text: `Workspace: ${getInstancePrimaryWorkspace(model.currentInstance)}`,
      priority: 4,
    });
  } else if (model.currentSessionId) {
    lines.push({
      text: `Current: sid=${shortSessionId(model.currentSessionId)} not registered`,
      priority: 3,
    });
  }
  if (model.otherInstances.length > 0) {
    lines.push({
      text: `Other instances: ${model.otherInstances.length}`,
      priority: 5,
    });
    const shownCount = Math.min(model.otherInstances.length, MANAGER_TOOLTIP_OTHER_INSTANCE_LIMIT);
    for (let i = 0; i < shownCount; i += 1) {
      const instance = model.otherInstances[i];
      lines.push({
        text: `- pid=${instance.pid} sid=${shortSessionId(instance.sessionId)} ws=${getInstancePrimaryWorkspace(instance)}`,
        priority: 6 + i,
      });
    }
    if (model.otherInstances.length > shownCount) {
      lines.push({
        text: `... +${model.otherInstances.length - shownCount} more`,
        priority: 8,
      });
    }
  }
  return fitManagerTooltipLines(lines);
}

async function fetchManagerTooltipModel(): Promise<ManagerTooltipModel> {
  let managerStatus: ManagerTooltipStatus;
  try {
    managerStatus = await getManagerTooltipStatus();
  } catch {
    managerStatus = {
      online: false,
      source: 'unavailable',
      reason: 'status query failed',
      instances: [],
    };
  }
  return deriveOwnership(managerStatus);
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
  const managerTooltipModel = await fetchManagerTooltipModel();
  if (serverState) {
    return {
      state: 'running',
      ownerWorkspacePath: serverState.ownerWorkspacePath,
      host: serverState.host,
      port: serverState.port,
      managerTooltipModel,
    };
  }
  return { state: 'off', managerTooltipModel };
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
  const managerLines = formatManagerTooltipLines(info.managerTooltipModel);
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
  const tooltipDetails: string[] = [];
  if (workspaceLines.length > 0) {
    tooltipDetails.push(...workspaceLines);
  }
  if (managerLines.length > 0) {
    if (tooltipDetails.length > 0) {
      tooltipDetails.push('');
    }
    tooltipDetails.push(...managerLines);
  }
  const tooltipDetailText = tooltipDetails.length > 0 ? `\n${tooltipDetails.join('\n')}` : '';
  const restartUiState = managerRestartUiState;
  if (restartUiState) {
    const sourceLine = `Restart source: ${restartUiState.source}`;
    const reasonLine = restartUiState.reason ? `Restart reason: ${restartUiState.reason}` : undefined;
    const messageLine = restartUiState.message
      ? `Restart details: ${trimMiddle(restartUiState.message, 120)}`
      : undefined;
    const restartLines = [sourceLine, reasonLine, messageLine].filter((line): line is string => Boolean(line));
    const restartTooltip = restartLines.length > 0 ? `\n${restartLines.join('\n')}` : '';
    if (restartUiState.phase === 'running') {
      statusBarItem.text = '$(sync~spin) LM Tools Bridge: Restarting Manager';
      statusBarItem.tooltip = `Manager restart in progress.${restartTooltip}${tooltipDetailText}`;
      statusBarItem.color = undefined;
      statusBarItem.show();
      return;
    }
    if (restartUiState.phase === 'success') {
      statusBarItem.text = '$(check) LM Tools Bridge: Restart Succeeded';
      statusBarItem.tooltip = `Manager restart completed.${restartTooltip}${tooltipDetailText}`;
      statusBarItem.color = undefined;
      statusBarItem.show();
      return;
    }
    statusBarItem.text = '$(error) LM Tools Bridge: Restart Failed';
    statusBarItem.tooltip = `Manager restart failed.${restartTooltip}${tooltipDetailText}`;
    statusBarItem.color = undefined;
    statusBarItem.show();
    return;
  }
  if (info.state === 'running') {
    statusBarItem.text = '$(play-circle) LM Tools Bridge: Running';
    statusBarItem.tooltip = `LM Tools Bridge server is running (${host}:${port})${tooltipDetailText}`;
    statusBarItem.color = undefined;
  } else if (info.state === 'port-in-use') {
    statusBarItem.text = '$(warning) LM Tools Bridge: Port In Use';
    statusBarItem.tooltip = `Port ${port} is already in use (${host}).${tooltipDetailText}`;
    statusBarItem.color = undefined;
  } else {
    statusBarItem.text = '$(circle-slash) LM Tools Bridge: Off';
    statusBarItem.tooltip = `LM Tools Bridge server is not running (${host}:${port}).${tooltipDetailText}`;
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

async function showStatusMenu(channel: vscode.OutputChannel): Promise<void> {
  const items: Array<vscode.QuickPickItem & { action?: 'configureExposure' | 'configureEnabled' | 'dump' | 'help' | 'restartManager' | 'openSettings' | 'openExtensionPage' }> = [
    {
      label: '$(settings-gear) Configure Exposure Tools',
      description: 'Choose tools available for MCP enablement',
      action: 'configureExposure',
    },
    {
      label: '$(settings-gear) Configure Enabled Tools',
      description: 'Enable only from the currently exposed tools',
      action: 'configureEnabled',
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
    {
      label: '$(settings) Open Settings',
      description: 'Open settings for this extension',
      action: 'openSettings',
    },
    {
      label: '$(extensions) Open Extension Page',
      description: 'Open this extension page in VS Code',
      action: 'openExtensionPage',
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

  if (selection.action === 'configureExposure') {
    await configureExposureTools();
    return;
  }

  if (selection.action === 'configureEnabled') {
    await configureEnabledTools();
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
    const result = await restartManagerFromMenu();
    if (result.ok) {
      logStatusInfo('restart-manager result=success reason=none');
    } else {
      const reason = result.reason ?? 'unknown';
      logStatusError(`restart-manager result=failed reason=${reason}`);
    }
    return;
  }

  if (selection.action === 'openSettings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jiangxiaoxu.lm-tools-bridge');
    return;
  }

  if (selection.action === 'openExtensionPage') {
    await openExtensionPage();
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

async function openExtensionPage(): Promise<void> {
  const extensionId = 'jiangxiaoxu.lm-tools-bridge';
  try {
    await vscode.commands.executeCommand('extension.open', extensionId);
    return;
  } catch {
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${extensionId}`);
  }
}



