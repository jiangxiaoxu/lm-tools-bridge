import * as vscode from 'vscode';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { rgPath } from '@vscode/ripgrep';

type RipgrepMatch = {
  path: string;
  line: number;
  preview: string;
};

type RipgrepSearchResult = {
  matches: RipgrepMatch[];
  totalMatches: number;
  capped: boolean;
};

type RipgrepFileSearchResult = {
  files: string[];
  totalMatches: number;
  capped: boolean;
};

export async function executeFindTextInFilesSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const queryValue = input.query;
  if (typeof queryValue !== 'string') {
    throw new Error('query must be a string');
  }
  const isRegexp = input.isRegexp === true;
  const caseSensitive = input.caseSensitive === true;
  const includeIgnoredFiles = input.includeIgnoredFiles === true;
  const maxResults = typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
    ? input.maxResults
    : undefined;

  const combinedMatches: RipgrepMatch[] = [];
  const seen = new Set<string>();
  let totalCount = 0;
  let capped = false;
  let remaining = maxResults ?? Number.POSITIVE_INFINITY;

  const targets = resolveRipgrepTargets(input.includePattern);
  for (const target of targets) {
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const result = await runRipgrepSearch(target, {
      query: queryValue,
      isRegexp,
      caseSensitive,
      includeIgnoredFiles,
      maxResults: maxResults !== undefined ? remaining : undefined,
    });
    capped = capped || result.capped;
    totalCount += result.totalMatches;
    for (const match of result.matches) {
      const key = `${match.path}:${match.line}:${match.preview}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combinedMatches.push(match);
    }
    if (maxResults !== undefined) {
      remaining = Math.max(0, maxResults - totalCount);
    }
  }

  return {
    capped,
    uniqueMatches: combinedMatches.length,
    totalMatches: totalCount,
    matches: combinedMatches,
  };
}

export async function executeFindFilesSearch(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const queryValue = input.query;
  if (typeof queryValue !== 'string') {
    throw new Error('query must be a string');
  }
  const maxResults = typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
    ? input.maxResults
    : undefined;
  const matched: string[] = [];
  const seen = new Set<string>();
  let remaining = maxResults ?? Number.POSITIVE_INFINITY;

  const targets = resolveFindFilesTargets(queryValue);
  for (const target of targets) {
    if (remaining <= 0) {
      break;
    }
    const result = await runRipgrepFileSearch(target, {
      maxResults: maxResults !== undefined ? remaining : undefined,
    });
    for (const filePath of result.files) {
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      matched.push(filePath);
      if (maxResults !== undefined && matched.length >= maxResults) {
        break;
      }
    }
    if (maxResults !== undefined) {
      remaining = Math.max(0, maxResults - matched.length);
    }
  }

  return {
    count: matched.length,
    files: matched,
  };
}

function formatSearchMatchPath(uri: vscode.Uri): string {
  return uri.fsPath;
}

function resolveRipgrepTargets(
  includePattern: unknown,
): Array<{ folder: vscode.WorkspaceFolder; glob?: string }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }
  if (typeof includePattern !== 'string') {
    return folders.map((folder) => ({ folder }));
  }
  const trimmed = includePattern.trim();
  if (!trimmed) {
    return folders.map((folder) => ({ folder }));
  }
  const parsed = parseWorkspacePrefixedIncludePattern(trimmed);
  if (parsed) {
    return [{ folder: parsed.workspaceFolder, glob: parsed.pattern }];
  }
  return folders.map((folder) => ({ folder, glob: trimmed }));
}

function resolveFindFilesTargets(
  includePattern: string,
): Array<{ folder: vscode.WorkspaceFolder; glob?: string }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }
  const trimmed = includePattern.trim();
  if (!trimmed) {
    return folders.map((folder) => ({ folder }));
  }
  if (path.isAbsolute(trimmed) || startsWithWindowsAbsolutePath(trimmed)) {
    const workspaceFolder = findWorkspaceFolderForAbsolutePath(trimmed, folders);
    if (!workspaceFolder) {
      return [];
    }
    const relativePath = path.relative(workspaceFolder.uri.fsPath, path.resolve(trimmed));
    const normalizedRelPath = normalizeGlob(relativePath);
    return [{
      folder: workspaceFolder,
      glob: normalizedRelPath.length > 0 ? normalizedRelPath : '**/*',
    }];
  }
  const parsed = parseWorkspacePrefixedIncludePattern(trimmed);
  if (parsed) {
    return [{ folder: parsed.workspaceFolder, glob: parsed.pattern }];
  }
  return folders.map((folder) => ({ folder, glob: trimmed }));
}

function findWorkspaceFolderForAbsolutePath(
  targetPath: string,
  folders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | undefined {
  const normalizedTarget = normalizePathForComparison(targetPath);
  for (const folder of folders) {
    const normalizedFolder = normalizePathForComparison(folder.uri.fsPath);
    const relative = path.relative(normalizedFolder, normalizedTarget);
    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return folder;
    }
  }
  return undefined;
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function runRipgrepSearch(
  target: { folder: vscode.WorkspaceFolder; glob?: string },
  options: {
    query: string;
    isRegexp: boolean;
    caseSensitive: boolean;
    includeIgnoredFiles: boolean;
    maxResults?: number;
  },
): Promise<RipgrepSearchResult> {
  const matches: RipgrepMatch[] = [];
  let totalMatches = 0;
  let capped = false;
  let stdoutBuffer = '';
  const stderrChunks: string[] = [];
  const args = buildRipgrepArgs(target, options);
  const maxResults = options.maxResults;
  const pushMatch = (match: RipgrepMatch) => {
    if (maxResults !== undefined && totalMatches >= maxResults) {
      return;
    }
    totalMatches += 1;
    matches.push(match);
    if (maxResults !== undefined && totalMatches >= maxResults && !capped) {
      capped = true;
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
    }
  };

  const child = spawn(rgPath, args, {
    cwd: target.folder.uri.fsPath,
    windowsHide: true,
  });

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    stdoutBuffer = consumeRipgrepLines(stdoutBuffer, (line) => {
      const match = parseRipgrepMatch(line, target.folder);
      if (!match) {
        return;
      }
      pushMatch(match);
    });
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolve(code));
  });

  if (stdoutBuffer.length > 0) {
    consumeRipgrepLines(stdoutBuffer, (line) => {
      const match = parseRipgrepMatch(line, target.folder);
      if (!match) {
        return;
      }
      pushMatch(match);
    });
  }

  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2 && !capped) {
    const stderrText = stderrChunks.join('').trim();
    throw new Error(stderrText || `ripgrep exited with code ${exitCode ?? 'null'}`);
  }

  return {
    matches,
    totalMatches,
    capped,
  };
}

async function runRipgrepFileSearch(
  target: { folder: vscode.WorkspaceFolder; glob?: string },
  options: { maxResults?: number },
): Promise<RipgrepFileSearchResult> {
  const files: string[] = [];
  let totalMatches = 0;
  let capped = false;
  let stdoutBuffer = '';
  const stderrChunks: string[] = [];
  const args = buildRipgrepFileArgs(target);
  const maxResults = options.maxResults;
  const pushFile = (filePath: string) => {
    if (maxResults !== undefined && totalMatches >= maxResults) {
      return;
    }
    totalMatches += 1;
    files.push(filePath);
    if (maxResults !== undefined && totalMatches >= maxResults && !capped) {
      capped = true;
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
    }
  };

  const child = spawn(rgPath, args, {
    cwd: target.folder.uri.fsPath,
    windowsHide: true,
  });

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    stdoutBuffer = consumeRipgrepFileLines(stdoutBuffer, (line) => {
      const filePath = parseRipgrepFilePath(line, target.folder);
      if (!filePath) {
        return;
      }
      pushFile(filePath);
    });
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'));
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolve(code));
  });

  if (stdoutBuffer.length > 0) {
    consumeRipgrepFileLines(stdoutBuffer, (line) => {
      const filePath = parseRipgrepFilePath(line, target.folder);
      if (!filePath) {
        return;
      }
      pushFile(filePath);
    });
  }

  if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2 && !capped) {
    const stderrText = stderrChunks.join('').trim();
    throw new Error(stderrText || `ripgrep exited with code ${exitCode ?? 'null'}`);
  }

  return {
    files,
    totalMatches,
    capped,
  };
}

function consumeRipgrepLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  let index = buffer.indexOf('\n', start);
  while (index !== -1) {
    const line = buffer.slice(start, index).trim();
    if (line.length > 0) {
      onLine(line);
    }
    start = index + 1;
    index = buffer.indexOf('\n', start);
  }
  return buffer.slice(start);
}

function consumeRipgrepFileLines(buffer: string, onLine: (line: string) => void): string {
  let start = 0;
  let index = buffer.indexOf('\n', start);
  while (index !== -1) {
    let line = buffer.slice(start, index);
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (line.length > 0) {
      onLine(line);
    }
    start = index + 1;
    index = buffer.indexOf('\n', start);
  }
  return buffer.slice(start);
}

function parseRipgrepMatch(line: string, folder: vscode.WorkspaceFolder): RipgrepMatch | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as { type?: unknown; data?: unknown };
  if (record.type !== 'match' || !record.data || typeof record.data !== 'object') {
    return undefined;
  }
  const data = record.data as {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
  const relPath = data.path?.text;
  const previewText = data.lines?.text;
  const lineNumber = data.line_number;
  if (!relPath || previewText === undefined || typeof lineNumber !== 'number') {
    return undefined;
  }
  let normalizedRelPath = relPath.replace(/\\/g, '/');
  normalizedRelPath = normalizedRelPath.replace(/^\.\//u, '').replace(/\/\.\//g, '/');
  const absolutePath = path.isAbsolute(relPath)
    ? relPath
    : path.resolve(folder.uri.fsPath, normalizedRelPath);
  const preview = previewText.replace(/\r\n/g, '\n').trimEnd();
  return {
    path: absolutePath,
    line: lineNumber,
    preview,
  };
}

function parseRipgrepFilePath(line: string, folder: vscode.WorkspaceFolder): string | undefined {
  if (!line) {
    return undefined;
  }
  let normalizedRelPath = line.replace(/\\/g, '/');
  normalizedRelPath = normalizedRelPath.replace(/^\.\//u, '').replace(/\/\.\//g, '/');
  const absolutePath = path.isAbsolute(line)
    ? line
    : path.resolve(folder.uri.fsPath, normalizedRelPath);
  return absolutePath;
}

function buildRipgrepArgs(
  target: { folder: vscode.WorkspaceFolder; glob?: string },
  options: { query: string; isRegexp: boolean; caseSensitive: boolean; includeIgnoredFiles: boolean },
): string[] {
  const args: string[] = ['--json', '--with-filename', '--line-number', '--no-messages'];

  if (!options.isRegexp) {
    if (options.caseSensitive) {
      args.push('--case-sensitive');
    } else {
      args.push('--smart-case');
    }
    args.push('--fixed-strings');
  } else if (options.caseSensitive) {
    args.push('--case-sensitive');
  } else {
    args.push('--smart-case');
  }

  const useIgnoreFiles = getSearchConfigValue('useIgnoreFiles', target.folder, true);
  const useGlobalIgnoreFiles = getSearchConfigValue('useGlobalIgnoreFiles', target.folder, true);
  const followSymlinks = getSearchConfigValue('followSymlinks', target.folder, true);

  if (options.includeIgnoredFiles || !useIgnoreFiles) {
    args.push('--no-ignore', '--no-ignore-parent');
  }
  if (options.includeIgnoredFiles || !useGlobalIgnoreFiles) {
    args.push('--no-ignore-global');
  }
  if (followSymlinks) {
    args.push('--follow');
  }

  if (!options.includeIgnoredFiles) {
    const searchExclude = collectExcludeGlobs(getExcludeConfig('search', target.folder));
    const filesExclude = collectExcludeGlobs(getExcludeConfig('files', target.folder));
    const excludePatterns = new Set<string>();
    for (const pattern of [...searchExclude, ...filesExclude]) {
      const normalized = normalizeGlob(pattern);
      if (!normalized) {
        continue;
      }
      excludePatterns.add(normalized.startsWith('!') ? normalized : `!${normalized}`);
      if (!/\/\*\*(?:\/\*)?$/u.test(normalized)) {
        const withChildren = normalized.endsWith('/') ? `${normalized}**` : `${normalized}/**`;
        excludePatterns.add(withChildren.startsWith('!') ? withChildren : `!${withChildren}`);
      }
    }
    for (const pattern of excludePatterns) {
      args.push('--glob', pattern);
    }
  }

  if (target.glob) {
    args.push('--glob', normalizeGlob(target.glob));
  }

  args.push('-e', options.query, '.');
  return args;
}

function buildRipgrepFileArgs(
  target: { folder: vscode.WorkspaceFolder; glob?: string },
): string[] {
  const args: string[] = ['--files', '--no-messages'];
  const useIgnoreFiles = getSearchConfigValue('useIgnoreFiles', target.folder, true);
  const useGlobalIgnoreFiles = getSearchConfigValue('useGlobalIgnoreFiles', target.folder, true);
  const followSymlinks = getSearchConfigValue('followSymlinks', target.folder, true);

  if (!useIgnoreFiles) {
    args.push('--no-ignore', '--no-ignore-parent');
  }
  if (!useGlobalIgnoreFiles) {
    args.push('--no-ignore-global');
  }
  if (followSymlinks) {
    args.push('--follow');
  }

    const searchExclude = collectExcludeGlobs(getExcludeConfig('search', target.folder));
    const filesExclude = collectExcludeGlobs(getExcludeConfig('files', target.folder));
  const excludePatterns = new Set<string>();
  for (const pattern of [...searchExclude, ...filesExclude]) {
    const normalized = normalizeGlob(pattern);
    if (!normalized) {
      continue;
    }
    excludePatterns.add(normalized.startsWith('!') ? normalized : `!${normalized}`);
    if (!/\/\*\*(?:\/\*)?$/u.test(normalized)) {
      const withChildren = normalized.endsWith('/') ? `${normalized}**` : `${normalized}/**`;
      excludePatterns.add(withChildren.startsWith('!') ? withChildren : `!${withChildren}`);
    }
  }
  for (const pattern of excludePatterns) {
    args.push('--glob', pattern);
  }

  if (target.glob) {
    args.push('--glob', normalizeGlob(target.glob));
  }

  return args;
}

function collectExcludeGlobs(values: Record<string, unknown>): string[] {
  return Object.entries(values)
    .filter(([, value]) => value === true || (typeof value === 'object' && value !== null))
    .map(([pattern]) => pattern);
}

function getExcludeConfig(
  section: 'search' | 'files',
  folder?: vscode.WorkspaceFolder,
): Record<string, unknown> {
  const workspaceConfig = vscode.workspace.getConfiguration(section);
  const workspaceExclude = workspaceConfig.get<Record<string, unknown>>('exclude', {});
  if (!folder) {
    return workspaceExclude;
  }
  const folderConfig = vscode.workspace.getConfiguration(section, folder.uri);
  const folderExclude = folderConfig.get<Record<string, unknown>>('exclude', {});
  return { ...workspaceExclude, ...folderExclude };
}

function getSearchConfigValue<T>(key: string, folder: vscode.WorkspaceFolder, fallback: T): T {
  const workspaceConfig = vscode.workspace.getConfiguration('search');
  const workspaceValue = workspaceConfig.get<T>(key, fallback);
  const folderConfig = vscode.workspace.getConfiguration('search', folder.uri);
  return folderConfig.get<T>(key, workspaceValue);
}

function buildFindFilesExcludePattern(folder?: vscode.WorkspaceFolder): string | undefined {
  const searchExclude = collectExcludeGlobs(getExcludeConfig('search', folder));
  const filesExclude = collectExcludeGlobs(getExcludeConfig('files', folder));
  const excludePatterns = new Set<string>();
  for (const pattern of [...searchExclude, ...filesExclude]) {
    const normalized = normalizeGlob(pattern).replace(/^!/, '');
    if (!normalized) {
      continue;
    }
    excludePatterns.add(normalized);
    if (!/\/\*\*(?:\/\*)?$/u.test(normalized)) {
      const withChildren = normalized.endsWith('/') ? `${normalized}**` : `${normalized}/**`;
      excludePatterns.add(withChildren);
    }
  }
  if (excludePatterns.size === 0) {
    return undefined;
  }
  if (excludePatterns.size === 1) {
    return [...excludePatterns][0];
  }
  return `{${[...excludePatterns].join(',')}}`;
}

function normalizeGlob(pattern: string): string {
  return pattern.replace(/\\/g, '/');
}

function normalizeFindTextInFilesIncludeEntry(entry: string): vscode.GlobPattern {
  const parsed = parseWorkspacePrefixedIncludePattern(entry);
  if (!parsed) {
    return entry;
  }
  return new vscode.RelativePattern(parsed.workspaceFolder.uri, parsed.pattern);
}

function parseWorkspacePrefixedIncludePattern(entry: string): {
  workspaceFolder: vscode.WorkspaceFolder;
  pattern: string;
} | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }
  if (path.isAbsolute(trimmed) || startsWithWindowsAbsolutePath(trimmed)) {
    return undefined;
  }
  const withoutDotPrefix = trimmed.replace(/^\.[\\/]+/u, '');
  const normalized = withoutDotPrefix.replace(/^[\\/]+/u, '');
  const separatorIndex = normalized.search(/[\\/]/u);
  const workspaceName = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : normalized;
  if (!workspaceName) {
    return undefined;
  }
  const workspaceFolder = findWorkspaceFolderByName(workspaceName);
  if (!workspaceFolder) {
    return undefined;
  }
  const remainder = separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : '';
  const normalizedRemainder = remainder ? remainder.replace(/^[\\/]+/u, '') : '**/*';
  return {
    workspaceFolder,
    pattern: normalizedRemainder,
  };
}

function findWorkspaceFolderByName(name: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const normalized = process.platform === 'win32' ? name.toLowerCase() : name;
  return folders.find((folder) => {
    const folderName = process.platform === 'win32' ? folder.name.toLowerCase() : folder.name;
    return folderName === normalized;
  });
}

function startsWithWindowsAbsolutePath(text: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(text) || text.startsWith('\\\\');
}
