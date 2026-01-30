import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { rgPath } from '@vscode/ripgrep';
import * as z from 'zod';
import { getManagerPipeName } from './managerShared';

const OUTPUT_CHANNEL_NAME = 'lm-tools-bridge';
const START_COMMAND_ID = 'lm-tools-bridge.start';
const STOP_COMMAND_ID = 'lm-tools-bridge.stop';
const CONFIGURE_COMMAND_ID = 'lm-tools-bridge.configureTools';
const CONFIGURE_BLACKLIST_COMMAND_ID = 'lm-tools-bridge.configureBlacklist';
const STATUS_MENU_COMMAND_ID = 'lm-tools-bridge.statusMenu';
const HELP_COMMAND_ID = 'lm-tools-bridge.openHelp';
const CONFIG_SECTION = 'lmToolsBridge';
const CONFIG_USE_WORKSPACE_SETTINGS = 'useWorkspaceSettings';
const CONFIG_ENABLED_TOOLS = 'tools.enabled';
const CONFIG_BLACKLIST = 'tools.blacklist';
const CONFIG_BLACKLIST_PATTERNS = 'tools.blacklistPatterns';
const CONFIG_RESPONSE_FORMAT = 'tools.responseFormat';
const CONFIG_DEBUG = 'debug';
const CONFIG_MANAGER_HTTP_PORT = 'manager.httpPort';
const FIND_FILES_TOOL_NAME = 'lm_findFiles';
const FIND_TEXT_IN_FILES_TOOL_NAME = 'lm_findTextInFiles';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 48123;
const DEFAULT_MANAGER_HTTP_PORT = 47100;
const HEALTH_PATH = '/mcp/health';
const STATUS_REFRESH_INTERVAL_MS = 3000;
const MANAGER_HEARTBEAT_INTERVAL_MS = 1000;
const MANAGER_REQUEST_TIMEOUT_MS = 1500;
const MANAGER_START_TIMEOUT_MS = 3000;
const MANAGER_LOCK_STALE_MS = 5000;
const PORT_RETRY_LIMIT = 50;
const PORT_MIN_VALUE = 1;
const PORT_MAX_VALUE = 65535;
const DEFAULT_ENABLED_TOOL_NAMES = [
  'copilot_searchCodebase',
  'copilot_searchWorkspaceSymbols',
  'copilot_listCodeUsages',
  FIND_FILES_TOOL_NAME,
  FIND_TEXT_IN_FILES_TOOL_NAME,
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
const BUILTIN_BLACKLISTED_TOOL_NAMES = [
  'copilot_applyPatch',
  'copilot_insertEdit',
  'copilot_replaceString',
  'copilot_multiReplaceString',
  'copilot_createFile',
  'copilot_createDirectory',
  'copilot_createNewJupyterNotebook',
  'copilot_editNotebook',
  'copilot_runNotebookCell',
  'copilot_readFile',
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
  'vscode_get_terminal_confirmation',
  'inline_chat_exit',
  'get_terminal_output',
  'terminal_selection',
  'terminal_last_command',
  'copilot_findFiles',
  'copilot_findTextInFiles',
  'copilot_findTestFiles',
  'copilot_getSearchResults',
  'copilot_githubRepo',
  'copilot_testFailure',
  'copilot_getChangedFiles',
];

type SchemaDefaultOverrides = Record<string, Record<string, unknown>>;

const BUILTIN_SCHEMA_DEFAULT_OVERRIDES: string[] = [
  'copilot_findTextInFiles.maxResults=500',
  'lm_findTextInFiles.maxResults=500',
];

const COPILOT_FIND_FILES_DESCRIPTION = [
  'Search for files in the workspace by glob pattern. This only returns the paths of matching files.',
  'Use this tool when you know the exact filename pattern of the files you\'re searching for.',
  'Glob patterns match from the root of the workspace folder. Examples:',
  '- **/*.{js,ts} to match all js/ts files in the workspace.',
  '- src/** to match all files under the top-level src folder.',
  '- **/foo/**/*.js to match all js files under any foo folder in the workspace.',
].join('\n');

const COPILOT_FIND_FILES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search for files with names or paths matching this glob pattern.',
    },
    maxResults: {
      type: 'number',
      description: 'The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don\'t see what you\'re looking for, you can try again with a more specific query or a larger maxResults.',
    },
  },
  required: ['query'],
};

const COPILOT_FIND_TEXT_IN_FILES_DESCRIPTION = [
  'Do a fast text search in the workspace. Use this tool when you want to search with an exact string or regex.',
  'If you are not sure what words will appear in the workspace, prefer using regex patterns with alternation (|) or character classes to search for multiple potential words at once instead of making separate searches.',
  'For example, use \'function|method|procedure\' to look for all of those words at once.',
  'Use includePattern to search within files matching a specific pattern, or in a specific file, using a relative path.',
  'Use \'includeIgnoredFiles\' to include files normally ignored by .gitignore, other ignore files, and `files.exclude` and `search.exclude` settings.',
  'Warning: using this may cause the search to be slower, only set it when you want to search in ignored folders like node_modules or build outputs.',
  'When caseSensitive is false, smart-case is used by default (including regex searches). Set caseSensitive to true to force case-sensitive matching.',
  'Use this tool when you want to see an overview of a particular file, instead of using read_file many times to look for code within a file.',
].join('\n');

const COPILOT_FIND_TEXT_IN_FILES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The pattern to search for in files in the workspace. Use regex with alternation (e.g., \'word1|word2|word3\') or character classes to find multiple potential words in a single search. Be sure to set the isRegexp property properly to declare whether it\'s a regex or plain text pattern. When caseSensitive is false, smart-case is used by default. If you need case-sensitive matching, set caseSensitive to true or use a regex pattern with an inline case-sensitivity flag.',
    },
    caseSensitive: {
      type: 'boolean',
      description: 'Whether the search should be case-sensitive. When false, smart-case is used by default (including regex). Regex inline flags can override this setting.',
    },
    isRegexp: {
      type: 'boolean',
      description: 'Whether the pattern is a regex.',
    },
    includePattern: {
      type: 'string',
      description: 'Search files matching this glob pattern. Will be applied to the relative path of files within the workspace. To search recursively inside a folder, use a proper glob pattern like "src/folder/**". Do not use | in includePattern.',
    },
    maxResults: {
      type: 'number',
      description: 'The maximum number of results to return. Do not use this unless necessary, it can slow things down. By default, only some matches are returned. If you use this and don\'t see what you\'re looking for, you can try again with a more specific query or a larger maxResults.',
      default: 500,
    },
    includeIgnoredFiles: {
      type: 'boolean',
      description: 'Whether to include files that would normally be ignored according to .gitignore, other ignore files and `files.exclude` and `search.exclude` settings. Warning: using this may cause the search to be slower. Only set it when you want to search in ignored folders like node_modules or build outputs.',
    },
  },
  required: ['query', 'isRegexp'],
};

const schemaDefaultOverrideWarnings = new Set<string>();

type ToolDetail = 'names' | 'full';
type ResponseFormat = 'text' | 'structured' | 'both';
type DebugLevel = 'off' | 'simple' | 'detail';

interface CustomToolInformation {
  name: string;
  description: string;
  tags: string[];
  inputSchema: unknown;
  isCustom: true;
}

interface CustomToolDefinition extends CustomToolInformation {
  invoke: (input: Record<string, unknown>) => Promise<unknown>;
}

type ExposedTool = vscode.LanguageModelToolInformation | CustomToolInformation;

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
let workspaceSettingWarningEmitted = false;
let extensionContext: vscode.ExtensionContext | undefined;
let managerHeartbeatTimer: NodeJS.Timeout | undefined;
let managerHeartbeatInFlight = false;
let managerStartPromise: Promise<boolean> | undefined;
let managerReady = false;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
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

function getConfigurationResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function isWorkspaceSettingsEnabled(resource?: vscode.Uri): boolean {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const inspection = config.inspect<boolean>(CONFIG_USE_WORKSPACE_SETTINGS);
  const workspaceValue = inspection?.workspaceFolderValue ?? inspection?.workspaceValue;
  if (workspaceValue === true) {
    return true;
  }
  if (!workspaceSettingWarningEmitted && inspection?.globalValue === true) {
    workspaceSettingWarningEmitted = true;
    logWarn('lmToolsBridge.useWorkspaceSettings is set in User settings but is only honored in Workspace settings.');
  }
  return false;
}

async function resolveToolsConfigTarget(resource?: vscode.Uri): Promise<vscode.ConfigurationTarget> {
  if (!isWorkspaceSettingsEnabled(resource)) {
    return vscode.ConfigurationTarget.Global;
  }
  if (vscode.workspace.workspaceFile) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return vscode.ConfigurationTarget.Workspace;
}

function getConfigValue<T>(key: string, fallback: T): T {
  const resource = getConfigurationResource();
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  if (isWorkspaceSettingsEnabled(resource)) {
    return config.get<T>(key, fallback);
  }
  const inspection = config.inspect<T>(key);
  if (!inspection) {
    return fallback;
  }
  if (inspection.globalValue !== undefined) {
    return inspection.globalValue as T;
  }
  if (inspection.defaultValue !== undefined) {
    return inspection.defaultValue as T;
  }
  return fallback;
}

function getEnabledToolsSetting(): string[] {
  const enabled = getConfigValue<string[]>(CONFIG_ENABLED_TOOLS, DEFAULT_ENABLED_TOOL_NAMES);
  return Array.isArray(enabled) ? enabled.filter((name) => typeof name === 'string') : [];
}

function getBlacklistedToolsSetting(): string[] {
  const blacklisted = getConfigValue<string[]>(CONFIG_BLACKLIST, []);
  return Array.isArray(blacklisted) ? blacklisted.filter((name) => typeof name === 'string') : [];
}

function getBlacklistedToolPatterns(): string[] {
  const rawPatterns = getConfigValue<string>(CONFIG_BLACKLIST_PATTERNS, '');
  if (!rawPatterns) {
    return [];
  }
  return rawPatterns
    .split('|')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

function compileBlacklistPatterns(patterns: readonly string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const escaped = escapeRegExp(pattern).replace(/\\\*/g, '.*');
    try {
      compiled.push(new RegExp(`^${escaped}$`, 'i'));
    } catch {
      // Ignore invalid patterns.
    }
  }
  return compiled;
}

function matchesBlacklistPattern(name: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isToolBlacklisted(
  name: string,
  blacklistedSet: ReadonlySet<string>,
  blacklistPatterns: readonly RegExp[],
): boolean {
  return BUILTIN_BLACKLISTED_TOOL_NAMES.includes(name)
    || blacklistedSet.has(name)
    || matchesBlacklistPattern(name, blacklistPatterns);
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
  return setBlacklistedTools([]);
}

async function configureExposedTools(): Promise<void> {
  const lm = getLanguageModelNamespace();
  if (!lm) {
    void vscode.window.showWarningMessage('vscode.lm is not available in this VS Code version.');
    return;
  }

  const allTools = getAllToolsSnapshot();
  if (allTools.length === 0) {
    void vscode.window.showInformationMessage('No tools found for MCP exposure.');
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
  const blacklistPatterns = compileBlacklistPatterns(getBlacklistedToolPatterns());
  const items: Array<vscode.QuickPickItem & { toolName?: string; isReset?: boolean }> = [];

  items.push({
    label: '$(refresh) Reset (default blacklist)',
    description: 'Clear the configured blacklist',
    alwaysShow: true,
    isReset: true,
  });
  items.push({ label: 'Tools', kind: vscode.QuickPickItemKind.Separator });

  for (const tool of tools) {
    if (BUILTIN_BLACKLISTED_TOOL_NAMES.includes(tool.name)) {
      continue;
    }
    if (matchesBlacklistPattern(tool.name, blacklistPatterns)) {
      continue;
    }
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
      ? 'Blacklisted tools cleared and removed from enabled list.'
      : 'Blacklisted tools cleared.';
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startManagerHeartbeat(): Promise<void> {
  if (managerHeartbeatTimer) {
    return;
  }
  managerReady = await ensureManagerRunning();
  if (managerReady) {
    await sendManagerHeartbeat();
  } else {
    logStatusWarn('Manager is not available yet; will retry via heartbeat.');
  }
  managerHeartbeatTimer = setInterval(() => {
    void sendManagerHeartbeat();
  }, MANAGER_HEARTBEAT_INTERVAL_MS);
}

async function stopManagerHeartbeat(): Promise<void> {
  if (managerHeartbeatTimer) {
    clearInterval(managerHeartbeatTimer);
    managerHeartbeatTimer = undefined;
  }
  managerReady = false;
  await sendManagerBye();
}

async function sendManagerHeartbeat(): Promise<void> {
  if (managerHeartbeatInFlight) {
    return;
  }
  const payload = buildManagerHeartbeatPayload();
  if (!payload) {
    return;
  }
  managerHeartbeatInFlight = true;
  try {
    if (!managerReady) {
      managerReady = await ensureManagerRunning();
      if (!managerReady) {
        return;
      }
    }
    const response = await managerRequest('POST', '/heartbeat', payload);
    if (!response.ok) {
      managerReady = false;
    }
  } finally {
    managerHeartbeatInFlight = false;
  }
}

async function sendManagerBye(): Promise<void> {
  const sessionId = vscode.env.sessionId;
  if (!sessionId) {
    return;
  }
  await managerRequest('POST', '/bye', { sessionId });
}

function buildManagerHeartbeatPayload(): {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile?: string;
  host: string;
  port: number;
  lastSeen: number;
} | undefined {
  if (!serverState) {
    return undefined;
  }
  const sessionId = vscode.env.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  return {
    sessionId,
    pid: process.pid,
    workspaceFolders,
    workspaceFile: vscode.workspace.workspaceFile?.fsPath,
    host: serverState.host,
    port: serverState.port,
    lastSeen: Date.now(),
  };
}

async function requestManagerPortAllocation(preferredPort: number, minPort?: number): Promise<number | undefined> {
  const sessionId = vscode.env.sessionId;
  if (!sessionId) {
    return undefined;
  }
  if (!isValidPort(preferredPort)) {
    return undefined;
  }
  if (minPort !== undefined && !isValidPort(minPort)) {
    return undefined;
  }
  const response = await managerRequest<{ ok?: boolean; port?: number }>('POST', '/allocate', {
    sessionId,
    preferredPort,
    minPort,
  });
  if (!response.ok || !response.data) {
    return undefined;
  }
  const port = (response.data as { port?: unknown }).port;
  return isValidPort(port) ? port : undefined;
}

async function ensureManagerRunning(): Promise<boolean> {
  if (managerStartPromise) {
    return managerStartPromise;
  }
  managerStartPromise = ensureManagerRunningInternal()
    .finally(() => {
      managerStartPromise = undefined;
    });
  return managerStartPromise;
}

async function ensureManagerRunningInternal(): Promise<boolean> {
  if (await isManagerAlive()) {
    return true;
  }
  if (!extensionContext) {
    return false;
  }

  const lockPath = await getManagerLockPath();
  const acquired = await tryAcquireManagerLock(lockPath);
  if (acquired) {
    await startManagerProcess();
    const ready = await waitForManagerReady();
    await releaseManagerLock(lockPath);
    return ready;
  }

  const ready = await waitForManagerReady();
  if (ready) {
    return true;
  }

  if (await isLockStale(lockPath)) {
    await releaseManagerLock(lockPath);
    const retryAcquired = await tryAcquireManagerLock(lockPath);
    if (!retryAcquired) {
      return false;
    }
    await startManagerProcess();
    const retryReady = await waitForManagerReady();
    await releaseManagerLock(lockPath);
    return retryReady;
  }

  return false;
}

async function waitForManagerReady(): Promise<boolean> {
  const deadline = Date.now() + MANAGER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isManagerAlive()) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function isManagerAlive(): Promise<boolean> {
  const response = await managerRequest('GET', '/health');
  return response.ok;
}

async function startManagerProcess(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const managerPath = extensionContext.asAbsolutePath(path.join('out', 'manager.js'));
  if (!fs.existsSync(managerPath)) {
    logStatusError(`Manager entry not found at ${managerPath}`);
    return;
  }
  const pipeName = getManagerPipeName();
  const managerHttpPort = getConfigValue<number>(CONFIG_MANAGER_HTTP_PORT, DEFAULT_MANAGER_HTTP_PORT);
  const child = spawn(process.execPath, [managerPath, '--pipe', pipeName, '--http-port', String(managerHttpPort)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function getManagerLockPath(): Promise<string> {
  if (!extensionContext) {
    return path.join(process.cwd(), 'lm-tools-bridge-manager.lock');
  }
  const baseDir = path.join(extensionContext.globalStorageUri.fsPath, 'manager');
  await fs.promises.mkdir(baseDir, { recursive: true });
  return path.join(baseDir, 'manager.lock');
}

async function tryAcquireManagerLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    await handle.close();
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function releaseManagerLock(lockPath: string): Promise<void> {
  try {
    await fs.promises.unlink(lockPath);
  } catch {
    // Ignore cleanup errors.
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(lockPath);
    return Date.now() - stats.mtimeMs > MANAGER_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function managerRequest<T = unknown>(
  method: string,
  requestPath: string,
  body?: unknown,
): Promise<{ ok: boolean; status?: number; data?: T }> {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const request = http.request(
      {
        socketPath: getManagerPipeName(),
        path: requestPath,
        method,
        headers: payload
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          if (chunks.length === 0) {
            resolve({ ok: status >= 200 && status < 300, status });
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(text) as T;
            resolve({ ok: status >= 200 && status < 300, status, data: parsed });
          } catch {
            resolve({ ok: false, status });
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, MANAGER_REQUEST_TIMEOUT_MS);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false });
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
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
      return resourceJson(uri.toString(), { name: tool.name, inputSchema: buildToolInputSchema(tool) });
    },
  );

  return server;
}

function registerExposedTools(server: McpServer): void {
  const toolInputSchema: z.ZodTypeAny = z.object({}).passthrough()
    .describe('Tool input object. Use lm-tools://schema/{name} for the expected shape.');
  const tools = getExposedToolsSnapshot();
  for (const tool of tools) {
    if (tool.name === 'getVSCodeWorkspace') {
      continue;
    }
    // @ts-expect-error TS2589: Deep instantiation from SDK tool generics.
    server.registerTool<z.ZodTypeAny, z.ZodTypeAny>(
      tool.name,
      {
        description: tool.description ?? '',
        inputSchema: toolInputSchema,
      },
      async (args: Record<string, unknown>) => invokeExposedTool(tool.name, args),
    );
  }
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

async function invokeExposedTool(toolName: string, args: unknown) {
  const debugLevel = getDebugLevel();
  const requestStartTime = Date.now();
  let debugInvokeInput: Record<string, unknown> | undefined;
  let debugOutputText: string | undefined;
  let debugStructuredOutput: unknown;
  let debugError: unknown;
  try {
    const tools = getExposedToolsSnapshot();
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return toolErrorResultPayload({
        error: `Tool not found or disabled: ${toolName}`,
        name: toolName,
        inputSchema: null,
      });
    }
    const input = args ?? {};
    if (!isPlainObject(input)) {
      return toolErrorResultPayload({
        error: 'Tool input must be an object. Use lm-tools://schema/{name} for the expected shape.',
        name: tool.name,
        inputSchema: tool.inputSchema ?? null,
      });
    }
    const normalizedInput = applyInputDefaultsToToolInput(input, tool.inputSchema, tool.name);
    debugInvokeInput = normalizedInput;
    let outputText: string | undefined;
    let structuredOutput: { blocks: unknown[] } | undefined;
    if (isCustomTool(tool)) {
      const result = await tool.invoke(normalizedInput);
      const serialized = serializeToolResult(result as vscode.LanguageModelToolResult);
      outputText = serializedToolResultToText(serialized);
      structuredOutput = { blocks: toolResultToStructuredBlocks(serialized) };
      debugOutputText = outputText;
      debugStructuredOutput = structuredOutput;
      return buildToolResult(structuredOutput, false, outputText);
    }

    const lm = getLanguageModelNamespace();
    if (!lm) {
      return toolErrorResult('vscode.lm is not available in this VS Code version.');
    }
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
    const message = String(error);
    debugError = error;
    return toolErrorResultPayload({
      error: message,
      name: toolName,
      inputSchema: getExposedToolsSnapshot().find((tool) => tool.name === toolName)?.inputSchema ?? null,
    });
  } finally {
    const durationMs = Date.now() - requestStartTime;
    if (debugLevel !== 'off') {
      logInfo(`mcpTool call name=${toolName} input=${formatLogPayload(debugInvokeInput ?? {})} durationMs=${durationMs}`);
    }
    if (debugLevel === 'detail') {
      if (debugError) {
        logInfo(`mcpTool call name=${toolName} error: ${String(debugError)}`);
      } else {
        logInfo(`mcpTool call name=${toolName} output: ${debugOutputText ?? ''}`);
        if (getResponseFormat() !== 'text') {
          logInfo(`mcpTool call name=${toolName} structured output: ${formatLogPayload(debugStructuredOutput)}`);
        }
      }
    }
  }
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

function formatToolNameList(tools: readonly ExposedTool[]): string {
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

function listToolsPayload(tools: readonly ExposedTool[], detail: ToolDetail) {
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

function patchFindFilesSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return schema;
  }
  const propRecord = properties as Record<string, unknown>;
  if (!propRecord.query) {
    return schema;
  }
  return schema;
}

function toolInfoPayload(tool: ExposedTool, detail: ToolDetail) {
  if (detail === 'names') {
    return {
      name: tool.name,
    };
  }
  const inputSchema = buildToolInputSchema(tool);

  return {
    name: tool.name,
    description: tool.description,
    tags: tool.tags,
    inputSchema,
    toolUri: getToolUri(tool.name),
    schemaUri: getSchemaUri(tool.name),
    usageHint: getToolUsageHint(tool),
  };
}

function buildToolInputSchema(tool: ExposedTool): unknown {
  let inputSchema = applySchemaDefaults(tool.inputSchema ?? null, tool.name);
  if (tool.name === 'copilot_findTextInFiles' || tool.name === FIND_TEXT_IN_FILES_TOOL_NAME) {
    inputSchema = patchFindTextInFilesSchema(inputSchema);
  }
  if (tool.name === FIND_FILES_TOOL_NAME) {
    inputSchema = patchFindFilesSchema(inputSchema);
  }
  return inputSchema;
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

type RipgrepMatch = {
  path: string;
  line: number;
  preview: string;
};

type RipgrepSearchResult = {
  matches: RipgrepMatch[];
  totalMatches: number;
  capped: boolean;
};

function buildFindTextInFilesToolDefinition(): CustomToolDefinition {
  const inputSchema = COPILOT_FIND_TEXT_IN_FILES_SCHEMA;
  const description = COPILOT_FIND_TEXT_IN_FILES_DESCRIPTION;
  return {
    name: FIND_TEXT_IN_FILES_TOOL_NAME,
    description,
    tags: [],
    inputSchema,
    isCustom: true,
    invoke: runFindTextInFilesTool,
  };
}

function buildFindFilesToolDefinition(): CustomToolDefinition {
  const inputSchema = COPILOT_FIND_FILES_SCHEMA;
  const description = COPILOT_FIND_FILES_DESCRIPTION;
  return {
    name: FIND_FILES_TOOL_NAME,
    description,
    tags: [],
    inputSchema,
    isCustom: true,
    invoke: runFindFilesTool,
  };
}

async function runFindTextInFilesTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const payload = await executeFindTextInFilesSearch(input);
    const text = safePrettyStringify(payload);
    return {
      content: [new vscode.LanguageModelTextPart(text)],
    };
  } catch (error) {
    const message = String(error);
    return {
      content: [new vscode.LanguageModelTextPart(message)],
    };
  }
}

async function runFindFilesTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const payload = await executeFindFilesSearch(input);
    const text = safePrettyStringify(payload);
    return {
      content: [new vscode.LanguageModelTextPart(text)],
    };
  } catch (error) {
    const message = String(error);
    return {
      content: [new vscode.LanguageModelTextPart(message)],
    };
  }
}

async function executeFindTextInFilesSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const queryValue = input.query;
  if (typeof queryValue !== 'string') {
    throw new Error('query must be a string');
  }
  const isRegexp = input.isRegexp === true;
  const caseSensitive = input.caseSensitive === true;
  const includeIgnoredFiles = input.includeIgnoredFiles === true;
  const maxResults = typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
    ? input.maxResults
    : undefined;

  const combinedMatches: RipgrepMatch[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  let capped = false;
  let remaining = maxResults ?? Number.POSITIVE_INFINITY;

  const targets = resolveRipgrepTargets(input.includePattern);
  for (const target of targets) {
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const result = await runRipgrepSearch(target, {
      query: queryValue,
      isRegexp,
      caseSensitive,
      includeIgnoredFiles,
      maxResults: maxResults !== undefined ? remaining : undefined,
    });
    capped = capped || result.capped;
    totalCount += result.totalMatches;
    for (const match of result.matches) {
      const key = `${match.path}:${match.line}:${match.preview}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combinedMatches.push(match);
    }
    if (maxResults !== undefined) {
      remaining = Math.max(0, maxResults - totalCount);
    }
  }

  return {
    capped,
    uniqueMatches: combinedMatches.length,
    totalMatches: totalCount,
    matches: combinedMatches,
  };
}

async function executeFindFilesSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const queryValue = input.query;
  if (typeof queryValue !== 'string') {
    throw new Error('query must be a string');
  }
  const maxResults = typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
    ? input.maxResults
    : undefined;
  const includePattern = normalizeFindTextInFilesIncludeEntry(queryValue);
  const uris = await vscode.workspace.findFiles(includePattern, null, maxResults);
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const rel = formatSearchMatchPath(uri);
    if (seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    matched.push(rel);
  }

  return {
    count: matched.length,
    files: matched,
  };
}

function formatSearchMatchPath(uri: vscode.Uri): string {
  return uri.fsPath;
}

function resolveRipgrepTargets(
  includePattern: unknown,
): Array<{ folder: vscode.WorkspaceFolder; glob?: string }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }
  if (typeof includePattern !== 'string') {
    return folders.map((folder) => ({ folder }));
  }
  const trimmed = includePattern.trim();
  if (!trimmed) {
    return folders.map((folder) => ({ folder }));
  }
  const parsed = parseWorkspacePrefixedIncludePattern(trimmed);
  if (parsed) {
    return [{ folder: parsed.workspaceFolder, glob: parsed.pattern }];
  }
  return folders.map((folder) => ({ folder, glob: trimmed }));
}

async function runRipgrepSearch(
  target: { folder: vscode.WorkspaceFolder; glob?: string },
  options: {
    query: string;
    isRegexp: boolean;
    caseSensitive: boolean;
    includeIgnoredFiles: boolean;
    maxResults?: number;
  },
): Promise<RipgrepSearchResult> {
  const matches: RipgrepMatch[] = [];
  let totalMatches = 0;
  let capped = false;
  let stdoutBuffer = '';
  const stderrChunks: string[] = [];
  const args = buildRipgrepArgs(target, options);
  const maxResults = options.maxResults;
  const pushMatch = (match: RipgrepMatch) => {
    if (maxResults !== undefined && totalMatches >= maxResults) {
      return;
    }
    totalMatches += 1;
    matches.push(match);
    if (maxResults !== undefined && totalMatches >= maxResults && !capped) {
      capped = true;
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
    }
  };

  const child = spawn(rgPath, args, {
    cwd: target.folder.uri.fsPath,
    windowsHide: true,
  });

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    stdoutBuffer = consumeRipgrepLines(stdoutBuffer, (line) => {
      const match = parseRipgrepMatch(line, target.folder);
      if (!match) {
        return;
      }
      pushMatch(match);
    });
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolve(code));
  });

  if (stdoutBuffer.length > 0) {
    consumeRipgrepLines(stdoutBuffer, (line) => {
      const match = parseRipgrepMatch(line, target.folder);
      if (!match) {
        return;
      }
      pushMatch(match);
    });
  }

  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2 && !capped) {
    const stderrText = stderrChunks.join('').trim();
    throw new Error(stderrText || `ripgrep exited with code ${exitCode ?? 'null'}`);
  }

  return {
    matches,
    totalMatches,
    capped,
  };
}

function consumeRipgrepLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  let index = buffer.indexOf('\n', start);
  while (index !== -1) {
    const line = buffer.slice(start, index).trim();
    if (line.length > 0) {
      onLine(line);
    }
    start = index + 1;
    index = buffer.indexOf('\n', start);
  }
  return buffer.slice(start);
}

function parseRipgrepMatch(line: string, folder: vscode.WorkspaceFolder): RipgrepMatch | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as { type?: unknown; data?: unknown };
  if (record.type !== 'match' || !record.data || typeof record.data !== 'object') {
    return undefined;
  }
  const data = record.data as {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
  const relPath = data.path?.text;
  const previewText = data.lines?.text;
  const lineNumber = data.line_number;
  if (!relPath || previewText === undefined || typeof lineNumber !== 'number') {
    return undefined;
  }
  let normalizedRelPath = relPath.replace(/\\/g, '/');
  normalizedRelPath = normalizedRelPath.replace(/^\.\//u, '').replace(/\/\.\//g, '/');
  const absolutePath = path.isAbsolute(relPath)
    ? relPath
    : path.resolve(folder.uri.fsPath, normalizedRelPath);
  const preview = previewText.replace(/\r\n/g, '\n').trimEnd();
  return {
    path: absolutePath,
    line: lineNumber,
    preview,
  };
}

function buildRipgrepArgs(
  target: { folder: vscode.WorkspaceFolder; glob?: string },
  options: { query: string; isRegexp: boolean; caseSensitive: boolean; includeIgnoredFiles: boolean },
): string[] {
  const args: string[] = ['--json', '--with-filename', '--line-number', '--no-messages'];

  if (!options.isRegexp) {
    if (options.caseSensitive) {
      args.push('--case-sensitive');
    } else {
      args.push('--smart-case');
    }
    args.push('--fixed-strings');
  } else if (options.caseSensitive) {
    args.push('--case-sensitive');
  } else {
    args.push('--smart-case');
  }

  const searchConfig = vscode.workspace.getConfiguration('search', target.folder.uri);
  const filesConfig = vscode.workspace.getConfiguration('files', target.folder.uri);
  const useIgnoreFiles = searchConfig.get<boolean>('useIgnoreFiles', true);
  const useGlobalIgnoreFiles = searchConfig.get<boolean>('useGlobalIgnoreFiles', true);
  const followSymlinks = searchConfig.get<boolean>('followSymlinks', true);

  if (options.includeIgnoredFiles || !useIgnoreFiles) {
    args.push('--no-ignore', '--no-ignore-parent');
  }
  if (options.includeIgnoredFiles || !useGlobalIgnoreFiles) {
    args.push('--no-ignore-global');
  }
  if (followSymlinks) {
    args.push('--follow');
  }

  if (!options.includeIgnoredFiles) {
    const searchExclude = collectExcludeGlobs(searchConfig.get<Record<string, unknown>>('exclude', {}));
    const filesExclude = collectExcludeGlobs(filesConfig.get<Record<string, unknown>>('exclude', {}));
    const excludePatterns = new Set<string>();
    for (const pattern of [...searchExclude, ...filesExclude]) {
      const normalized = normalizeGlob(pattern);
      if (!normalized) {
        continue;
      }
      excludePatterns.add(normalized.startsWith('!') ? normalized : `!${normalized}`);
      if (!/\/\*\*(?:\/\*)?$/u.test(normalized)) {
        const withChildren = normalized.endsWith('/') ? `${normalized}**` : `${normalized}/**`;
        excludePatterns.add(withChildren.startsWith('!') ? withChildren : `!${withChildren}`);
      }
    }
    for (const pattern of excludePatterns) {
      args.push('--glob', pattern);
    }
  }

  if (target.glob) {
    args.push('--glob', normalizeGlob(target.glob));
  }

  args.push('-e', options.query, '.');
  return args;
}

function collectExcludeGlobs(values: Record<string, unknown>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value === true || (typeof value === 'object' && value !== null))
    .map(([pattern]) => pattern);
}

function normalizeGlob(pattern: string): string {
  return pattern.replace(/\\/g, '/');
}

function normalizeFindTextInFilesIncludeEntry(entry: string): vscode.GlobPattern {
  const parsed = parseWorkspacePrefixedIncludePattern(entry);
  if (!parsed) {
    return entry;
  }
  return new vscode.RelativePattern(parsed.workspaceFolder.uri, parsed.pattern);
}

function parseWorkspacePrefixedIncludePattern(entry: string): {
  workspaceFolder: vscode.WorkspaceFolder;
  pattern: string;
} | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }
  if (path.isAbsolute(trimmed) || startsWithWindowsAbsolutePath(trimmed)) {
    return undefined;
  }
  const withoutDotPrefix = trimmed.replace(/^\.[\\/]+/u, '');
  const normalized = withoutDotPrefix.replace(/^[\\/]+/u, '');
  const separatorIndex = normalized.search(/[\\/]/u);
  const workspaceName = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
  if (!workspaceName) {
    return undefined;
  }
  const workspaceFolder = findWorkspaceFolderByName(workspaceName);
  if (!workspaceFolder) {
    return undefined;
  }
  const remainder = separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : '';
  const normalizedRemainder = remainder ? remainder.replace(/^[\\/]+/u, '') : '**/*';
  return {
    workspaceFolder,
    pattern: normalizedRemainder,
  };
}

function findWorkspaceFolderByName(name: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const normalized = process.platform === 'win32' ? name.toLowerCase() : name;
  return folders.find((folder) => {
    const folderName = process.platform === 'win32' ? folder.name.toLowerCase() : folder.name;
    return folderName === normalized;
  });
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

function getToolUsageHint(tool: ExposedTool): Record<string, unknown> {
  const combined = `${tool.name} ${(tool.description ?? '')}`.toLowerCase();
  if (combined.includes('do not use') || combined.includes('placeholder')) {
    return {
      mode: 'do-not-use',
      reason: 'Heuristic: description indicates do-not-use/placeholder.',
    };
  }

  if (tool.tags.some((tag) => tag.includes('codesearch'))) {
    return {
      mode: 'direct',
      reason: 'Heuristic: codesearch tag; call the tool directly.',
    };
  }

  return {
    mode: 'direct',
    reason: 'Heuristic: default to calling the tool directly.',
    requiresObjectInput: schemaRequiresObjectInput(tool.inputSchema) || undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaRequiresObjectInput(schema: unknown): boolean {
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

function isCustomTool(tool: ExposedTool): tool is CustomToolDefinition {
  return (tool as CustomToolDefinition).isCustom === true;
}

function getCustomToolsSnapshot(): readonly CustomToolDefinition[] {
  return [buildFindFilesToolDefinition(), buildFindTextInFilesToolDefinition()];
}

function getAllToolsSnapshot(): readonly ExposedTool[] {
  return [...getAllLmToolsSnapshot(), ...getCustomToolsSnapshot()];
}

function getVisibleToolsSnapshot(): readonly ExposedTool[] {
  const blacklistedSet = new Set(getBlacklistedToolsSetting());
  const blacklistPatterns = compileBlacklistPatterns(getBlacklistedToolPatterns());
  return getAllToolsSnapshot().filter((tool) => {
    return !isToolBlacklisted(tool.name, blacklistedSet, blacklistPatterns);
  });
}

function getExposedToolsSnapshot(): readonly ExposedTool[] {
  const enabledSet = new Set(getEnabledToolsSetting());
  const blacklistedSet = new Set(getBlacklistedToolsSetting());
  const blacklistPatterns = compileBlacklistPatterns(getBlacklistedToolPatterns());
  return getAllToolsSnapshot().filter((tool) => {
    if (isToolBlacklisted(tool.name, blacklistedSet, blacklistPatterns)) {
      return false;
    }
    return enabledSet.has(tool.name);
  });
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
    statusBarItem.tooltip = `LM Tools Bridge server is running (${host}:${port})${workspaceSuffix}`;
    statusBarItem.color = undefined;
  } else if (info.state === 'port-in-use') {
    statusBarItem.text = '$(warning) LM Tools Bridge: Port In Use';
    statusBarItem.tooltip = `Port ${port} is already in use (${host}).${workspaceSuffix}`;
    statusBarItem.color = undefined;
  } else {
    statusBarItem.text = '$(circle-slash) LM Tools Bridge: Off';
    statusBarItem.tooltip = `LM Tools Bridge server is not running (${host}:${port}).${workspaceSuffix}`;
    statusBarItem.color = undefined;
  }
  statusBarItem.show();
}

async function showStatusMenu(channel: vscode.OutputChannel): Promise<void> {
  const items: Array<vscode.QuickPickItem & { action?: 'configure' | 'configureBlacklist' | 'dump' | 'help' | 'reload' }> = [
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

function prioritizeTool(
  tools: readonly ExposedTool[],
  preferredName: string,
): ExposedTool[] {
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

function applySchemaDefaults(schema: unknown, toolName: string): unknown {
  const overrides = getSchemaDefaultOverridesForTool(toolName, schema);
  return applySchemaDefaultsInternal(schema, overrides, undefined);
}

function applyInputDefaultsToToolInput(
  input: Record<string, unknown>,
  schema: unknown,
  toolName: string,
): Record<string, unknown> {
  const overrides = getSchemaDefaultOverridesForTool(toolName, schema);
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

function getSchemaDefaultOverrides(): SchemaDefaultOverrides {
  const fromConfig = getConfigValue<unknown>('tools.schemaDefaults', []);
  const overrides = parseSchemaDefaultOverrides(fromConfig);
  const merged: SchemaDefaultOverrides = {};
  const builtinOverrides = parseSchemaDefaultOverrides(BUILTIN_SCHEMA_DEFAULT_OVERRIDES);
  for (const [toolName, toolDefaults] of Object.entries(builtinOverrides)) {
    merged[toolName] = { ...toolDefaults };
  }
  for (const [toolName, toolDefaults] of Object.entries(overrides)) {
    merged[toolName] = { ...(merged[toolName] ?? {}), ...toolDefaults };
  }
  return merged;
}

function getSchemaDefaultOverridesForTool(toolName: string, schema: unknown): Record<string, unknown> {
  if (!toolName) {
    return {};
  }
  const overrides = getSchemaDefaultOverrides();
  const toolOverrides = overrides[toolName];
  if (!toolOverrides) {
    return {};
  }
  const allowedNames = extractSchemaPropertyNames(schema);
  if (!allowedNames || allowedNames.size === 0) {
    return { ...toolOverrides };
  }
  const filtered: Record<string, unknown> = {};
  for (const [paramName, paramValue] of Object.entries(toolOverrides)) {
    if (!allowedNames.has(paramName)) {
      warnSchemaDefaultOverride(toolName, paramName, 'parameter is not defined in the tool schema', paramValue);
      continue;
    }
    const propertySchema = findSchemaPropertySchema(schema, paramName);
    const validation = propertySchema ? schemaAllowsValue(propertySchema, paramValue) : undefined;
    if (validation === false) {
      warnSchemaDefaultOverride(toolName, paramName, 'parameter value type does not match the tool schema', paramValue, propertySchema);
      continue;
    }
    filtered[paramName] = paramValue;
  }
  return filtered;
}

function parseSchemaDefaultOverrides(value: unknown): SchemaDefaultOverrides {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      warnSchemaDefaultOverrideEntry(String(value), 'expected an array of strings');
    }
    return {};
  }
  const result: SchemaDefaultOverrides = {};
  for (const entry of value) {
    if (typeof entry !== 'string') {
      warnSchemaDefaultOverrideEntry(String(entry), 'entry is not a string');
      continue;
    }
    const parsed = parseSchemaDefaultOverrideEntry(entry);
    if (!parsed) {
      continue;
    }
    const toolDefaults = result[parsed.toolName] ?? {};
    toolDefaults[parsed.paramName] = parsed.paramValue;
    result[parsed.toolName] = toolDefaults;
  }
  return result;
}

function parseSchemaDefaultOverrideEntry(
  entry: string,
): { toolName: string; paramName: string; paramValue: unknown } | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    warnSchemaDefaultOverrideEntry(entry, 'entry is empty');
    return undefined;
  }
  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex <= 0 || equalsIndex === trimmed.length - 1) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const key = trimmed.slice(0, equalsIndex).trim();
  const rawValue = trimmed.slice(equalsIndex + 1).trim();
  if (!key || rawValue.length === 0) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const parts = key.split('.');
  if (parts.length !== 2) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const toolName = parts[0]?.trim();
  const paramName = parts[1]?.trim();
  if (!toolName || !paramName) {
    warnSchemaDefaultOverrideEntry(entry, 'expected "tool.param=value" format');
    return undefined;
  }
  const parsedValue = parseSchemaDefaultOverrideValue(rawValue);
  if (parsedValue === undefined) {
    warnSchemaDefaultOverrideEntry(entry, 'value must be a quoted string, number, boolean, or array');
    return undefined;
  }
  return { toolName, paramName, paramValue: parsedValue };
}

function parseSchemaDefaultOverrideValue(rawValue: string): unknown | undefined {
  if (rawValue.startsWith('{')) {
    if (!rawValue.endsWith('}')) {
      return undefined;
    }
    return parseSchemaDefaultOverrideArray(rawValue.slice(1, -1));
  }
  if (rawValue.startsWith('[')) {
    return undefined;
  }
  return parseSchemaDefaultOverrideScalar(rawValue);
}

function parseSchemaDefaultOverrideArray(rawValue: string): unknown[] | undefined {
  if (rawValue.length === 0) {
    return [];
  }
  const entries = rawValue.split(',');
  const result: unknown[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      result.push('');
      continue;
    }
    const parsed = parseSchemaDefaultOverrideArrayItem(trimmed);
    if (parsed === undefined) {
      return undefined;
    }
    result.push(parsed);
  }
  return result;
}

function parseSchemaDefaultOverrideArrayItem(rawValue: string): unknown | undefined {
  if (rawValue.startsWith('"') || rawValue.endsWith('"')) {
    if (!(rawValue.startsWith('"') && rawValue.endsWith('"'))) {
      return undefined;
    }
    return rawValue.slice(1, -1);
  }
  return parseSchemaDefaultOverrideScalar(rawValue);
}

function parseSchemaDefaultOverrideScalar(rawValue: string): unknown | undefined {
  const normalized = rawValue.toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  const numberValue = parseSchemaDefaultOverrideNumber(rawValue);
  if (numberValue !== undefined) {
    return numberValue;
  }
  if (rawValue.startsWith('"') || rawValue.endsWith('"')) {
    if (!(rawValue.startsWith('"') && rawValue.endsWith('"'))) {
      return undefined;
    }
    return rawValue.slice(1, -1);
  }
  return undefined;
}

function parseSchemaDefaultOverrideNumber(rawValue: string): number | undefined {
  if (!/^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/u.test(rawValue)) {
    return undefined;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function warnSchemaDefaultOverride(
  toolName: string,
  paramName: string,
  reason: string,
  value: unknown,
  propertySchema?: Record<string, unknown>,
): void {
  const key = `${toolName}.${paramName}:${reason}`;
  if (schemaDefaultOverrideWarnings.has(key)) {
    return;
  }
  schemaDefaultOverrideWarnings.add(key);
  const valueText = formatSchemaDefaultValue(value);
  const expectedText = propertySchema ? describeSchemaPropertyExpected(propertySchema) : undefined;
  const details = expectedText ? `; expected ${expectedText}` : '';
  logWarn(`lmToolsBridge.tools.schemaDefaults ignored: ${toolName}.${paramName}=${valueText} (${reason}${details}).`);
}

function warnSchemaDefaultOverrideEntry(entry: string, reason: string): void {
  const key = `entry:${entry}:${reason}`;
  if (schemaDefaultOverrideWarnings.has(key)) {
    return;
  }
  schemaDefaultOverrideWarnings.add(key);
  logWarn(`lmToolsBridge.tools.schemaDefaults ignored: "${entry}" (${reason}).`);
}

function formatSchemaDefaultValue(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  const serialized = JSON.stringify(value);
  return serialized ?? String(value);
}

function describeSchemaPropertyExpected(schema: Record<string, unknown>): string | undefined {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return `enum ${JSON.stringify(enumValues)}`;
  }
  const typeValue = schema.type;
  if (typeof typeValue === 'string') {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    return typeValue.filter((entry) => typeof entry === 'string').join('|') || undefined;
  }
  return undefined;
}

function findSchemaPropertySchema(schema: unknown, name: string): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const found = findSchemaPropertySchema(entry, name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  const props = record.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const propRecord = props as Record<string, unknown>;
    const propSchema = propRecord[name];
    if (propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)) {
      return propSchema as Record<string, unknown>;
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findSchemaPropertySchema(entry, name);
        if (found) {
          return found;
        }
      }
    }
  }
  return undefined;
}

function schemaAllowsValue(schema: Record<string, unknown>, value: unknown): boolean | undefined {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues) {
    return enumValues.some((entry) => enumValueMatches(entry, value));
  }
  const typeValue = schema.type;
  const types = Array.isArray(typeValue)
    ? typeValue.filter((entry) => typeof entry === 'string')
    : typeof typeValue === 'string'
      ? [typeValue]
      : [];
  if (types.length === 0) {
    return undefined;
  }
  return types.some((entry) => schemaAllowsValueForType(entry, schema, value));
}

function enumValueMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return false;
    }
    for (let index = 0; index < expected.length; index += 1) {
      if (!Object.is(expected[index], actual[index])) {
        return false;
      }
    }
    return true;
  }
  return Object.is(expected, actual);
}

function schemaAllowsValueForType(typeValue: string, schema: Record<string, unknown>, value: unknown): boolean {
  switch (typeValue) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return schemaAllowsArrayValue(schema, value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function schemaAllowsArrayValue(schema: Record<string, unknown>, value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const items = schema.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) {
    return true;
  }
  return value.every((entry) => schemaAllowsValue(items as Record<string, unknown>, entry) !== false);
}

function getResponseFormat(): ResponseFormat {
  const rawValue = normalizeConfigString(getConfigValue<string>(CONFIG_RESPONSE_FORMAT, 'text'));
  const value = rawValue ? rawValue.toLowerCase() : '';
  if (value === 'structured' || value === 'both') {
    return value;
  }
  return 'text';
}

function getDebugLevel(): DebugLevel {
  const rawValue = normalizeConfigString(getConfigValue<string>(CONFIG_DEBUG, 'off'));
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

function formatTags(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(', ') : '(none)';
}

function formatSchema(schema: unknown): string {
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
