import * as path from 'node:path';
import * as vscode from 'vscode';
import { ClangdToolError } from './errors';

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

function findWorkspaceFolderByName(name: string): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
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
  return { workspaceName, remainder };
}

function isAbsolutePath(input: string): boolean {
  return path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/u.test(input) || input.startsWith('\\\\');
}

function getWorkspaceNames(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.map((folder) => folder.name).join(', ');
}

export function resolveInputFilePath(filePath: string): ResolvedInputFilePath {
  const raw = filePath.trim();
  if (!raw) {
    throw new ClangdToolError('INVALID_INPUT', "Expected 'filePath' to be a non-empty string.");
  }
  if (/^file:\/\//iu.test(raw)) {
    throw new ClangdToolError('INVALID_INPUT', "Input no longer accepts URI. Use 'filePath' instead of 'uri'.");
  }

  let absoluteFilePath: string;
  if (isAbsolutePath(raw)) {
    absoluteFilePath = path.resolve(raw);
  } else {
    const parsed = parseWorkspacePrefixedPath(raw);
    if (!parsed) {
      throw new ClangdToolError(
        'INVALID_INPUT',
        "Workspace-relative path must include workspace name prefix, for example 'UE5/Engine/Source/...'.",
      );
    }
    const workspaceFolder = findWorkspaceFolderByName(parsed.workspaceName);
    if (!workspaceFolder) {
      const workspaceNames = getWorkspaceNames();
      throw new ClangdToolError(
        'INVALID_INPUT',
        `Workspace '${parsed.workspaceName}' was not found. Known workspaces: ${workspaceNames || '(none)'}.`,
      );
    }
    absoluteFilePath = path.resolve(workspaceFolder.uri.fsPath, parsed.remainder);
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
