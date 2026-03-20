import * as path from 'node:path';
import { compileGlobToRegexSource, normalizeWorkspaceSearchGlobPattern } from './qgrepGlob';
import { tryResolveWorkspaceScopePattern } from './qgrepWorkspaceScope';

export interface DiagnosticsWorkspaceFolder {
  name: string;
  rootPath: string;
}

export interface DiagnosticsWorkspaceFile {
  absolutePath: string;
  workspaceName: string;
  relativePath: string;
}

export interface DiagnosticsIncludePatternMatcher {
  matches(file: DiagnosticsWorkspaceFile): boolean;
}

interface PreparedDiagnosticsWorkspaceFolder extends DiagnosticsWorkspaceFolder {
  normalizedRootPath: string;
  comparableRootPath: string;
}

type DiagnosticsPathRegex = {
  regex: RegExp;
};

function normalizeSlash(value: string): string {
  return value.replace(/\\/gu, '/');
}

function normalizeForComparison(value: string): string {
  const normalized = normalizeSlash(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeRootPath(value: string): string {
  const resolved = normalizeSlash(path.resolve(value));
  if (resolved.length <= 1) {
    return resolved;
  }
  return resolved.replace(/\/+$/u, '');
}

function prepareWorkspaceFolders(
  folders: readonly DiagnosticsWorkspaceFolder[],
): PreparedDiagnosticsWorkspaceFolder[] {
  return folders.map((folder) => ({
    ...folder,
    rootPath: normalizeRootPath(folder.rootPath),
    normalizedRootPath: normalizeRootPath(folder.rootPath),
    comparableRootPath: normalizeForComparison(folder.rootPath),
  }));
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const comparableRoot = normalizeForComparison(rootPath);
  const comparableTarget = normalizeForComparison(targetPath);
  const relative = path.relative(comparableRoot, comparableTarget);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAbsolutePath(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || /^[a-zA-Z]:[\\/]/u.test(inputPath) || inputPath.startsWith('\\\\');
}

function compileWorkspacePatternRegex(pattern: string): DiagnosticsPathRegex {
  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(pattern);
  let glob = normalizedPattern.startsWith('/') ? normalizedPattern.slice(1) : normalizedPattern;
  if (glob.length === 0) {
    glob = '**/*';
  }
  return {
    regex: buildRegex(glob),
  };
}

function compileAbsolutePatternRegex(pattern: string): DiagnosticsPathRegex {
  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(pattern);
  if (!isAbsolutePath(normalizedPattern)) {
    throw new Error(`includePattern must be an absolute path or glob: ${pattern}`);
  }
  return {
    regex: buildRegex(normalizedPattern),
  };
}

function buildRegex(glob: string): RegExp {
  const source = compileGlobToRegexSource(glob, 'includePattern glob pattern');
  const flags = process.platform === 'win32' ? 'iu' : 'u';
  return new RegExp(`^${source}$`, flags);
}

function getLiteralAbsolutePrefix(pattern: string): string {
  let prefix = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next === undefined) {
        break;
      }
      prefix += next;
      index += 1;
      continue;
    }
    if (char === '*' || char === '?' || char === '[' || char === '{') {
      break;
    }
    prefix += char;
  }
  return prefix;
}

function getAbsolutePrefixForWorkspaceCheck(pattern: string): string {
  const literalPrefix = getLiteralAbsolutePrefix(pattern);
  if (literalPrefix.length === 0) {
    return normalizeRootPath(pattern);
  }
  const normalizedLiteralPrefix = normalizeSlash(literalPrefix);
  if (normalizedLiteralPrefix.endsWith('/')) {
    return normalizeRootPath(normalizedLiteralPrefix);
  }
  const parsedRoot = path.parse(normalizedLiteralPrefix).root;
  if (parsedRoot === normalizedLiteralPrefix) {
    return normalizeRootPath(normalizedLiteralPrefix);
  }
  return normalizeRootPath(path.dirname(normalizedLiteralPrefix));
}

function arePathsRelated(leftPath: string, rightPath: string): boolean {
  return isPathInsideRoot(leftPath, rightPath) || isPathInsideRoot(rightPath, leftPath);
}

export function resolveDiagnosticsWorkspaceFile(
  absolutePath: string,
  folders: readonly DiagnosticsWorkspaceFolder[],
): DiagnosticsWorkspaceFile | undefined {
  const preparedFolders = prepareWorkspaceFolders(folders);
  const resolvedAbsolutePath = normalizeRootPath(absolutePath);
  const comparableAbsolutePath = normalizeForComparison(absolutePath);

  let bestMatch: PreparedDiagnosticsWorkspaceFolder | undefined;
  for (const folder of preparedFolders) {
    const relative = path.relative(folder.comparableRootPath, comparableAbsolutePath);
    const inside = !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!inside) {
      continue;
    }
    if (!bestMatch || folder.comparableRootPath.length > bestMatch.comparableRootPath.length) {
      bestMatch = folder;
    }
  }

  if (!bestMatch) {
    return undefined;
  }

  return {
    absolutePath: resolvedAbsolutePath,
    workspaceName: bestMatch.name,
    relativePath: normalizeSlash(path.relative(bestMatch.normalizedRootPath, resolvedAbsolutePath)),
  };
}

export function createDiagnosticsIncludePatternMatcher(
  includePattern: string,
  folders: readonly DiagnosticsWorkspaceFolder[],
): DiagnosticsIncludePatternMatcher {
  const preparedFolders = prepareWorkspaceFolders(folders);
  if (preparedFolders.length === 0) {
    throw new Error('No workspace folders are open.');
  }

  const normalizedPattern = normalizeWorkspaceSearchGlobPattern(includePattern);
  if (isAbsolutePath(normalizedPattern)) {
    const checkPrefix = getAbsolutePrefixForWorkspaceCheck(normalizedPattern);
    const matchesWorkspace = preparedFolders.some((folder) => arePathsRelated(folder.normalizedRootPath, checkPrefix));
    if (!matchesWorkspace) {
      throw new Error(`includePattern is outside current workspaces: ${includePattern}`);
    }
    const absolutePattern = compileAbsolutePatternRegex(normalizedPattern);
    return {
      matches(file): boolean {
        return absolutePattern.regex.test(file.absolutePath);
      },
    };
  }

  const workspaceNames = preparedFolders.map((folder) => folder.name);
  const scoped = tryResolveWorkspaceScopePattern(normalizedPattern, workspaceNames);
  if (scoped) {
    const matchersByWorkspace = new Map<string, DiagnosticsPathRegex>();
    for (const target of scoped.targets) {
      matchersByWorkspace.set(
        process.platform === 'win32' ? target.workspaceName.toLowerCase() : target.workspaceName,
        compileWorkspacePatternRegex(target.pattern),
      );
    }
    return {
      matches(file): boolean {
        const workspaceKey = process.platform === 'win32' ? file.workspaceName.toLowerCase() : file.workspaceName;
        const matcher = matchersByWorkspace.get(workspaceKey);
        if (!matcher) {
          return false;
        }
        return matcher.regex.test(file.relativePath);
      },
    };
  }

  const workspacePattern = compileWorkspacePatternRegex(normalizedPattern);
  return {
    matches(file): boolean {
      return workspacePattern.regex.test(file.relativePath);
    },
  };
}
