import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveComparablePath,
} from './windowsWorkspacePath';

export interface InstanceAdvertisement {
  sessionId: string;
  pid: number;
  workspaceFolders: string[];
  workspaceFile?: string;
  host: string;
  port: number;
  lastSeen: number;
  startedAt: number;
}

export interface RegisteredInstance extends InstanceAdvertisement {
  recordPath: string;
  normalizedFolders: string[];
  normalizedWorkspaceFile?: string;
}

export interface InstanceRegistryPublisherOptions {
  sessionId: string;
  directory?: string;
  intervalMs?: number;
  getAdvertisement: () => Omit<InstanceAdvertisement, 'sessionId' | 'lastSeen' | 'startedAt'> | undefined;
}

const DEFAULT_INSTANCE_REGISTRY_DIR_NAME = path.join('lm-tools-bridge', 'instances');
export const DEFAULT_INSTANCE_REGISTRY_HEARTBEAT_INTERVAL_MS = 1000;
export const DEFAULT_INSTANCE_REGISTRY_TTL_MS = 2500;

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-z0-9._-]/giu, '_');
}

function normalizePath(value: string): string {
  return resolveComparablePath(value).replace(/\//g, '\\').toLowerCase();
}

function toNumber(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getInstanceRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LM_TOOLS_BRIDGE_INSTANCE_REGISTRY_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  const baseDir = env.LOCALAPPDATA?.trim() || os.tmpdir();
  return path.join(baseDir, DEFAULT_INSTANCE_REGISTRY_DIR_NAME);
}

export function getInstanceRegistryTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return toNumber(env.LM_TOOLS_BRIDGE_INSTANCE_TTL_MS, DEFAULT_INSTANCE_REGISTRY_TTL_MS);
}

export async function ensureInstanceRegistryDir(directory = getInstanceRegistryDir()): Promise<string> {
  await fs.promises.mkdir(directory, { recursive: true });
  return directory;
}

export function getInstanceRecordPath(
  sessionId: string,
  directory = getInstanceRegistryDir(),
): string {
  return path.join(directory, `${sanitizeSessionId(sessionId)}.json`);
}

function normalizeFolders(workspaceFolders: string[]): string[] {
  return workspaceFolders.map((entry) => normalizePath(entry));
}

function isValidAdvertisement(record: unknown): record is InstanceAdvertisement {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }
  const value = record as Partial<InstanceAdvertisement>;
  return typeof value.sessionId === 'string'
    && value.sessionId.trim().length > 0
    && typeof value.pid === 'number'
    && Number.isInteger(value.pid)
    && Array.isArray(value.workspaceFolders)
    && value.workspaceFolders.every((entry) => typeof entry === 'string')
    && typeof value.host === 'string'
    && value.host.trim().length > 0
    && typeof value.port === 'number'
    && Number.isInteger(value.port)
    && typeof value.lastSeen === 'number'
    && Number.isFinite(value.lastSeen)
    && typeof value.startedAt === 'number'
    && Number.isFinite(value.startedAt)
    && (value.workspaceFile === undefined || typeof value.workspaceFile === 'string');
}

export function toRegisteredInstance(
  record: InstanceAdvertisement,
  recordPath: string,
): RegisteredInstance {
  return {
    ...record,
    recordPath,
    normalizedFolders: normalizeFolders(record.workspaceFolders),
    normalizedWorkspaceFile: record.workspaceFile ? normalizePath(record.workspaceFile) : undefined,
  };
}

export async function writeInstanceAdvertisement(
  record: InstanceAdvertisement,
  directory = getInstanceRegistryDir(),
): Promise<void> {
  await ensureInstanceRegistryDir(directory);
  const recordPath = getInstanceRecordPath(record.sessionId, directory);
  await fs.promises.writeFile(recordPath, JSON.stringify(record), 'utf8');
}

export async function removeInstanceAdvertisement(
  sessionId: string,
  directory = getInstanceRegistryDir(),
): Promise<void> {
  const recordPath = getInstanceRecordPath(sessionId, directory);
  try {
    await fs.promises.unlink(recordPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function readRegisteredInstances(options?: {
  directory?: string;
  now?: number;
  ttlMs?: number;
  pruneStale?: boolean;
}): Promise<RegisteredInstance[]> {
  const directory = options?.directory ?? getInstanceRegistryDir();
  const ttlMs = options?.ttlMs ?? getInstanceRegistryTtlMs();
  const now = options?.now ?? Date.now();
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const instances = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const recordPath = path.join(directory, entry.name);
      try {
        const text = await fs.promises.readFile(recordPath, 'utf8');
        const parsed = JSON.parse(text) as unknown;
        if (!isValidAdvertisement(parsed)) {
          if (options?.pruneStale) {
            await fs.promises.unlink(recordPath).catch(() => undefined);
          }
          return undefined;
        }
        if (now - parsed.lastSeen > ttlMs) {
          if (options?.pruneStale) {
            await fs.promises.unlink(recordPath).catch(() => undefined);
          }
          return undefined;
        }
        return toRegisteredInstance(parsed, recordPath);
      } catch {
        if (options?.pruneStale) {
          await fs.promises.unlink(recordPath).catch(() => undefined);
        }
        return undefined;
      }
    }));
  return instances.filter((entry): entry is RegisteredInstance => Boolean(entry));
}

export function pickBestMatchingInstance(
  cwd: string,
  instances: readonly RegisteredInstance[],
): RegisteredInstance | undefined {
  const normalizedCwd = normalizePath(cwd);
  let best: RegisteredInstance | undefined;
  let bestScore = 0;

  for (const instance of instances) {
    let score = 0;
    if (instance.normalizedWorkspaceFile && normalizedCwd === instance.normalizedWorkspaceFile) {
      score = 3;
    } else if (instance.normalizedFolders.includes(normalizedCwd)) {
      score = 2;
    } else if (instance.normalizedFolders.some((folder) => normalizedCwd.startsWith(`${folder}\\`))) {
      score = 1;
    }

    if (score > bestScore) {
      best = instance;
      bestScore = score;
      continue;
    }
    if (score === bestScore && score > 0 && best && instance.lastSeen > best.lastSeen) {
      best = instance;
    }
  }

  return bestScore > 0 ? best : undefined;
}

export function isCwdWithinWorkspaceFolders(cwd: string, workspaceFolders: readonly string[]): boolean {
  const normalizedCwd = normalizePath(cwd);
  return workspaceFolders.some((folder) => {
    const normalizedFolder = normalizePath(folder);
    const relative = path.relative(normalizedFolder, normalizedCwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function isCwdMatchingWorkspaceFile(cwd: string, workspaceFile?: string | null): boolean {
  if (!workspaceFile) {
    return false;
  }
  return normalizePath(cwd) === normalizePath(workspaceFile);
}

export class InstanceRegistryPublisher {
  private readonly sessionId: string;
  private readonly directory: string;
  private readonly intervalMs: number;
  private readonly getAdvertisement: InstanceRegistryPublisherOptions['getAdvertisement'];
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private active = false;

  public constructor(options: InstanceRegistryPublisherOptions) {
    this.sessionId = options.sessionId;
    this.directory = options.directory ?? getInstanceRegistryDir();
    this.intervalMs = options.intervalMs ?? DEFAULT_INSTANCE_REGISTRY_HEARTBEAT_INTERVAL_MS;
    this.getAdvertisement = options.getAdvertisement;
  }

  public async start(): Promise<void> {
    if (this.active) {
      return;
    }
    this.active = true;
    await this.publishOnce();
    this.timer = setInterval(() => {
      void this.publishOnce();
    }, this.intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await removeInstanceAdvertisement(this.sessionId, this.directory);
  }

  private async publishOnce(): Promise<void> {
    const next = this.getAdvertisement();
    if (!next) {
      await removeInstanceAdvertisement(this.sessionId, this.directory);
      return;
    }
    await writeInstanceAdvertisement({
      sessionId: this.sessionId,
      ...next,
      lastSeen: Date.now(),
      startedAt: this.startedAt,
    }, this.directory);
  }
}
