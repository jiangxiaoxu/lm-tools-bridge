import * as vscode from 'vscode';
import { ClangdToolError } from '../errors';
import { HOVER_METHOD, SIGNATURE_HELP_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { formatSummaryPath, resolveInputFilePath, resolveStructuredPath } from '../workspacePath';
import { readPositionFromInput, readString } from './shared';

export interface OneBasedRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface FlatLocation extends OneBasedRange {
  filePath: string;
}

export interface StructuredLocation extends OneBasedRange {
  absolutePath: string;
  workspacePath: string | null;
  preview?: string;
}

export type SymbolSignatureSource = 'signatureHelp' | 'hover' | 'definitionLine' | 'none';

export interface ResolvedSymbolSignature {
  signature: string | null;
  source: SymbolSignatureSource;
}

interface RawLspPosition {
  line?: unknown;
  character?: unknown;
}

interface RawLspRange {
  start?: RawLspPosition;
  end?: RawLspPosition;
}

interface RawLspLocation {
  uri?: unknown;
  range?: RawLspRange;
}

interface RawLspLocationLink {
  targetUri?: unknown;
  targetRange?: RawLspRange;
  targetSelectionRange?: RawLspRange;
}

function toOneBasedPosition(value: RawLspPosition | undefined): { line: number; character: number } | undefined {
  const line = value?.line;
  const character = value?.character;
  if (typeof line !== 'number' || !Number.isInteger(line) || typeof character !== 'number' || !Number.isInteger(character)) {
    return undefined;
  }
  return {
    line: line + 1,
    character: character + 1,
  };
}

function parseLocation(value: unknown): FlatLocation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const location = value as RawLspLocation;
  if (typeof location.uri === 'string' && location.range && typeof location.range === 'object') {
    const start = toOneBasedPosition(location.range.start);
    const end = toOneBasedPosition(location.range.end);
    if (!start || !end) {
      return undefined;
    }
    const filePath = vscode.Uri.parse(location.uri).fsPath;
    return {
      filePath,
      startLine: start.line,
      startCharacter: start.character,
      endLine: end.line,
      endCharacter: end.character,
    };
  }

  const link = value as RawLspLocationLink;
  if (typeof link.targetUri === 'string') {
    const range = link.targetSelectionRange ?? link.targetRange;
    if (range && typeof range === 'object') {
      const start = toOneBasedPosition(range.start);
      const end = toOneBasedPosition(range.end);
      if (!start || !end) {
        return undefined;
      }
      const filePath = vscode.Uri.parse(link.targetUri).fsPath;
      return {
        filePath,
        startLine: start.line,
        startCharacter: start.character,
        endLine: end.line,
        endCharacter: end.character,
      };
    }
  }

  return undefined;
}

export function extractLocations(value: unknown): FlatLocation[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => parseLocation(item))
      .filter((item): item is FlatLocation => item !== undefined);
  }
  const location = parseLocation(value);
  return location ? [location] : [];
}

export function locationToSummaryPath(location: FlatLocation): string {
  return formatSummaryPath(
    location.filePath,
    location.startLine,
    location.endLine !== location.startLine ? location.endLine : undefined,
  );
}

export function toStructuredLocation(location: FlatLocation, preview?: string): StructuredLocation {
  const pathInfo = resolveStructuredPath(location.filePath);
  const normalizedPreview = typeof preview === 'string' ? preview.trim() : '';
  return {
    absolutePath: pathInfo.absolutePath,
    workspacePath: pathInfo.workspacePath,
    startLine: location.startLine,
    startCharacter: location.startCharacter,
    endLine: location.endLine,
    endCharacter: location.endCharacter,
    preview: normalizedPreview.length > 0 ? normalizedPreview : undefined,
  };
}

export function renderReferenceSummary(location: FlatLocation, lineText: string): string {
  const text = lineText.trim();
  if (text.length === 0) {
    return `reference at ${location.startLine}:${location.startCharacter}`;
  }
  return text;
}

export function toTextDocumentPositionParams(input: Record<string, unknown>): {
  absoluteFilePath: string;
  uri: string;
  position: { line: number; character: number };
} {
  const filePath = readString(input, 'filePath');
  const resolved = resolveInputFilePath(filePath);
  const position = readPositionFromInput(input, 'position');
  return {
    absoluteFilePath: resolved.absoluteFilePath,
    uri: resolved.uri,
    position,
  };
}

export async function readLineTextFromFile(
  filePath: string,
  lineOneBased: number,
  cache: Map<string, string[] | null>,
): Promise<string> {
  if (lineOneBased <= 0) {
    return '';
  }
  const cacheKey = filePath;
  if (!cache.has(cacheKey)) {
    try {
      const uri = vscode.Uri.file(filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      cache.set(cacheKey, text.split(/\r?\n/));
    } catch {
      cache.set(cacheKey, null);
    }
  }
  const lines = cache.get(cacheKey);
  if (!lines) {
    return '';
  }
  return lines[lineOneBased - 1] ?? '';
}

export async function getFileLines(
  filePath: string,
  cache: Map<string, string[] | null>,
): Promise<string[] | null> {
  if (!cache.has(filePath)) {
    try {
      const uri = vscode.Uri.file(filePath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(bytes);
      cache.set(filePath, text.split(/\r?\n/));
    } catch {
      cache.set(filePath, null);
    }
  }
  return cache.get(filePath) ?? null;
}

export async function readSnippetFromFile(
  filePath: string,
  startLineOneBased: number,
  maxLines: number,
  cache: Map<string, string[] | null>,
): Promise<string> {
  const lines = await getFileLines(filePath, cache);
  if (!lines || startLineOneBased <= 0) {
    return '';
  }
  const startIndex = startLineOneBased - 1;
  const endIndex = Math.min(lines.length, startIndex + maxLines);
  const snippetLines: string[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    snippetLines.push(lines[index] ?? '');
  }
  return snippetLines.join('\n').trimEnd();
}

export function parseLimit(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maxValue: number,
): number {
  const value = input[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be a positive integer.`);
  }
  return Math.min(value, maxValue);
}

export function parseStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be an array of strings.`);
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function flattenMarkupText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenMarkupText(item)).filter((item) => item.length > 0).join('\n');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as Record<string, unknown>;
  if (typeof record.value === 'string') {
    return record.value;
  }
  if (record.contents !== undefined) {
    return flattenMarkupText(record.contents);
  }
  return '';
}

function parseActiveSignatureLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const signatures = Array.isArray(record.signatures) ? record.signatures : [];
  if (signatures.length === 0) {
    return null;
  }
  const activeSignature = typeof record.activeSignature === 'number' && Number.isInteger(record.activeSignature)
    ? record.activeSignature
    : 0;
  const index = Math.max(0, Math.min(activeSignature, signatures.length - 1));
  const selected = signatures[index];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    return null;
  }
  const label = (selected as Record<string, unknown>).label;
  if (typeof label !== 'string') {
    return null;
  }
  const normalized = label.trim();
  return normalized.length > 0 ? normalized : null;
}

export function extractSignatureFromSignatureHelp(value: unknown): string | null {
  return parseActiveSignatureLabel(value);
}

export function extractSignatureFromHover(value: unknown): string | null {
  const flattened = flattenMarkupText(value).trim();
  if (!flattened) {
    return null;
  }

  const fencedCodeBlocks = flattened.match(/```[\s\S]*?```/g);
  if (fencedCodeBlocks && fencedCodeBlocks.length > 0) {
    for (const block of fencedCodeBlocks) {
      const content = block
        .replace(/^```[^\n]*\n?/u, '')
        .replace(/\n?```$/u, '')
        .trim();
      if (content.length > 0) {
        return content;
      }
    }
  }

  return flattened;
}

export async function resolveSymbolSignature(
  location: FlatLocation,
  lineCache?: Map<string, string[] | null>,
): Promise<ResolvedSymbolSignature> {
  const uri = vscode.Uri.file(location.filePath).toString();
  const lspPosition = {
    line: Math.max(0, location.startLine - 1),
    character: Math.max(0, location.startCharacter - 1),
  };

  try {
    const signatureHelp = await sendRequestWithAutoStart<unknown>(SIGNATURE_HELP_METHOD, {
      textDocument: { uri },
      position: lspPosition,
    });
    const signature = extractSignatureFromSignatureHelp(signatureHelp);
    if (signature) {
      return {
        signature,
        source: 'signatureHelp',
      };
    }
  } catch {
    // Fall through to hover and line-based fallback.
  }

  try {
    const hover = await sendRequestWithAutoStart<unknown>(HOVER_METHOD, {
      textDocument: { uri },
      position: lspPosition,
    });
    const signature = extractSignatureFromHover(hover);
    if (signature) {
      return {
        signature,
        source: 'hover',
      };
    }
  } catch {
    // Fall through to line-based fallback.
  }

  const cache = lineCache ?? new Map<string, string[] | null>();
  const lineText = (await readLineTextFromFile(location.filePath, location.startLine, cache)).trim();
  if (lineText.length > 0) {
    return {
      signature: lineText,
      source: 'definitionLine',
    };
  }

  return {
    signature: null,
    source: 'none',
  };
}
