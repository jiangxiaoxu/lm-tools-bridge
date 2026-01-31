import * as vscode from 'vscode';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const CONFIG_MANAGER_HTTP_PORT = 'manager.httpPort';
const DEFAULT_MANAGER_HTTP_PORT = 47100;
const MANAGER_HEARTBEAT_INTERVAL_MS = 1000;
const MANAGER_REQUEST_TIMEOUT_MS = 1500;
const MANAGER_START_TIMEOUT_MS = 3000;
const MANAGER_LOCK_STALE_MS = 5000;
const MANAGER_SHUTDOWN_TIMEOUT_MS = 3000;
const MANAGER_RESTART_LOCK_TIMEOUT_MS = 2000;
const PIPE_PREFIX = 'lm-tools-bridge-manager';

interface ManagerServerState {
  host: string;
  port: number;
}

interface ManagerHeartbeatPayload {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile?: string;
  host: string;
  port: number;
  lastSeen: number;
}

export interface ManagerClientDeps {
  getExtensionContext: () => vscode.ExtensionContext | undefined;
  getServerState: () => ManagerServerState | undefined;
  getConfigValue: <T>(key: string, fallback: T) => T;
  isValidPort: (value: unknown) => value is number;
  logStatusInfo: (message: string) => void;
  logStatusWarn: (message: string) => void;
  logStatusError: (message: string) => void;
}

let deps: ManagerClientDeps | undefined;
let managerHeartbeatTimer: NodeJS.Timeout | undefined;
let managerHeartbeatInFlight = false;
let managerStartPromise: Promise<boolean> | undefined;
let managerReady = false;
let managerRestartPromise: Promise<boolean> | undefined;

export function initManagerClient(nextDeps: ManagerClientDeps): void {
  deps = nextDeps;
}

function requireDeps(): ManagerClientDeps {
  if (!deps) {
    throw new Error('Manager client is not initialized.');
  }
  return deps;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

export async function startManagerHeartbeat(): Promise<void> {
  if (managerHeartbeatTimer) {
    return;
  }
  managerReady = await ensureManagerRunning();
  if (managerReady) {
    await sendManagerHeartbeat();
  } else {
    requireDeps().logStatusWarn('Manager is not available yet; will retry via heartbeat.');
  }
  managerHeartbeatTimer = setInterval(() => {
    void sendManagerHeartbeat();
  }, MANAGER_HEARTBEAT_INTERVAL_MS);
}

export async function stopManagerHeartbeat(): Promise<void> {
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

function buildManagerHeartbeatPayload(): ManagerHeartbeatPayload | undefined {
  const serverState = requireDeps().getServerState();
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

export async function requestManagerPortAllocation(
  preferredPort: number,
  minPort?: number,
): Promise<number | undefined> {
  const sessionId = vscode.env.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const { isValidPort } = requireDeps();
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

export async function ensureManagerRunning(): Promise<boolean> {
  if (managerRestartPromise) {
    return managerRestartPromise;
  }
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
    const extensionVersion = getExtensionVersion();
    if (extensionVersion) {
      const managerVersion = await getManagerVersionFromPipe();
      if (managerVersion && managerVersion !== extensionVersion) {
        const comparison = compareVersionStrings(extensionVersion, managerVersion);
        if (comparison <= 0) {
          requireDeps().logStatusWarn(
            `Manager version (${managerVersion}) is newer or equal to extension (${extensionVersion}); skip restart.`,
          );
          return true;
        }
        const restarted = await restartManagerForVersionMismatch(extensionVersion, managerVersion);
        if (restarted) {
          return true;
        }
      }
    }
    return true;
  }
  if (!requireDeps().getExtensionContext()) {
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

function getExtensionVersion(): string | undefined {
  const version = requireDeps().getExtensionContext()?.extension?.packageJSON?.version;
  return typeof version === 'string' ? version : undefined;
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < maxLength; i += 1) {
    const leftPart = leftParts[i] ?? '0';
    const rightPart = rightParts[i] ?? '0';
    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);
    const leftIsNumber = Number.isFinite(leftNumber);
    const rightIsNumber = Number.isFinite(rightNumber);
    if (leftIsNumber && rightIsNumber) {
      if (leftNumber > rightNumber) {
        return 1;
      }
      if (leftNumber < rightNumber) {
        return -1;
      }
      continue;
    }
    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }
  return 0;
}

async function getManagerVersionFromPipe(): Promise<string | undefined> {
  const response = await managerRequest<{ version?: unknown }>('GET', '/status');
  if (!response.ok || !response.data) {
    return undefined;
  }
  const version = response.data.version;
  return typeof version === 'string' ? version : undefined;
}

async function restartManagerForVersionMismatch(
  extensionVersion: string,
  managerVersion: string,
): Promise<boolean> {
  requireDeps().logStatusInfo(
    `Manager version mismatch (manager=${managerVersion} extension=${extensionVersion}). Restarting manager.`,
  );
  return restartManagerWithProgress({
    reason: 'version_mismatch',
    force: false,
    title: 'LM Tools Bridge: Manager update detected',
  });
}

async function waitForManagerExit(): Promise<boolean> {
  const deadline = Date.now() + MANAGER_SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isManagerAlive())) {
      return true;
    }
    await delay(200);
  }
  return false;
}

async function restartManagerWithProgress(options: {
  reason: string;
  force: boolean;
  title: string;
}): Promise<boolean> {
  if (managerRestartPromise) {
    return managerRestartPromise;
  }
  const progressPromise = Promise.resolve(vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: options.title,
      cancellable: false,
    },
    async (progress) => {
      const result = await runManagerRestartWorkflow(options, progress);
      return result;
    },
  ));
  managerRestartPromise = progressPromise
    .then((result) => {
      if (result) {
        void vscode.window.showInformationMessage('Manager restart completed.');
      }
      return result;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Manager restart failed: ${message}`);
      return false;
    })
    .finally(() => {
      managerRestartPromise = undefined;
    });
  return managerRestartPromise;
}

async function runManagerRestartWorkflow(
  options: { reason: string; force: boolean },
  progress: vscode.Progress<{ message?: string }>,
): Promise<boolean> {
  progress.report({ message: 'Checking versions...' });
  const extensionVersion = getExtensionVersion();
  const managerVersion = await getManagerVersionFromPipe();
  if (!options.force && extensionVersion && managerVersion) {
    const comparison = compareVersionStrings(extensionVersion, managerVersion);
    if (comparison <= 0) {
      progress.report({ message: 'Extension version is not newer than the manager; restart canceled.' });
      return false;
    }
  }
  if (!options.force && extensionVersion && managerVersion && managerVersion === extensionVersion) {
    progress.report({ message: 'Already up to date; no restart needed.' });
    return true;
  }

  progress.report({ message: 'Waiting to acquire restart lock...' });
  const lockPath = await getManagerLockPath();
  const acquired = await waitForManagerRestartLock(lockPath, progress);
  if (!acquired) {
    throw new Error('Timed out while acquiring restart lock.');
  }
  try {
    const alive = await isManagerAlive();
    const currentVersion = await getManagerVersionFromPipe();
    if (!options.force && extensionVersion && currentVersion && currentVersion === extensionVersion) {
      progress.report({ message: 'A newer manager is already running; no restart needed.' });
      return true;
    }

    if (alive) {
      const expectedVersion = currentVersion ?? managerVersion;
      if (!expectedVersion) {
        throw new Error('Unable to read manager version.');
      }
      progress.report({ message: 'Requesting old manager shutdown...' });
      const shutdownResponse = await managerRequest('POST', '/shutdown', {
        reason: options.reason,
        expectedVersion,
      });
      if (!shutdownResponse.ok) {
        throw new Error('Failed to shut down old manager.');
      }
      progress.report({ message: 'Waiting for old manager to exit...' });
      const stopped = await waitForManagerExit();
      if (!stopped) {
        throw new Error('Old manager did not exit.');
      }
    }

    progress.report({ message: 'Starting new manager...' });
    await startManagerProcess();
    const ready = await waitForManagerReady();
    if (!ready) {
      throw new Error('Failed to start new manager.');
    }
    if (!options.force && extensionVersion) {
      progress.report({ message: 'Verifying version...' });
      const newVersion = await getManagerVersionFromPipe();
      if (newVersion && newVersion !== extensionVersion) {
        throw new Error(`Version still mismatched: ${newVersion}`);
      }
    }
    progress.report({ message: 'Done.' });
    return true;
  } finally {
    await releaseManagerLock(lockPath);
  }
}

async function waitForManagerRestartLock(
  lockPath: string,
  progress: vscode.Progress<{ message?: string }>,
): Promise<boolean> {
  const deadline = Date.now() + MANAGER_RESTART_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const acquired = await tryAcquireManagerLock(lockPath);
    if (acquired) {
      return true;
    }
    progress.report({ message: 'Waiting to acquire restart lock...' });
    await delay(200);
  }
  return false;
}

async function restartManagerProcess(): Promise<boolean> {
  if (!requireDeps().getExtensionContext()) {
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

async function startManagerProcess(): Promise<void> {
  const extensionContext = requireDeps().getExtensionContext();
  if (!extensionContext) {
    return;
  }
  const managerPath = extensionContext.asAbsolutePath(path.join('out', 'manager.js'));
  if (!fs.existsSync(managerPath)) {
    requireDeps().logStatusError(`Manager entry not found at ${managerPath}`);
    return;
  }
  const pipeName = getManagerPipeName();
  const managerHttpPort = requireDeps().getConfigValue<number>(CONFIG_MANAGER_HTTP_PORT, DEFAULT_MANAGER_HTTP_PORT);
  const child = spawn(process.execPath, [managerPath, '--pipe', pipeName, '--http-port', String(managerHttpPort)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function getManagerLockPath(): Promise<string> {
  const extensionContext = requireDeps().getExtensionContext();
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

export async function restartManagerFromMenu(): Promise<void> {
  await restartManagerWithProgress({
    reason: 'manual_restart',
    force: true,
    title: 'LM Tools Bridge: Restarting manager',
  });
}
