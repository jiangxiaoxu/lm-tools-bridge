import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveComparablePath } from './windowsWorkspacePath';

export type WorkspaceDiscoveryTargetKind = 'folder' | 'workspace-file';

export interface WorkspaceDiscoveryTarget {
  targetKind: WorkspaceDiscoveryTargetKind;
  openPath: string;
  canonicalIdentity: string;
  discoveryPipePath: string;
  launchLockPipePath: string;
  workspaceFolders: string[];
  workspaceFile: string | null;
}

export interface UnsupportedWorkspaceDiscoveryTarget {
  code: 'UNTITLED_MULTI_ROOT_UNSUPPORTED';
  message: string;
}

export interface WorkspaceDiscoveryAdvertisement {
  ok: true;
  protocolVersion: 1;
  targetIdentity: string;
  targetKind: WorkspaceDiscoveryTargetKind;
  workspaceFolders: string[];
  workspaceFile: string | null;
  host: string;
  port: number;
  serverSessionId: string;
  pid: number;
  startedAt: number;
}

interface WorkspaceDiscoveryAdvertisementInput {
  target: WorkspaceDiscoveryTarget;
  host: string;
  port: number;
}

interface WorkspaceDiscoveryRequest {
  op: 'discover';
  protocolVersion: 1;
  managerSessionId: string;
  targetIdentity: string;
}

interface WorkspaceDiscoveryErrorResponse {
  ok: false;
  protocolVersion: 1;
  code: string;
  message: string;
}

export interface WorkspaceDiscoveryPublisherOptions {
  serverSessionId: string;
  getAdvertisement: () => WorkspaceDiscoveryAdvertisementInput | UnsupportedWorkspaceDiscoveryTarget | undefined;
  retryIntervalMs?: number;
  logger?: {
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

const DEFAULT_DISCOVERY_PIPE_PREFIX = 'lm-tools-bridge.discovery.v1.';
const DEFAULT_LAUNCH_LOCK_PIPE_PREFIX = 'lm-tools-bridge.launch-lock.v1.';
const DEFAULT_DISCOVERY_PUBLISH_RETRY_MS = 1000;
const DEFAULT_DISCOVERY_REQUEST_TIMEOUT_MS = 1200;
const MAX_DISCOVERY_MESSAGE_BYTES = 64 * 1024;
const UNTITLED_MULTI_ROOT_UNSUPPORTED_MESSAGE = 'Untitled multi-root workspace is not supported. Save the workspace as a .code-workspace file first.';

function sanitizePipePrefix(prefix: string): string {
  return prefix.replace(/[^a-z0-9._-]/giu, '_');
}

function normalizeIdentityPath(value: string): string {
  return resolveComparablePath(value).replace(/\//g, '\\').toLowerCase();
}

function buildPipeSocketPath(pipeName: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${pipeName}`;
  }
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

function buildPipeName(prefix: string, canonicalIdentity: string): string {
  return `${prefix}${crypto.createHash('sha256').update(canonicalIdentity).digest('hex')}`;
}

function isUnsupportedWorkspaceDiscoveryTarget(
  value: WorkspaceDiscoveryAdvertisementInput | UnsupportedWorkspaceDiscoveryTarget | undefined,
): value is UnsupportedWorkspaceDiscoveryTarget {
  return Boolean(value && 'code' in value);
}

function isWorkspaceDiscoveryRequest(value: unknown): value is WorkspaceDiscoveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const request = value as Partial<WorkspaceDiscoveryRequest>;
  return request.op === 'discover'
    && request.protocolVersion === 1
    && typeof request.managerSessionId === 'string'
    && request.managerSessionId.trim().length > 0
    && typeof request.targetIdentity === 'string'
    && request.targetIdentity.trim().length > 0;
}

function isWorkspaceDiscoveryAdvertisement(value: unknown): value is WorkspaceDiscoveryAdvertisement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<WorkspaceDiscoveryAdvertisement>;
  return payload.ok === true
    && payload.protocolVersion === 1
    && typeof payload.targetIdentity === 'string'
    && (payload.targetKind === 'folder' || payload.targetKind === 'workspace-file')
    && Array.isArray(payload.workspaceFolders)
    && payload.workspaceFolders.every((entry) => typeof entry === 'string')
    && (payload.workspaceFile === null || typeof payload.workspaceFile === 'string')
    && typeof payload.host === 'string'
    && payload.host.trim().length > 0
    && typeof payload.port === 'number'
    && Number.isInteger(payload.port)
    && typeof payload.serverSessionId === 'string'
    && payload.serverSessionId.trim().length > 0
    && typeof payload.pid === 'number'
    && Number.isInteger(payload.pid)
    && typeof payload.startedAt === 'number'
    && Number.isFinite(payload.startedAt);
}

function toDiscoveryErrorResponse(code: string, message: string): WorkspaceDiscoveryErrorResponse {
  return {
    ok: false,
    protocolVersion: 1,
    code,
    message,
  };
}

function writeJsonLine(socket: net.Socket, payload: WorkspaceDiscoveryAdvertisement | WorkspaceDiscoveryErrorResponse): void {
  socket.end(`${JSON.stringify(payload)}\n`);
}

async function removeUnixSocketIfNeeded(socketPath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    return;
  }
  try {
    await fs.promises.unlink(socketPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function closeServer(server: net.Server | undefined, socketPath?: string): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      server.close(() => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
  if (socketPath) {
    await removeUnixSocketIfNeeded(socketPath).catch(() => undefined);
  }
}

export function getDiscoveryPipePrefix(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LM_TOOLS_BRIDGE_DISCOVERY_PIPE_PREFIX?.trim();
  return sanitizePipePrefix(override || DEFAULT_DISCOVERY_PIPE_PREFIX);
}

export function getLaunchLockPipePrefix(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LM_TOOLS_BRIDGE_LAUNCH_LOCK_PIPE_PREFIX?.trim();
  return sanitizePipePrefix(override || DEFAULT_LAUNCH_LOCK_PIPE_PREFIX);
}

export function getUntitledMultiRootUnsupportedMessage(): string {
  return UNTITLED_MULTI_ROOT_UNSUPPORTED_MESSAGE;
}

export function createWorkspaceDiscoveryTarget(
  targetKind: WorkspaceDiscoveryTargetKind,
  openPath: string,
  options?: {
    workspaceFolders?: readonly string[];
    workspaceFile?: string | null;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): WorkspaceDiscoveryTarget {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const resolvedOpenPath = resolveComparablePath(openPath, platform);
  const workspaceFolders = (options?.workspaceFolders ?? []).map((entry) => resolveComparablePath(entry, platform));
  const workspaceFile = options?.workspaceFile
    ? resolveComparablePath(options.workspaceFile, platform)
    : (targetKind === 'workspace-file' ? resolvedOpenPath : null);
  const canonicalIdentity = `${targetKind}|${normalizeIdentityPath(resolvedOpenPath)}`;
  const discoveryPipePath = buildPipeSocketPath(
    buildPipeName(getDiscoveryPipePrefix(env), canonicalIdentity),
    platform,
  );
  const launchLockPipePath = buildPipeSocketPath(
    buildPipeName(getLaunchLockPipePrefix(env), canonicalIdentity),
    platform,
  );
  return {
    targetKind,
    openPath: resolvedOpenPath,
    canonicalIdentity,
    discoveryPipePath,
    launchLockPipePath,
    workspaceFolders,
    workspaceFile,
  };
}

export function resolveWorkspaceDiscoveryTargetFromWindow(
  workspaceFolders: readonly string[],
  workspaceFile?: string | null,
  options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): WorkspaceDiscoveryTarget | UnsupportedWorkspaceDiscoveryTarget | undefined {
  const platform = options?.platform ?? process.platform;
  const normalizedFolders = workspaceFolders
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolveComparablePath(entry, platform));

  if (workspaceFile && workspaceFile.trim().length > 0) {
    return createWorkspaceDiscoveryTarget('workspace-file', workspaceFile, {
      workspaceFolders: normalizedFolders,
      workspaceFile,
      env: options?.env,
      platform,
    });
  }

  if (normalizedFolders.length === 0) {
    return undefined;
  }
  if (normalizedFolders.length > 1) {
    return {
      code: 'UNTITLED_MULTI_ROOT_UNSUPPORTED',
      message: UNTITLED_MULTI_ROOT_UNSUPPORTED_MESSAGE,
    };
  }
  return createWorkspaceDiscoveryTarget('folder', normalizedFolders[0], {
    workspaceFolders: normalizedFolders,
    workspaceFile: null,
    env: options?.env,
    platform,
  });
}

export async function requestWorkspaceDiscovery(
  target: WorkspaceDiscoveryTarget,
  managerSessionId: string,
  timeoutMs = DEFAULT_DISCOVERY_REQUEST_TIMEOUT_MS,
): Promise<WorkspaceDiscoveryAdvertisement | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(target.discoveryPipePath);
    let settled = false;
    let buffer = '';

    const finish = (result?: WorkspaceDiscoveryAdvertisement, error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(undefined);
    }, Math.max(1, timeoutMs));

    socket.on('error', (error) => {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT' || nodeError.code === 'ECONNREFUSED' || nodeError.code === 'EPIPE') {
        finish(undefined);
        return;
      }
      finish(undefined, error);
    });

    socket.on('connect', () => {
      const request: WorkspaceDiscoveryRequest = {
        op: 'discover',
        protocolVersion: 1,
        managerSessionId,
        targetIdentity: target.canonicalIdentity,
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_DISCOVERY_MESSAGE_BYTES) {
        finish(undefined, new Error('Discovery pipe response exceeded maximum size.'));
        return;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        finish(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isWorkspaceDiscoveryAdvertisement(parsed)) {
          if (parsed.targetIdentity !== target.canonicalIdentity) {
            finish(undefined, new Error('Discovery response target identity mismatch.'));
            return;
          }
          finish(parsed);
          return;
        }
        const errorResponse = parsed as Partial<WorkspaceDiscoveryErrorResponse>;
        if (errorResponse.ok === false) {
          finish(undefined);
          return;
        }
        finish(undefined, new Error('Discovery pipe returned an invalid payload.'));
      } catch (error) {
        finish(undefined, error);
      }
    });

    socket.on('close', () => {
      finish(undefined);
    });
  });
}

export async function tryAcquireLaunchLock(
  target: WorkspaceDiscoveryTarget,
): Promise<(() => Promise<void>) | undefined> {
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  await removeUnixSocketIfNeeded(target.launchLockPipePath).catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target.launchLockPipePath, () => {
        resolve();
      });
    });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EADDRINUSE') {
      await closeServer(server, target.launchLockPipePath);
      return undefined;
    }
    throw error;
  }
  return async () => {
    await closeServer(server, target.launchLockPipePath);
  };
}

export function isCwdWithinWorkspaceFolders(cwd: string, workspaceFolders: readonly string[]): boolean {
  const normalizedCwd = normalizeIdentityPath(cwd);
  return workspaceFolders.some((folder) => {
    const normalizedFolder = normalizeIdentityPath(folder);
    const relative = path.relative(normalizedFolder, normalizedCwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function isCwdMatchingWorkspaceFile(cwd: string, workspaceFile?: string | null): boolean {
  if (!workspaceFile) {
    return false;
  }
  return normalizeIdentityPath(cwd) === normalizeIdentityPath(workspaceFile);
}

export class WorkspaceDiscoveryPublisher {
  private readonly serverSessionId: string;
  private readonly getAdvertisement: WorkspaceDiscoveryPublisherOptions['getAdvertisement'];
  private readonly retryIntervalMs: number;
  private readonly logger: WorkspaceDiscoveryPublisherOptions['logger'];
  private readonly startedAt = Date.now();
  private readonly pid = process.pid;
  private active = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private server: net.Server | undefined;
  private ownedIdentity: string | undefined;
  private ownedPipePath: string | undefined;
  private lastUnsupportedMessage: string | undefined;
  private reconcileInFlight = false;
  private reconcilePending = false;

  public constructor(options: WorkspaceDiscoveryPublisherOptions) {
    this.serverSessionId = options.serverSessionId;
    this.getAdvertisement = options.getAdvertisement;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_DISCOVERY_PUBLISH_RETRY_MS;
    this.logger = options.logger;
  }

  public async start(): Promise<void> {
    if (this.active) {
      return;
    }
    this.active = true;
    this.retryTimer = setInterval(() => {
      void this.reconcile();
    }, this.retryIntervalMs);
    this.retryTimer.unref();
    await this.reconcile();
  }

  public async refresh(): Promise<void> {
    if (!this.active) {
      return;
    }
    await this.reconcile();
  }

  public async stop(): Promise<void> {
    this.active = false;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = undefined;
    }
    await this.releaseCurrentServer();
  }

  private async reconcile(): Promise<void> {
    if (this.reconcileInFlight) {
      this.reconcilePending = true;
      return;
    }
    this.reconcileInFlight = true;
    try {
      do {
        this.reconcilePending = false;
        await this.reconcileOnce();
      } while (this.reconcilePending && this.active);
    } finally {
      this.reconcileInFlight = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const next = this.getAdvertisement();
    if (!next) {
      this.lastUnsupportedMessage = undefined;
      await this.releaseCurrentServer();
      return;
    }
    if (isUnsupportedWorkspaceDiscoveryTarget(next)) {
      if (this.lastUnsupportedMessage !== next.message) {
        this.lastUnsupportedMessage = next.message;
        this.logger?.warn?.(next.message);
      }
      await this.releaseCurrentServer();
      return;
    }
    this.lastUnsupportedMessage = undefined;
    if (this.server && this.ownedIdentity === next.target.canonicalIdentity) {
      return;
    }

    await this.releaseCurrentServer();
    await this.tryListen(next);
  }

  private async tryListen(next: WorkspaceDiscoveryAdvertisementInput): Promise<void> {
    const pipePath = next.target.discoveryPipePath;
    const server = net.createServer((socket) => {
      void this.handleSocket(socket, next.target.canonicalIdentity);
    });
    await removeUnixSocketIfNeeded(pipePath).catch(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, () => {
          resolve();
        });
      });
      this.server = server;
      this.ownedIdentity = next.target.canonicalIdentity;
      this.ownedPipePath = pipePath;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'EADDRINUSE') {
        this.logger?.error?.(`Failed to listen on workspace discovery pipe: ${String(error)}`);
      }
      await closeServer(server, pipePath);
    }
  }

  private async handleSocket(socket: net.Socket, expectedIdentity: string): Promise<void> {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_DISCOVERY_MESSAGE_BYTES) {
        writeJsonLine(socket, toDiscoveryErrorResponse('MESSAGE_TOO_LARGE', 'Discovery request exceeded maximum size.'));
        return;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        writeJsonLine(socket, toDiscoveryErrorResponse('INVALID_REQUEST', 'Discovery request line is empty.'));
        return;
      }
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        writeJsonLine(socket, toDiscoveryErrorResponse('INVALID_JSON', 'Discovery request is not valid JSON.'));
        return;
      }
      if (!isWorkspaceDiscoveryRequest(request)) {
        writeJsonLine(socket, toDiscoveryErrorResponse('INVALID_REQUEST', 'Discovery request shape is invalid.'));
        return;
      }
      if (request.targetIdentity !== expectedIdentity) {
        writeJsonLine(socket, toDiscoveryErrorResponse('TARGET_IDENTITY_MISMATCH', 'Discovery target identity does not match this pipe.'));
        return;
      }
      const current = this.getAdvertisement();
      if (!current || isUnsupportedWorkspaceDiscoveryTarget(current) || current.target.canonicalIdentity !== expectedIdentity) {
        writeJsonLine(socket, toDiscoveryErrorResponse('TARGET_UNAVAILABLE', 'Workspace discovery target is not currently available.'));
        return;
      }
      writeJsonLine(socket, {
        ok: true,
        protocolVersion: 1,
        targetIdentity: current.target.canonicalIdentity,
        targetKind: current.target.targetKind,
        workspaceFolders: current.target.workspaceFolders,
        workspaceFile: current.target.workspaceFile,
        host: current.host,
        port: current.port,
        serverSessionId: this.serverSessionId,
        pid: this.pid,
        startedAt: this.startedAt,
      });
    });
  }

  private async releaseCurrentServer(): Promise<void> {
    const server = this.server;
    const pipePath = this.ownedPipePath;
    this.server = undefined;
    this.ownedIdentity = undefined;
    this.ownedPipePath = undefined;
    await closeServer(server, pipePath);
  }
}
