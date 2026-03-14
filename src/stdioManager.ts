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
  HandshakeDiscoveryIssue,
  HandshakeDiscoveryPayload,
  HandshakeDiscoveryResourceTemplate,
  HandshakeDiscoveryTool,
  HandshakeGuidance,
  WorkspaceHandshakePayload,
} from './managerHandshake';
import {
  getInstanceRegistryDir,
  getInstanceRegistryTtlMs,
  isCwdMatchingWorkspaceFile,
  isCwdWithinWorkspaceFolders,
  pickBestMatchingInstance,
  readRegisteredInstances,
  type RegisteredInstance,
} from './instanceRegistry';
import {
  isSupportedWindowsWorkspacePath,
  resolveComparablePath,
} from './windowsWorkspacePath';

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

interface LaunchTarget {
  openPath: string;
  kind: 'workspace-file' | 'folder';
  lockKey: string;
}

const HEALTH_PATH = '/mcp/health';
const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.requestWorkspaceMCPServer';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callTool';
const HANDSHAKE_RESOURCE_URI = 'lm-tools-bridge://handshake';
const CALL_TOOL_RESOURCE_URI = 'lm-tools-bridge://callTool';
const TOOL_NAMES_RESOURCE_URI = 'lm-tools://names';
const TOOL_URI_TEMPLATE = 'lm-tools://tool/{name}';
const TOOL_SCHEMA_URI_TEMPLATE = 'lm-tools://schema/{name}';
const HEALTH_TIMEOUT_MS = 1200;
const INSTANCE_POLL_INTERVAL_MS = 500;
const DISCOVERY_POLL_INTERVAL_MS = 500;
const HANDSHAKE_WAIT_TIMEOUT_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_HANDSHAKE_WAIT_TIMEOUT_MS', 90000);
const DISCOVERY_WAIT_TIMEOUT_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_DISCOVERY_WAIT_TIMEOUT_MS', 15000);
const LAUNCH_LOCK_STALE_MS = getPositiveIntFromEnv('LM_TOOLS_BRIDGE_LAUNCH_LOCK_STALE_MS', 120000);

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

function getSchemaReadHint(): string {
  return `read ${TOOL_SCHEMA_URI_TEMPLATE} before the first tool call and build arguments that match inputSchema.`;
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
    `pass arguments.arguments as an object that matches ${TOOL_SCHEMA_URI_TEMPLATE} for the target tool.`,
  );
}

function getDirectCallForbiddenToolNameMessage(): string {
  return appendNextStep(
    'Invalid params: tool name is not allowed.',
    'set arguments.name to a bridged workspace tool from discovery.bridgedTools or tools/list.',
  );
}

function getHandshakeResourceDescription(): string {
  return `Handshake required: call ${REQUEST_WORKSPACE_METHOD} with params.cwd; success includes discovery (callTool/bridgedTools).`;
}

function getRequestWorkspaceToolDescription(): string {
  return 'Resolve and bind a workspace MCP server. Input: { cwd: string }.';
}

function getDirectToolCallDescription(): string {
  return 'Directly call an exposed tool by name after workspace handshake. Input: { name: string, arguments?: object }.';
}

function toOfflineDurationSec(startedAt?: number): number | null {
  if (!startedAt) {
    return null;
  }
  return Math.floor((Date.now() - startedAt) / 1000);
}

function toManagerMatch(instance: RegisteredInstance): ManagerMatch {
  return {
    sessionId: instance.sessionId,
    host: instance.host,
    port: instance.port,
    workspaceFolders: instance.workspaceFolders,
    workspaceFile: instance.workspaceFile ?? null,
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

function buildSimpleInputHint(inputSchema: unknown): string | undefined {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return undefined;
  }
  const record = inputSchema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return undefined;
  }
  const propertyEntries = Object.entries(properties)
    .filter(([name]) => name.trim().length > 0);
  if (propertyEntries.length === 0) {
    return undefined;
  }
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
  );
  const parts = propertyEntries.map(([name, schema]) => {
    const optionalMarker = required.has(name) ? '' : '?';
    const typeLabel = getInputSchemaTypeLabel(schema);
    return `${name}${optionalMarker}: ${typeLabel}`;
  });
  return `Input: { ${parts.join(', ')} }.`;
}

function getInputSchemaTypeLabel(schema: unknown): string {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'unknown';
  }
  const record = schema as Record<string, unknown>;
  const type = record.type;
  if (typeof type === 'string' && type.trim().length > 0) {
    return type;
  }
  if (Array.isArray(type)) {
    const labels = type
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    if (labels.length > 0) {
      return labels.join('|');
    }
  }
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return 'enum';
  }
  if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
    return 'object';
  }
  if (record.items !== undefined) {
    return 'array';
  }
  return 'unknown';
}

function withSimpleInputHint(descriptionValue: unknown, inputSchema: unknown): string {
  const description = typeof descriptionValue === 'string' ? descriptionValue.trim() : '';
  if (description.includes('Input: {')) {
    return description;
  }
  const inputHint = buildSimpleInputHint(inputSchema);
  if (!inputHint) {
    return description;
  }
  if (!description) {
    return inputHint;
  }
  const needsPeriod = description.endsWith('.') ? '' : '.';
  return `${description}${needsPeriod} ${inputHint}`;
}

function toHandshakeDiscoveryTool(entry: unknown): HandshakeDiscoveryTool | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const record = entry as { name?: unknown; description?: unknown; inputSchema?: unknown };
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) {
    return undefined;
  }
  const description = withSimpleInputHint(record.description, record.inputSchema);
  const normalized: HandshakeDiscoveryTool = {
    name,
    description,
  };
  if (record.inputSchema && typeof record.inputSchema === 'object' && !Array.isArray(record.inputSchema)) {
    normalized.inputSchema = record.inputSchema as Record<string, unknown>;
  }
  return normalized;
}

function mergeHandshakeDiscoveryTools(base: HandshakeDiscoveryTool[], incoming: unknown[]): HandshakeDiscoveryTool[] {
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

function sortHandshakeDiscoveryTools(tools: HandshakeDiscoveryTool[]): HandshakeDiscoveryTool[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function buildHandshakeUriTemplates(): HandshakeDiscoveryResourceTemplate[] {
  return [
    {
      name: 'Tool URI template',
      uriTemplate: TOOL_URI_TEMPLATE,
    },
    {
      name: 'Schema URI template',
      uriTemplate: TOOL_SCHEMA_URI_TEMPLATE,
    },
  ];
}

function buildHandshakeGuidance(discovery: HandshakeDiscoveryPayload): HandshakeGuidance {
  const nextSteps = [
    `For each bridged tool, ${getSchemaReadHint()}`,
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
        cwd: { type: 'string', description: 'Workspace path to resolve.' },
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
        name: { type: 'string', description: 'Tool name to call.' },
        arguments: { type: 'object', description: 'Tool arguments.' },
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
    toolUri: `lm-tools://tool/${tool.name}`,
    schemaUri: `lm-tools://schema/${tool.name}`,
  };
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
    uri: HANDSHAKE_RESOURCE_URI,
    name: 'MCP manager handshake',
    description: getHandshakeResourceDescription(),
    mimeType: 'text/plain',
  };
}

function getCallToolResource() {
  return {
    uri: CALL_TOOL_RESOURCE_URI,
    name: 'MCP manager direct tool call',
    description: getDirectToolCallDescription(),
    mimeType: 'text/plain',
  };
}

function getNamesResource() {
  return {
    uri: TOOL_NAMES_RESOURCE_URI,
    name: 'Bridged tool names',
    description: 'Read bridged workspace tool names after handshake.',
    mimeType: 'application/json',
  };
}

function getToolTemplate() {
  return {
    name: 'Tool URI template',
    uriTemplate: TOOL_URI_TEMPLATE,
    description: 'Read a bridged tool definition by name.',
    mimeType: 'application/json',
  };
}

function getSchemaTemplate() {
  return {
    name: 'Schema URI template',
    uriTemplate: TOOL_SCHEMA_URI_TEMPLATE,
    description: 'Read a bridged tool input schema by name.',
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
        sessionId: target.sessionId,
        host: target.host,
        port: target.port,
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

async function resolveHealthyTarget(cwd: string): Promise<ManagerMatch | undefined> {
  const instances = await readRegisteredInstances({
    directory: getInstanceRegistryDir(),
    ttlMs: getInstanceRegistryTtlMs(),
    pruneStale: true,
  });
  const matched = pickBestMatchingInstance(cwd, instances);
  if (!matched) {
    return undefined;
  }
  const target = toManagerMatch(matched);
  const health = await checkTargetHealth(target);
  return isHealthOk(health) ? target : undefined;
}

async function tryAcquireLaunchLock(lockPath: string): Promise<(() => Promise<void>) | undefined> {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.promises.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
    await handle.close();
    return async () => {
      try {
        await fs.promises.unlink(lockPath);
      } catch {
        // Ignore cleanup failures.
      }
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EEXIST') {
      throw error;
    }
    try {
      const stats = await fs.promises.stat(lockPath);
      if (Date.now() - stats.mtimeMs > LAUNCH_LOCK_STALE_MS) {
        await fs.promises.unlink(lockPath).catch(() => undefined);
      }
    } catch {
      // Ignore lock read failures.
    }
    return undefined;
  }
}

function getLaunchLockPath(lockKey: string): string {
  return path.join(
    getInstanceRegistryDir(),
    'locks',
    `${crypto.createHash('sha1').update(lockKey).digest('hex')}.lock`,
  );
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

async function resolveLaunchTarget(cwd: string): Promise<LaunchTarget> {
  const comparable = resolveComparablePath(cwd);
  if (await pathIsFile(comparable) && comparable.toLowerCase().endsWith('.code-workspace')) {
    return {
      openPath: comparable,
      kind: 'workspace-file',
      lockKey: comparable.toLowerCase(),
    };
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
      return {
        openPath: workspaceFile,
        kind: 'workspace-file',
        lockKey: workspaceFile.toLowerCase(),
      };
    }
    if (await pathIsDirectory(path.join(current, '.vscode'))) {
      return {
        openPath: current,
        kind: 'folder',
        lockKey: current.toLowerCase(),
      };
    }
    if (await pathExists(path.join(current, '.git'))) {
      return {
        openPath: current,
        kind: 'folder',
        lockKey: current.toLowerCase(),
      };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return {
    openPath: baseDirectory,
    kind: 'folder',
    lockKey: baseDirectory.toLowerCase(),
  };
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

async function launchVsCode(target: LaunchTarget): Promise<void> {
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

async function waitForHealthyTarget(cwd: string, deadlineMs: number): Promise<ManagerMatch | undefined> {
  while (Date.now() < deadlineMs) {
    const target = await resolveHealthyTarget(cwd);
    if (target) {
      return target;
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
  const existing = await resolveHealthyTarget(cwd);
  if (existing) {
    return {
      target: existing,
      startupAttempted: false,
    };
  }

  const launchTarget = await resolveLaunchTarget(cwd);
  const deadlineMs = Date.now() + HANDSHAKE_WAIT_TIMEOUT_MS;
  const lockPath = getLaunchLockPath(launchTarget.lockKey);

  while (Date.now() < deadlineMs) {
    const release = await tryAcquireLaunchLock(lockPath);
    if (release) {
      try {
        const matchedBeforeLaunch = await resolveHealthyTarget(cwd);
        if (matchedBeforeLaunch) {
          return {
            target: matchedBeforeLaunch,
            startupAttempted: false,
          };
        }
        await launchVsCode(launchTarget);
        return {
          target: await waitForHealthyTarget(cwd, deadlineMs),
          startupAttempted: true,
        };
      } finally {
        await release();
      }
    }

    const matched = await resolveHealthyTarget(cwd);
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

async function readToolSchemaFromResource(
  target: ManagerMatch,
  toolName: string,
): Promise<{ inputSchema?: Record<string, unknown>; issue?: HandshakeDiscoveryIssue }> {
  const response = await requestTargetJson(target, {
    jsonrpc: '2.0',
    id: `mgr-schema-${toolName}-${Date.now()}`,
    method: 'resources/read',
    params: {
      uri: `lm-tools://schema/${toolName}`,
    },
  });
  if (!response.ok) {
    return {
      issue: {
        level: 'warning',
        category: 'schema',
        code: 'SCHEMA_READ_REQUEST_FAILED',
        toolName,
        message: 'Failed to fetch schema resource for tool.',
      },
    };
  }
  const parsed = getRemoteResultObject(response.data);
  if (parsed.errorMessage) {
    return {
      issue: {
        level: 'warning',
        category: 'schema',
        code: 'SCHEMA_READ_RPC_ERROR',
        toolName,
        message: 'Workspace MCP server returned an error while reading schema resource.',
        details: parsed.errorMessage,
      },
    };
  }
  const contents = Array.isArray(parsed.result?.contents) ? parsed.result.contents : undefined;
  if (!contents || contents.length === 0) {
    return {
      issue: {
        level: 'warning',
        category: 'schema',
        code: 'SCHEMA_CONTENT_MISSING',
        toolName,
        message: 'Schema resource did not include readable contents.',
      },
    };
  }
  const first = contents[0];
  if (!first || typeof first !== 'object') {
    return {
      issue: {
        level: 'warning',
        category: 'schema',
        code: 'SCHEMA_CONTENT_INVALID',
        toolName,
        message: 'Schema resource content format is invalid.',
      },
    };
  }
  const text = (first as { text?: unknown }).text;
  if (typeof text !== 'string') {
    return {
      issue: {
        level: 'warning',
        category: 'schema',
        code: 'SCHEMA_TEXT_MISSING',
        toolName,
        message: 'Schema resource text payload is missing.',
      },
    };
  }
  try {
    const payload = JSON.parse(text) as { inputSchema?: unknown };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        issue: {
          level: 'warning',
          category: 'schema',
          code: 'SCHEMA_JSON_INVALID',
          toolName,
          message: 'Schema resource JSON payload is invalid.',
        },
      };
    }
    if (!payload.inputSchema || typeof payload.inputSchema !== 'object' || Array.isArray(payload.inputSchema)) {
      return {
        issue: {
          level: 'warning',
          category: 'schema',
          code: 'SCHEMA_INPUT_MISSING',
          toolName,
          message: 'Schema resource does not define a valid inputSchema object.',
        },
      };
    }
    return {
      inputSchema: payload.inputSchema as Record<string, unknown>,
    };
  } catch {
    return {
      issue: {
        level: 'warning',
        category: 'schema',
        code: 'SCHEMA_JSON_PARSE_FAILED',
        toolName,
        message: 'Failed to parse schema resource JSON.',
      },
    };
  }
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

  const tools = await Promise.all(filtered.map(async (entry) => {
    if (!entry || typeof entry !== 'object') {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) {
      return undefined;
    }
    const schemaResult = await readToolSchemaFromResource(target, name);
    if (schemaResult.issue) {
      issues.push(schemaResult.issue);
    }
    return {
      ...record,
      ...(schemaResult.inputSchema ? { inputSchema: schemaResult.inputSchema } : {}),
      name,
    } satisfies WorkspaceToolDefinition;
  }));

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
  const callTool = toHandshakeDiscoveryTool(getDirectToolCallDefinition()) ?? {
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
    mcpSessionId: session.sessionId,
    cwd: session.resolveCwd,
    target: {
      sessionId: matchedTarget.sessionId,
      host: matchedTarget.host,
      port: matchedTarget.port,
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
    'This MCP manager requires an explicit workspace handshake.',
    `Call ${REQUEST_WORKSPACE_METHOD} with params.cwd before workspace tools.`,
    `On workspace failures or MCP call failures, ${getRebindRetryHint()}`,
    'A successful handshake response includes discovery data (callTool/bridgedTools).',
    `After handshake, ${getDiscoveryRefreshHint()}`,
    `Before first tool call, ${getSchemaReadHint()}`,
    `Invoke ${DIRECT_TOOL_CALL_NAME} only after handshake and schema read.`,
    '',
    'Status snapshot:',
    JSON.stringify(statusPayload, null, 2),
  ].join('\n');
}

function getCallToolResourceText(): string {
  return [
    'Direct tool call bridge (handshake + schema required).',
    `Tool name: ${DIRECT_TOOL_CALL_NAME}`,
    'Input: { name: string, arguments?: object }',
    `Before first call, ${getSchemaReadHint()}`,
    `When discovery is partial or has issues, ${getDiscoveryRefreshHint()}`,
    `If workspace errors appear, ${getRebindRetryHint()}`,
    'Example:',
    JSON.stringify(
      {
        name: 'lm_findFiles',
        arguments: { query: 'src/**/*.ts', maxResults: 20 },
      },
      null,
      2,
    ),
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
        getCallToolResource(),
        getNamesResource(),
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        getToolTemplate(),
        getSchemaTemplate(),
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === HANDSHAKE_RESOURCE_URI) {
      return resourceJson(uri, getHandshakeResourceText(await buildStatusPayload()), 'text/plain');
    }
    if (uri === CALL_TOOL_RESOURCE_URI) {
      return resourceJson(uri, getCallToolResourceText(), 'text/plain');
    }
    if (uri === TOOL_NAMES_RESOURCE_URI) {
      return resourceJson(uri, { tools: getBoundToolNames() });
    }
    const toolName = getToolNameFromUri(uri, 'lm-tools://tool/');
    if (toolName) {
      const tool = findToolDefinitionByName(toolName);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Tool not found or unavailable: ${toolName}`);
      }
      return resourceJson(uri, buildToolInfoPayload(tool));
    }
    const schemaName = getToolNameFromUri(uri, 'lm-tools://schema/');
    if (schemaName) {
      const tool = findToolDefinitionByName(schemaName);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `Tool not found or unavailable: ${schemaName}`);
      }
      return resourceJson(uri, {
        name: tool.name,
        inputSchema: tool.inputSchema ?? null,
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
