export interface ResolvedWorkspaceScopePattern {
  targets: ResolvedWorkspaceScopeTarget[];
  scopeLabel: string | null;
}

export interface ResolvedWorkspaceScopeTarget {
  workspaceName: string;
  pattern: string;
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
    targets: [{
      workspaceName,
      pattern: remainder.length > 0 ? remainder : '**/*',
    }],
    scopeLabel: workspaceName,
  };
}

function tryResolveBraceWorkspaceScopePattern(
  inputPath: string,
  workspaceNames: readonly string[],
): ResolvedWorkspaceScopePattern | undefined {
  return tryResolveBraceWorkspaceSelectorPattern(inputPath, workspaceNames)
    ?? tryResolveBraceWorkspaceAlternationPattern(inputPath, workspaceNames);
}

function tryResolveBraceWorkspaceSelectorPattern(
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
    targets: resolvedWorkspaceNames.map((workspaceName) => ({
      workspaceName,
      pattern: remainder.length > 0 ? remainder : '**/*',
    })),
    scopeLabel: `{${resolvedWorkspaceNames.join(',')}}`,
  };
}

function tryResolveBraceWorkspaceAlternationPattern(
  inputPath: string,
  workspaceNames: readonly string[],
): ResolvedWorkspaceScopePattern | undefined {
  const branches = tryParseTopLevelBraceAlternationBranches(inputPath);
  if (!branches || branches.length < 2) {
    return undefined;
  }

  const resolvedBranches = branches.map((branch) => ({
    branch,
    resolved: tryResolveSingleWorkspaceScopePattern(branch, workspaceNames),
  }));
  const hasScopedBranch = resolvedBranches.some((entry) => entry.resolved?.targets.length === 1);
  if (!hasScopedBranch) {
    return undefined;
  }

  const targetPatternsByWorkspaceKey = new Map<string, { workspaceName: string; patterns: string[]; seen: Set<string> }>();
  const orderedWorkspaceNames: string[] = [];
  let hasUnscopedBranch = false;

  for (const entry of resolvedBranches) {
    const resolvedBranch = entry.resolved;
    if (resolvedBranch && resolvedBranch.targets.length === 1) {
      const [{ workspaceName, pattern }] = resolvedBranch.targets;
      appendWorkspacePattern(
        targetPatternsByWorkspaceKey,
        orderedWorkspaceNames,
        workspaceName,
        pattern,
      );
      continue;
    }

    hasUnscopedBranch = true;
    for (const workspaceName of workspaceNames) {
      appendWorkspacePattern(
        targetPatternsByWorkspaceKey,
        orderedWorkspaceNames,
        workspaceName,
        entry.branch,
      );
    }
  }

  if (orderedWorkspaceNames.length === 0) {
    return undefined;
  }

  const targets = orderedWorkspaceNames.map((workspaceName) => {
    const workspaceKey = getWorkspaceNameKey(workspaceName);
    const target = targetPatternsByWorkspaceKey.get(workspaceKey);
    if (!target) {
      throw new Error(`Failed to resolve scoped workspace target for '${workspaceName}'.`);
    }
    return {
      workspaceName: target.workspaceName,
      pattern: target.patterns.length === 1 ? target.patterns[0] : `{${target.patterns.join(',')}}`,
    };
  });

  return {
    targets,
    scopeLabel: hasUnscopedBranch
      ? null
      : orderedWorkspaceNames.length === 1
      ? orderedWorkspaceNames[0]
      : `{${orderedWorkspaceNames.join(',')}}`,
  };
}

function appendWorkspacePattern(
  targetPatternsByWorkspaceKey: Map<string, { workspaceName: string; patterns: string[]; seen: Set<string> }>,
  orderedWorkspaceNames: string[],
  workspaceName: string,
  pattern: string,
): void {
  const workspaceKey = getWorkspaceNameKey(workspaceName);
  const normalizedPatternKey = getPatternKey(pattern);
  const existingTarget = targetPatternsByWorkspaceKey.get(workspaceKey);
  if (existingTarget) {
    if (existingTarget.seen.has(normalizedPatternKey)) {
      return;
    }
    existingTarget.seen.add(normalizedPatternKey);
    existingTarget.patterns.push(pattern);
    return;
  }

  targetPatternsByWorkspaceKey.set(workspaceKey, {
    workspaceName,
    patterns: [pattern],
    seen: new Set([normalizedPatternKey]),
  });
  orderedWorkspaceNames.push(workspaceName);
}

function tryParseTopLevelBraceAlternationBranches(inputPath: string): string[] | undefined {
  if (!inputPath.startsWith('{')) {
    return undefined;
  }

  const branches: string[] = [];
  let braceDepth = 0;
  let branchStartIndex = 1;
  let inCharacterClass = false;

  for (let index = 0; index < inputPath.length; index += 1) {
    const char = inputPath[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inCharacterClass) {
      if (char === ']') {
        inCharacterClass = false;
      }
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) {
        if (index !== inputPath.length - 1) {
          return undefined;
        }
        const branch = inputPath.slice(branchStartIndex, index).trim();
        if (branch.length === 0) {
          return undefined;
        }
        branches.push(branch);
        return branches;
      }
      if (braceDepth < 0) {
        return undefined;
      }
      continue;
    }
    if (char === ',' && braceDepth === 1) {
      const branch = inputPath.slice(branchStartIndex, index).trim();
      if (branch.length === 0) {
        return undefined;
      }
      branches.push(branch);
      branchStartIndex = index + 1;
    }
  }

  return undefined;
}

function findWorkspaceName(name: string, workspaceNames: readonly string[]): string | undefined {
  const expected = getWorkspaceNameKey(name);
  return workspaceNames.find((workspaceName) => getWorkspaceNameKey(workspaceName) === expected);
}

function getWorkspaceNameKey(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function getPatternKey(pattern: string): string {
  const normalized = pattern.trim().replace(/\\/gu, '/').replace(/\/{2,}/gu, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
