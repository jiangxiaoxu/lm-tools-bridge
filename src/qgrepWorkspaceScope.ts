export interface ResolvedWorkspaceScopePattern {
  workspaceNames: string[];
  pattern: string;
  scopeLabel: string;
}

export function tryResolveWorkspaceScopePattern(
  inputPath: string,
  workspaceNames: readonly string[],
): ResolvedWorkspaceScopePattern | undefined {
  const trimmed = inputPath.trim().replace(/^[\\/]+/u, '');
  if (trimmed.length === 0) {
    return undefined;
  }

  if (trimmed.startsWith('{')) {
    return tryResolveBraceWorkspaceScopePattern(trimmed, workspaceNames);
  }

  return tryResolveSingleWorkspaceScopePattern(trimmed, workspaceNames);
}

function tryResolveSingleWorkspaceScopePattern(
  inputPath: string,
  workspaceNames: readonly string[],
): ResolvedWorkspaceScopePattern | undefined {
  const separatorIndex = findFirstPathSeparatorIndex(inputPath);
  const workspaceSegment = separatorIndex >= 0 ? inputPath.slice(0, separatorIndex) : inputPath;
  const workspaceName = findWorkspaceName(workspaceSegment, workspaceNames);
  if (!workspaceName) {
    return undefined;
  }

  const remainder = separatorIndex >= 0
    ? inputPath.slice(separatorIndex + 1).replace(/^[\\/]+/u, '')
    : '';
  return {
    workspaceNames: [workspaceName],
    pattern: remainder.length > 0 ? remainder : '**/*',
    scopeLabel: workspaceName,
  };
}

function tryResolveBraceWorkspaceScopePattern(
  inputPath: string,
  workspaceNames: readonly string[],
): ResolvedWorkspaceScopePattern | undefined {
  const separatorIndex = findFirstPathSeparatorIndex(inputPath);
  const closingBraceIndex = inputPath.indexOf('}');
  if (closingBraceIndex <= 1) {
    return undefined;
  }
  if (separatorIndex >= 0 && separatorIndex < closingBraceIndex) {
    return undefined;
  }
  if (closingBraceIndex < inputPath.length - 1) {
    const nextChar = inputPath[closingBraceIndex + 1];
    if (nextChar !== '/' && nextChar !== '\\') {
      return undefined;
    }
  }

  const selectorBody = inputPath.slice(1, closingBraceIndex);
  const selectorEntries = selectorBody.split(',').map((entry) => entry.trim());
  if (selectorEntries.length === 0 || selectorEntries.some((entry) => entry.length === 0)) {
    return undefined;
  }

  const resolvedWorkspaceNames: string[] = [];
  const seenWorkspaceKeys = new Set<string>();
  for (const selectorEntry of selectorEntries) {
    const workspaceName = findWorkspaceName(selectorEntry, workspaceNames);
    if (!workspaceName) {
      return undefined;
    }
    const workspaceKey = getWorkspaceNameKey(workspaceName);
    if (seenWorkspaceKeys.has(workspaceKey)) {
      continue;
    }
    seenWorkspaceKeys.add(workspaceKey);
    resolvedWorkspaceNames.push(workspaceName);
  }

  if (resolvedWorkspaceNames.length === 0) {
    return undefined;
  }

  const remainder = closingBraceIndex < inputPath.length - 1
    ? inputPath.slice(closingBraceIndex + 1).replace(/^[\\/]+/u, '')
    : '';
  return {
    workspaceNames: resolvedWorkspaceNames,
    pattern: remainder.length > 0 ? remainder : '**/*',
    scopeLabel: `{${resolvedWorkspaceNames.join(',')}}`,
  };
}

function findWorkspaceName(name: string, workspaceNames: readonly string[]): string | undefined {
  const expected = getWorkspaceNameKey(name);
  return workspaceNames.find((workspaceName) => getWorkspaceNameKey(workspaceName) === expected);
}

function getWorkspaceNameKey(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function findFirstPathSeparatorIndex(value: string): number {
  const forwardSlashIndex = value.indexOf('/');
  const backwardSlashIndex = value.indexOf('\\');
  if (forwardSlashIndex < 0) {
    return backwardSlashIndex;
  }
  if (backwardSlashIndex < 0) {
    return forwardSlashIndex;
  }
  return Math.min(forwardSlashIndex, backwardSlashIndex);
}
