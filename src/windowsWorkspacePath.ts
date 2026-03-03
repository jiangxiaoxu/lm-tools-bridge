import * as path from 'node:path';

const WINDOWS_NT_NAMESPACE_PREFIX = '\\\\?\\';
const WINDOWS_NT_UNC_PREFIX = 'UNC\\';

function isWindowsPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export function isWindowsDriveAbsolutePath(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value);
}

export function isWindowsUncPath(value: string): boolean {
  return /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/iu.test(value);
}

export function parseWindowsNtPrefixedNormalPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isWindowsPlatform(platform)) {
    return undefined;
  }
  const lowerValue = value.toLowerCase();
  if (!lowerValue.startsWith(WINDOWS_NT_NAMESPACE_PREFIX.toLowerCase())) {
    return undefined;
  }
  const tail = value.slice(WINDOWS_NT_NAMESPACE_PREFIX.length);
  if (isWindowsDriveAbsolutePath(tail)) {
    return tail;
  }
  if (/^unc\\[^\\/]+[\\/][^\\/]+(?:[\\/].*)?$/iu.test(tail)) {
    return `\\\\${tail.slice(WINDOWS_NT_UNC_PREFIX.length)}`;
  }
  return undefined;
}

export function stripWindowsNtNamespacePrefix(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return parseWindowsNtPrefixedNormalPath(value, platform) ?? value;
}

export function isSupportedWindowsWorkspacePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isWindowsPlatform(platform)) {
    return true;
  }
  const trimmed = value.trim();
  return isWindowsDriveAbsolutePath(trimmed)
    || isWindowsUncPath(trimmed)
    || parseWindowsNtPrefixedNormalPath(trimmed, platform) !== undefined;
}

export function resolveComparablePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.resolve(stripWindowsNtNamespacePrefix(value, platform));
}
