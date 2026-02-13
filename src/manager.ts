import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderStatusHtml } from './managerStatusPage';

const PIPE_PREFIX = 'lm-tools-bridge-manager';

function getUserSeed(): string {
  return process.env.USERNAME ?? process.env.USERPROFILE ?? os.userInfo().username ?? 'default-user';
}

function hashUserSeed(seed: string): string {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

function getManagerPipeName(): string {
  const hash = hashUserSeed(getUserSeed());
  return `\\\\.\\pipe\\${PIPE_PREFIX}-${hash}`;
}

interface InstanceRecord {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile?: string;
  host: string;
  port: number;
  lastSeen: number;
  startedAt: number;
  normalizedFolders: string[];
  normalizedWorkspaceFile?: string;
}

interface ManagerMatch {
  sessionId: string;
  host: string;
  port: number;
  workspaceFolders: string[];
  workspaceFile?: string | null;
}

interface SessionState {
  sessionId: string;
  resolveCwd: string;
  workspaceSetExplicitly: boolean;
  workspaceMatched: boolean;
  currentTarget?: ManagerMatch;
  offlineSince?: number;
  resolveInFlight?: Promise<ResolveResult>;
  clientSupportsRoots: boolean;
  clientSupportsRootsListChanged: boolean;
  clientCapabilityFlags: Record<string, boolean>;
  clientCapabilityObjectKeys: Record<string, string[]>;
  clientCapabilities: Record<string, unknown>;
  pendingRootsRequestId?: string;
  pendingRootsRequestedAt?: number;
  pendingRootsReason?: RootsSyncReason;
  lastRootsSyncAt?: number;
  lastRootsSyncReason?: RootsSyncReason;
  lastRootsCount?: number;
  lastRootsPreview: string[];
  lastRootsError?: string;
  lastSeen: number;
}

type ResolveErrorKind = 'no_match';
type RootsSyncReason = 'initialized' | 'list_changed';

type ResolveResult = {
  target?: ManagerMatch;
  errorKind?: ResolveErrorKind;
};

type JsonRpcLikeMessage = {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

type DiscoveryIssueLevel = 'error' | 'warning';
type DiscoveryIssueCategory = 'tools/list' | 'schema';

interface HandshakeDiscoveryTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface HandshakeDiscoveryResourceTemplate {
  name: string;
  uriTemplate: string;
}

interface HandshakeDiscoveryIssue {
  level: DiscoveryIssueLevel;
  category: DiscoveryIssueCategory;
  code: string;
  message: string;
  toolName?: string;
  details?: string;
}

interface HandshakeDiscoveryPayload {
  callTool: HandshakeDiscoveryTool;
  bridgedTools: HandshakeDiscoveryTool[];
  resourceTemplates: HandshakeDiscoveryResourceTemplate[];
  partial: boolean;
  issues: HandshakeDiscoveryIssue[];
}

interface ManagerStatusInstanceDetail {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile: string | null;
  host: string;
  port: number;
  lastSeen: number;
  lastSeenLocal: string;
  lastSeenAgeSec: number;
  startedAt: number;
  startedAtLocal: string;
  uptimeSec: number;
}

interface ManagerStatusSessionTarget {
  sessionId: string;
  host: string;
  port: number;
}

interface ManagerStatusSessionDetail {
  sessionId: string;
  resolveCwd: string;
  workspaceSetExplicitly: boolean;
  workspaceMatched: boolean;
  target: ManagerStatusSessionTarget | null;
  lastSeen: number;
  lastSeenLocal: string;
  lastSeenAgeSec: number;
  offlineSince: number | null;
  offlineSinceLocal: string | null;
  clientRootsSupported: boolean;
  clientRootsListChangedSupported: boolean;
  clientCapabilityFlags: Record<string, boolean>;
  clientCapabilityObjectKeys: Record<string, string[]>;
  clientCapabilities: Record<string, unknown>;
  pendingRootsRequestId: string | null;
  lastRootsSyncAt: number | null;
  lastRootsSyncAtLocal: string | null;
  lastRootsSyncReason: RootsSyncReason | null;
  lastRootsCount: number | null;
  lastRootsPreview: string[];
  lastRootsError: string | null;
}

interface ManagerStatusRootsPolicy {
  mode: 'server-requests-client';
  triggerOnInitialized: boolean;
  triggerOnListChanged: boolean;
  source: 'client-capability-roots';
  logging: '/mcp/log';
}

export interface ManagerStatusPayload {
  ok: true;
  version: string;
  now: number;
  nowIso: string;
  nowLocal: string;
  instances: number;
  instanceDetails: ManagerStatusInstanceDetail[];
  sessions: number;
  sessionDetails: ManagerStatusSessionDetail[];
  rootsPolicy: ManagerStatusRootsPolicy;
  lastNonEmptyAt: number;
  lastNonEmptyAtIso: string;
  lastNonEmptyAtLocal: string;
  lastNonEmptyAgeSec: number;
  uptimeSec: number;
}

const TTL_MS = 2500;
const PRUNE_INTERVAL_MS = 500;
const IDLE_GRACE_MS = 10000;
const PORT_RESERVATION_TTL_MS = 15000;
const MCP_HTTP_PORT_DEFAULT = 47100;
const MCP_SESSION_TTL_MS = 5 * 60 * 60 * 1000;
const PORT_MIN_VALUE = 1;
const PORT_MAX_VALUE = 65535;
const RESOLVE_RETRY_DELAY_MS = 500;
const RESOLVE_RETRIES = 10;
const STARTUP_GRACE_MS = 5000;
const STARTUP_TIME = Date.now();
const HEALTH_PATH = '/mcp/health';
const HEALTH_TIMEOUT_MS = 1200;
const ROOTS_REQUEST_TIMEOUT_MS = 15000;
const ROOTS_PREVIEW_LIMIT = 5;
const REQUEST_WORKSPACE_METHOD = 'lmToolsBridge.requestWorkspaceMCPServer';
const DIRECT_TOOL_CALL_NAME = 'lmToolsBridge.callTool';
const HANDSHAKE_RESOURCE_URI = 'lm-tools-bridge://handshake';
const CALL_TOOL_RESOURCE_URI = 'lm-tools-bridge://callTool';
const ERROR_MANAGER_UNREACHABLE = -32003;
const ERROR_NO_MATCH = -32004;
const ERROR_WORKSPACE_NOT_SET = -32005;
const ERROR_MCP_OFFLINE = -32006;
const LOG_ENV = 'LM_TOOLS_BRIDGE_MANAGER_LOG';
const LOG_MAX_LINES = 200;
const logBuffer: string[] = [];
const ROOTS_POLICY: ManagerStatusRootsPolicy = {
  mode: 'server-requests-client',
  triggerOnInitialized: true,
  triggerOnListChanged: true,
  source: 'client-capability-roots',
  logging: '/mcp/log',
};

const instances = new Map<string, InstanceRecord>();
const reservedPorts = new Map<string, { port: number; reservedAt: number }>();
const sessions = new Map<string, SessionState>();
let lastNonEmptyAt = Date.now();
let managerInternalRequestCounter = 0;

function nextManagerRequestId(prefix: string): string {
  managerInternalRequestCounter += 1;
  return `${prefix}-${managerInternalRequestCounter}`;
}

function getLogPath(): string | undefined {
  return process.env[LOG_ENV];
}

function formatLog(message: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] ${message}`;
}

function appendLog(message: string): void {
  const line = formatLog(message);
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX_LINES) {
    logBuffer.splice(0, logBuffer.length - LOG_MAX_LINES);
  }
  const logPath = getLogPath();
  if (!logPath) {
    return;
  }
  try {
    fs.appendFileSync(logPath, `${line}\n`, { encoding: 'utf8' });
  } catch {
    // Ignore log failures.
  }
}

function getPipeNameFromArgs(): string | undefined {
  const index = process.argv.indexOf('--pipe');
  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

function getHttpPortFromArgs(): number | undefined {
  const index = process.argv.indexOf('--http-port');
  if (index !== -1 && process.argv[index + 1]) {
    const parsed = Number(process.argv[index + 1]);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase();
}

function normalizeFolders(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => normalizePath(entry));
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= PORT_MIN_VALUE
    && value <= PORT_MAX_VALUE;
}

function prunePortReservations(now: number): void {
  for (const [sessionId, reservation] of reservedPorts.entries()) {
    if (now - reservation.reservedAt > PORT_RESERVATION_TTL_MS) {
      reservedPorts.delete(sessionId);
    }
  }
}

function pruneSessions(now: number): void {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.pendingRootsRequestId
      && typeof session.pendingRootsRequestedAt === 'number'
      && now - session.pendingRootsRequestedAt > ROOTS_REQUEST_TIMEOUT_MS) {
      appendLog(
        `[roots.list.timeout] session=${session.sessionId} id=${session.pendingRootsRequestId} reason=${session.pendingRootsReason ?? 'unknown'}`,
      );
      session.lastRootsError = 'roots/list response timeout';
      clearPendingRootsRequest(session);
    }
    if (now - session.lastSeen > MCP_SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

function getUsedPorts(now: number): Set<number> {
  prunePortReservations(now);
  const used = new Set<number>();
  for (const record of getAliveRecords()) {
    if (isValidPort(record.port)) {
      used.add(record.port);
    }
  }
  for (const reservation of reservedPorts.values()) {
    if (isValidPort(reservation.port)) {
      used.add(reservation.port);
    }
  }
  return used;
}

function respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
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
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

function getRequestUrl(req: http.IncomingMessage): URL | undefined {
  const urlValue = req.url;
  if (!urlValue) {
    return undefined;
  }
  const host = req.headers.host ?? '127.0.0.1';
  try {
    return new URL(urlValue, `http://${host}`);
  } catch {
    return undefined;
  }
}

function shouldLogHttpRequest(req: http.IncomingMessage, requestUrl: URL | undefined): boolean {
  const method = (req.method ?? '').toUpperCase();
  const pathname = requestUrl?.pathname ?? '';
  const isMcpPath = pathname === '/mcp' || pathname === '/mcp/';
  if (!isMcpPath) {
    return false;
  }
  return method === 'POST' || method === 'DELETE';
}

function getSessionIdFromRequest(req: http.IncomingMessage): string | undefined {
  const headerValue = req.headers['mcp-session-id'];
  if (Array.isArray(headerValue)) {
    const candidate = headerValue.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    return candidate ? candidate.trim() : undefined;
  }
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    return headerValue.trim();
  }
  return undefined;
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    resolveCwd: process.cwd(),
    workspaceSetExplicitly: false,
    workspaceMatched: false,
    currentTarget: undefined,
    offlineSince: undefined,
    resolveInFlight: undefined,
    clientSupportsRoots: false,
    clientSupportsRootsListChanged: false,
    clientCapabilityFlags: {},
    clientCapabilityObjectKeys: {},
    clientCapabilities: {},
    pendingRootsRequestId: undefined,
    pendingRootsRequestedAt: undefined,
    pendingRootsReason: undefined,
    lastRootsSyncAt: undefined,
    lastRootsSyncReason: undefined,
    lastRootsCount: undefined,
    lastRootsPreview: [],
    lastRootsError: undefined,
    lastSeen: Date.now(),
  };
}

function getManagerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const text = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown } | undefined;
    if (parsed && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // Ignore read/parse failures.
  }
  return 'unknown';
}

function pickBestMatch(cwd: string, records: InstanceRecord[]): InstanceRecord | undefined {
  const normalizedCwd = normalizePath(cwd);
  let best: InstanceRecord | undefined;
  let bestScore = 0;

  for (const record of records) {
    let score = 0;
    if (record.normalizedWorkspaceFile && normalizedCwd === record.normalizedWorkspaceFile) {
      score = 3;
    } else if (record.normalizedFolders.includes(normalizedCwd)) {
      score = 2;
    } else if (record.normalizedFolders.some((folder) => normalizedCwd.startsWith(`${folder}\\`))) {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = record;
    } else if (score === bestScore && score > 0 && best && record.lastSeen > best.lastSeen) {
      best = record;
    }
  }

  return bestScore > 0 ? best : undefined;
}

function toManagerMatch(record: InstanceRecord): ManagerMatch {
  return {
    sessionId: record.sessionId,
    host: record.host,
    port: record.port,
    workspaceFolders: record.workspaceFolders,
    workspaceFile: record.workspaceFile ?? null,
  };
}

function getAliveRecords(): InstanceRecord[] {
  const now = Date.now();
  const alive: InstanceRecord[] = [];
  for (const record of instances.values()) {
    if (now - record.lastSeen <= TTL_MS) {
      alive.push(record);
    }
  }
  return alive;
}

function normalizeFsPath(value: string): string {
  return path.resolve(value).toLowerCase();
}

function isCwdWithinWorkspaceFolders(cwd: string, workspaceFolders: string[]): boolean {
  const normalizedCwd = normalizeFsPath(cwd);
  return workspaceFolders.some((folder) => {
    const normalizedFolder = normalizeFsPath(folder);
    const relative = path.relative(normalizedFolder, normalizedCwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function isCwdMatchingWorkspaceFile(cwd: string, workspaceFile?: string | null): boolean {
  if (!workspaceFile) {
    return false;
  }
  return normalizePath(cwd) === normalizePath(workspaceFile);
}

function clearPendingRootsRequest(session: SessionState): void {
  session.pendingRootsRequestId = undefined;
  session.pendingRootsRequestedAt = undefined;
  session.pendingRootsReason = undefined;
}

function cloneJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
      return {};
    }
    return cloned as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getObjectKeys(value: unknown): string[] {
  const record = toObjectRecord(value);
  if (!record) {
    return [];
  }
  return Object.keys(record).sort((a, b) => a.localeCompare(b));
}

function cloneBooleanRecord(record: Record<string, boolean>): Record<string, boolean> {
  const cloned: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'boolean') {
      cloned[key] = value;
    }
  }
  return cloned;
}

function cloneStringArrayRecord(record: Record<string, string[]>): Record<string, string[]> {
  const cloned: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(record)) {
    cloned[key] = Array.isArray(value) ? [...value] : [];
  }
  return cloned;
}

function parseInitializeClientCapabilities(params: unknown): {
  clientSupportsRoots: boolean;
  clientSupportsRootsListChanged: boolean;
  clientCapabilityFlags: Record<string, boolean>;
  clientCapabilityObjectKeys: Record<string, string[]>;
  clientCapabilities: Record<string, unknown>;
} {
  const fallback = {
    clientSupportsRoots: false,
    clientSupportsRootsListChanged: false,
    clientCapabilityFlags: {},
    clientCapabilityObjectKeys: {},
    clientCapabilities: {},
  };
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return fallback;
  }
  const capabilities = cloneJsonRecord((params as { capabilities?: unknown }).capabilities);
  const rootsCapability = toObjectRecord(capabilities.roots);
  const capabilityFlags: Record<string, boolean> = {};
  const capabilityObjectKeys: Record<string, string[]> = {};
  for (const [capabilityName, capabilityValue] of Object.entries(capabilities)) {
    const capabilityObject = toObjectRecord(capabilityValue);
    capabilityFlags[capabilityName] = Boolean(capabilityObject);
    if (capabilityObject) {
      capabilityObjectKeys[capabilityName] = getObjectKeys(capabilityObject);
    }
  }
  const listChanged = rootsCapability ? rootsCapability.listChanged : undefined;
  return {
    clientSupportsRoots: Boolean(rootsCapability),
    clientSupportsRootsListChanged: Boolean(listChanged),
    clientCapabilityFlags: capabilityFlags,
    clientCapabilityObjectKeys: capabilityObjectKeys,
    clientCapabilities: capabilities,
  };
}

function describeRootsPreview(
  roots: Array<{ uri: string; name?: string }>,
  limit = ROOTS_PREVIEW_LIMIT,
): string[] {
  return roots.slice(0, limit).map((root) => {
    const rootName = typeof root.name === 'string' && root.name.trim().length > 0 ? root.name.trim() : undefined;
    return rootName ? `${rootName} -> ${root.uri}` : root.uri;
  });
}

function normalizeRootsFromResult(result: unknown): {
  roots: Array<{ uri: string; name?: string }>;
  error?: string;
} {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { roots: [], error: 'Invalid roots/list result payload: expected object.' };
  }
  const rootsValue = (result as { roots?: unknown }).roots;
  if (!Array.isArray(rootsValue)) {
    return { roots: [], error: 'Invalid roots/list result payload: roots must be an array.' };
  }
  const roots = rootsValue.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return [];
    }
    const uri = (entry as { uri?: unknown }).uri;
    if (typeof uri !== 'string' || uri.trim().length === 0) {
      return [];
    }
    const name = (entry as { name?: unknown }).name;
    return [{
      uri: uri.trim(),
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined,
    }];
  });
  return { roots };
}

function extractJsonRpcErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return 'Unknown roots/list error.';
  }
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  if (typeof code === 'number' && typeof message === 'string' && message.trim().length > 0) {
    return `[${code}] ${message.trim()}`;
  }
  if (typeof message === 'string' && message.trim().length > 0) {
    return message.trim();
  }
  if (typeof code === 'number') {
    return `[${code}] roots/list failed.`;
  }
  return 'Unknown roots/list error.';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveTargetWithDeadline(cwd: string, deadlineMs: number): Promise<ResolveResult> {
  while (Date.now() < deadlineMs) {
    const alive = getAliveRecords();
    const match = pickBestMatch(cwd, alive);
    if (match) {
      return { target: toManagerMatch(match), errorKind: undefined };
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(RESOLVE_RETRY_DELAY_MS, remaining));
  }
  return { target: undefined, errorKind: 'no_match' };
}

async function resolveTarget(cwd: string): Promise<ResolveResult> {
  const deadline = Date.now() + (RESOLVE_RETRIES * RESOLVE_RETRY_DELAY_MS);
  return resolveTargetWithDeadline(cwd, deadline);
}

function isSameTarget(left: ManagerMatch | undefined, right: ManagerMatch | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  return left.host === right.host && left.port === right.port;
}

async function checkTargetHealth(target: ManagerMatch): Promise<{ ok: boolean; status?: number; data?: unknown }> {
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
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
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

function toOfflineDurationSec(startedAt?: number): number | null {
  if (!startedAt) {
    return null;
  }
  return Math.floor((Date.now() - startedAt) / 1000);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatLocalDateTime(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildManagerStatusPayload(now: number): ManagerStatusPayload {
  const alive = getAliveRecords();
  return {
    ok: true,
    version: getManagerVersion(),
    now,
    nowIso: new Date(now).toISOString(),
    nowLocal: formatLocalDateTime(now),
    instances: alive.length,
    instanceDetails: alive.map((record) => ({
      sessionId: record.sessionId,
      pid: record.pid,
      workspaceFolders: record.workspaceFolders,
      workspaceFile: record.workspaceFile ?? null,
      host: record.host,
      port: record.port,
      lastSeen: record.lastSeen,
      lastSeenLocal: formatLocalDateTime(record.lastSeen),
      lastSeenAgeSec: Math.floor((now - record.lastSeen) / 1000),
      startedAt: record.startedAt,
      startedAtLocal: formatLocalDateTime(record.startedAt),
      uptimeSec: Math.floor((now - record.startedAt) / 1000),
    })),
    sessions: sessions.size,
    sessionDetails: Array.from(sessions.values()).map((session) => ({
      sessionId: session.sessionId,
      resolveCwd: session.resolveCwd,
      workspaceSetExplicitly: session.workspaceSetExplicitly,
      workspaceMatched: session.workspaceMatched,
      target: session.currentTarget
        ? {
          sessionId: session.currentTarget.sessionId,
          host: session.currentTarget.host,
          port: session.currentTarget.port,
        }
        : null,
      lastSeen: session.lastSeen,
      lastSeenLocal: formatLocalDateTime(session.lastSeen),
      lastSeenAgeSec: Math.floor((now - session.lastSeen) / 1000),
      offlineSince: session.offlineSince ?? null,
      offlineSinceLocal: session.offlineSince ? formatLocalDateTime(session.offlineSince) : null,
      clientRootsSupported: session.clientSupportsRoots,
      clientRootsListChangedSupported: session.clientSupportsRootsListChanged,
      clientCapabilityFlags: cloneBooleanRecord(session.clientCapabilityFlags),
      clientCapabilityObjectKeys: cloneStringArrayRecord(session.clientCapabilityObjectKeys),
      clientCapabilities: cloneJsonRecord(session.clientCapabilities),
      pendingRootsRequestId: session.pendingRootsRequestId ?? null,
      lastRootsSyncAt: session.lastRootsSyncAt ?? null,
      lastRootsSyncAtLocal: session.lastRootsSyncAt ? formatLocalDateTime(session.lastRootsSyncAt) : null,
      lastRootsSyncReason: session.lastRootsSyncReason ?? null,
      lastRootsCount: typeof session.lastRootsCount === 'number' ? session.lastRootsCount : null,
      lastRootsPreview: [...session.lastRootsPreview],
      lastRootsError: session.lastRootsError ?? null,
    })),
    rootsPolicy: ROOTS_POLICY,
    lastNonEmptyAt,
    lastNonEmptyAtIso: new Date(lastNonEmptyAt).toISOString(),
    lastNonEmptyAtLocal: formatLocalDateTime(lastNonEmptyAt),
    lastNonEmptyAgeSec: Math.floor((now - lastNonEmptyAt) / 1000),
    uptimeSec: Math.floor((now - STARTUP_TIME) / 1000),
  };
}

function shouldServeHtmlStatus(
  requestUrl: URL,
  acceptHeader: string | string[] | undefined,
): boolean {
  const format = requestUrl.searchParams.get('format')?.trim().toLowerCase();
  if (format === 'html') {
    return true;
  }
  if (format === 'json') {
    return false;
  }
  const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : acceptHeader ?? '';
  return accept.toLowerCase().includes('text/html');
}

function respondJsonRpcResult(
  res: http.ServerResponse,
  id: unknown,
  result: Record<string, unknown>,
  headers?: Record<string, string>,
): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }));
}

function respondJsonRpcError(
  res: http.ServerResponse,
  status: number,
  id: unknown,
  code: number,
  message: string,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
}

function formatWorkspaceHandshakeSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return JSON.stringify(payload);
  }
  const record = payload as Record<string, unknown>;
  const target = (record.target && typeof record.target === 'object' && !Array.isArray(record.target))
    ? record.target as Record<string, unknown>
    : undefined;
  const discovery = (record.discovery && typeof record.discovery === 'object' && !Array.isArray(record.discovery))
    ? record.discovery as Record<string, unknown>
    : undefined;
  const discoveryIssues = Array.isArray(discovery?.issues) ? discovery.issues : [];
  const workspaceFolders = Array.isArray(target?.workspaceFolders) ? target.workspaceFolders : [];
  const bridgedTools = Array.isArray(discovery?.bridgedTools) ? discovery.bridgedTools : [];
  const bridgedToolNames = bridgedTools
    .map((tool) => {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return '';
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === 'string' ? name.trim() : '';
    })
    .filter((name) => name.length > 0);
  const lines: string[] = [
    'Workspace handshake summary',
    `ok: ${record.ok === true ? 'true' : 'false'}`,
    `cwd: ${typeof record.cwd === 'string' ? record.cwd : 'n/a'}`,
    `target: ${String(target?.host ?? 'n/a')}:${String(target?.port ?? 'n/a')}`,
    `workspaceFolders: ${workspaceFolders.length}`,
    `online: ${record.online === true ? 'true' : record.online === false ? 'false' : 'n/a'}`,
    `discovery.partial: ${discovery?.partial === true ? 'true' : 'false'}`,
    `bridgedTools: ${bridgedTools.length}`,
  ];
  lines.push('tools:');
  if (bridgedToolNames.length === 0) {
    lines.push('  (none)');
  } else {
    for (const toolName of bridgedToolNames) {
      lines.push(`  - ${toolName}`);
    }
  }
  if (discoveryIssues.length === 0) {
    lines.push('Issues: none');
  } else {
    lines.push('Issues:');
    for (const issue of discoveryIssues) {
      if (!issue || typeof issue !== 'object') {
        continue;
      }
      const issueRecord = issue as {
        level?: unknown;
        category?: unknown;
        code?: unknown;
        message?: unknown;
        toolName?: unknown;
        details?: unknown;
      };
      const level = typeof issueRecord.level === 'string' ? issueRecord.level : 'unknown';
      const category = typeof issueRecord.category === 'string' ? issueRecord.category : 'unknown';
      const code = typeof issueRecord.code === 'string' ? issueRecord.code : 'UNKNOWN';
      const message = typeof issueRecord.message === 'string' ? issueRecord.message : '';
      const toolName = typeof issueRecord.toolName === 'string' ? issueRecord.toolName.trim() : '';
      const details = typeof issueRecord.details === 'string' ? issueRecord.details.trim() : '';
      const toolSuffix = toolName.length > 0 ? `[${toolName}]` : '';
      lines.push(`- [${level}][${category}][${code}]${toolSuffix} ${message}`);
      if (details.length > 0) {
        lines.push(`  details: ${details}`);
      }
    }
  }
  return lines.join('\n');
}

function respondToolCall(res: http.ServerResponse, id: unknown, payload: unknown, textOverride?: string): void {
  const text = textOverride ?? JSON.stringify(payload);
  respondJsonRpcResult(res, id, {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    structuredContent: payload,
  });
}

function respondToolCallWithNotifications(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: unknown,
  payload: unknown,
  textOverride?: string,
): void {
  const text = textOverride ?? JSON.stringify(payload);
  if (!isSseRequest(req)) {
    respondToolCall(res, id, payload, text);
    return;
  }
  const resultMessage = {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [
        {
          type: 'text',
          text,
        },
      ],
      structuredContent: payload,
    },
  };
  respondSse(res, [resultMessage, ...buildListChangedNotifications()]);
}

function respondJsonRpcResultWithNotifications(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: unknown,
  payload: unknown,
): void {
  if (!isSseRequest(req)) {
    respondJsonRpcResult(res, id, payload as Record<string, unknown>);
    return;
  }
  const resultMessage = {
    jsonrpc: '2.0',
    id: id ?? null,
    result: payload,
  };
  respondSse(res, [resultMessage, ...buildListChangedNotifications()]);
}

function buildListChangedNotifications(): Array<Record<string, unknown>> {
  return [
    { jsonrpc: '2.0', method: 'notifications/resources/list_changed', params: {} },
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} },
  ];
}

function isSseRequest(req: http.IncomingMessage): boolean {
  const rawAccept = Array.isArray(req.headers.accept)
    ? req.headers.accept.join(',')
    : req.headers.accept ?? '';
  return rawAccept.includes('text/event-stream');
}

function respondSse(res: http.ServerResponse, messages: readonly unknown[]): void {
  if (res.headersSent) {
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  for (const message of messages) {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function respondToolError(res: http.ServerResponse, id: unknown, code: number, message: string): void {
  respondJsonRpcError(res, 200, id, code, message);
}

function getHandshakeResource(): Record<string, unknown> {
  return {
    uri: HANDSHAKE_RESOURCE_URI,
    name: 'MCP manager handshake',
    description: 'Handshake required: call lmToolsBridge.requestWorkspaceMCPServer with params.cwd; success includes discovery (callTool/bridgedTools). Use tools/list as refresh fallback and read lm-tools://schema/{name} before first tool call when needed.',
    mimeType: 'text/plain',
  };
}

function getCallToolResource(): Record<string, unknown> {
  return {
    uri: CALL_TOOL_RESOURCE_URI,
    name: 'MCP manager direct tool call',
    description: 'Call lmToolsBridge.callTool after handshake to invoke a tool by name.',
    mimeType: 'text/plain',
  };
}

function getHandshakeTemplate(): Record<string, unknown> {
  return {
    name: 'MCP manager handshake',
    uriTemplate: HANDSHAKE_RESOURCE_URI,
    description: 'Handshake required: call lmToolsBridge.requestWorkspaceMCPServer with params.cwd; success includes discovery (callTool/bridgedTools). Use tools/list as refresh fallback and read lm-tools://schema/{name} before first tool call when needed.',
    mimeType: 'text/plain',
  };
}

function getCallToolTemplate(): Record<string, unknown> {
  return {
    name: 'MCP manager direct tool call',
    uriTemplate: CALL_TOOL_RESOURCE_URI,
    description: 'Call lmToolsBridge.callTool after handshake to invoke a tool by name.',
    mimeType: 'text/plain',
  };
}

function getRequestWorkspaceToolDefinition(): Record<string, unknown> {
  return {
    name: REQUEST_WORKSPACE_METHOD,
    description: 'Resolve and bind a workspace MCP server. Input: { cwd: string }.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Workspace path to resolve.' },
      },
      required: ['cwd'],
    },
  };
}

function getDirectToolCallDefinition(): Record<string, unknown> {
  return {
    name: DIRECT_TOOL_CALL_NAME,
    description: 'Directly call an exposed tool by name after workspace handshake. Input: { name: string, arguments?: object }.',
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

function enrichDiscoveryToolWithSchema(entry: unknown, inputSchema: unknown): unknown {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return entry;
  }
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return entry;
  }
  const record = entry as Record<string, unknown>;
  return {
    ...record,
    inputSchema,
  };
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
  if (name === DIRECT_TOOL_CALL_NAME
    && record.inputSchema
    && typeof record.inputSchema === 'object'
    && !Array.isArray(record.inputSchema)) {
    normalized.inputSchema = record.inputSchema as Record<string, unknown>;
  }
  return normalized;
}

function mergeHandshakeDiscoveryTools(
  base: HandshakeDiscoveryTool[],
  incoming: unknown[],
): HandshakeDiscoveryTool[] {
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
  return [...tools].sort((left, right) => {
    const leftFolded = left.name.toLowerCase();
    const rightFolded = right.name.toLowerCase();
    if (leftFolded < rightFolded) {
      return -1;
    }
    if (leftFolded > rightFolded) {
      return 1;
    }
    if (left.name < right.name) {
      return -1;
    }
    if (left.name > right.name) {
      return 1;
    }
    return 0;
  });
}

function isBridgeDiscoveryToolName(name: string): boolean {
  return name !== REQUEST_WORKSPACE_METHOD && name !== DIRECT_TOOL_CALL_NAME;
}

function buildHandshakeUriTemplates(): HandshakeDiscoveryResourceTemplate[] {
  return [
    {
      name: 'Tool URI template',
      uriTemplate: 'lm-tools://tool/{name}',
    },
    {
      name: 'Schema URI template',
      uriTemplate: 'lm-tools://schema/{name}',
    },
  ];
}

function mergeResourceTemplates(
  base: Array<Record<string, unknown>>,
  incoming: unknown[],
): Array<Record<string, unknown>> {
  const merged = [...base];
  const seen = new Set<string>();
  for (const entry of base) {
    const uriTemplate = typeof entry.uriTemplate === 'string' ? entry.uriTemplate : '';
    if (uriTemplate) {
      seen.add(uriTemplate);
    }
  }
  for (const entry of incoming) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const uriTemplate = typeof record.uriTemplate === 'string' ? record.uriTemplate : '';
    if (!uriTemplate || seen.has(uriTemplate)) {
      continue;
    }
    seen.add(uriTemplate);
    merged.push(record);
  }
  return merged;
}

async function requestTargetJson(target: ManagerMatch, payload: unknown): Promise<{ ok: boolean; data?: unknown }> {
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
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
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
                resolve({ ok: true, data: parsed });
                return;
              } catch {
                continue;
              }
            }
            resolve({ ok: false });
            return;
          }
          try {
            const parsed = JSON.parse(text) as unknown;
            resolve({ ok: true, data: parsed });
          } catch {
            resolve({ ok: false });
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

function getRemoteResultObject(data: unknown): { result?: Record<string, unknown>; errorMessage?: string } {
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

async function readToolSchemaFromResource(
  target: ManagerMatch,
  toolName: string,
): Promise<{ inputSchema?: Record<string, unknown>; issue?: HandshakeDiscoveryIssue }> {
  const response = await requestTargetJson(target, {
    jsonrpc: '2.0',
    id: nextManagerRequestId('mgr-discovery-resource-read'),
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
    const payload = JSON.parse(text) as unknown;
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
    const inputSchema = (payload as { inputSchema?: unknown }).inputSchema;
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
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
    return { inputSchema: inputSchema as Record<string, unknown> };
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

async function buildHandshakeDiscovery(target: ManagerMatch): Promise<HandshakeDiscoveryPayload> {
  const callTool = toHandshakeDiscoveryTool(getDirectToolCallDefinition()) ?? {
    name: DIRECT_TOOL_CALL_NAME,
    description: 'Directly call an exposed tool by name after workspace handshake. Input: { name: string, arguments?: object }.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['name'],
    },
  };

  const issues: HandshakeDiscoveryIssue[] = [];
  let bridgedTools: HandshakeDiscoveryTool[] = [];

  const toolsResponse = await requestTargetJson(target, {
    jsonrpc: '2.0',
    id: nextManagerRequestId('mgr-discovery-tools-list'),
    method: 'tools/list',
    params: {},
  });

  if (!toolsResponse.ok) {
    issues.push({
      level: 'error',
      category: 'tools/list',
      code: 'TOOLS_LIST_FETCH_FAILED',
      message: 'Failed to fetch tools/list from workspace MCP server.',
    });
  } else {
    const parsed = getRemoteResultObject(toolsResponse.data);
    const remoteTools = Array.isArray(parsed.result?.tools) ? parsed.result.tools : undefined;
    if (!remoteTools) {
      issues.push({
        level: 'error',
        category: 'tools/list',
        code: 'TOOLS_LIST_INVALID_RESULT',
        message: parsed.errorMessage ?? 'Invalid tools/list response from workspace MCP server.',
      });
    } else {
      const filteredRemoteTools = remoteTools.filter((entry) => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        const name = typeof (entry as { name?: unknown }).name === 'string'
          ? ((entry as { name: string }).name)
          : '';
        return isBridgeDiscoveryToolName(name);
      });
      const enrichedTools: unknown[] = [];
      await Promise.all(filteredRemoteTools.map(async (entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const name = typeof (entry as { name?: unknown }).name === 'string'
          ? ((entry as { name: string }).name)
          : '';
        if (!name) {
          return;
        }
        try {
          const schemaReadResult = await readToolSchemaFromResource(target, name);
          if (schemaReadResult.issue) {
            issues.push(schemaReadResult.issue);
          }
          enrichedTools.push(enrichDiscoveryToolWithSchema(entry, schemaReadResult.inputSchema));
        } catch {
          issues.push({
            level: 'warning',
            category: 'schema',
            code: 'SCHEMA_READ_UNEXPECTED_ERROR',
            toolName: name,
            message: 'Unexpected error while reading schema resource.',
          });
          enrichedTools.push(entry);
        }
      }));
      bridgedTools = mergeHandshakeDiscoveryTools(bridgedTools, enrichedTools);
    }
  }
  bridgedTools = sortHandshakeDiscoveryTools(bridgedTools);

  const hasErrorIssue = issues.some((issue) => issue.level === 'error');
  return {
    callTool,
    bridgedTools,
    resourceTemplates: buildHandshakeUriTemplates(),
    partial: hasErrorIssue,
    issues,
  };
}

async function refreshSessionTarget(session: SessionState, deadlineMs?: number): Promise<ResolveResult> {
  if (session.resolveInFlight) {
    return session.resolveInFlight;
  }
  const resolver = deadlineMs
    ? resolveTargetWithDeadline(session.resolveCwd, deadlineMs)
    : resolveTarget(session.resolveCwd);
  session.resolveInFlight = resolver.finally(() => {
    session.resolveInFlight = undefined;
  });
  const resolved = await session.resolveInFlight;
  if (resolved?.target) {
    session.currentTarget = resolved.target;
  }
  return resolved;
}

function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

function resolveSessionByHeaderId(sessionId: string): SessionState | undefined {
  return getSession(sessionId);
}

function createAndRegisterSession(preferredSessionId?: string): SessionState {
  const preferred = typeof preferredSessionId === 'string' ? preferredSessionId.trim() : '';
  let sessionId = preferred.length > 0 ? preferred : generateSessionId();
  while (sessions.has(sessionId) || sessionId.length === 0) {
    sessionId = generateSessionId();
  }
  const session = createSessionState(sessionId);
  sessions.set(sessionId, session);
  touchSession(session);
  return session;
}

function touchSession(session: SessionState): void {
  session.lastSeen = Date.now();
}

function isWorkspaceHandshakeRpcMessage(rpcMessage: { method?: string; params?: Record<string, unknown> }): boolean {
  if (rpcMessage.method === REQUEST_WORKSPACE_METHOD) {
    return true;
  }
  if (rpcMessage.method !== 'tools/call') {
    return false;
  }
  const name = rpcMessage.params?.name;
  return typeof name === 'string' && name === REQUEST_WORKSPACE_METHOD;
}

function isJsonRpcResponseMessage(message: JsonRpcLikeMessage): boolean {
  if (message.id === undefined) {
    return false;
  }
  if (message.method !== undefined) {
    return false;
  }
  const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
  return hasResult || hasError;
}

function dispatchRootsListRequest(
  session: SessionState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reason: RootsSyncReason,
  requestIdForSse?: string,
): boolean {
  const now = Date.now();
  if (!session.clientSupportsRoots) {
    appendLog(`[roots.list.skip] session=${session.sessionId} reason=no_capability trigger=${reason}`);
    return false;
  }
  if (session.pendingRootsRequestId && typeof session.pendingRootsRequestedAt === 'number') {
    if (now - session.pendingRootsRequestedAt <= ROOTS_REQUEST_TIMEOUT_MS) {
      appendLog(
        `[roots.list.skip] session=${session.sessionId} reason=pending trigger=${reason} pendingId=${session.pendingRootsRequestId}`,
      );
      return false;
    }
    appendLog(
      `[roots.list.timeout] session=${session.sessionId} id=${session.pendingRootsRequestId} reason=${session.pendingRootsReason ?? 'unknown'}`,
    );
    session.lastRootsError = 'roots/list response timeout';
    clearPendingRootsRequest(session);
  }
  if (!isSseRequest(req)) {
    appendLog(`[roots.list.skip] session=${session.sessionId} reason=no_sse trigger=${reason}`);
    return false;
  }
  const requestId = requestIdForSse ?? nextManagerRequestId('roots-list');
  session.pendingRootsRequestId = requestId;
  session.pendingRootsRequestedAt = now;
  session.pendingRootsReason = reason;
  appendLog(`[roots.list.request] session=${session.sessionId} id=${requestId} reason=${reason}`);
  respondSse(
    res,
    [{
      jsonrpc: '2.0',
      id: requestId,
      method: 'roots/list',
      params: {},
    }],
  );
  return true;
}

function handleIncomingClientResponse(session: SessionState, message: JsonRpcLikeMessage): void {
  const pendingId = session.pendingRootsRequestId;
  const responseId = typeof message.id === 'string' || typeof message.id === 'number'
    ? String(message.id)
    : undefined;
  if (!pendingId || !responseId || responseId !== pendingId) {
    appendLog(
      `[rpc.response] session=${session.sessionId} ignored=true id=${String(responseId ?? 'unknown')} pending=${String(pendingId ?? '')}`,
    );
    return;
  }
  const reason = session.pendingRootsReason ?? 'initialized';
  clearPendingRootsRequest(session);
  session.lastRootsSyncAt = Date.now();
  session.lastRootsSyncReason = reason;
  if (Object.prototype.hasOwnProperty.call(message, 'error')) {
    const errorText = extractJsonRpcErrorMessage(message.error);
    session.lastRootsCount = undefined;
    session.lastRootsPreview = [];
    session.lastRootsError = errorText;
    appendLog(`[roots.list.error] session=${session.sessionId} id=${responseId} reason=${reason} error=${errorText}`);
    return;
  }
  const normalized = normalizeRootsFromResult(message.result);
  if (normalized.error) {
    session.lastRootsCount = undefined;
    session.lastRootsPreview = [];
    session.lastRootsError = normalized.error;
    appendLog(`[roots.list.error] session=${session.sessionId} id=${responseId} reason=${reason} error=${normalized.error}`);
    return;
  }
  session.lastRootsCount = normalized.roots.length;
  session.lastRootsPreview = describeRootsPreview(normalized.roots);
  session.lastRootsError = undefined;
  const previewText = session.lastRootsPreview.length > 0 ? session.lastRootsPreview.join(' | ') : '-';
  appendLog(
    `[roots.list.result] session=${session.sessionId} id=${responseId} reason=${reason} count=${normalized.roots.length} preview=${previewText}`,
  );
}

async function buildStatusPayload(session: SessionState): Promise<{
  payload: Record<string, unknown>;
  debug: Record<string, unknown>;
}> {
  let resolveResult: ResolveResult | undefined;
  if (session.workspaceSetExplicitly && !session.workspaceMatched) {
    const deadline = Date.now() + RESOLVE_RETRY_DELAY_MS;
    resolveResult = await refreshSessionTarget(session, deadline);
  }
  const target = session.workspaceSetExplicitly ? session.currentTarget : undefined;
  const health = target ? await checkTargetHealth(target) : undefined;
  const online = isHealthOk(health);
  if (!online && target) {
    session.workspaceMatched = false;
    session.currentTarget = undefined;
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
  } else if (online) {
    session.offlineSince = undefined;
  }
  const ready = session.workspaceMatched && Boolean(target) && online;
  return {
    payload: {
      ready,
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
      resolveErrorKind: resolveResult?.errorKind,
      health,
    },
    debug: {
      ready,
      online,
      workspaceSetExplicitly: session.workspaceSetExplicitly,
      workspaceMatched: session.workspaceMatched,
      offlineDurationSec: toOfflineDurationSec(session.offlineSince),
      target: target ? `${target.host}:${target.port}` : null,
      resolveErrorKind: resolveResult?.errorKind ?? null,
    },
  };
}

async function handleRequestWorkspace(
  session: SessionState,
  cwdValue: unknown,
): Promise<{ payload?: Record<string, unknown>; error?: { code: number; message: string } }> {
  if (typeof cwdValue !== 'string' || cwdValue.trim().length === 0) {
    return { error: { code: -32602, message: 'Invalid params: expected params.cwd (string).' } };
  }
  session.resolveCwd = path.resolve(cwdValue);
  session.workspaceSetExplicitly = true;
  session.workspaceMatched = false;
  session.currentTarget = undefined;
  session.resolveInFlight = undefined;
  const resolveResult = await refreshSessionTarget(session);
  const matchedTarget = resolveResult?.target;
  if (!matchedTarget) {
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    return {
      error: {
        code: resolveResult?.errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
        message: resolveResult?.errorKind === 'no_match'
          ? 'No matching VS Code instance for provided workspace.'
          : 'Manager unreachable.',
      },
    };
  }
  if (!isCwdWithinWorkspaceFolders(session.resolveCwd, matchedTarget.workspaceFolders)
    && !isCwdMatchingWorkspaceFile(session.resolveCwd, matchedTarget.workspaceFile)) {
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    return {
      error: {
        code: ERROR_NO_MATCH,
        message: 'Provided cwd is not within resolved workspace folders.',
      },
    };
  }
  const health = await checkTargetHealth(matchedTarget);
  if (!isHealthOk(health)) {
    session.workspaceMatched = false;
    session.currentTarget = undefined;
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    return {
      error: {
        code: ERROR_MCP_OFFLINE,
        message: 'Resolved MCP server is offline.',
      },
    };
  }
  session.workspaceMatched = true;
  session.currentTarget = matchedTarget;
  session.offlineSince = undefined;
  const discovery = await buildHandshakeDiscovery(matchedTarget);
  return {
    payload: {
      ok: true,
      mcpSessionId: session.sessionId,
      cwd: session.resolveCwd,
      target: {
        sessionId: matchedTarget.sessionId,
        host: matchedTarget.host,
        port: matchedTarget.port,
        workspaceFolders: matchedTarget.workspaceFolders,
        workspaceFile: matchedTarget.workspaceFile ?? null,
      },
      online: true,
      health,
      discovery,
    },
  };
}

async function forwardMcpMessage(
  target: ManagerMatch,
  payload: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<{ ok: boolean; error?: unknown }> {
  return new Promise((resolve) => {
    const rawAccept = Array.isArray(req.headers.accept)
      ? req.headers.accept.join(',')
      : req.headers.accept ?? '';
    const acceptHeader = rawAccept.includes('application/json') && rawAccept.includes('text/event-stream')
      ? rawAccept
      : 'application/json, text/event-stream';
    const request = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path: '/mcp',
        method: 'POST',
        headers: {
          Accept: acceptHeader,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        res.statusCode = response.statusCode ?? 200;
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        }
        response.on('data', (chunk) => {
          res.write(chunk);
        });
        response.on('end', () => {
          res.end();
          resolve({ ok: true });
        });
      },
    );

    request.on('error', (error) => {
      resolve({ ok: false, error });
    });

    request.write(payload);
    request.end();
  });
}

async function handleSessionMessage(
  session: SessionState,
  message: JsonRpcLikeMessage,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = message.method ?? '';
  appendLog(`[session] id=${session.sessionId} method=${method} matched=${String(session.workspaceMatched)} set=${String(session.workspaceSetExplicitly)} cwd=${session.resolveCwd}`);
  if (method === 'initialized' || method === 'notifications/initialized') {
    if (message.id === undefined || message.id === null) {
      const dispatched = dispatchRootsListRequest(session, req, res, 'initialized');
      if (!dispatched) {
        res.statusCode = 204;
        res.end();
      }
      return;
    }
    respondJsonRpcResult(res, message.id, {});
    return;
  }
  if (method === 'notifications/roots/list_changed') {
    const dispatched = dispatchRootsListRequest(session, req, res, 'list_changed');
    if (!dispatched) {
      res.statusCode = 204;
      res.end();
    }
    return;
  }
  if (method === 'ping') {
    respondJsonRpcResult(res, message.id ?? null, {});
    return;
  }
  if (method === 'roots/list') {
    respondJsonRpcError(
      res,
      200,
      message.id ?? null,
      -32601,
      'Method not found: roots/list is a client capability request and is issued by server to client.',
    );
    return;
  }
  if (method === 'resources/read' && message.params?.uri === HANDSHAKE_RESOURCE_URI) {
    const statusResult = await buildStatusPayload(session);
    const content = [
      'This MCP manager requires an explicit workspace handshake.',
      'Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd. If the call fails, do not invoke MCP tools or resources.',
      'A successful handshake response includes discovery data (callTool/bridgedTools).',
      'Use tools/list as refresh fallback when discovery is partial.',
      'Before calling any tool for the first time, read lm-tools://schema/{name} if input schema is not already known.',
      'Invoke tools via lmToolsBridge.callTool only after the tool schema has been read.',
      '',
      'Status snapshot:',
      JSON.stringify(statusResult.payload, null, 2),
    ].join('\n');
    respondJsonRpcResult(res, message.id ?? null, {
      contents: [
        {
          uri: HANDSHAKE_RESOURCE_URI,
          mimeType: 'text/plain',
          text: content,
        },
      ],
    });
    return;
  }
  if (method === 'resources/read' && message.params?.uri === CALL_TOOL_RESOURCE_URI) {
    if (!session.workspaceMatched) {
      respondJsonRpcError(
        res,
        200,
        message.id ?? null,
        session.workspaceSetExplicitly ? ERROR_NO_MATCH : ERROR_WORKSPACE_NOT_SET,
        session.workspaceSetExplicitly
          ? 'Workspace not matched. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd and wait for success.'
          : 'Workspace not set. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd before using MCP.',
      );
      return;
    }
    const content = [
      'Direct tool call bridge (handshake required).',
      `Tool name: ${DIRECT_TOOL_CALL_NAME}`,
      'Input: { name: string, arguments?: object }',
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
    respondJsonRpcResult(res, message.id ?? null, {
      contents: [
        {
          uri: CALL_TOOL_RESOURCE_URI,
          mimeType: 'text/plain',
          text: content,
        },
      ],
    });
    return;
  }
  if (method === 'resources/list') {
    if (!session.workspaceMatched) {
      appendLog('[resources.list] blocked: workspace_not_matched');
      respondJsonRpcResult(res, message.id ?? null, { resources: [getHandshakeResource()] });
      return;
    }
    const target = session.currentTarget;
    if (!target) {
      appendLog('[resources.list] blocked: no_target');
      respondJsonRpcResult(res, message.id ?? null, { resources: [getHandshakeResource()] });
      return;
    }
    appendLog(`[resources.list] forwarding to ${target.host}:${target.port}`);
    const remote = await requestTargetJson(target, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      method: 'resources/list',
      params: message.params ?? {},
    });
    if (!remote.ok) {
      const retryHealth = await checkTargetHealth(target);
      if (!isHealthOk(retryHealth)) {
        session.workspaceMatched = false;
        session.currentTarget = undefined;
        if (!session.offlineSince) {
          session.offlineSince = Date.now();
        }
      }
    }
    const remoteResources = (remote.ok && (remote.data as { result?: { resources?: unknown[] } })?.result?.resources)
      ? (remote.data as { result: { resources: unknown[] } }).result.resources
      : [];
    appendLog(`[resources.list] ok=${String(remote.ok)} items=${String(remoteResources.length)}`);
    const merged = [
      getHandshakeResource(),
      getCallToolResource(),
      ...remoteResources.filter((entry) => (entry as { uri?: unknown })?.uri !== HANDSHAKE_RESOURCE_URI),
    ];
    respondJsonRpcResult(res, message.id ?? null, { resources: merged });
    return;
  }
  if (method === 'resources/templates/list') {
    const handshakeTemplates = [getHandshakeTemplate(), getCallToolTemplate()];
    if (!session.workspaceMatched) {
      respondJsonRpcResult(res, message.id ?? null, { resourceTemplates: handshakeTemplates });
      return;
    }
    const target = session.currentTarget;
    if (!target) {
      respondJsonRpcResult(res, message.id ?? null, { resourceTemplates: handshakeTemplates });
      return;
    }
    const remote = await requestTargetJson(target, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      method: 'resources/templates/list',
      params: message.params ?? {},
    });
    if (!remote.ok) {
      const retryHealth = await checkTargetHealth(target);
      if (!isHealthOk(retryHealth)) {
        session.workspaceMatched = false;
        session.currentTarget = undefined;
        if (!session.offlineSince) {
          session.offlineSince = Date.now();
        }
      }
    }
    const remoteTemplates = (remote.ok && (remote.data as { result?: { resourceTemplates?: unknown[] } })?.result?.resourceTemplates)
      ? (remote.data as { result: { resourceTemplates: unknown[] } }).result.resourceTemplates
      : [];
    respondJsonRpcResult(res, message.id ?? null, { resourceTemplates: mergeResourceTemplates(handshakeTemplates, remoteTemplates) });
    return;
  }
  if (method === 'tools/list') {
    const requestWorkspaceTool = getRequestWorkspaceToolDefinition();
    const directToolCall = getDirectToolCallDefinition();
    if (!session.workspaceMatched) {
      respondJsonRpcResult(res, message.id ?? null, {
        tools: [requestWorkspaceTool, directToolCall],
      });
      return;
    }
    const target = session.currentTarget;
    if (!target) {
      respondJsonRpcResult(res, message.id ?? null, { tools: [requestWorkspaceTool, directToolCall] });
      return;
    }
    const remote = await requestTargetJson(target, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      method: 'tools/list',
      params: message.params ?? {},
    });
    if (!remote.ok) {
      const retryHealth = await checkTargetHealth(target);
      if (!isHealthOk(retryHealth)) {
        session.workspaceMatched = false;
        session.currentTarget = undefined;
        if (!session.offlineSince) {
          session.offlineSince = Date.now();
        }
      }
    }
    const remoteTools = (remote.ok && (remote.data as { result?: { tools?: unknown[] } })?.result?.tools)
      ? (remote.data as { result: { tools: unknown[] } }).result.tools
      : [];
    const merged = [
      requestWorkspaceTool,
      directToolCall,
      ...remoteTools.filter((entry) => (entry as { name?: unknown })?.name !== REQUEST_WORKSPACE_METHOD),
    ];
    respondJsonRpcResult(res, message.id ?? null, { tools: merged });
    return;
  }
  if (method === 'tools/call') {
    const name = message.params?.name as string | undefined;
    const args = message.params?.arguments as { cwd?: unknown } | undefined;
    appendLog(`[tools.call] name=${String(name ?? '')} hasCwd=${String(args?.cwd !== undefined)}`);
    if (name === REQUEST_WORKSPACE_METHOD) {
      const result = await handleRequestWorkspace(session, args?.cwd);
      if (result.error) {
        appendLog(`[handshake.error] code=${String(result.error.code)} message=${result.error.message}`);
        respondToolError(res, message.id ?? null, result.error.code, result.error.message);
        return;
      }
      const targetSummary = result.payload && typeof result.payload === 'object'
        ? String((result.payload as { target?: { host?: unknown; port?: unknown } }).target?.host ?? '')
          + ':' + String((result.payload as { target?: { host?: unknown; port?: unknown } }).target?.port ?? '')
        : ':';
      appendLog(`[handshake.ok] cwd=${String(result.payload?.cwd ?? '')} target=${targetSummary}`);
      const summaryText = formatWorkspaceHandshakeSummary(result.payload);
      respondToolCallWithNotifications(req, res, message.id ?? null, result.payload, summaryText);
      return;
    }
    if (name === DIRECT_TOOL_CALL_NAME) {
      if (!session.workspaceMatched) {
        appendLog('[tools.call.direct] blocked: workspace_not_matched');
        respondToolError(
          res,
          message.id ?? null,
          session.workspaceSetExplicitly ? ERROR_NO_MATCH : ERROR_WORKSPACE_NOT_SET,
          session.workspaceSetExplicitly
            ? 'Workspace not matched. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd and wait for success.'
            : 'Workspace not set. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd before using MCP.',
        );
        return;
      }
      const directArgs = message.params?.arguments as { name?: unknown; arguments?: unknown } | undefined;
      const targetToolName = typeof directArgs?.name === 'string' ? directArgs.name.trim() : '';
      if (!targetToolName) {
        respondToolError(res, message.id ?? null, -32602, 'Invalid params: expected arguments.name (string).');
        return;
      }
      if (directArgs?.arguments !== undefined) {
        const argValue = directArgs.arguments;
        if (typeof argValue !== 'object' || argValue === null || Array.isArray(argValue)) {
          respondToolError(res, message.id ?? null, -32602, 'Invalid params: expected arguments.arguments (object).');
          return;
        }
      }
      if (targetToolName === DIRECT_TOOL_CALL_NAME || targetToolName === REQUEST_WORKSPACE_METHOD) {
        respondToolError(res, message.id ?? null, -32602, 'Invalid params: tool name is not allowed.');
        return;
      }
      let target = session.currentTarget;
      if (!target) {
        const now = Date.now();
        const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
        const refreshResult = await refreshSessionTarget(session, now < graceDeadline ? graceDeadline : undefined);
        target = refreshResult?.target;
        if (!target) {
          respondToolError(
            res,
            message.id ?? null,
            refreshResult?.errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
            refreshResult?.errorKind === 'no_match'
              ? 'No matching VS Code instance for current workspace.'
              : 'Manager unreachable.',
          );
          return;
        }
      }
      const remote = await requestTargetJson(target, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        method: 'tools/call',
        params: {
          name: targetToolName,
          arguments: directArgs?.arguments ?? {},
        },
      });
      if (!remote.ok) {
        const retryHealth = await checkTargetHealth(target);
        if (!isHealthOk(retryHealth)) {
          session.workspaceMatched = false;
          session.currentTarget = undefined;
          if (!session.offlineSince) {
            session.offlineSince = Date.now();
          }
          respondToolError(res, message.id ?? null, ERROR_MCP_OFFLINE, 'Resolved MCP server is offline.');
          return;
        }
        respondToolError(res, message.id ?? null, ERROR_MANAGER_UNREACHABLE, 'Manager unreachable.');
        return;
      }
      const remoteResult = (remote.data as { result?: Record<string, unknown> } | undefined)?.result;
      if (!remoteResult || typeof remoteResult !== 'object') {
        respondToolError(res, message.id ?? null, -32603, 'Invalid response from MCP server.');
        return;
      }
      respondJsonRpcResult(res, message.id ?? null, remoteResult);
      return;
    }
    if (!session.workspaceMatched) {
      appendLog('[tools.call] blocked: workspace_not_matched');
      respondToolError(res, message.id ?? null, -32602, `Unknown tool: ${String(name)}`);
      return;
    }
  }
  if (method === REQUEST_WORKSPACE_METHOD) {
    const result = await handleRequestWorkspace(session, message.params?.cwd);
    if (result.error) {
      appendLog(`[handshake.error] code=${String(result.error.code)} message=${result.error.message}`);
      respondJsonRpcError(res, 200, message.id ?? null, result.error.code, result.error.message);
      return;
    }
    const targetSummary = result.payload && typeof result.payload === 'object'
      ? String((result.payload as { target?: { host?: unknown; port?: unknown } }).target?.host ?? '')
        + ':' + String((result.payload as { target?: { host?: unknown; port?: unknown } }).target?.port ?? '')
      : ':';
    appendLog(`[handshake.ok] cwd=${String(result.payload?.cwd ?? '')} target=${targetSummary}`);
    respondJsonRpcResultWithNotifications(req, res, message.id ?? null, result.payload ?? {});
    return;
  }
  if (!session.workspaceMatched) {
    respondJsonRpcError(
      res,
      200,
      message.id ?? null,
      session.workspaceSetExplicitly ? ERROR_NO_MATCH : ERROR_WORKSPACE_NOT_SET,
      session.workspaceSetExplicitly
        ? 'Workspace not matched. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd and wait for success.'
        : 'Workspace not set. Call lmToolsBridge.requestWorkspaceMCPServer with params.cwd before using MCP.',
    );
    return;
  }
  const payload = JSON.stringify(message);
  let target = session.currentTarget;
  if (!target) {
    const now = Date.now();
    const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
    const refreshResult = await refreshSessionTarget(session, now < graceDeadline ? graceDeadline : undefined);
    target = refreshResult?.target;
    if (!target) {
      respondJsonRpcError(
        res,
        200,
        message.id ?? null,
        refreshResult?.errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
        refreshResult?.errorKind === 'no_match'
          ? 'No matching VS Code instance for current workspace.'
          : 'Manager unreachable.',
      );
      return;
    }
  }

  const firstAttempt = await forwardMcpMessage(target, payload, req, res);
  if (firstAttempt.ok) {
    return;
  }

  const firstHealth = await checkTargetHealth(target);
  if (!isHealthOk(firstHealth)) {
    session.workspaceMatched = false;
    session.currentTarget = undefined;
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    respondJsonRpcError(res, 200, message.id ?? null, ERROR_MCP_OFFLINE, 'Resolved MCP server is offline.');
    return;
  }
  const now = Date.now();
  const graceDeadline = STARTUP_TIME + STARTUP_GRACE_MS;
  const refreshResult = await refreshSessionTarget(session, now < graceDeadline ? graceDeadline : undefined);
  const refreshed = refreshResult?.target;
  if (!refreshed || isSameTarget(target, refreshed)) {
    respondJsonRpcError(
      res,
      200,
      message.id ?? null,
      refreshResult?.errorKind === 'no_match' ? ERROR_NO_MATCH : ERROR_MANAGER_UNREACHABLE,
      refreshResult?.errorKind === 'no_match'
        ? 'No matching VS Code instance for current workspace.'
        : 'Manager unreachable.',
    );
    return;
  }

  const refreshedHealth = await checkTargetHealth(refreshed);
  if (!isHealthOk(refreshedHealth)) {
    session.workspaceMatched = false;
    session.currentTarget = undefined;
    if (!session.offlineSince) {
      session.offlineSince = Date.now();
    }
    respondJsonRpcError(res, 200, message.id ?? null, ERROR_MCP_OFFLINE, 'Resolved MCP server is offline.');
    return;
  }
  const retryAttempt = await forwardMcpMessage(refreshed, payload, req, res);
  if (retryAttempt.ok) {
    return;
  }
  respondJsonRpcError(res, 200, message.id ?? null, ERROR_MANAGER_UNREACHABLE, 'Manager unreachable.');
}

async function handleMcpHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const requestUrl = getRequestUrl(req);
  if (shouldLogHttpRequest(req, requestUrl)) {
    appendLog(`[request] ${req.method ?? 'UNKNOWN'} ${req.url ?? ''} session=${String(getSessionIdFromRequest(req) ?? '')} accept=${String(req.headers.accept ?? '')}`);
  }
  if (!requestUrl) {
    respondJson(res, 400, { error: 'Bad Request' });
    return;
  }
  if (requestUrl.pathname === HEALTH_PATH && req.method === 'GET') {
    respondJson(res, 200, { ok: true });
    return;
  }
  if ((requestUrl.pathname === '/mcp/log' || requestUrl.pathname === '/mcp/log/')
    && req.method === 'GET') {
    const accept = Array.isArray(req.headers.accept) ? req.headers.accept.join(',') : req.headers.accept ?? '';
    if (accept.includes('text/html')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>LM Tools Bridge Manager Log</title>
    <style>
      body { font-family: Consolas, "Courier New", monospace; margin: 16px; }
      h1 { font-size: 16px; margin: 0 0 12px 0; }
      pre { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>LM Tools Bridge Manager Log</h1>
    <pre>${logBuffer.map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('\n')}</pre>
  </body>
</html>`);
      return;
    }
    respondJson(res, 200, { ok: true, lines: [...logBuffer] });
    return;
  }
  if ((requestUrl.pathname === '/mcp' || requestUrl.pathname === '/mcp/')
    && req.method === 'DELETE') {
    const requestedSessionId = getSessionIdFromRequest(req);
    if (requestedSessionId) {
      const existed = sessions.delete(requestedSessionId);
      respondJson(
        res,
        200,
        {
          ok: true,
          deleted: existed,
          sessionId: requestedSessionId,
        },
      );
      return;
    }
    respondJson(res, 200, { ok: true, deleted: false, reason: 'missing_session' });
    return;
  }
  if ((requestUrl.pathname === '/mcp/status' || requestUrl.pathname === '/mcp/status/')
    && req.method === 'GET') {
    const now = Date.now();
    const payload = buildManagerStatusPayload(now);
    if (shouldServeHtmlStatus(requestUrl, req.headers.accept)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(renderStatusHtml(payload));
      return;
    }
    respondJson(res, 200, payload);
    return;
  }
  if (requestUrl.pathname !== '/mcp' && requestUrl.pathname !== '/mcp/') {
    respondJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    respondJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }
  let message: unknown;
  try {
    message = await readJsonBody(req);
  } catch {
    appendLog('[error] invalid_json');
    respondJsonRpcError(res, 400, null, -32700, 'Invalid JSON received by MCP manager.');
    return;
  }
  if (!message || typeof message !== 'object') {
    appendLog('[error] invalid_request_body');
    respondJsonRpcError(res, 400, null, -32600, 'Invalid request.');
    return;
  }
  const rpcMessage = message as JsonRpcLikeMessage;
  appendLog(`[rpc] method=${String(rpcMessage.method ?? '')} id=${String(rpcMessage.id ?? '')} hasParams=${String(Boolean(rpcMessage.params))}`);
  if (rpcMessage.method === 'initialize') {
    const session = createAndRegisterSession();
    const clientCapabilities = parseInitializeClientCapabilities(rpcMessage.params);
    session.clientSupportsRoots = clientCapabilities.clientSupportsRoots;
    session.clientSupportsRootsListChanged = clientCapabilities.clientSupportsRootsListChanged;
    session.clientCapabilityFlags = cloneBooleanRecord(clientCapabilities.clientCapabilityFlags);
    session.clientCapabilityObjectKeys = cloneStringArrayRecord(clientCapabilities.clientCapabilityObjectKeys);
    session.clientCapabilities = clientCapabilities.clientCapabilities;
    appendLog(
      `[roots.capability] session=${session.sessionId} roots=${String(session.clientSupportsRoots)} listChanged=${String(session.clientSupportsRootsListChanged)}`,
    );
    respondJsonRpcResult(
      res,
      rpcMessage.id ?? null,
      {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'lm-tools-bridge-manager',
          version: getManagerVersion(),
        },
        capabilities: {
          tools: {
            list: true,
            call: true,
            listChanged: true,
          },
          resources: {
            list: true,
            read: true,
            listChanged: true,
          },
        },
      },
      { 'Mcp-Session-Id': session.sessionId },
    );
    return;
  }
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    respondJsonRpcError(res, 400, rpcMessage.id ?? null, -32600, 'Missing Mcp-Session-Id.');
    return;
  }
  let session = resolveSessionByHeaderId(sessionId);
  if (!session) {
    if (!isWorkspaceHandshakeRpcMessage(rpcMessage)) {
      respondJsonRpcError(
        res,
        400,
        rpcMessage.id ?? null,
        -32600,
        'Unknown Mcp-Session-Id. Call lmToolsBridge.requestWorkspaceMCPServer to re-bind.',
      );
      return;
    }
    session = createAndRegisterSession(sessionId);
    appendLog(`[session.recover] created=${session.sessionId} reason=unknown`);
  }
  touchSession(session);
  if (isJsonRpcResponseMessage(rpcMessage)) {
    handleIncomingClientResponse(session, rpcMessage);
    res.statusCode = 202;
    res.end();
    return;
  }
  await handleSessionMessage(session, rpcMessage, req, res);
}

function pruneInstances(): void {
  const now = Date.now();
  prunePortReservations(now);
  pruneSessions(now);
  for (const [key, record] of instances.entries()) {
    if (now - record.lastSeen > TTL_MS) {
      instances.delete(key);
    }
  }

  if (instances.size > 0 || reservedPorts.size > 0) {
    lastNonEmptyAt = now;
    return;
  }

  if (now - lastNonEmptyAt >= IDLE_GRACE_MS) {
    shutdown();
  }
}

function shutdown(): void {
  let remaining = 2;
  const finalize = () => {
    remaining -= 1;
    if (remaining <= 0) {
      process.exit(0);
    }
  };
  pipeServer.close(finalize);
  mcpServer.close(finalize);
}

const pipeServer = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    respondJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url === '/status') {
    respondJson(res, 200, {
      ok: true,
      version: getManagerVersion(),
      pid: process.pid,
      now: Date.now(),
    });
    return;
  }

  if (req.method === 'POST' && url === '/shutdown') {
    let reason: string | undefined;
    let expectedVersion: string | undefined;
    try {
      const payload = await readJsonBody(req);
      const shutdownPayload = payload as { reason?: string; expectedVersion?: string } | undefined;
      reason = shutdownPayload?.reason;
      expectedVersion = shutdownPayload?.expectedVersion;
    } catch {
      // Ignore invalid JSON for shutdown requests.
    }
    const currentVersion = getManagerVersion();
    if (expectedVersion && expectedVersion !== currentVersion) {
      appendLog(`[shutdown] rejected expected=${String(expectedVersion)} current=${currentVersion} reason=${String(reason ?? '')}`);
      respondJson(res, 409, { ok: false, reason: 'version_mismatch', version: currentVersion });
      return;
    }
    appendLog(`[shutdown] reason=${String(reason ?? '')} expected=${String(expectedVersion ?? '')}`);
    respondJson(res, 200, { ok: true });
    setTimeout(() => {
      shutdown();
    }, 0);
    return;
  }

  if (req.method === 'GET' && url === '/list') {
    respondJson(res, 200, { ok: true, instances: getAliveRecords() });
    return;
  }

  if (req.method === 'POST' && url === '/heartbeat') {
    try {
      const payload = await readJsonBody(req);
      const record = payload as Partial<InstanceRecord>;
      if (!record.sessionId || !record.host || !record.port) {
        respondJson(res, 400, { ok: false, reason: 'invalid_payload' });
        return;
      }

      const now = Date.now();
      const workspaceFolders = Array.isArray(record.workspaceFolders) ? record.workspaceFolders : [];
      const normalizedFolders = normalizeFolders(workspaceFolders);
      const normalizedWorkspaceFile = record.workspaceFile ? normalizePath(record.workspaceFile) : undefined;

      const existing = instances.get(record.sessionId);
      instances.set(record.sessionId, {
        sessionId: record.sessionId,
        pid: record.pid ?? existing?.pid ?? 0,
        workspaceFolders,
        workspaceFile: record.workspaceFile ?? existing?.workspaceFile,
        host: record.host,
        port: record.port,
        lastSeen: now,
        startedAt: existing?.startedAt ?? now,
        normalizedFolders,
        normalizedWorkspaceFile,
      });
      reservedPorts.delete(record.sessionId);

      lastNonEmptyAt = now;
      respondJson(res, 200, { ok: true });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  if (req.method === 'POST' && url === '/bye') {
    try {
      const payload = await readJsonBody(req);
      const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
      if (sessionId) {
        instances.delete(sessionId);
        reservedPorts.delete(sessionId);
      }
      respondJson(res, 200, { ok: true });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  if (req.method === 'POST' && url === '/allocate') {
    try {
      const payload = await readJsonBody(req);
      const request = payload as { sessionId?: string; preferredPort?: number; minPort?: number };
      const sessionId = request?.sessionId;
      const preferredPort = request?.preferredPort;
      const minPort = request?.minPort;
      if (!sessionId || !isValidPort(preferredPort) || (minPort !== undefined && !isValidPort(minPort))) {
        respondJson(res, 400, { ok: false, reason: 'invalid_payload' });
        return;
      }

      const now = Date.now();
      const existingRecord = instances.get(sessionId);
      if (existingRecord && now - existingRecord.lastSeen <= TTL_MS && isValidPort(existingRecord.port)) {
        respondJson(res, 200, { ok: true, port: existingRecord.port });
        return;
      }

      const startPort = Math.max(minPort ?? preferredPort, preferredPort);
      if (!isValidPort(startPort)) {
        respondJson(res, 409, { ok: false, reason: 'port_exhausted' });
        return;
      }

      const existingReservation = reservedPorts.get(sessionId);
      if (existingReservation) {
        if (now - existingReservation.reservedAt <= PORT_RESERVATION_TTL_MS && existingReservation.port >= startPort) {
          respondJson(res, 200, { ok: true, port: existingReservation.port });
          return;
        }
        if (existingReservation.port < startPort) {
          reservedPorts.delete(sessionId);
        }
      }

      const usedPorts = getUsedPorts(now);
      let candidate = startPort;
      while (candidate <= PORT_MAX_VALUE && usedPorts.has(candidate)) {
        candidate += 1;
      }
      if (!isValidPort(candidate)) {
        respondJson(res, 409, { ok: false, reason: 'port_exhausted' });
        return;
      }

      reservedPorts.set(sessionId, { port: candidate, reservedAt: now });
      respondJson(res, 200, { ok: true, port: candidate });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  if (req.method === 'POST' && url === '/resolve') {
    try {
      const payload = await readJsonBody(req);
      const cwd = (payload as { cwd?: string } | undefined)?.cwd;
      if (!cwd) {
        respondJson(res, 400, { ok: false, reason: 'missing_cwd' });
        return;
      }

      const alive = getAliveRecords();
      const match = pickBestMatch(cwd, alive);
      if (!match) {
        respondJson(res, 404, { ok: false, reason: 'not_found' });
        return;
      }

      respondJson(res, 200, {
        ok: true,
        match: {
          sessionId: match.sessionId,
          host: match.host,
          port: match.port,
          workspaceFolders: match.workspaceFolders,
          workspaceFile: match.workspaceFile ?? null,
        },
      });
      return;
    } catch {
      respondJson(res, 400, { ok: false, reason: 'invalid_json' });
      return;
    }
  }

  respondJson(res, 404, { ok: false, reason: 'not_found' });
});

pipeServer.on('error', (error) => {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
    return;
  }
  process.exit(1);
});

const pipeName = getPipeNameFromArgs() ?? getManagerPipeName();
pipeServer.listen(pipeName, () => {
  lastNonEmptyAt = Date.now();
});

const mcpServer = http.createServer((req, res) => {
  void handleMcpHttpRequest(req, res);
});

mcpServer.keepAliveTimeout = 60000;
mcpServer.headersTimeout = 65000;

mcpServer.on('error', (error) => {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
    return;
  }
  process.exit(1);
});

const httpPortArg = getHttpPortFromArgs();
const httpPort = isValidPort(httpPortArg) ? httpPortArg : MCP_HTTP_PORT_DEFAULT;
mcpServer.listen(httpPort, '127.0.0.1');

const pruneTimer = setInterval(pruneInstances, PRUNE_INTERVAL_MS);
pruneTimer.unref();

