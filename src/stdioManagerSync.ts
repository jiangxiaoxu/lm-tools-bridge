import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export const STDIO_MANAGER_SYNC_DIRNAME = 'lm-tools-bridge';
export const STDIO_MANAGER_SYNC_FILENAME = 'stdioManager.js';
export const STDIO_MANAGER_RUNTIME_SYNC_FILENAME = 'stdioManagerRuntime.js';
export const STDIO_MANAGER_SYNC_METADATA_FILENAME = 'metadata.json';
export const STDIO_MANAGER_MANAGERS_DIRNAME = 'managers';
export const BUNDLED_STDIO_MANAGER_BANNER = '/* lm-tools-bridge bundled stdioManager */';
export const BUNDLED_STDIO_MANAGER_RUNTIME_BANNER = '/* lm-tools-bridge bundled stdioManager runtime */';

const PUBLISH_LOCK_PIPE_NAME = 'lm-tools-bridge.publish-lock.v1';
const PUBLISH_LOCK_WAIT_TIMEOUT_MS = 5000;
const PUBLISH_LOCK_RETRY_INTERVAL_MS = 200;
const CONTROL_PROTOCOL_VERSION = 1;
const CONTROL_PIPE_CONNECT_TIMEOUT_MS = 300;
const CONTROL_PIPE_RESPONSE_TIMEOUT_MS = 3000;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

export interface StdioManagerSyncMetadata {
  generation: number;
  extensionVersion: string;
  managerFileName: string;
  runtimeFileName: string;
  managerSha256: string;
  runtimeSha256: string;
  syncedAt: string;
}

interface StdioManagerRegistryEntry {
  protocolVersion: 1;
  sessionId: string;
  pid: number;
  startedAt: number;
  controlPipePath: string;
}

interface StdioManagerControlRequest {
  op: 'generationChanged';
  protocolVersion: 1;
  generation: number;
}

interface StdioManagerControlResponse {
  ok: true;
  protocolVersion: 1;
  generationApplied: number;
  bindingInvalidated: boolean;
}

interface SyncMetadataReadState {
  metadata?: StdioManagerSyncMetadata;
  state: 'valid' | 'missing' | 'invalid' | 'legacy';
}

export interface StdioManagerSyncLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SyncBundledStdioManagerOptions {
  bundledManagerPath: string;
  bundledRuntimePath: string;
  extensionVersion: string;
  env?: NodeJS.ProcessEnv;
  logger?: StdioManagerSyncLogger;
}

export interface SyncBundledStdioManagerResult {
  status: 'synced' | 'unchanged' | 'skipped';
  targetDir?: string;
  targetPath?: string;
  runtimePath?: string;
  metadataPath?: string;
  managersDir?: string;
  sha256?: string;
  runtimeSha256?: string;
  generation?: number;
  notifiedManagers?: number;
  reason?: string;
}

export function resolveStdioManagerSyncPaths(env: NodeJS.ProcessEnv = process.env): {
  targetDir?: string;
  targetPath?: string;
  runtimePath?: string;
  metadataPath?: string;
  managersDir?: string;
} {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return {};
  }
  const targetDir = path.join(localAppData, STDIO_MANAGER_SYNC_DIRNAME);
  return {
    targetDir,
    targetPath: path.join(targetDir, STDIO_MANAGER_SYNC_FILENAME),
    runtimePath: path.join(targetDir, STDIO_MANAGER_RUNTIME_SYNC_FILENAME),
    metadataPath: path.join(targetDir, STDIO_MANAGER_SYNC_METADATA_FILENAME),
    managersDir: path.join(targetDir, STDIO_MANAGER_MANAGERS_DIRNAME),
  };
}

export async function syncBundledStdioManager(options: SyncBundledStdioManagerOptions): Promise<SyncBundledStdioManagerResult> {
  const resolvedPaths = resolveStdioManagerSyncPaths(options.env);
  if (
    !resolvedPaths.targetDir
    || !resolvedPaths.targetPath
    || !resolvedPaths.runtimePath
    || !resolvedPaths.metadataPath
    || !resolvedPaths.managersDir
  ) {
    const reason = 'LOCALAPPDATA is not available; skipped stdio manager sync.';
    options.logger?.warn?.(reason);
    return {
      status: 'skipped',
      reason,
    };
  }

  await cleanupManagerRegistry(resolvedPaths.managersDir, options.logger).catch((error) => {
    options.logger?.warn?.(`Failed to scan manager registry '${resolvedPaths.managersDir}': ${formatErrorMessage(error)}`);
  });

  let bundledContent: string;
  let bundledRuntimeContent: string;
  try {
    bundledContent = await fs.promises.readFile(options.bundledManagerPath, 'utf8');
    bundledRuntimeContent = await fs.promises.readFile(options.bundledRuntimePath, 'utf8');
  } catch (error) {
    const message = formatErrorMessage(error);
    options.logger?.warn?.(`Failed to read bundled stdio manager artifacts: ${message}`);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      runtimePath: resolvedPaths.runtimePath,
      metadataPath: resolvedPaths.metadataPath,
      managersDir: resolvedPaths.managersDir,
      reason: message,
    };
  }

  if (!isBundledStdioManagerContent(bundledContent)) {
    const reason = `Bundled stdio manager sync skipped because '${options.bundledManagerPath}' is not a bundled runtime artifact.`;
    options.logger?.warn?.(reason);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      runtimePath: resolvedPaths.runtimePath,
      metadataPath: resolvedPaths.metadataPath,
      managersDir: resolvedPaths.managersDir,
      reason,
    };
  }

  if (!isBundledStdioManagerRuntimeContent(bundledRuntimeContent)) {
    const reason = `Bundled stdio manager sync skipped because '${options.bundledRuntimePath}' is not a bundled runtime artifact.`;
    options.logger?.warn?.(reason);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      runtimePath: resolvedPaths.runtimePath,
      metadataPath: resolvedPaths.metadataPath,
      managersDir: resolvedPaths.managersDir,
      reason,
    };
  }

  const releasePublishLock = await acquirePublishLock(options.logger);
  if (!releasePublishLock) {
    const reason = `Timed out waiting for publish lock '${PUBLISH_LOCK_PIPE_NAME}'.`;
    options.logger?.warn?.(reason);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      runtimePath: resolvedPaths.runtimePath,
      metadataPath: resolvedPaths.metadataPath,
      managersDir: resolvedPaths.managersDir,
      reason,
    };
  }

  try {
    await cleanupManagerRegistry(resolvedPaths.managersDir, options.logger).catch((error) => {
      options.logger?.warn?.(`Failed to rescan manager registry '${resolvedPaths.managersDir}': ${formatErrorMessage(error)}`);
    });

    const sha256 = computeSha256(bundledContent);
    const runtimeSha256 = computeSha256(bundledRuntimeContent);
    const targetContent = await readOptionalFile(resolvedPaths.targetPath);
    const runtimeContent = await readOptionalFile(resolvedPaths.runtimePath);
    const targetSha256 = targetContent === undefined ? undefined : computeSha256(targetContent);
    const runtimeTargetSha256 = runtimeContent === undefined ? undefined : computeSha256(runtimeContent);
    const existingMetadataState = await readSyncMetadataState(resolvedPaths.metadataPath);
    const existingMetadata = existingMetadataState.metadata;
    const targetMatches = targetSha256 === sha256;
    const runtimeMatches = runtimeTargetSha256 === runtimeSha256;
    const syncedArtifactsExist = targetContent !== undefined || runtimeContent !== undefined;
    const metadataCurrent = isSyncMetadataCurrent(existingMetadata, {
      managerSha256: sha256,
      runtimeSha256,
    });

    if (targetMatches && runtimeMatches && metadataCurrent) {
      return {
        status: 'unchanged',
        targetDir: resolvedPaths.targetDir,
        targetPath: resolvedPaths.targetPath,
        runtimePath: resolvedPaths.runtimePath,
        metadataPath: resolvedPaths.metadataPath,
        managersDir: resolvedPaths.managersDir,
        sha256,
        runtimeSha256,
        generation: existingMetadata?.generation,
        notifiedManagers: 0,
      };
    }

    const nextGeneration = existingMetadata?.generation !== undefined
      ? existingMetadata.generation + 1
      : syncedArtifactsExist && existingMetadataState.state !== 'legacy'
        ? Date.now()
        : 1;
    await fs.promises.mkdir(resolvedPaths.targetDir, { recursive: true });
    if (!targetMatches) {
      await writeFileAtomically(resolvedPaths.targetPath, bundledContent);
    }
    if (!runtimeMatches) {
      await writeFileAtomically(resolvedPaths.runtimePath, bundledRuntimeContent);
    }
    const metadata = createSyncMetadata({
      extensionVersion: options.extensionVersion,
      generation: nextGeneration,
      managerSha256: sha256,
      runtimeSha256,
    });
    await writeFileAtomically(
      resolvedPaths.metadataPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
    );

    const notifiedManagers = await notifyManagers(
      resolvedPaths.managersDir,
      nextGeneration,
      options.logger,
    );
    options.logger?.info?.(
      `Synced stdio manager to '${resolvedPaths.targetPath}' (generation ${String(nextGeneration)}).`,
    );
    return {
      status: 'synced',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      runtimePath: resolvedPaths.runtimePath,
      metadataPath: resolvedPaths.metadataPath,
      managersDir: resolvedPaths.managersDir,
      sha256,
      runtimeSha256,
      generation: nextGeneration,
      notifiedManagers,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    options.logger?.warn?.(`Failed to sync stdio manager to '${resolvedPaths.targetDir}': ${message}`);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      runtimePath: resolvedPaths.runtimePath,
      metadataPath: resolvedPaths.metadataPath,
      managersDir: resolvedPaths.managersDir,
      reason: message,
    };
  } finally {
    await releasePublishLock();
  }
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isBundledStdioManagerContent(content: string): boolean {
  return content.startsWith(BUNDLED_STDIO_MANAGER_BANNER);
}

export function isBundledStdioManagerRuntimeContent(content: string): boolean {
  return content.startsWith(BUNDLED_STDIO_MANAGER_RUNTIME_BANNER);
}

function createSyncMetadata(args: {
  extensionVersion: string;
  generation: number;
  managerSha256: string;
  runtimeSha256: string;
}): StdioManagerSyncMetadata {
  return {
    generation: args.generation,
    extensionVersion: args.extensionVersion,
    managerFileName: STDIO_MANAGER_SYNC_FILENAME,
    runtimeFileName: STDIO_MANAGER_RUNTIME_SYNC_FILENAME,
    managerSha256: args.managerSha256,
    runtimeSha256: args.runtimeSha256,
    syncedAt: new Date().toISOString(),
  };
}

function isSyncMetadataCurrent(
  metadata: StdioManagerSyncMetadata | undefined,
  expected: {
    managerSha256: string;
    runtimeSha256: string;
  },
): boolean {
  return metadata?.generation !== undefined
    && Number.isInteger(metadata.generation)
    && metadata.generation > 0
    && metadata.managerFileName === STDIO_MANAGER_SYNC_FILENAME
    && metadata.runtimeFileName === STDIO_MANAGER_RUNTIME_SYNC_FILENAME
    && metadata.managerSha256 === expected.managerSha256
    && metadata.runtimeSha256 === expected.runtimeSha256
    && typeof metadata.syncedAt === 'string'
    && metadata.syncedAt.trim().length > 0;
}

async function readSyncMetadataState(metadataPath: string): Promise<SyncMetadataReadState> {
  try {
    const text = await fs.promises.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return isSyncMetadata(parsed)
      ? { state: 'valid', metadata: parsed }
      : isLegacySyncMetadata(parsed)
        ? { state: 'legacy' }
        : { state: 'invalid' };
  } catch (error) {
    return isMissingFileError(error)
      ? { state: 'missing' }
      : { state: 'invalid' };
  }
}

function isLegacySyncMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const metadata = value as {
    extensionVersion?: unknown;
    managerFileName?: unknown;
    syncedAt?: unknown;
    generation?: unknown;
    runtimeFileName?: unknown;
    managerSha256?: unknown;
    runtimeSha256?: unknown;
  };
  return typeof metadata.extensionVersion === 'string'
    && metadata.managerFileName === STDIO_MANAGER_SYNC_FILENAME
    && typeof metadata.syncedAt === 'string'
    && metadata.syncedAt.trim().length > 0
    && metadata.generation === undefined
    && metadata.runtimeFileName === undefined
    && metadata.managerSha256 === undefined
    && metadata.runtimeSha256 === undefined;
}

function isSyncMetadata(value: unknown): value is StdioManagerSyncMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Partial<StdioManagerSyncMetadata>;
  return typeof metadata.generation === 'number'
    && Number.isInteger(metadata.generation)
    && metadata.generation > 0
    && typeof metadata.extensionVersion === 'string'
    && typeof metadata.managerFileName === 'string'
    && typeof metadata.runtimeFileName === 'string'
    && typeof metadata.managerSha256 === 'string'
    && metadata.managerSha256.trim().length > 0
    && typeof metadata.runtimeSha256 === 'string'
    && metadata.runtimeSha256.trim().length > 0
    && typeof metadata.syncedAt === 'string'
    && metadata.syncedAt.trim().length > 0;
}

function isManagerRegistryEntry(value: unknown): value is StdioManagerRegistryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<StdioManagerRegistryEntry>;
  return entry.protocolVersion === CONTROL_PROTOCOL_VERSION
    && typeof entry.sessionId === 'string'
    && entry.sessionId.trim().length > 0
    && typeof entry.pid === 'number'
    && Number.isInteger(entry.pid)
    && typeof entry.startedAt === 'number'
    && Number.isFinite(entry.startedAt)
    && typeof entry.controlPipePath === 'string'
    && entry.controlPipePath.trim().length > 0;
}

function isControlResponse(value: unknown): value is StdioManagerControlResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const response = value as Partial<StdioManagerControlResponse>;
  return response.ok === true
    && response.protocolVersion === CONTROL_PROTOCOL_VERSION
    && typeof response.generationApplied === 'number'
    && Number.isInteger(response.generationApplied)
    && typeof response.bindingInvalidated === 'boolean';
}

async function cleanupManagerRegistry(
  managersDir: string,
  logger?: StdioManagerSyncLogger,
): Promise<StdioManagerRegistryEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(managersDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const liveEntries: StdioManagerRegistryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) {
      continue;
    }
    const entryPath = path.join(managersDir, entry.name);
    const registry = await readRegistryEntry(entryPath);
    if (!registry) {
      await fs.promises.rm(entryPath, { force: true }).catch(() => undefined);
      continue;
    }
    const reachable = await isControlPipeReachable(registry.controlPipePath);
    if (!reachable) {
      await fs.promises.rm(entryPath, { force: true }).catch(() => undefined);
      continue;
    }
    liveEntries.push(registry);
  }
  if (liveEntries.length > 0) {
    logger?.info?.(`Found ${String(liveEntries.length)} live stdio manager instance(s) under '${managersDir}'.`);
  }
  return liveEntries;
}

async function notifyManagers(
  managersDir: string,
  generation: number,
  logger?: StdioManagerSyncLogger,
): Promise<number> {
  const liveEntries = await cleanupManagerRegistry(managersDir, logger);
  let notifiedManagers = 0;
  for (const entry of liveEntries) {
    const response = await sendGenerationChanged(entry.controlPipePath, generation);
    if (!response) {
      logger?.warn?.(
        `stdio manager '${entry.sessionId}' did not acknowledge generation ${String(generation)} before timeout; keeping registry entry for a later retry.`,
      );
      continue;
    }
    if (response.generationApplied !== generation) {
      logger?.warn?.(
        `stdio manager '${entry.sessionId}' acknowledged generation ${String(generation)} but stayed on ${String(response.generationApplied)}; keeping registry entry for a later retry.`,
      );
      continue;
    }
    notifiedManagers += 1;
  }
  return notifiedManagers;
}

async function readRegistryEntry(filePath: string): Promise<StdioManagerRegistryEntry | undefined> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return isManagerRegistryEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function isControlPipeReachable(controlPipePath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(controlPipePath);
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish(false);
    }, CONTROL_PIPE_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timeout);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      finish(false);
    });
  });
}

async function sendGenerationChanged(
  controlPipePath: string,
  generation: number,
): Promise<StdioManagerControlResponse | undefined> {
  return await new Promise((resolve) => {
    const socket = net.createConnection(controlPipePath);
    let settled = false;
    let buffer = '';

    const finish = (result?: StdioManagerControlResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(undefined);
    }, CONTROL_PIPE_RESPONSE_TIMEOUT_MS);

    socket.once('connect', () => {
      const request: StdioManagerControlRequest = {
        op: 'generationChanged',
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        generation,
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_CONTROL_MESSAGE_BYTES) {
        finish(undefined);
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
        finish(isControlResponse(parsed) ? parsed : undefined);
      } catch {
        finish(undefined);
      }
    });

    socket.once('error', () => {
      finish(undefined);
    });

    socket.once('close', () => {
      finish(undefined);
    });
  });
}

async function acquirePublishLock(
  logger?: StdioManagerSyncLogger,
): Promise<(() => Promise<void>) | undefined> {
  const deadline = Date.now() + PUBLISH_LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const release = await tryAcquirePipeLock(PUBLISH_LOCK_PIPE_NAME);
    if (release) {
      return release;
    }
    await delay(PUBLISH_LOCK_RETRY_INTERVAL_MS);
  }
  logger?.warn?.(`Timed out waiting for stdio manager publish lock '${PUBLISH_LOCK_PIPE_NAME}'.`);
  return undefined;
}

export async function tryAcquirePipeLock(
  pipeName: string,
  platform: NodeJS.Platform = process.platform,
): Promise<(() => Promise<void>) | undefined> {
  const socketPath = buildPipeSocketPath(pipeName, platform);
  let attemptedStaleRecovery = false;
  while (true) {
    const server = net.createServer((socket) => {
      socket.destroy();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          resolve();
        });
      });
      return async () => {
        await closeServer(server, socketPath, platform);
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      await closeServer(server, socketPath, platform, { removeSocket: false });
      if (
        nodeError.code === 'EADDRINUSE'
        && platform !== 'win32'
        && !attemptedStaleRecovery
        && await recoverStaleUnixSocket(socketPath)
      ) {
        attemptedStaleRecovery = true;
        continue;
      }
      if (nodeError.code === 'EADDRINUSE') {
        return undefined;
      }
      throw error;
    }
  }
}

function buildPipeSocketPath(pipeName: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${pipeName}`;
  }
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

async function closeServer(
  server: net.Server | undefined,
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
  options?: { removeSocket?: boolean },
): Promise<void> {
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
  if (options?.removeSocket !== false) {
    await removeUnixSocketIfNeeded(socketPath, platform).catch(() => undefined);
  }
}

async function removeUnixSocketIfNeeded(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
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

async function recoverStaleUnixSocket(socketPath: string): Promise<boolean> {
  const isStale = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => {
      finish(false);
    });
    socket.once('error', (error) => {
      const nodeError = error as NodeJS.ErrnoException;
      finish(nodeError.code === 'ECONNREFUSED' || nodeError.code === 'ENOENT');
    });
  });
  if (!isStale) {
    return false;
  }
  await removeUnixSocketIfNeeded(socketPath, 'linux');
  return true;
}

async function writeFileAtomically(targetPath: string, content: string): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rm(targetPath, { force: true });
    await fs.promises.rename(tempPath, targetPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
