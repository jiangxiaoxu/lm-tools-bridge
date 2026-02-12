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
const MANAGER_LOCK_STALE_MS = 15000;
const MANAGER_SHUTDOWN_TIMEOUT_MS = 5000;
const MANAGER_RESTART_LOCK_TIMEOUT_MS = 2000;
const MANAGER_MANUAL_RESTART_LOCK_TIMEOUT_MS = 8000;
const MANAGER_AUTO_RESTART_NOTICE_DEBOUNCE_MS = 30000;
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

export type RestartFailureReason =
  | 'other_instance_lock'
  | 'manager_shutdown_failed'
  | 'manager_start_failed'
  | 'unknown';

export type RestartFlowSource = 'manual_menu' | 'version_upgrade' | 'version_mismatch';

export interface RestartManagerResult {
  ok: boolean;
  reason?: RestartFailureReason;
  message?: string;
  timedOut?: boolean;
}

export type ManagerRestartUiPhase = 'running' | 'success' | 'failed';

export interface ManagerRestartUiEvent {
  phase: ManagerRestartUiPhase;
  source: RestartFlowSource;
  reason?: RestartFailureReason;
  message?: string;
}

export interface ManagerTooltipInstanceInfo {
  sessionId: string;
  pid: number;
  host: string;
  port: number;
  workspaceFolders: string[];
  workspaceFile?: string;
}

export interface ManagerTooltipStatus {
  online: boolean;
  source: 'pipe' | 'http-status' | 'unavailable';
  reason?: string;
  instances: ManagerTooltipInstanceInfo[];
}

interface ManagerLockInfo {
  pid?: number;
  timestamp?: number;
  mtimeMs?: number;
  pidAlive?: boolean;
}

export interface ManagerClientDeps {
  getExtensionContext: () => vscode.ExtensionContext | undefined;
  getServerState: () => ManagerServerState | undefined;
  getConfigValue: <T>(key: string, fallback: T) => T;
  isValidPort: (value: unknown) => value is number;
  logStatusInfo: (message: string) => void;
  logStatusWarn: (message: string) => void;
  logStatusError: (message: string) => void;
  onManagerRestartUiEvent: (event: ManagerRestartUiEvent) => void;
}

let deps: ManagerClientDeps | undefined;
let managerHeartbeatTimer: NodeJS.Timeout | undefined;
let managerHeartbeatInFlight = false;
let managerStartPromise: Promise<boolean> | undefined;
let managerReady = false;
let managerRestartPromise: Promise<RestartManagerResult> | undefined;
let lastAutoRestartNoticeKey: string | undefined;
let lastAutoRestartNoticeAt = 0;

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
    const restartResult = await managerRestartPromise;
    return restartResult.ok;
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
        if (isUnknownVersion(managerVersion)) {
          requireDeps().logStatusWarn('Manager version is unknown; restart requires confirmation.');
          const confirmed = await promptRestartForUnknownVersion();
          if (!confirmed) {
            return true;
          }
          const restarted = await restartManagerForVersionMismatch(
            extensionVersion,
            managerVersion,
            'version_mismatch',
          );
          return restarted;
        }
        const comparison = compareVersionStrings(extensionVersion, managerVersion);
        if (comparison <= 0) {
          requireDeps().logStatusWarn(
            `Manager version (${managerVersion}) is newer or equal to extension (${extensionVersion}); skip restart.`,
          );
          return true;
        }
        const restarted = await restartManagerForVersionMismatch(
          extensionVersion,
          managerVersion,
          'version_upgrade',
        );
        return restarted;
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

function isUnknownVersion(value: string | undefined): boolean {
  return value === 'unknown';
}

async function promptRestartForUnknownVersion(): Promise<boolean> {
  const selection = await vscode.window.showWarningMessage(
    'Manager version is unknown. Restart the manager now?',
    { modal: false },
    'Restart',
    'Cancel',
  );
  return selection === 'Restart';
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
  source: RestartFlowSource,
): Promise<boolean> {
  requireDeps().logStatusInfo(
    `Manager version mismatch (manager=${managerVersion} extension=${extensionVersion}). Restarting manager.`,
  );
  const result = await restartManagerViaUnifiedFlow({
    reason: source === 'version_upgrade' ? 'version_upgrade' : 'version_mismatch',
    title: 'LM Tools Bridge: Manager update detected',
    source,
  });
  return result.ok;
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

async function restartManagerViaUnifiedFlow(options: {
  reason: string;
  title: string;
  source: RestartFlowSource;
}): Promise<RestartManagerResult> {
  return restartManagerWithProgress({
    reason: options.reason,
    force: true,
    title: options.title,
    lockTimeoutMs: MANAGER_MANUAL_RESTART_LOCK_TIMEOUT_MS,
    source: options.source,
  });
}

function shouldNotifyRestartResult(source: RestartFlowSource, result: RestartManagerResult): boolean {
  if (source === 'manual_menu') {
    return true;
  }
  if (result.ok) {
    return false;
  }
  const timeoutKey = isRestartTimeout(result) ? 'timeout' : 'normal';
  const key = `${source}:${result.reason ?? 'unknown'}:${timeoutKey}:${result.message ?? ''}`;
  const now = Date.now();
  if (lastAutoRestartNoticeKey === key && now - lastAutoRestartNoticeAt < MANAGER_AUTO_RESTART_NOTICE_DEBOUNCE_MS) {
    return false;
  }
  lastAutoRestartNoticeKey = key;
  lastAutoRestartNoticeAt = now;
  return true;
}

function emitManagerRestartUiEvent(event: ManagerRestartUiEvent): void {
  requireDeps().onManagerRestartUiEvent(event);
}

async function restartManagerWithProgress(options: {
  reason: string;
  force: boolean;
  title: string;
  lockTimeoutMs?: number;
  source: RestartFlowSource;
}): Promise<RestartManagerResult> {
  if (managerRestartPromise) {
    return managerRestartPromise;
  }
  emitManagerRestartUiEvent({
    phase: 'running',
    source: options.source,
  });
  const progressPromise = runManagerRestartWorkflow(options);
  managerRestartPromise = progressPromise
    .then((result) => {
      emitManagerRestartUiEvent({
        phase: result.ok ? 'success' : 'failed',
        source: options.source,
        reason: result.reason,
        message: result.message,
      });
      if (!shouldNotifyRestartResult(options.source, result)) {
        if (result.ok) {
          requireDeps().logStatusInfo(`Manager restart completed. source=${options.source}`);
        } else {
          requireDeps().logStatusError(`Manager restart failed. source=${options.source} reason=${result.reason ?? 'unknown'} message=${result.message ?? ''}`);
        }
        return result;
      }
      if (result.ok) {
        void vscode.window.showInformationMessage('Manager restart completed.');
      } else {
        void vscode.window.showErrorMessage(buildRestartFailureMessage(result, options.source));
      }
      return result;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const result: RestartManagerResult = {
        ok: false,
        reason: 'unknown',
        message,
        timedOut: /timed out|timeout/i.test(message),
      };
      emitManagerRestartUiEvent({
        phase: 'failed',
        source: options.source,
        reason: result.reason,
        message: result.message,
      });
      if (shouldNotifyRestartResult(options.source, result)) {
        void vscode.window.showErrorMessage(buildRestartFailureMessage(result, options.source));
      } else {
        requireDeps().logStatusError(`Manager restart failed. source=${options.source} reason=unknown message=${message}`);
      }
      return result;
    })
    .finally(() => {
      managerRestartPromise = undefined;
    });
  return managerRestartPromise;
}

async function runManagerRestartWorkflow(
  options: { reason: string; force: boolean; lockTimeoutMs?: number },
): Promise<RestartManagerResult> {
  const extensionVersion = getExtensionVersion();
  const managerVersion = await getManagerVersionFromPipe();
  const comparableManagerVersion = isUnknownVersion(managerVersion) ? undefined : managerVersion;
  if (!options.force && extensionVersion && comparableManagerVersion) {
    const comparison = compareVersionStrings(extensionVersion, comparableManagerVersion);
    if (comparison <= 0) {
      return {
        ok: false,
        reason: 'unknown',
        message: 'Extension version is not newer than the manager; restart canceled.',
      };
    }
  }
  if (!options.force && extensionVersion && comparableManagerVersion && managerVersion === extensionVersion) {
    return { ok: true };
  }

  const lockPath = await getManagerLockPath();
  const acquired = await waitForManagerRestartLock(
    lockPath,
    options.lockTimeoutMs ?? MANAGER_RESTART_LOCK_TIMEOUT_MS,
  );
  if (!acquired) {
    const lockInfo = await readManagerLockInfo(lockPath);
    if (lockInfo) {
      const ageBase = lockInfo.mtimeMs ?? lockInfo.timestamp;
      const ageMs = ageBase !== undefined ? Math.max(0, Date.now() - ageBase) : undefined;
      requireDeps().logStatusWarn(
        `Restart lock diagnostics: pid=${String(lockInfo.pid ?? 'unknown')} alive=${String(lockInfo.pidAlive ?? 'unknown')} ageMs=${String(ageMs ?? 'unknown')}`,
      );
    } else {
      requireDeps().logStatusWarn('Restart lock diagnostics: lock file not found or unreadable.');
    }
    if (lockInfo?.pidAlive && lockInfo.pid !== process.pid) {
      return {
        ok: false,
        reason: 'other_instance_lock',
        message: lockInfo.pid
          ? `Another VS Code instance appears to own manager lock (pid=${lockInfo.pid}).`
          : 'Another VS Code instance appears to own manager lock.',
      };
    }
    return {
      ok: false,
      reason: 'manager_start_failed',
      message: 'Timed out while acquiring restart lock.',
      timedOut: true,
    };
  }
  try {
    const alive = await isManagerAlive();
    const currentVersion = await getManagerVersionFromPipe();
    if (!options.force && extensionVersion && currentVersion && currentVersion === extensionVersion) {
      return { ok: true };
    }

    if (alive) {
      const expectedVersion = currentVersion ?? managerVersion;
      const shutdownResponse = await managerRequest('POST', '/shutdown', {
        reason: options.reason,
        ...(isUnknownVersion(expectedVersion) || !expectedVersion ? {} : { expectedVersion }),
      });
      if (!shutdownResponse.ok) {
        return {
          ok: false,
          reason: 'manager_shutdown_failed',
          message: 'Failed to shut down old manager.',
        };
      }
      const stopped = await waitForManagerExit();
      if (!stopped) {
        return {
          ok: false,
          reason: 'manager_shutdown_failed',
          message: 'Old manager did not exit.',
        };
      }
    }

    await startManagerProcess();
    const ready = await waitForManagerReady();
    if (!ready) {
      return {
        ok: false,
        reason: 'manager_start_failed',
        message: 'Timed out while starting new manager.',
        timedOut: true,
      };
    }
    if (!options.force && extensionVersion) {
      const newVersion = await getManagerVersionFromPipe();
      if (newVersion && newVersion !== extensionVersion) {
        return {
          ok: false,
          reason: 'manager_start_failed',
          message: `Version still mismatched: ${newVersion}`,
        };
      }
    }
    return { ok: true };
  } finally {
    await releaseManagerLock(lockPath);
  }
}

async function waitForManagerRestartLock(
  lockPath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const acquired = await tryAcquireManagerLock(lockPath);
    if (acquired) {
      return true;
    }
    if (await isLockStale(lockPath)) {
      await releaseManagerLock(lockPath);
    }
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

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

async function readManagerLockInfo(lockPath: string): Promise<ManagerLockInfo | undefined> {
  try {
    const [text, stats] = await Promise.all([
      fs.promises.readFile(lockPath, 'utf8'),
      fs.promises.stat(lockPath),
    ]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { mtimeMs: stats.mtimeMs };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { mtimeMs: stats.mtimeMs };
    }
    const record = parsed as { pid?: unknown; timestamp?: unknown };
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : undefined;
    const timestamp = typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : undefined;
    return {
      pid,
      timestamp,
      mtimeMs: stats.mtimeMs,
      pidAlive: pid !== undefined ? isPidAlive(pid) : undefined,
    };
  } catch {
    return undefined;
  }
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
  const lockInfo = await readManagerLockInfo(lockPath);
  if (!lockInfo) {
    return false;
  }
  if (lockInfo.pid === undefined) {
    return true;
  }
  if (lockInfo.pidAlive === false) {
    return true;
  }
  const ageBase = lockInfo.mtimeMs ?? lockInfo.timestamp;
  if (ageBase === undefined) {
    return false;
  }
  return Date.now() - ageBase > MANAGER_LOCK_STALE_MS;
}

function isRestartTimeout(result: RestartManagerResult): boolean {
  if (result.timedOut) {
    return true;
  }
  if (!result.message) {
    return false;
  }
  return /timed out|timeout/i.test(result.message);
}

function buildRestartFailureMessage(result: RestartManagerResult, source: RestartFlowSource): string {
  if (source === 'version_upgrade' && isRestartTimeout(result)) {
    return 'Manager upgrade restart timed out. Please run "Restart Manager" from the status menu manually.';
  }
  if (result.reason === 'other_instance_lock') {
    const detail = result.message ? ` ${result.message}` : '';
    return `Manager restart failed: restart lock is owned by another VS Code instance.${detail} Restart manager from that instance or close it, then retry.`;
  }
  if (result.reason === 'manager_shutdown_failed') {
    const detail = result.message ? ` Details: ${result.message}` : '';
    return `Manager restart failed while stopping old manager.${detail} Retry once from status menu.`;
  }
  if (result.reason === 'manager_start_failed') {
    const detail = result.message ? ` Details: ${result.message}` : '';
    return `Manager restart failed while starting new manager.${detail} Retry once from status menu.`;
  }
  if (result.message) {
    return `Manager restart failed: ${result.message}`;
  }
  return 'Manager restart failed.';
}

function toManagerTooltipInstances(value: unknown): ManagerTooltipInstanceInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const instances: ManagerTooltipInstanceInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as {
      sessionId?: unknown;
      pid?: unknown;
      host?: unknown;
      port?: unknown;
      workspaceFolders?: unknown;
      workspaceFile?: unknown;
    };
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : 0;
    const host = typeof record.host === 'string' ? record.host.trim() : '';
    const port = typeof record.port === 'number' && Number.isInteger(record.port) ? record.port : NaN;
    if (!sessionId || !host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      continue;
    }
    const workspaceFolders = Array.isArray(record.workspaceFolders)
      ? record.workspaceFolders.filter((folder): folder is string => typeof folder === 'string')
      : [];
    const workspaceFile = typeof record.workspaceFile === 'string' ? record.workspaceFile : undefined;
    instances.push({
      sessionId,
      pid,
      host,
      port,
      workspaceFolders,
      workspaceFile,
    });
  }
  return instances;
}

async function managerHttpStatusRequest(): Promise<{ ok: boolean; status?: number; data?: unknown; reason?: string }> {
  return new Promise((resolve) => {
    const managerHttpPort = requireDeps().getConfigValue<number>(CONFIG_MANAGER_HTTP_PORT, DEFAULT_MANAGER_HTTP_PORT);
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: managerHttpPort,
        path: '/mcp/status',
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
            resolve({ ok: status >= 200 && status < 300, status, reason: 'empty_response' });
            return;
          }
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(text) as unknown;
            resolve({ ok: status >= 200 && status < 300, status, data: parsed });
          } catch {
            resolve({ ok: false, status, reason: 'invalid_json' });
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error('Timeout'));
    }, MANAGER_REQUEST_TIMEOUT_MS);

    request.on('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false, reason: 'request_error' });
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.end();
  });
}

export async function getManagerTooltipStatus(): Promise<ManagerTooltipStatus> {
  const healthResponse = await managerRequest('GET', '/health');
  if (healthResponse.ok) {
    const listResponse = await managerRequest<{ instances?: unknown }>('GET', '/list');
    if (!listResponse.ok) {
      return {
        online: true,
        source: 'pipe',
        reason: 'list unavailable',
        instances: [],
      };
    }
    const instances = toManagerTooltipInstances(listResponse.data?.instances);
    return {
      online: true,
      source: 'pipe',
      instances,
    };
  }

  const fallbackResponse = await managerHttpStatusRequest();
  if (fallbackResponse.ok && fallbackResponse.data && typeof fallbackResponse.data === 'object' && !Array.isArray(fallbackResponse.data)) {
    const payload = fallbackResponse.data as { ok?: unknown; instanceDetails?: unknown };
    if (payload.ok === true || payload.ok === undefined) {
      return {
        online: true,
        source: 'http-status',
        reason: 'pipe unavailable, using /mcp/status fallback',
        instances: toManagerTooltipInstances(payload.instanceDetails),
      };
    }
  }

  return {
    online: false,
    source: 'unavailable',
    reason: 'pipe unreachable',
    instances: [],
  };
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

export async function restartManagerFromMenu(): Promise<RestartManagerResult> {
  return restartManagerViaUnifiedFlow({
    reason: 'manual_restart',
    title: 'LM Tools Bridge: Restarting manager',
    source: 'manual_menu',
  });
}
