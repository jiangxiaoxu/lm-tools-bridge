import * as fs from 'node:fs';
import * as path from 'node:path';
import { STDIO_MANAGER_SYNC_DIRNAME } from './stdioManagerSync';

const LEGACY_INSTANCES_DIRNAME = 'instances';

export interface LegacyManagerCleanupLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface CleanupLegacyManagerInstancesDirOptions {
  env?: NodeJS.ProcessEnv;
  logger?: LegacyManagerCleanupLogger;
}

export interface CleanupLegacyManagerInstancesDirResult {
  status: 'removed' | 'skipped' | 'missing';
  targetDir?: string;
  reason?: string;
}

export function resolveLegacyManagerInstancesDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return undefined;
  }
  return path.join(localAppData, STDIO_MANAGER_SYNC_DIRNAME, LEGACY_INSTANCES_DIRNAME);
}

export async function cleanupLegacyManagerInstancesDir(
  options: CleanupLegacyManagerInstancesDirOptions = {},
): Promise<CleanupLegacyManagerInstancesDirResult> {
  const targetDir = resolveLegacyManagerInstancesDir(options.env);
  if (!targetDir) {
    return {
      status: 'skipped',
      reason: 'LOCALAPPDATA is not available.',
    };
  }

  try {
    const stat = await fs.promises.stat(targetDir);
    if (!stat.isDirectory()) {
      return {
        status: 'missing',
        targetDir,
        reason: 'Legacy instances path is not a directory.',
      };
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: 'missing',
        targetDir,
      };
    }
    const message = formatErrorMessage(error);
    options.logger?.warn?.(`Failed to inspect legacy manager instances directory '${targetDir}': ${message}`);
    return {
      status: 'skipped',
      targetDir,
      reason: message,
    };
  }

  try {
    await fs.promises.rm(targetDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    options.logger?.warn?.(`Failed to remove legacy manager instances directory '${targetDir}': ${message}`);
    return {
      status: 'skipped',
      targetDir,
      reason: message,
    };
  }

  options.logger?.info?.(`Removed legacy manager instances directory '${targetDir}'.`);
  return {
    status: 'removed',
    targetDir,
  };
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
