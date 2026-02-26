import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

class WorkspacePathError extends Error {
  public readonly code: 'INVALID_INPUT';
  public readonly details?: unknown;

  constructor(code: 'INVALID_INPUT', message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface ResolvedInputFilePath {
  absoluteFilePath: string;
  uri: string;
}

export interface ResolvedStructuredPath {
  absolutePath: string;
  workspacePath: string | null;
}

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

function normalizeForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function findWorkspaceFolderByName(name: string): vscode.WorkspaceFolder | undefined {
  const folders = getWorkspaceFolders();
  const expected = process.platform === 'win32' ? name.toLowerCase() : name;
  return folders.find((folder) => {
    const folderName = process.platform === 'win32' ? folder.name.toLowerCase() : folder.name;
    return folderName === expected;
  });
}

function parseWorkspacePrefixedPath(filePath: string): { workspaceName: string; remainder: string } | undefined {
  const normalized = normalizeSlash(filePath.trim()).replace(/^\/+/u, '');
  const separatorIndex = normalized.indexOf('/');
  if (separatorIndex < 0) {
    return undefined;
  }
  const workspaceName = normalized.slice(0, separatorIndex).trim();
  const remainder = normalized.slice(separatorIndex + 1).trim();
  if (!workspaceName || !remainder) {
    return undefined;
  }
  return {
    workspaceName,
    remainder: remainder.replace(/^\/+/u, ''),
  };
}

function isAbsolutePath(input: string): boolean {
  return path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/u.test(input) || input.startsWith('\\\\');
}

function getWorkspaceNames(): string {
  const folders = getWorkspaceFolders();
  return folders.map((folder) => folder.name).join(', ');
}

function pathExists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

function isPathInsideWorkspaceRoot(workspaceRoot: string, targetPath: string): boolean {
  const normalizedRoot = normalizeForComparison(workspaceRoot);
  const normalizedTarget = normalizeForComparison(targetPath);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ensurePathExists(targetPath: string, inputPath: string): void {
  if (pathExists(targetPath)) {
    return;
  }
  throw new WorkspacePathError(
    'INVALID_INPUT',
    `Path '${inputPath}' does not exist.`,
  );
}

function ensurePathInsideWorkspaceRoot(
  workspaceFolder: vscode.WorkspaceFolder,
  targetPath: string,
  inputPath: string,
): void {
  if (isPathInsideWorkspaceRoot(workspaceFolder.uri.fsPath, targetPath)) {
    return;
  }
  throw new WorkspacePathError(
    'INVALID_INPUT',
    `Path '${inputPath}' resolves outside workspace '${workspaceFolder.name}'. Use '${workspaceFolder.name}/...'.`,
  );
}

function containsRelativeTraversal(inputPath: string): boolean {
  const normalized = normalizeSlash(path.normalize(inputPath));
  return normalized === '..' || normalized.startsWith('../');
}

function normalizeRelativePathHint(inputPath: string): string {
  const normalized = normalizeSlash(inputPath.trim())
    .replace(/^(?:\.\/)+/u, '')
    .replace(/^\/+/u, '');
  return normalized.length > 0 ? normalized : inputPath.trim();
}

function resolveWorkspacePrefixedPath(
  inputPath: string,
  workspaceFolder: vscode.WorkspaceFolder,
  remainder: string,
): string {
  const targetPath = path.resolve(workspaceFolder.uri.fsPath, remainder);
  ensurePathInsideWorkspaceRoot(workspaceFolder, targetPath, inputPath);
  ensurePathExists(targetPath, inputPath);
  return targetPath;
}

function resolveWorkspaceRootRelativePath(inputPath: string): string {
  const folders = getWorkspaceFolders();
  if (folders.length === 0) {
    throw new WorkspacePathError(
      'INVALID_INPUT',
      `Cannot resolve relative path '${inputPath}' because no workspace folders are open.`,
    );
  }
  if (containsRelativeTraversal(inputPath)) {
    throw new WorkspacePathError(
      'INVALID_INPUT',
      `Relative path '${inputPath}' must stay inside workspace root and cannot escape with '..'.`,
    );
  }

  const matches: Array<{ folder: vscode.WorkspaceFolder; absolutePath: string }> = [];
  for (const folder of folders) {
    const targetPath = path.resolve(folder.uri.fsPath, inputPath);
    if (!isPathInsideWorkspaceRoot(folder.uri.fsPath, targetPath)) {
      continue;
    }
    if (!pathExists(targetPath)) {
      continue;
    }
    matches.push({
      folder,
      absolutePath: targetPath,
    });
  }

  if (matches.length === 1) {
    return matches[0].absolutePath;
  }
  if (matches.length === 0) {
    const workspaceNames = getWorkspaceNames();
    throw new WorkspacePathError(
      'INVALID_INPUT',
      `Relative path '${inputPath}' was not found in any workspace folder. Known workspaces: ${workspaceNames || '(none)'}.`,
    );
  }

  const ambiguousTargets = matches
    .map((match) => `${match.folder.name} (${normalizeSlash(match.folder.uri.fsPath)})`)
    .join(', ');
  const hintPath = normalizeRelativePathHint(inputPath);
  throw new WorkspacePathError(
    'INVALID_INPUT',
    `Relative path '${inputPath}' is ambiguous across workspace folders: ${ambiguousTargets}. Use 'WorkspaceName/${hintPath}'.`,
  );
}

export function resolveInputFilePath(filePath: string): ResolvedInputFilePath {
  const raw = filePath.trim();
  if (!raw) {
    throw new WorkspacePathError('INVALID_INPUT', "Expected 'filePath' to be a non-empty string.");
  }
  if (/^file:\/\//iu.test(raw)) {
    throw new WorkspacePathError('INVALID_INPUT', "Input no longer accepts URI. Use 'filePath' instead of 'uri'.");
  }

  let absoluteFilePath: string;
  if (isAbsolutePath(raw)) {
    absoluteFilePath = path.resolve(raw);
    ensurePathExists(absoluteFilePath, raw);
  } else {
    const parsed = parseWorkspacePrefixedPath(raw);
    const workspaceFolder = parsed ? findWorkspaceFolderByName(parsed.workspaceName) : undefined;
    if (parsed && workspaceFolder) {
      absoluteFilePath = resolveWorkspacePrefixedPath(raw, workspaceFolder, parsed.remainder);
    } else {
      absoluteFilePath = resolveWorkspaceRootRelativePath(raw);
    }
  }

  const uri = vscode.Uri.file(absoluteFilePath).toString();
  return {
    absoluteFilePath,
    uri,
  };
}

export function formatSummaryPath(
  absoluteFilePath: string,
  startLine: number,
  endLine?: number,
): string {
  const structuredPath = resolveStructuredPath(absoluteFilePath);
  const displayPath = structuredPath.workspacePath ?? structuredPath.absolutePath;

  if (startLine <= 0) {
    return displayPath;
  }
  if (endLine && endLine > 0 && endLine !== startLine) {
    return `${displayPath}#${startLine}-${endLine}`;
  }
  return `${displayPath}#${startLine}`;
}

export function resolveStructuredPath(absoluteFilePath: string): ResolvedStructuredPath {
  const resolved = path.resolve(absoluteFilePath);
  const folders = vscode.workspace.workspaceFolders ?? [];

  let bestMatch: vscode.WorkspaceFolder | undefined;
  let bestLength = -1;
  const normalizedResolved = normalizeForComparison(resolved);
  for (const folder of folders) {
    const normalizedFolder = normalizeForComparison(folder.uri.fsPath);
    const relative = path.relative(normalizedFolder, normalizedResolved);
    const inside = !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!inside) {
      continue;
    }
    if (normalizedFolder.length > bestLength) {
      bestLength = normalizedFolder.length;
      bestMatch = folder;
    }
  }

  const absolutePath = normalizeSlash(resolved);
  if (!bestMatch) {
    return {
      absolutePath,
      workspacePath: null,
    };
  }

  const relativePath = path.relative(bestMatch.uri.fsPath, resolved);
  const normalizedRelativePath = normalizeSlash(relativePath);
  return {
    absolutePath,
    workspacePath: normalizedRelativePath.length > 0
      ? `${bestMatch.name}/${normalizedRelativePath}`
      : bestMatch.name,
  };
}
