import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildWorkspaceHandshakePayload,
  formatWorkspaceHandshakeSummary,
} from './managerHandshake';
import type {
  HandshakeDiscoveryCallTool,
  HandshakeDiscoveryBridgedTool,
  HandshakeDiscoveryIssue,
  HandshakeDiscoveryPayload,
  HandshakeDiscoveryResourceTemplate,
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
import {
  getPathScopeSpecReadHint,
  getPathScopeSpecResourceDescription,
  getPathScopeSpecText,
  PATH_SCOPE_SPEC_URI,
} from './pathScopeSpec';

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
  [key: string]: unknown;
}

interface SessionState {
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
const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.bindWorkspace';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callBridgedTool';
const GUIDE_RESOURCE_URI = 'lm-tools-bridge://guide';
const TOOL_NAMES_RESOURCE_URI = 'lm-tools://tool-names';
const TOOL_URI_TEMPLATE = 'lm-tools://tool/{name}';
const HEALTH_TIMEOUT_MS = 1200;
const INSTANCE_POLL_INTERVAL_MS = 500;
const DISCOVERY_POLL_INTERVAL_MS = 500;
const HANDSHAKE_WAIT_TIMEOUT_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_HANDSHAKE_WAIT_TIMEOUT_MS', 30000);
const DISCOVERY_WAIT_TIMEOUT_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_DISCOVERY_WAIT_TIMEOUT_MS', 15000);

const session: SessionState = {
  sessionId: crypto.randomUUID(),
  resolveCwd: process.cwd(),
  workspaceSetExplicitly: false,
  workspaceMatched: false,
  currentTarget: undefined,
  offlineSince: undefined,
  boundTools: [],
  discovery: undefined,
};

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

function getPackageVersion(): string {
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
  return `read ${TOOL_URI_TEMPLATE} before the first tool call and build arguments that match its inputSchema.`;
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
    `pass arguments.arguments as an object that matches the target tool inputSchema from ${TOOL_URI_TEMPLATE}.`,
  );
}

function getDirectCallForbiddenToolNameMessage(): string {
  return appendNextStep(
    'Invalid params: tool name is not allowed.',
    'set arguments.name to a bridged workspace tool from discovery.bridgedTools or tools/list.',
  );
}

function getHandshakeResourceDescription(): string {
  return `Detailed bridge usage guide: bind once per session with ${REQUEST_WORKSPACE_METHOD}, then follow the bridged-tool, pathScope, routing, and fallback guidance in this resource.`;
}

function getRequestWorkspaceToolDescription(): string {
  return 'If the task calls for vscode-tools-like workspace search, code navigation, diagnostics, or VS Code IDE actions, or explicitly includes phrases like `vscode-tools` or `use vscode`, start here. Read lm-tools-bridge://guide before first use. Then bind this session to the workspace resolved from an absolute project path or absolute .code-workspace path, and rebind only when the workspace target changes. Input: { cwd: string }.';
}

function getDirectToolCallDescription(): string {
  return 'Read lm-tools-bridge://guide before first use. Then call a bridged workspace tool after bind, read lm-tools://tool/{name} before the first call, pass arguments that match the target tool inputSchema, and read lm-tools://spec/pathScope before any pathScope argument. Input: { name: string, arguments?: object }.';
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
  errorMessage?: string;
} {
  if (!data || typeof data !== 'object') {
    return { errorMessage: 'Invalid JSON-RPC payload from workspace MCP server.' };
  }
  const record = data as { result?: unknown; error?: unknown };
  if (record.error && typeof record.error === 'object') {
    const errorRecord = record.error as { message?: unknown };
    const message = typeof errorRecord.message === 'string'
      ? errorRecord.message
      : 'Workspace MCP server returned a JSON-RPC error.';
    return { errorMessage: message };
  }
  if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
    return { errorMessage: 'Workspace MCP server returned an invalid JSON-RPC result object.' };
  }
  return { result: record.result as Record<string, unknown> };
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

// Handshake discovery only advertises bridged tool names. Clients must read tool resources on demand.
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

function buildHandshakeUriTemplates(): HandshakeDiscoveryResourceTemplate[] {
  return [
    {
      name: 'Tool URI template',
      uriTemplate: TOOL_URI_TEMPLATE,
    },
  ];
}

function buildHandshakeGuidance(discovery: HandshakeDiscoveryPayload): HandshakeGuidance {
  const nextSteps = [
    `For each bridged tool, ${getToolReadHint()}`,
    getPathScopeSpecReadHint(),
  ];
  if (discovery.partial || discovery.issues.length > 0) {
    nextSteps.push(`Discovery is partial or has issues: ${getDiscoveryRefreshHint()}`);
  }
  return {
    nextSteps,
  };
}

function buildStructuredToolResult(payload: unknown, text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    structuredContent: payload as Record<string, unknown>,
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
          description: 'Bridged tool name to call. Resolve it from discovery.bridgedTools, lm-tools://tool-names, or lm-tools://tool/{name}.',
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

function getBoundToolNames(): string[] {
  return session.boundTools
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
}

function getAllVisibleTools(): WorkspaceToolDefinition[] {
  return [
    getRequestWorkspaceToolDefinition(),
    getDirectToolCallDefinition(),
    ...session.boundTools,
  ];
}

function findToolDefinitionByName(name: string): WorkspaceToolDefinition | undefined {
  return getAllVisibleTools().find((tool) => tool.name === name);
}

function buildToolInfoPayload(tool: WorkspaceToolDefinition): Record<string, unknown> {
  return {
    ...tool,
  };
}

async function readToolInputSchemaFromResource(
  target: ManagerMatch,
  toolName: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await requestTargetJson(target, {
    jsonrpc: '2.0',
    id: `mgr-tool-${toolName}-${Date.now()}`,
    method: 'resources/read',
    params: {
      uri: `lm-tools://tool/${toolName}`,
    },
  });
  if (!response.ok) {
    return undefined;
  }
  const parsed = getRemoteResultObject(response.data);
  if (parsed.errorMessage) {
    return undefined;
  }
  const contents = Array.isArray(parsed.result?.contents) ? parsed.result.contents : undefined;
  if (!contents || contents.length === 0) {
    return undefined;
  }
  const first = contents[0];
  if (!first || typeof first !== 'object') {
    return undefined;
  }
  const text = (first as { text?: unknown }).text;
  if (typeof text !== 'string') {
    return undefined;
  }
  try {
    const payload = JSON.parse(text) as { inputSchema?: unknown };
    if (!payload.inputSchema || typeof payload.inputSchema !== 'object' || Array.isArray(payload.inputSchema)) {
      return undefined;
    }
    return payload.inputSchema as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function resolveToolInputSchema(tool: WorkspaceToolDefinition): Promise<Record<string, unknown> | null> {
  const isBoundTool = session.boundTools.some((entry) => entry.name === tool.name);
  if (!isBoundTool || !session.currentTarget) {
    return tool.inputSchema ?? null;
  }
  // Avoid tool-definition fan-out during handshake and fetch the latest inputSchema only when a resource is actually read.
  return await readToolInputSchemaFromResource(session.currentTarget, tool.name) ?? tool.inputSchema ?? null;
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

function getHandshakeResource() {
  return {
    uri: GUIDE_RESOURCE_URI,
    name: 'Bridge usage guide',
    description: getHandshakeResourceDescription(),
    mimeType: 'text/plain',
  };
}

function getNamesResource() {
  return {
    uri: TOOL_NAMES_RESOURCE_URI,
    name: 'Bridged tool names',
    description: 'Read bridged tool names after bind. This is names-only discovery; read lm-tools://tool/{name} on demand for the full definition.',
    mimeType: 'application/json',
  };
}

function getPathScopeSpecResource() {
  return {
    uri: PATH_SCOPE_SPEC_URI,
    name: 'Shared pathScope syntax',
    description: getPathScopeSpecResourceDescription(),
    mimeType: 'text/plain',
  };
}

function getToolTemplate() {
  return {
    name: 'Tool URI template',
    uriTemplate: TOOL_URI_TEMPLATE,
    description: 'Read a bridged tool definition by name before the first call, then build arguments from its inputSchema.',
    mimeType: 'application/json',
  };
}

async function buildStatusPayload(): Promise<Record<string, unknown>> {
  const target = session.currentTarget;
  const health = target ? await checkTargetHealth(target) : undefined;
  const online = isHealthOk(health);
  return {
    ready: session.workspaceMatched && Boolean(target) && online,
    online,
    workspaceSetExplicitly: session.workspaceSetExplicitly,
    cwd: session.resolveCwd,
    offlineDurationSec: toOfflineDurationSec(session.offlineSince),
    target: target
      ? {
        workspaceFolders: target.workspaceFolders,
        workspaceFile: target.workspaceFile ?? null,
      }
      : null,
    health,
  };
}

async function clearBindingIfNeeded(server: Server): Promise<void> {
  if (!session.workspaceMatched && !session.currentTarget && session.boundTools.length === 0) {
    return;
  }
  session.workspaceMatched = false;
  session.currentTarget = undefined;
  session.boundTools = [];
  session.discovery = undefined;
  if (!session.offlineSince) {
    session.offlineSince = Date.now();
  }
  await server.sendToolListChanged();
  await server.sendResourceListChanged();
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
    return name !== REQUEST_WORKSPACE_METHOD && name !== DIRECT_TOOL_CALL_NAME;
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

  return {
    tools: tools
      .filter((entry): entry is WorkspaceToolDefinition => Boolean(entry))
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
  return {
    tools: fetched.tools,
    discovery: {
      callTool,
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
    throw new McpError(ErrorCode.InternalError, parsed.errorMessage);
  }
  return parsed.result as Record<string, unknown>;
}

function getHandshakeResourceText(statusPayload: Record<string, unknown>): string {
  return [
    'Workspace bridge guide',
    '',
    'This MCP manager requires an explicit workspace binding before workspace tools can be used.',
    '',
    'When to bind:',
    `- Call ${REQUEST_WORKSPACE_METHOD} with params.cwd once per client session.`,
    '- Reuse the current bind across calls; do not handshake again before every tool call.',
    '- Re-run handshake only when the workspace target changes or the bound workspace goes offline.',
    '',
    'Core flow:',
    `1. Call ${REQUEST_WORKSPACE_METHOD} with params.cwd set to the project path or .code-workspace path.`,
    '2. Treat the resolved workspace roots as the validated lmToolsBridge scope.',
    `3. Follow guidance.nextSteps from the handshake response.`,
    `4. Use discovery.bridgedTools as names-only discovery and read lm-tools://tool/{name} only for the tools needed by the current task.`,
    `5. Before the first bridged tool call, ${getToolReadHint()}`,
    `6. ${getPathScopeSpecReadHint()}`,
    `7. Invoke ${DIRECT_TOOL_CALL_NAME} only after handshake and tool-definition read, or call the bridged tools returned by tools/list after handshake.`,
    '',
    'Routing and fallback:',
    '- Prefer lmToolsBridge tools for workspace file search, text search, multi-file inspection, and VS Code IDE actions inside validated workspace roots.',
    '- Prefer qgrep search tools for repeated workspace text search when they are available.',
    '- In multi-root workspaces, use WorkspaceName/... only when narrowing to one root; otherwise keep cross-root scope.',
    '- Do not use lmToolsBridge tools for paths outside validated workspace roots.',
    '- Never perform silent fallback. Report the failing tool and reason before any non-lmToolsBridge fallback.',
    '- If discovery is partial or has issues, refresh tool visibility before assuming a tool is unavailable.',
    `- On workspace failures or MCP call failures, ${getRebindRetryHint()}`,
    `- After handshake, ${getDiscoveryRefreshHint()}`,
    '',
    'Handshake result:',
    '- A successful handshake response includes discovery data (callTool, bridgedTools, resourceTemplates).',
    '- discovery.bridgedTools returns names only; read lm-tools://tool/{name} for per-tool description and inputSchema.',
    '',
    'Direct tool call after handshake:',
    `- ${DIRECT_TOOL_CALL_NAME} is used after a successful workspace binding.`,
    `- Before the first direct call, ${getToolReadHint()}`,
    '- Build arguments from the tool inputSchema you just read.',
    `- If any argument is named pathScope, ${getPathScopeSpecReadHint()}`,
    `- Call ${DIRECT_TOOL_CALL_NAME} with the bridged tool name and arguments object.`,
    '- Prefer bridged workspace tools for validated workspace requests.',
    '- Prefer qgrep search tools for repeated workspace text search when they are available.',
    '- Do not use lmToolsBridge tools for paths outside validated workspace roots.',
    '- Never perform silent fallback. Report the failing tool and reason before any non-lmToolsBridge fallback.',
    `- When discovery is partial or has issues, ${getDiscoveryRefreshHint()}`,
    `- If workspace errors appear, ${getRebindRetryHint()}`,
    '- Example:',
    JSON.stringify(
      {
        name: 'lm_findFiles',
        arguments: { query: 'src/**/*.ts', maxResults: 20 },
      },
      null,
      2,
    ),
    '',
    'Status snapshot:',
    JSON.stringify(statusPayload, null, 2),
  ].join('\n');
}

function getToolNameFromUri(uri: string, prefix: string): string | undefined {
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const raw = uri.slice(prefix.length);
  return raw.length > 0 ? decodeURIComponent(raw) : undefined;
}

function createServer(): Server {
  const server = new Server(
    {
      name: 'lm-tools-bridge-stdio-manager',
      version: getPackageVersion(),
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {
          listChanged: true,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: getAllVisibleTools(),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const rawArgs = request.params.arguments;
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
      ? rawArgs as Record<string, unknown>
      : {};

    if (name === REQUEST_WORKSPACE_METHOD) {
      const payload = await handleRequestWorkspace(server, args.cwd);
      return buildStructuredToolResult(payload, formatWorkspaceHandshakeSummary(payload));
    }

    if (name === DIRECT_TOOL_CALL_NAME) {
      const targetToolName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!targetToolName) {
        throw new McpError(ErrorCode.InvalidParams, getDirectCallNameParamMessage());
      }
      if (targetToolName === DIRECT_TOOL_CALL_NAME || targetToolName === REQUEST_WORKSPACE_METHOD) {
        throw new McpError(ErrorCode.InvalidParams, getDirectCallForbiddenToolNameMessage());
      }
      const targetArgs = args.arguments;
      if (targetArgs !== undefined && (typeof targetArgs !== 'object' || targetArgs === null || Array.isArray(targetArgs))) {
        throw new McpError(ErrorCode.InvalidParams, getDirectCallArgumentsParamMessage());
      }
      return invokeBoundTool(server, targetToolName, (targetArgs as Record<string, unknown> | undefined) ?? {});
    }

    const tool = session.boundTools.find((entry) => entry.name === name);
    if (!tool) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        session.workspaceSetExplicitly ? getWorkspaceNotMatchedMessage() : getWorkspaceNotSetMessage(),
      );
    }
    return invokeBoundTool(server, name, args);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        getHandshakeResource(),
        getPathScopeSpecResource(),
        getNamesResource(),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        getToolTemplate(),
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === GUIDE_RESOURCE_URI) {
      return resourceJson(uri, getHandshakeResourceText(await buildStatusPayload()), 'text/plain');
    }
    if (uri === TOOL_NAMES_RESOURCE_URI) {
      return resourceJson(uri, { tools: getBoundToolNames() });
    }
    if (uri === PATH_SCOPE_SPEC_URI) {
      return resourceJson(uri, getPathScopeSpecText(), 'text/plain');
    }
    const toolName = getToolNameFromUri(uri, 'lm-tools://tool/');
    if (toolName) {
      const tool = findToolDefinitionByName(toolName);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Tool not found or unavailable: ${toolName}`);
      }
      return resourceJson(uri, {
        ...buildToolInfoPayload(tool),
        inputSchema: await resolveToolInputSchema(tool),
      });
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    process.stderr.write(`stdio manager transport error: ${String(error)}\n`);
  };
  await server.connect(transport);
}

void main().catch((error) => {
  process.stderr.write(`stdio manager failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
