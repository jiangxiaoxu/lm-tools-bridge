import {
  compileFilesQueryGlobToRegexSource,
  normalizeFilesQueryGlobErrorMessage,
} from './qgrepGlob';

export type QgrepFilesQuerySemantics = 'glob-vscode' | 'regex';

export interface FilesQueryDraft {
  targets: FilesQueryDraftTarget[];
  scope: string | null;
  semantics: QgrepFilesQuerySemantics;
}

export type FilesQueryDraftTarget =
  | {
    workspaceName: string;
    kind: 'regex';
    queryRegex: string;
  }
  | {
    workspaceName: string;
    kind: 'glob-absolute' | 'glob-relative';
    pattern: string;
  };

export function buildFilesQueryDraft(
  query: string,
  isRegexp: boolean,
  workspaceNames: readonly string[],
): FilesQueryDraft {
  if (isRegexp) {
    return buildRegexFilesQueryDraft(query, workspaceNames);
  }
  return buildGlobFilesQueryDraft(query, workspaceNames);
}

export function ensureFilesLegacyParamsUnsupported(input: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(input, 'mode') && input.mode !== undefined) {
    throw new Error(
      'mode is no longer supported for lm_qgrepSearchFiles. Use query with optional isRegexp instead.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(input, 'searchPath') && input.searchPath !== undefined) {
    throw new Error(
      'searchPath is no longer supported for lm_qgrepSearchFiles. Use query with WorkspaceName/... scoping.',
    );
  }
}

function buildRegexFilesQueryDraft(
  query: string,
  workspaceNames: readonly string[],
): FilesQueryDraft {
  const scoped = tryResolveWorkspacePrefixedRegexQuery(query, workspaceNames);
  if (scoped) {
    return {
      targets: [{
        workspaceName: scoped.workspaceName,
        kind: 'regex',
        queryRegex: scoped.regexQuery,
      }],
      scope: scoped.workspaceName,
      semantics: 'regex',
    };
  }
  return {
    targets: workspaceNames.map((workspaceName) => ({
      workspaceName,
      kind: 'regex' as const,
      queryRegex: query,
    })),
    scope: null,
    semantics: 'regex',
  };
}

function buildGlobFilesQueryDraft(
  query: string,
  workspaceNames: readonly string[],
): FilesQueryDraft {
  const trimmed = query.trim();
  const scoped = tryResolveWorkspacePrefixedGlobPattern(trimmed, workspaceNames);
  if (scoped) {
    validateFilesGlobPattern(scoped.pattern);
    return {
      targets: [{
        workspaceName: scoped.workspaceName,
        kind: 'glob-relative',
        pattern: scoped.pattern,
      }],
      scope: scoped.workspaceName,
      semantics: 'glob-vscode',
    };
  }

  validateFilesGlobPattern(trimmed);
  const kind = isAbsolutePath(trimmed) ? 'glob-absolute' : 'glob-relative';
  return {
    targets: workspaceNames.map((workspaceName) => ({
      workspaceName,
      kind,
      pattern: trimmed,
    })),
    scope: null,
    semantics: 'glob-vscode',
  };
}

function validateFilesGlobPattern(query: string): void {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error('query must be a non-empty glob string when isRegexp is false.');
  }
  try {
    compileFilesQueryGlobToRegexSource(trimmed);
  } catch (error) {
    throw new Error(normalizeFilesQueryGlobErrorMessage(error));
  }
}

function tryResolveWorkspacePrefixedRegexQuery(
  inputQuery: string,
  workspaceNames: readonly string[],
): {
  workspaceName: string;
  regexQuery: string;
} | undefined {
  const trimmed = inputQuery.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const normalizedInput = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  for (const workspaceName of workspaceNames) {
    const expectedName = process.platform === 'win32' ? workspaceName.toLowerCase() : workspaceName;
    if (!normalizedInput.startsWith(`${expectedName}/`) && !normalizedInput.startsWith(`${expectedName}\\`)) {
      continue;
    }
    const remainder = trimmed.slice(workspaceName.length + 1).replace(/^[\\/]+/u, '');
    if (remainder.length === 0) {
      throw new Error(`query regex is empty after workspace prefix '${workspaceName}/'.`);
    }
    return {
      workspaceName,
      regexQuery: remainder,
    };
  }
  return undefined;
}

function tryResolveWorkspacePrefixedGlobPattern(
  inputPath: string,
  workspaceNames: readonly string[],
): {
  workspaceName: string;
  pattern: string;
} | undefined {
  const trimmed = inputPath.trim().replace(/^[\\/]+/u, '');
  if (trimmed.length === 0) {
    return undefined;
  }
  const normalizedInput = process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  for (const workspaceName of workspaceNames) {
    const expectedName = process.platform === 'win32' ? workspaceName.toLowerCase() : workspaceName;
    if (normalizedInput === expectedName) {
      return {
        workspaceName,
        pattern: '**/*',
      };
    }
    if (normalizedInput.startsWith(`${expectedName}/`) || normalizedInput.startsWith(`${expectedName}\\`)) {
      const remainder = trimmed.slice(workspaceName.length + 1).replace(/^[\\/]+/u, '');
      return {
        workspaceName,
        pattern: remainder.length > 0 ? remainder : '**/*',
      };
    }
  }
  return undefined;
}

function isAbsolutePath(inputPath: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(inputPath) || inputPath.startsWith('\\\\') || inputPath.startsWith('/');
}
