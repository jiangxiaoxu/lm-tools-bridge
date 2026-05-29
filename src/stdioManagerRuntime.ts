import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildWorkspaceHandshakePayload,
} from './managerHandshake';
import type {
  HandshakeDiscoveryCallTool,
  HandshakeDiscoveryBridgedTool,
  HandshakeDiscoveryIssue,
  HandshakeDiscoveryPayload,
  HandshakeDiscoveryToolDefinitionsTool,
  HandshakeGuidance,
  WorkspaceHandshakePayload,
} from './managerHandshake';
import {
  createWorkspaceDiscoveryTarget,
  isCwdMatchingWorkspaceFile,
  isCwdWithinWorkspaceFolders,
  requestWorkspaceDiscovery,
  tryAcquireLaunchLock,
  type WorkspaceDiscoveryAdvertisement,
  type WorkspaceDiscoveryTarget,
} from './workspaceDiscovery';
import {
  isSupportedWindowsWorkspacePath,
  resolveComparablePath,
} from './windowsWorkspacePath';
import { getPathScopeSpecText } from './pathScopeSpec';
import {
  buildToolDefinitionsPayload,
  getToolDefinitionsLookupDefinition,
  LEGACY_LM_GET_TOOL_DEFINITIONS_TOOL_NAME,
  LM_TOOLS_BRIDGE_GET_TOOL_DEFINITIONS_TOOL_NAME,
  parseRequiredToolDefinitionNames,
} from './toolDefinitionsContract';

interface ManagerMatch {
  sessionId: string;
  host: string;
  port: number;
  workspaceFolders: string[];
  workspaceFile?: string | null;
}

interface WorkspaceToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StdioManagerRuntimeSessionState {
  sessionId: string;
  resolveCwd: string;
  workspaceSetExplicitly: boolean;
  workspaceMatched: boolean;
  currentTarget?: ManagerMatch;
  offlineSince?: number;
  boundTools: WorkspaceToolDefinition[];
  discovery?: HandshakeDiscoveryPayload;
}

const HEALTH_PATH = '/mcp/health';
const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge_bindWorkspace';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge_callBridgedTool';
const GET_TOOL_DEFINITIONS_METHOD = LM_TOOLS_BRIDGE_GET_TOOL_DEFINITIONS_TOOL_NAME;
const LEGACY_REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.bindWorkspace';
const LEGACY_DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callBridgedTool';
const LEGACY_GET_TOOL_DEFINITIONS_METHOD = 'lmToolsBridge.getToolDefinitions';
const TOOL_NAMES_RESOURCE_URI = 'lm-tools://tool-names';
const TOOL_DEFINITIONS_RESOURCE_URI = 'lm-tools://tool-definitions';
const HEALTH_TIMEOUT_MS = 1200;
const INSTANCE_POLL_INTERVAL_MS = 500;
const DISCOVERY_POLL_INTERVAL_MS = 500;
const HANDSHAKE_WAIT_TIMEOUT_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_HANDSHAKE_WAIT_TIMEOUT_MS', 30000);
const DISCOVERY_WAIT_TIMEOUT_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_DISCOVERY_WAIT_TIMEOUT_MS', 15000);

export interface StdioManagerRuntimeInitialState {
  sessionId?: string;
  resolveCwd?: string;
  workspaceSetExplicitly?: boolean;
  offlineSince?: number;
}

export interface StdioManagerRuntimeLocalHelperOverrides {
  guideText?: string;
  helperToolDefinitions?: WorkspaceToolDefinition[];
}

export interface StdioManagerRuntimeApi {
  bindWorkspace(server: Server, cwd: unknown): Promise<WorkspaceHandshakePayload>;
  getToolDefinitions(server: Server, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  callBridgedTool(server: Server, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  listBridgedTools(): WorkspaceToolDefinition[];
  readBridgedResource(server: Server, uri: string): Promise<Record<string, unknown>>;
  invalidateBinding(server: Server): Promise<void>;
  getLocalHelperOverrides(): StdioManagerRuntimeLocalHelperOverrides;
  dispose(): Promise<void>;
}

let session: StdioManagerRuntimeSessionState = createInitialSessionState();

function createInitialSessionState(
  state?: StdioManagerRuntimeInitialState,
): StdioManagerRuntimeSessionState {
  return {
    sessionId: state?.sessionId ?? crypto.randomUUID(),
    resolveCwd: state?.resolveCwd ?? process.cwd(),
    workspaceSetExplicitly: state?.workspaceSetExplicitly ?? false,
    workspaceMatched: false,
    currentTarget: undefined,
    offlineSince: state?.offlineSince,
    boundTools: [],
    discovery: undefined,
  };
}

function getPositiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const text = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown } | undefined;
    return typeof parsed?.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function appendNextStep(message: string, nextStep: string): string {
  const trimmed = message.trim();
  const suffix = trimmed.endsWith('.') ? '' : '.';
  return `${trimmed}${suffix} Next step: ${nextStep}`;
}

function getToolReadHint(): string {
  return 'follow the ToolDefinition cache and lookup rules in lm-tools://guide.';
}

function getDiscoveryRefreshHint(): string {
  return 'if discovery.partial=true or discovery.issues is non-empty, refresh available tools via tools/list.';
}

function getRebindRetryHint(): string {
  return `call ${REQUEST_WORKSPACE_METHOD} with params.cwd, wait for ok=true, then retry once.`;
}

function getWorkspaceNotMatchedMessage(): string {
  return appendNextStep(
    'Workspace not matched.',
    `call ${REQUEST_WORKSPACE_METHOD} with a cwd inside the target workspace, wait for success, then retry once.`,
  );
}

function getWorkspaceNotSetMessage(): string {
  return appendNextStep(
    'Workspace not set.',
    `call ${REQUEST_WORKSPACE_METHOD} with params.cwd before using workspace tools, then retry once.`,
  );
}

function getBridgedResourceBindingRequiredMessage(): string {
  return appendNextStep(
    'Workspace binding required before reading bridged discovery resources.',
    `call ${REQUEST_WORKSPACE_METHOD} with params.cwd, wait for ok=true, then retry once.`,
  );
}

function getBridgedResourceRebindMessage(): string {
  return appendNextStep(
    'Active workspace binding required before reading bridged discovery resources.',
    `${getRebindRetryHint()} Bridged discovery resources are available only after a successful bind.`,
  );
}

function getTargetUnreachableMessage(): string {
  return appendNextStep(
    'Workspace MCP server is unreachable.',
    `retry once; if it still fails, ${getRebindRetryHint()}`,
  );
}

function getMcpOfflineMessage(): string {
  return appendNextStep(
    'Resolved workspace MCP server is offline.',
    `${getRebindRetryHint()} Handshake will attempt VS Code auto-start when needed.`,
  );
}

function getInvalidRequestWorkspaceParamsMessage(): string {
  return appendNextStep(
    'Invalid params: expected params.cwd (string).',
    `call ${REQUEST_WORKSPACE_METHOD} with a non-empty cwd string and retry.`,
  );
}

function getInvalidWindowsCwdMessage(): string {
  return appendNextStep(
    'Invalid params.cwd: on Windows, only normal absolute paths or \\\\?\\ + normal absolute paths are supported.',
    `pass a supported absolute path to ${REQUEST_WORKSPACE_METHOD} and retry.`,
  );
}

function getDirectCallNameParamMessage(): string {
  return appendNextStep(
    'Invalid params: expected arguments.name (string).',
    `call ${DIRECT_TOOL_CALL_NAME} with { name: string, arguments?: object } and set arguments.name to a bridged tool name.`,
  );
}

function getDirectCallArgumentsParamMessage(): string {
  return appendNextStep(
    'Invalid params: expected arguments.arguments (object).',
    `pass arguments.arguments as an object that matches the target tool inputSchema from ${GET_TOOL_DEFINITIONS_METHOD}.`,
  );
}

function getDirectCallForbiddenToolNameMessage(): string {
  return appendNextStep(
    'Invalid params: tool name is not allowed.',
    'set arguments.name to a bridged workspace tool from discovery.bridgedTools or tools/list.',
  );
}

function isBridgeHelperToolName(name: string): boolean {
  return name === REQUEST_WORKSPACE_METHOD
    || name === DIRECT_TOOL_CALL_NAME
    || name === GET_TOOL_DEFINITIONS_METHOD
    || name === LEGACY_REQUEST_WORKSPACE_METHOD
    || name === LEGACY_DIRECT_TOOL_CALL_NAME
    || name === LEGACY_GET_TOOL_DEFINITIONS_METHOD
    || name === LEGACY_LM_GET_TOOL_DEFINITIONS_TOOL_NAME;
}

function getRequestWorkspaceToolDescription(): string {
  return 'If the task calls for vscode-tools-like workspace search, code navigation, diagnostics, or VS Code IDE actions, or explicitly includes phrases like `vscode-tools` or `use vscode`, start here. Read lm-tools://guide before first use. Then bind this session to the workspace resolved from an absolute project path or absolute .code-workspace path, and rebind only when the workspace target changes. Input: { cwd: string }.';
}

function getDirectToolCallDescription(): string {
  return `Read lm-tools://guide before first use. Before calling this bridged tool wrapper, this exact tool's full ToolDefinition must be known from ${GET_TOOL_DEFINITIONS_METHOD}. Reuse a known ToolDefinition and do not request it again. For an unknown ToolDefinition, call ${GET_TOOL_DEFINITIONS_METHOD} with names containing only tool names whose ToolDefinitions are unknown; never guess or infer the inputSchema. Pass arguments that match the target tool inputSchema. When an argument is named pathScope, use its parameter description for the compact syntax summary and lm-tools://guide for the full syntax. Input: { name: string, arguments?: object }.`;
}

function toOfflineDurationSec(startedAt?: number): number | null {
  if (!startedAt) {
    return null;
  }
  return Math.floor((Date.now() - startedAt) / 1000);
}

function toManagerMatch(advertisement: WorkspaceDiscoveryAdvertisement): ManagerMatch {
  return {
    sessionId: advertisement.serverSessionId,
    host: advertisement.host,
    port: advertisement.port,
    workspaceFolders: advertisement.workspaceFolders,
    workspaceFile: advertisement.workspaceFile ?? null,
  };
}

async function checkTargetHealth(
  target: ManagerMatch,
): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path: HEALTH_PATH,
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
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
            const parsed = JSON.parse(text) as unknown;
            resolve({ ok: status >= 200 && status < 300, status, data: parsed });
          } catch {
            resolve({ ok: false, status });
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, HEALTH_TIMEOUT_MS);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false });
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.end();
  });
}

function isHealthOk(health?: { ok?: boolean } | null): boolean {
  return health?.ok === true;
}

async function requestTargetJson(
  target: ManagerMatch,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status?: number; data?: unknown }> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path: '/mcp',
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          const text = Buffer.concat(chunks).toString('utf8');
          const contentType = Array.isArray(response.headers['content-type'])
            ? response.headers['content-type'].join(';')
            : response.headers['content-type'] ?? '';
          if (contentType.includes('text/event-stream')) {
            const events = text.split(/\r?\n\r?\n/);
            for (const eventBlock of events) {
              const lines = eventBlock.split(/\r?\n/);
              const dataLines = lines
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart());
              if (dataLines.length === 0) {
                continue;
              }
              const dataText = dataLines.join('\n').trim();
              if (!dataText || dataText === '[DONE]') {
                continue;
              }
              try {
                const parsed = JSON.parse(dataText) as unknown;
                resolve({ ok: status >= 200 && status < 300, status, data: parsed });
                return;
              } catch {
                continue;
              }
            }
            resolve({ ok: false, status });
            return;
          }
          try {
            const parsed = JSON.parse(text) as unknown;
            resolve({ ok: status >= 200 && status < 300, status, data: parsed });
          } catch {
            resolve({ ok: false, status });
          }
        });
      },
    );

    request.on('error', () => {
      resolve({ ok: false });
    });
    request.write(body);
    request.end();
  });
}

function getRemoteResultObject(data: unknown): {
  result?: Record<string, unknown>;
  errorCode?: number;
  errorMessage?: string;
} {
  if (!data || typeof data !== 'object') {
    return { errorMessage: 'Invalid JSON-RPC payload from workspace MCP server.' };
  }
  const record = data as { result?: unknown; error?: unknown };
  if (record.error && typeof record.error === 'object') {
    const errorRecord = record.error as { code?: unknown; message?: unknown };
    const code = typeof errorRecord.code === 'number' ? errorRecord.code : undefined;
    const message = typeof errorRecord.message === 'string'
      ? errorRecord.message
      : 'Workspace MCP server returned a JSON-RPC error.';
    return { errorCode: code, errorMessage: message };
  }
  if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
    return { errorMessage: 'Workspace MCP server returned an invalid JSON-RPC result object.' };
  }
  return { result: record.result as Record<string, unknown> };
}

function parseWorkspaceToolDefinitionsResource(result: Record<string, unknown>): WorkspaceToolDefinition[] | undefined {
  const contents = result.contents;
  if (!Array.isArray(contents)) {
    return undefined;
  }
  const first = contents[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return undefined;
  }
  const text = (first as { text?: unknown }).text;
  if (typeof text !== 'string') {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const tools = (payload as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const definitions = tools.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
      return undefined;
    }
    return {
      ...record,
      name,
    } satisfies WorkspaceToolDefinition;
  });
  return definitions.filter((entry): entry is WorkspaceToolDefinition => Boolean(entry));
}

function appendToolDefinitionRefreshHint(toolName: string, message: string): string {
  return `${message} Refresh ${toolName}'s ToolDefinition with ${GET_TOOL_DEFINITIONS_METHOD}, then retry with arguments that match the refreshed inputSchema.`;
}

function normalizeHandshakeToolDescription(descriptionValue: unknown): string {
  return typeof descriptionValue === 'string' ? descriptionValue.trim() : '';
}

function toHandshakeDiscoveryTool(entry: unknown): HandshakeDiscoveryBridgedTool | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as { name?: unknown };
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) {
    return undefined;
  }
  return {
    name,
  };
}

// Handshake discovery only advertises bridged tool names. Clients fetch tool definitions through the local helper.
function toHandshakeDiscoveryCallTool(entry: unknown): HandshakeDiscoveryCallTool | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) {
    return undefined;
  }
  const normalized: HandshakeDiscoveryCallTool = {
    name,
    description: normalizeHandshakeToolDescription(record.description),
  };
  if (record.inputSchema && typeof record.inputSchema === 'object' && !Array.isArray(record.inputSchema)) {
    normalized.inputSchema = record.inputSchema as Record<string, unknown>;
  }
  return normalized;
}

function buildHandshakeDiscoveryToolDefinitionsTool(
  _tools: readonly WorkspaceToolDefinition[],
): HandshakeDiscoveryToolDefinitionsTool {
  return getToolDefinitionsLookupDefinition();
}

function mergeHandshakeDiscoveryTools(
  base: HandshakeDiscoveryBridgedTool[],
  incoming: unknown[],
): HandshakeDiscoveryBridgedTool[] {
  const merged = [...base];
  const seen = new Set(base.map((entry) => entry.name));
  for (const entry of incoming) {
    const normalized = toHandshakeDiscoveryTool(entry);
    if (!normalized || seen.has(normalized.name)) {
      continue;
    }
    seen.add(normalized.name);
    merged.push(normalized);
  }
  return merged;
}

function sortHandshakeDiscoveryTools(
  tools: HandshakeDiscoveryBridgedTool[],
): HandshakeDiscoveryBridgedTool[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function buildHandshakeUriTemplates(): [] {
  return [];
}

function buildHandshakeGuidance(discovery: HandshakeDiscoveryPayload): HandshakeGuidance {
  const nextSteps = [
    `Use discovery.toolDefinitionsTool for ${GET_TOOL_DEFINITIONS_METHOD} usage, inputSchema, and outputSchema; ${getToolReadHint()}`,
    'For any tool argument named pathScope, use its parameter description for the compact syntax summary and lm-tools://guide for the full syntax.',
  ];
  if (discovery.partial || discovery.issues.length > 0) {
    nextSteps.push(`Discovery is partial or has issues: ${getDiscoveryRefreshHint()}`);
  }
  return {
    nextSteps,
  };
}

function getRequestWorkspaceToolDefinition(): WorkspaceToolDefinition {
  return {
    name: REQUEST_WORKSPACE_METHOD,
    description: getRequestWorkspaceToolDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Absolute workspace path to resolve. Use the absolute project root path or the absolute .code-workspace path. Relative paths are invalid.' },
      },
      required: ['cwd'],
    },
  };
}

function getDirectToolCallDefinition(): WorkspaceToolDefinition {
  return {
    name: DIRECT_TOOL_CALL_NAME,
    description: getDirectToolCallDescription(),
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Bridged tool name to call. Resolve it from discovery.bridgedTools, tools/list, or lm-tools://tool-names.',
        },
        arguments: {
          type: 'object',
          description: 'Optional arguments object for the bridged tool call. Must match the target tool inputSchema.',
        },
      },
      required: ['name'],
    },
  };
}

function getToolDefinitionsToolDefinition(): WorkspaceToolDefinition {
  return { ...getToolDefinitionsLookupDefinition() };
}

function getBoundToolNames(): string[] {
  return session.boundTools
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
}

function findBridgedToolDefinitionByName(name: string): WorkspaceToolDefinition | undefined {
  return session.boundTools.find((tool) => tool.name === name);
}

function resourceJson(uri: string, payload: unknown, mimeType = 'application/json') {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    contents: [
      {
        uri,
        mimeType,
        text,
      },
    ],
  };
}

async function ensureBridgedDiscoveryResourceReadable(server: Server): Promise<void> {
  if (!session.workspaceSetExplicitly) {
    throw new McpError(ErrorCode.InvalidRequest, getBridgedResourceBindingRequiredMessage());
  }
  if (!session.workspaceMatched || !session.currentTarget) {
    throw new McpError(ErrorCode.InvalidRequest, getBridgedResourceRebindMessage());
  }

  const health = await checkTargetHealth(session.currentTarget);
  if (!isHealthOk(health)) {
    await clearBindingIfNeeded(server);
    throw new McpError(ErrorCode.InvalidRequest, getBridgedResourceRebindMessage());
  }
}

async function clearBindingIfNeeded(
  server: Server,
  options?: { notify?: boolean },
): Promise<boolean> {
  if (!session.workspaceMatched && !session.currentTarget && session.boundTools.length === 0) {
    return false;
  }
  session.workspaceMatched = false;
  session.currentTarget = undefined;
  session.boundTools = [];
  session.discovery = undefined;
  if (!session.offlineSince) {
    session.offlineSince = Date.now();
  }
  if (options?.notify !== false) {
    await server.sendToolListChanged();
    await server.sendResourceListChanged();
  }
  return true;
}

async function resolveHealthyTarget(targets: readonly WorkspaceDiscoveryTarget[]): Promise<ManagerMatch | undefined> {
  for (const target of targets) {
    const discovered = await requestWorkspaceDiscovery(target, session.sessionId);
    if (!discovered) {
      continue;
    }
    const matched = toManagerMatch(discovered);
    const health = await checkTargetHealth(matched);
    if (isHealthOk(health)) {
      return matched;
    }
  }
  return undefined;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function findSingleWorkspaceFile(directory: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(directory);
  } catch {
    return undefined;
  }
  const workspaceFiles = entries
    .filter((entry) => entry.toLowerCase().endsWith('.code-workspace'))
    .map((entry) => path.join(directory, entry));
  if (workspaceFiles.length === 0) {
    return undefined;
  }
  if (workspaceFiles.length > 1) {
    throw new Error(`Multiple .code-workspace files found under ${directory}. Pass the target workspace file path explicitly.`);
  }
  return workspaceFiles[0];
}

async function resolveDiscoveryTargets(cwd: string): Promise<WorkspaceDiscoveryTarget[]> {
  const comparable = resolveComparablePath(cwd);
  if (await pathIsFile(comparable) && comparable.toLowerCase().endsWith('.code-workspace')) {
    return [createWorkspaceDiscoveryTarget('workspace-file', comparable)];
  }

  const baseDirectory = await pathIsFile(comparable)
    ? path.dirname(comparable)
    : comparable;
  if (!(await pathExists(baseDirectory))) {
    throw new Error(`Cannot auto-start VS Code because path does not exist: ${baseDirectory}`);
  }

  const targets: WorkspaceDiscoveryTarget[] = [];
  const seen = new Set<string>();
  let current = baseDirectory;

  while (true) {
    const workspaceFile = await findSingleWorkspaceFile(current);
    if (workspaceFile) {
      const workspaceTarget = createWorkspaceDiscoveryTarget('workspace-file', workspaceFile);
      if (!seen.has(workspaceTarget.canonicalIdentity)) {
        seen.add(workspaceTarget.canonicalIdentity);
        targets.push(workspaceTarget);
      }
    }
    const folderTarget = createWorkspaceDiscoveryTarget('folder', current);
    if (!seen.has(folderTarget.canonicalIdentity)) {
      seen.add(folderTarget.canonicalIdentity);
      targets.push(folderTarget);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return targets;
}

async function resolveLaunchTarget(cwd: string): Promise<WorkspaceDiscoveryTarget> {
  const comparable = resolveComparablePath(cwd);
  if (await pathIsFile(comparable) && comparable.toLowerCase().endsWith('.code-workspace')) {
    return createWorkspaceDiscoveryTarget('workspace-file', comparable);
  }

  const baseDirectory = await pathIsFile(comparable)
    ? path.dirname(comparable)
    : comparable;
  if (!(await pathExists(baseDirectory))) {
    throw new Error(`Cannot auto-start VS Code because path does not exist: ${baseDirectory}`);
  }

  let current = baseDirectory;

  while (true) {
    const workspaceFile = await findSingleWorkspaceFile(current);
    if (workspaceFile) {
      return createWorkspaceDiscoveryTarget('workspace-file', workspaceFile);
    }
    if (await pathIsDirectory(path.join(current, '.vscode'))) {
      return createWorkspaceDiscoveryTarget('folder', current);
    }
    if (await pathExists(path.join(current, '.git'))) {
      return createWorkspaceDiscoveryTarget('folder', current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return createWorkspaceDiscoveryTarget('folder', baseDirectory);
}

async function spawnDetached(command: string, args: string[], useShell: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: useShell,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function launchVsCode(target: WorkspaceDiscoveryTarget): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('VS Code auto-start is currently supported only on Windows.');
  }
  const args = ['--new-window', target.openPath];
  try {
    await spawnDetached('code.cmd', args, true);
    return;
  } catch {
    // Fall through to code.
  }
  try {
    await spawnDetached('code', args, false);
    return;
  } catch {
    throw new Error('Failed to launch VS Code from PATH. Tried code.cmd and code.');
  }
}

async function waitForHealthyTarget(
  targets: readonly WorkspaceDiscoveryTarget[],
  deadlineMs: number,
): Promise<ManagerMatch | undefined> {
  while (Date.now() < deadlineMs) {
    const matched = await resolveHealthyTarget(targets);
    if (matched) {
      return matched;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(INSTANCE_POLL_INTERVAL_MS, remaining));
  }
  return undefined;
}

async function ensureTargetWithAutoStart(cwd: string): Promise<{
  target: ManagerMatch | undefined;
  startupAttempted: boolean;
}> {
  const discoveryTargets = await resolveDiscoveryTargets(cwd);
  const launchTarget = await resolveLaunchTarget(cwd);
  const existing = await resolveHealthyTarget(discoveryTargets);
  if (existing) {
    return {
      target: existing,
      startupAttempted: false,
    };
  }

  const deadlineMs = Date.now() + HANDSHAKE_WAIT_TIMEOUT_MS;

  while (Date.now() < deadlineMs) {
    const release = await tryAcquireLaunchLock(launchTarget);
    if (release) {
      try {
        const matchedBeforeLaunch = await resolveHealthyTarget(discoveryTargets);
        if (matchedBeforeLaunch) {
          return {
            target: matchedBeforeLaunch,
            startupAttempted: false,
          };
        }
        await launchVsCode(launchTarget);
        return {
          target: await waitForHealthyTarget(discoveryTargets, deadlineMs),
          startupAttempted: true,
        };
      } finally {
        await release();
      }
    }

    const matched = await resolveHealthyTarget(discoveryTargets);
    if (matched) {
      return {
        target: matched,
        startupAttempted: true,
      };
    }
    await delay(INSTANCE_POLL_INTERVAL_MS);
  }

  return {
    target: undefined,
    startupAttempted: true,
  };
}

async function fetchWorkspaceTools(target: ManagerMatch): Promise<{
  tools: WorkspaceToolDefinition[];
  issues: HandshakeDiscoveryIssue[];
  partial: boolean;
}> {
  const issues: HandshakeDiscoveryIssue[] = [];
  const response = await requestTargetJson(target, {
    jsonrpc: '2.0',
    id: `mgr-tools-${Date.now()}`,
    method: 'tools/list',
    params: {},
  });
  if (!response.ok) {
    issues.push({
      level: 'error',
      category: 'tools/list',
      code: 'TOOLS_LIST_FETCH_FAILED',
      message: 'Failed to fetch tools/list from workspace MCP server.',
    });
    return { tools: [], issues, partial: true };
  }
  const parsed = getRemoteResultObject(response.data);
  const remoteTools = Array.isArray(parsed.result?.tools) ? parsed.result.tools : undefined;
  if (!remoteTools) {
    issues.push({
      level: 'error',
      category: 'tools/list',
      code: 'TOOLS_LIST_INVALID_RESULT',
      message: parsed.errorMessage ?? 'Invalid tools/list response from workspace MCP server.',
    });
    return { tools: [], issues, partial: true };
  }

  const filtered = remoteTools.filter((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const name = typeof (entry as { name?: unknown }).name === 'string'
      ? (entry as { name: string }).name
      : '';
    return !isBridgeHelperToolName(name);
  });

  const tools = filtered.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
      return undefined;
    }
    return {
      ...record,
      name,
    } satisfies WorkspaceToolDefinition;
  });
  const visibleTools = tools.filter((entry): entry is WorkspaceToolDefinition => Boolean(entry));
  const fullDefinitionsResponse = await requestTargetJson(target, {
    jsonrpc: '2.0',
    id: `mgr-tool-definitions-${Date.now()}`,
    method: 'resources/read',
    params: {
      uri: TOOL_DEFINITIONS_RESOURCE_URI,
    },
  });
  const fullDefinitionsByName = new Map<string, WorkspaceToolDefinition>();
  if (fullDefinitionsResponse.ok) {
    const fullDefinitionsResult = getRemoteResultObject(fullDefinitionsResponse.data);
    if (fullDefinitionsResult.result) {
      const fullDefinitions = parseWorkspaceToolDefinitionsResource(fullDefinitionsResult.result);
      for (const definition of fullDefinitions ?? []) {
        fullDefinitionsByName.set(definition.name, definition);
      }
    }
  }
  const mergedTools = visibleTools.map((tool) => fullDefinitionsByName.get(tool.name) ?? tool);

  return {
    tools: mergedTools
      .sort((left, right) => left.name.localeCompare(right.name)),
    issues,
    partial: issues.some((issue) => issue.level === 'error'),
  };
}

async function buildHandshakeDiscovery(
  target: ManagerMatch,
  startupAttempted: boolean,
): Promise<{ discovery: HandshakeDiscoveryPayload; tools: WorkspaceToolDefinition[] }> {
  const callTool = toHandshakeDiscoveryCallTool(getDirectToolCallDefinition()) ?? {
    name: DIRECT_TOOL_CALL_NAME,
    description: getDirectToolCallDescription(),
    inputSchema: getDirectToolCallDefinition().inputSchema,
  };
  let fetched = await fetchWorkspaceTools(target);
  if (startupAttempted && fetched.tools.length === 0) {
    const deadlineMs = Date.now() + DISCOVERY_WAIT_TIMEOUT_MS;
    while (Date.now() < deadlineMs) {
      const health = await checkTargetHealth(target);
      if (!isHealthOk(health)) {
        break;
      }
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(DISCOVERY_POLL_INTERVAL_MS, remaining));
      fetched = await fetchWorkspaceTools(target);
      if (fetched.tools.length > 0) {
        break;
      }
    }
  }
  const bridgedTools = sortHandshakeDiscoveryTools(
    mergeHandshakeDiscoveryTools([], fetched.tools),
  );
  const toolDefinitionsTool = buildHandshakeDiscoveryToolDefinitionsTool(fetched.tools);
  return {
    tools: fetched.tools,
    discovery: {
      callTool,
      toolDefinitionsTool,
      bridgedTools,
      resourceTemplates: buildHandshakeUriTemplates(),
      partial: fetched.partial,
      issues: fetched.issues,
    },
  };
}

async function handleRequestWorkspace(server: Server, cwdValue: unknown): Promise<WorkspaceHandshakePayload> {
  if (typeof cwdValue !== 'string' || cwdValue.trim().length === 0) {
    throw new McpError(ErrorCode.InvalidParams, getInvalidRequestWorkspaceParamsMessage());
  }
  const trimmedCwd = cwdValue.trim();
  if (process.platform === 'win32' && !isSupportedWindowsWorkspacePath(trimmedCwd)) {
    throw new McpError(ErrorCode.InvalidParams, getInvalidWindowsCwdMessage());
  }

  session.resolveCwd = resolveComparablePath(trimmedCwd);
  session.workspaceSetExplicitly = true;

  const resolvedTarget = await ensureTargetWithAutoStart(session.resolveCwd);
  const matchedTarget = resolvedTarget.target;
  if (!matchedTarget) {
    session.workspaceMatched = false;
    session.currentTarget = undefined;
    session.boundTools = [];
    session.discovery = undefined;
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    await server.sendToolListChanged();
    await server.sendResourceListChanged();
    throw new McpError(
      ErrorCode.InvalidRequest,
      appendNextStep(
        'No matching or healthy VS Code instance for provided workspace.',
        'start VS Code for the target workspace manually or fix params.cwd, then call handshake again.',
      ),
    );
  }

  if (!isCwdWithinWorkspaceFolders(session.resolveCwd, matchedTarget.workspaceFolders)
    && !isCwdMatchingWorkspaceFile(session.resolveCwd, matchedTarget.workspaceFile)) {
    session.workspaceMatched = false;
    session.currentTarget = undefined;
    session.boundTools = [];
    session.discovery = undefined;
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    await server.sendToolListChanged();
    await server.sendResourceListChanged();
    throw new McpError(
      ErrorCode.InvalidRequest,
      appendNextStep(
        'Provided cwd is not within resolved workspace folders.',
        'choose a cwd inside workspaceFolders (or matching workspaceFile), then call handshake again.',
      ),
    );
  }

  const discoveryResult = await buildHandshakeDiscovery(matchedTarget, resolvedTarget.startupAttempted);
  const guidance = buildHandshakeGuidance(discoveryResult.discovery);
  session.workspaceMatched = true;
  session.currentTarget = matchedTarget;
  session.boundTools = discoveryResult.tools;
  session.discovery = discoveryResult.discovery;
  session.offlineSince = undefined;
  await server.sendToolListChanged();
  await server.sendResourceListChanged();
  return buildWorkspaceHandshakePayload({
    cwd: session.resolveCwd,
    target: {
      workspaceFolders: matchedTarget.workspaceFolders,
      workspaceFile: matchedTarget.workspaceFile ?? null,
    },
    discovery: discoveryResult.discovery,
    guidance,
  });
}

async function invokeBoundTool(
  server: Server,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!session.workspaceMatched || !session.currentTarget) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      session.workspaceSetExplicitly ? getWorkspaceNotMatchedMessage() : getWorkspaceNotSetMessage(),
    );
  }

  const remote = await requestTargetJson(session.currentTarget, {
    jsonrpc: '2.0',
    id: `mgr-call-${toolName}-${Date.now()}`,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  });
  if (!remote.ok) {
    const retryHealth = await checkTargetHealth(session.currentTarget);
    if (!isHealthOk(retryHealth)) {
      await clearBindingIfNeeded(server);
      throw new McpError(ErrorCode.InvalidRequest, getMcpOfflineMessage());
    }
    throw new McpError(ErrorCode.InternalError, getTargetUnreachableMessage());
  }
  const parsed = getRemoteResultObject(remote.data);
  if (parsed.errorMessage) {
    const isInvalidParams = parsed.errorCode === -32602;
    throw new McpError(
      isInvalidParams ? ErrorCode.InvalidParams : ErrorCode.InternalError,
      isInvalidParams ? appendToolDefinitionRefreshHint(toolName, parsed.errorMessage) : parsed.errorMessage,
    );
  }
  return parsed.result as Record<string, unknown>;
}

async function runGetToolDefinitions(
  server: Server,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await ensureBridgedDiscoveryResourceReadable(server);
  const names = parseRequiredToolDefinitionNames(args);
  return buildToolDefinitionsPayload(session.boundTools, names) as unknown as Record<string, unknown>;
}

function getHandshakeResourceText(): string {
  return [
    'Workspace bridge guide',
    '',
    'This MCP manager requires an explicit workspace binding before workspace tools can be used.',
    '',
    'Bind:',
    `- Call ${REQUEST_WORKSPACE_METHOD} once per client session with params.cwd set to an absolute project path or .code-workspace path.`,
    '- Reuse the current bind; rebind only when the workspace target changes or the bound workspace goes offline.',
    '- Treat returned workspaceFolders/workspaceFile as the validated lmToolsBridge scope.',
    '- Follow guidance.nextSteps from the handshake response.',
    '',
    'Tool discovery and calls:',
    '- discovery.bridgedTools is names-only.',
    `- discovery.toolDefinitionsTool describes ${GET_TOOL_DEFINITIONS_METHOD} and includes its inputSchema/outputSchema.`,
    `- Before invoking a bridged tool, have that exact tool's full ToolDefinition from ${GET_TOOL_DEFINITIONS_METHOD}; discovery.bridgedTools names alone are not definitions.`,
    `- Use ${GET_TOOL_DEFINITIONS_METHOD} only with tool names whose ToolDefinitions are unknown.`,
    '- If every needed ToolDefinition is already known, skip the definition lookup entirely and reuse the known ToolDefinition.',
    `- Do not guess or infer ToolDefinitions or inputSchemas from tool names, prior experience, or similar tools; definitions returned by ${GET_TOOL_DEFINITIONS_METHOD} are the source of truth.`,
    '- Build arguments from the known ToolDefinition inputSchema.',
    `- Call ${DIRECT_TOOL_CALL_NAME} with the bridged tool name and arguments object, or call a bridged tool directly only after its ToolDefinition is known.`,
    '- If an argument is named pathScope, use its parameter description for the compact syntax summary; the full pathScope syntax is below.',
    '',
    'Routing and recovery:',
    '- Prefer lmToolsBridge tools for workspace file search, text search, multi-file inspection, and VS Code IDE actions inside validated workspace roots.',
    '- Prefer qgrep search tools for repeated workspace text search when they are available.',
    '- In multi-root workspaces, use WorkspaceName/... only when narrowing to one root; otherwise keep cross-root scope.',
    '- Do not use lmToolsBridge tools for paths outside validated workspace roots.',
    '- Never perform silent fallback. Report the failing tool and reason before any non-lmToolsBridge fallback.',
    `- If discovery is partial or has issues, ${getDiscoveryRefreshHint()}`,
    `- On workspace or MCP call failures, ${getRebindRetryHint()}`,
    '- Reading lm-tools://tool-names before bind returns an actionable bind-required error.',
    '',
    getPathScopeSpecText(),
  ].join('\n');
}

export function createStdioManagerRuntime(
  initialState?: StdioManagerRuntimeInitialState,
): StdioManagerRuntimeApi {
  session = createInitialSessionState(initialState);
  return {
    async bindWorkspace(server, cwd) {
      return await handleRequestWorkspace(server, cwd);
    },
    async getToolDefinitions(server, args) {
      return await runGetToolDefinitions(server, args);
    },
    async callBridgedTool(server, name, args) {
      const tool = findBridgedToolDefinitionByName(name);
      if (!tool) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          session.workspaceSetExplicitly ? getWorkspaceNotMatchedMessage() : getWorkspaceNotSetMessage(),
        );
      }
      return await invokeBoundTool(server, name, args);
    },
    listBridgedTools() {
      return session.boundTools.map((tool) => ({ ...tool }));
    },
    async readBridgedResource(server, uri) {
      if (uri === TOOL_NAMES_RESOURCE_URI) {
        await ensureBridgedDiscoveryResourceReadable(server);
        return resourceJson(uri, { tools: getBoundToolNames() });
      }
      throw new McpError(ErrorCode.InvalidParams, `Unknown bridged resource URI: ${uri}`);
    },
    async invalidateBinding(server) {
      await clearBindingIfNeeded(server, { notify: false });
    },
    getLocalHelperOverrides() {
      return {
        guideText: getHandshakeResourceText(),
        helperToolDefinitions: [
          getRequestWorkspaceToolDefinition(),
          getDirectToolCallDefinition(),
          getToolDefinitionsToolDefinition(),
        ],
      };
    },
    async dispose() {
      return undefined;
    },
  };
}
