import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const STDIO_MANAGER_SYNC_DIRNAME = 'lm-tools-bridge';
export const STDIO_MANAGER_SYNC_FILENAME = 'stdioManager.js';
export const STDIO_MANAGER_SYNC_METADATA_FILENAME = 'metadata.json';
export const BUNDLED_STDIO_MANAGER_BANNER = '/* lm-tools-bridge bundled stdioManager */';

export interface StdioManagerSyncMetadata {
  extensionVersion: string;
  managerFileName: string;
  syncedAt: string;
}

export interface StdioManagerSyncLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SyncBundledStdioManagerOptions {
  bundledManagerPath: string;
  extensionVersion: string;
  env?: NodeJS.ProcessEnv;
  logger?: StdioManagerSyncLogger;
}

export interface SyncBundledStdioManagerResult {
  status: 'synced' | 'unchanged' | 'skipped';
  targetDir?: string;
  targetPath?: string;
  metadataPath?: string;
  sha256?: string;
  reason?: string;
}

export function resolveStdioManagerSyncPaths(env: NodeJS.ProcessEnv = process.env): {
  targetDir?: string;
  targetPath?: string;
  metadataPath?: string;
} {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return {};
  }
  const targetDir = path.join(localAppData, STDIO_MANAGER_SYNC_DIRNAME);
  return {
    targetDir,
    targetPath: path.join(targetDir, STDIO_MANAGER_SYNC_FILENAME),
    metadataPath: path.join(targetDir, STDIO_MANAGER_SYNC_METADATA_FILENAME),
  };
}

export async function syncBundledStdioManager(options: SyncBundledStdioManagerOptions): Promise<SyncBundledStdioManagerResult> {
  const resolvedPaths = resolveStdioManagerSyncPaths(options.env);
  if (!resolvedPaths.targetDir || !resolvedPaths.targetPath || !resolvedPaths.metadataPath) {
    const reason = 'LOCALAPPDATA is not available; skipped stdio manager sync.';
    options.logger?.warn?.(reason);
    return {
      status: 'skipped',
      reason,
    };
  }

  let bundledContent: string;
  try {
    bundledContent = await fs.promises.readFile(options.bundledManagerPath, 'utf8');
  } catch (error) {
    const message = formatErrorMessage(error);
    options.logger?.warn?.(`Failed to read bundled stdio manager from '${options.bundledManagerPath}': ${message}`);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      metadataPath: resolvedPaths.metadataPath,
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
      metadataPath: resolvedPaths.metadataPath,
      reason,
    };
  }

  const sha256 = computeSha256(bundledContent);
  const targetContent = await readOptionalFile(resolvedPaths.targetPath);
  const targetSha256 = targetContent === undefined ? undefined : computeSha256(targetContent);
  const existingMetadata = await readSyncMetadata(resolvedPaths.metadataPath);
  const targetExists = targetContent !== undefined;
  const targetMatches = targetExists && targetSha256 === sha256;
  const metadataCurrent = isSyncMetadataCurrent(existingMetadata, options.extensionVersion);

  if (targetMatches && metadataCurrent) {
    return {
      status: 'unchanged',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      metadataPath: resolvedPaths.metadataPath,
      sha256,
    };
  }

  try {
    await fs.promises.mkdir(resolvedPaths.targetDir, { recursive: true });
    if (!targetMatches) {
      await writeFileAtomically(resolvedPaths.targetPath, bundledContent);
    }
    const metadata = createSyncMetadata({
      extensionVersion: options.extensionVersion,
    });
    if (!metadataCurrent || !targetMatches) {
      await writeFileAtomically(
        resolvedPaths.metadataPath,
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    options.logger?.warn?.(`Failed to sync stdio manager to '${resolvedPaths.targetDir}': ${message}`);
    return {
      status: 'skipped',
      targetDir: resolvedPaths.targetDir,
      targetPath: resolvedPaths.targetPath,
      metadataPath: resolvedPaths.metadataPath,
      reason: message,
    };
  }

  options.logger?.info?.(`Synced stdio manager to '${resolvedPaths.targetPath}'.`);
  return {
    status: 'synced',
    targetDir: resolvedPaths.targetDir,
    targetPath: resolvedPaths.targetPath,
    metadataPath: resolvedPaths.metadataPath,
    sha256,
  };
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function isBundledStdioManagerContent(content: string): boolean {
  return content.startsWith(BUNDLED_STDIO_MANAGER_BANNER);
}

function createSyncMetadata(args: {
  extensionVersion: string;
}): StdioManagerSyncMetadata {
  return {
    extensionVersion: args.extensionVersion,
    managerFileName: STDIO_MANAGER_SYNC_FILENAME,
    syncedAt: new Date().toISOString(),
  };
}

function isSyncMetadataCurrent(
  metadata: StdioManagerSyncMetadata | undefined,
  extensionVersion: string,
): boolean {
  return metadata?.extensionVersion === extensionVersion
    && metadata.managerFileName === STDIO_MANAGER_SYNC_FILENAME
    && typeof metadata.syncedAt === 'string'
    && metadata.syncedAt.trim().length > 0;
}

async function readSyncMetadata(metadataPath: string): Promise<StdioManagerSyncMetadata | undefined> {
  try {
    const text = await fs.promises.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(text) as Partial<StdioManagerSyncMetadata>;
    if (
      typeof parsed.extensionVersion !== 'string'
      || typeof parsed.managerFileName !== 'string'
      || typeof parsed.syncedAt !== 'string'
    ) {
      return undefined;
    }
    return {
      extensionVersion: parsed.extensionVersion,
      managerFileName: parsed.managerFileName,
      syncedAt: parsed.syncedAt,
    };
  } catch {
    return undefined;
  }
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

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
