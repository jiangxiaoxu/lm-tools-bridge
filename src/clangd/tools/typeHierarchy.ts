import * as vscode from 'vscode';
import { DOCUMENT_SYMBOL_METHOD, TYPE_HIERARCHY_METHOD, TYPE_HIERARCHY_RESOLVE_METHOD } from '../methods';
import { ClangdToolError } from '../errors';
import { sendRequestWithAutoStart } from '../transport';
import { renderSection, renderSummaryText } from '../format/aiSummary';
import { formatSummaryPath, resolveInputFilePath } from '../workspacePath';
import {
  errorResult,
  readOptionalInteger,
  readPositionFromInput,
  readString,
  successTextResult,
} from './shared';

interface RawLspPosition {
  line?: number;
  character?: number;
}

interface RawLspRange {
  start?: RawLspPosition;
  end?: RawLspPosition;
}

interface RawTypeHierarchyItem {
  name?: unknown;
  uri?: unknown;
  range?: RawLspRange;
  selectionRange?: RawLspRange;
  parents?: unknown;
  children?: unknown;
}

interface RawLspLocation {
  uri?: unknown;
  range?: RawLspRange;
}

interface RawDocumentSymbol {
  name?: unknown;
  kind?: unknown;
  range?: RawLspRange;
  selectionRange?: RawLspRange;
  children?: unknown;
}

interface RawSymbolInformation {
  name?: unknown;
  kind?: unknown;
  location?: RawLspLocation;
}

interface SourceLocationSummary {
  filePath: string;
  startLine: number;
  endLine: number;
  preview: string;
}

interface TypeSymbolRange {
  name: string;
  startLine: number;
  endLine: number;
  selectionStartLine: number;
}

function normalizeDirection(value: number | undefined, fallback: 0 | 1 | 2): 0 | 1 | 2 {
  if (value === undefined) {
    return fallback;
  }
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new ClangdToolError('INVALID_INPUT', `Invalid direction value '${value}'. Expected 0, 1, or 2.`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
): number {
  const value = readOptionalInteger(input, key);
  if (value === undefined) {
    return defaultValue;
  }
  if (value < 0) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be a non-negative integer.`);
  }
  return value;
}

function asTypeHierarchyItem(value: unknown): RawTypeHierarchyItem | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as RawTypeHierarchyItem;
}

function asTypeHierarchyItems(value: unknown): RawTypeHierarchyItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asTypeHierarchyItem(item))
    .filter((item): item is RawTypeHierarchyItem => item !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asDocumentSymbols(value: unknown): RawDocumentSymbol[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .filter((item) => Array.isArray(item.children) || item.selectionRange !== undefined)
    .map((item) => item as RawDocumentSymbol);
}

function asSymbolInformation(value: unknown): RawSymbolInformation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .filter((item) => item.location !== undefined)
    .map((item) => item as RawSymbolInformation);
}

function extractRootItem(result: unknown): RawTypeHierarchyItem | undefined {
  const item = asTypeHierarchyItem(result);
  if (item) {
    return item;
  }
  return asTypeHierarchyItems(result)[0];
}

function getItemName(item: RawTypeHierarchyItem | undefined): string | undefined {
  if (!item) {
    return undefined;
  }
  return typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : undefined;
}

function getItemRange(item: RawTypeHierarchyItem): RawLspRange | undefined {
  return item.range ?? item.selectionRange;
}

function isUeTypeMacroLine(lineText: string): boolean {
  return /^\s*U(?:CLASS|STRUCT)\s*\(/.test(lineText);
}

async function getDocumentLines(
  uri: vscode.Uri,
  cache: Map<string, string[] | null>,
): Promise<string[] | null> {
  const cacheKey = uri.toString();
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    const lines = text.split(/\r?\n/);
    cache.set(cacheKey, lines);
    return lines;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

async function normalizeUeStartLine(
  uri: vscode.Uri,
  startLineOneBased: number,
  cache: Map<string, string[] | null>,
): Promise<number> {
  if (startLineOneBased <= 1) {
    return startLineOneBased;
  }
  const lines = await getDocumentLines(uri, cache);
  if (!lines) {
    return startLineOneBased;
  }
  const previousLineText = lines[startLineOneBased - 2] ?? '';
  if (isUeTypeMacroLine(previousLineText)) {
    return startLineOneBased - 1;
  }
  return startLineOneBased;
}

function getTrimmedLine(lines: readonly string[] | null, lineOneBased: number): string | undefined {
  if (!lines || lineOneBased < 1 || lineOneBased > lines.length) {
    return undefined;
  }
  const value = lines[lineOneBased - 1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function findFirstNonEmptyLine(lines: readonly string[] | null, startLine: number, endLine: number): string | undefined {
  if (!lines || startLine < 1) {
    return undefined;
  }
  const safeEnd = Math.min(Math.max(endLine, startLine), lines.length);
  for (let line = startLine; line <= safeEnd; line += 1) {
    const value = lines[line - 1]?.trim();
    if (value && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function toOneBasedLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value + 1 : undefined;
}

function isTypeSymbolKind(kind: unknown): boolean {
  return kind === 5 || kind === 23;
}

function parseRangeLines(range: RawLspRange | undefined): { startLine: number; endLine: number } | undefined {
  const startLine = toOneBasedLine(range?.start?.line);
  const endLine = toOneBasedLine(range?.end?.line);
  if (!startLine || !endLine) {
    return undefined;
  }
  return { startLine, endLine };
}

function parseDocumentSymbolNode(node: RawDocumentSymbol): TypeSymbolRange | undefined {
  if (typeof node.name !== 'string' || !isTypeSymbolKind(node.kind)) {
    return undefined;
  }
  const range = parseRangeLines(node.range);
  if (!range) {
    return undefined;
  }
  const selectionStartLine = toOneBasedLine(node.selectionRange?.start?.line) ?? range.startLine;
  return {
    name: node.name,
    startLine: range.startLine,
    endLine: range.endLine,
    selectionStartLine,
  };
}

function collectDocumentSymbolRanges(nodes: readonly RawDocumentSymbol[]): TypeSymbolRange[] {
  const results: TypeSymbolRange[] = [];
  const visit = (entry: RawDocumentSymbol): void => {
    const parsed = parseDocumentSymbolNode(entry);
    if (parsed) {
      results.push(parsed);
    }
    const children = Array.isArray(entry.children) ? entry.children : [];
    for (const child of children) {
      const node = asRecord(child) as RawDocumentSymbol | undefined;
      if (node) {
        visit(node);
      }
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return results;
}

function parseSymbolInformationEntry(
  value: RawSymbolInformation,
  expectedUri: string,
): TypeSymbolRange | undefined {
  if (typeof value.name !== 'string' || !isTypeSymbolKind(value.kind)) {
    return undefined;
  }
  const location = value.location;
  if (!location || typeof location.uri !== 'string' || location.uri !== expectedUri) {
    return undefined;
  }
  const range = parseRangeLines(location.range);
  if (!range) {
    return undefined;
  }
  return {
    name: value.name,
    startLine: range.startLine,
    endLine: range.endLine,
    selectionStartLine: range.startLine,
  };
}

async function getTypeSymbolRanges(
  uri: vscode.Uri,
  cache: Map<string, TypeSymbolRange[] | null>,
): Promise<TypeSymbolRange[] | null> {
  const cacheKey = uri.toString();
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }
  try {
    const raw = await sendRequestWithAutoStart<unknown>(DOCUMENT_SYMBOL_METHOD, {
      textDocument: { uri: cacheKey },
    });
    const documentSymbols = asDocumentSymbols(raw);
    if (documentSymbols.length > 0) {
      const parsed = collectDocumentSymbolRanges(documentSymbols);
      cache.set(cacheKey, parsed);
      return parsed;
    }
    const symbolInformation = asSymbolInformation(raw)
      .map((entry) => parseSymbolInformationEntry(entry, cacheKey))
      .filter((entry): entry is TypeSymbolRange => entry !== undefined);
    cache.set(cacheKey, symbolInformation);
    return symbolInformation;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

function pickBestTypeSymbolRange(
  ranges: readonly TypeSymbolRange[] | null,
  typeName: string,
  typeHierarchyStartLine: number,
): TypeSymbolRange | undefined {
  if (!ranges || ranges.length === 0) {
    return undefined;
  }
  const matches = ranges.filter((entry) => entry.name === typeName);
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((left, right) => {
    const leftDistance = Math.abs(left.startLine - typeHierarchyStartLine);
    const rightDistance = Math.abs(right.startLine - typeHierarchyStartLine);
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    const leftSelectionDistance = Math.abs(left.selectionStartLine - typeHierarchyStartLine);
    const rightSelectionDistance = Math.abs(right.selectionStartLine - typeHierarchyStartLine);
    if (leftSelectionDistance !== rightSelectionDistance) {
      return leftSelectionDistance - rightSelectionDistance;
    }
    return (left.endLine - left.startLine) - (right.endLine - right.startLine);
  });
  return matches[0];
}

async function toSourceLocation(
  item: RawTypeHierarchyItem,
  lineCache: Map<string, string[] | null>,
  symbolRangeCache: Map<string, TypeSymbolRange[] | null>,
  fallbackClassName: string,
): Promise<SourceLocationSummary | undefined> {
  const uri = typeof item.uri === 'string' ? item.uri : undefined;
  const range = getItemRange(item);
  const startLine = range?.start?.line;
  if (!uri || typeof startLine !== 'number') {
    return undefined;
  }
  const uriObject = vscode.Uri.parse(uri);
  const startLineOneBased = startLine + 1;
  const normalizedStartLine = await normalizeUeStartLine(uriObject, startLineOneBased, lineCache);
  const typeSymbolRanges = await getTypeSymbolRanges(uriObject, symbolRangeCache);
  const bestSymbolRange = pickBestTypeSymbolRange(typeSymbolRanges, fallbackClassName, startLineOneBased);
  const endLineOneBased = bestSymbolRange ? Math.max(bestSymbolRange.endLine, normalizedStartLine) : normalizedStartLine;
  const lines = await getDocumentLines(uriObject, lineCache);
  const previewLine = bestSymbolRange?.selectionStartLine ?? normalizedStartLine;
  const preview =
    getTrimmedLine(lines, previewLine) ??
    getTrimmedLine(lines, normalizedStartLine) ??
    findFirstNonEmptyLine(lines, normalizedStartLine, normalizedStartLine) ??
    `type ${fallbackClassName}`;
  return {
    filePath: uriObject.fsPath,
    startLine: normalizedStartLine,
    endLine: endLineOneBased,
    preview,
  };
}

function getParents(item: RawTypeHierarchyItem): RawTypeHierarchyItem[] {
  return asTypeHierarchyItems(item.parents);
}

function getChildren(item: RawTypeHierarchyItem): RawTypeHierarchyItem[] {
  return asTypeHierarchyItems(item.children);
}

async function resolveOneLevel(
  item: RawTypeHierarchyItem,
  direction: 0 | 1,
): Promise<RawTypeHierarchyItem[]> {
  const resolved = await sendRequestWithAutoStart<unknown>(TYPE_HIERARCHY_RESOLVE_METHOD, {
    item,
    resolve: 1,
    direction,
  });
  const resolvedItem = extractRootItem(resolved) ?? item;
  return direction === 1 ? getParents(resolvedItem) : getChildren(resolvedItem);
}

function renderSupersSection(supers: readonly string[]): string {
  if (supers.length === 0) {
    return renderSection('SUPERS', '(none)');
  }
  return renderSection('SUPERS', supers.join(' | '));
}

function renderDerivedSection(derivedByParent: Readonly<Record<string, string[]>>): string {
  const lines = Object.entries(derivedByParent).map(([parent, children]) => {
    if (children.length === 0) {
      return `${parent} => (none)`;
    }
    return `${parent} => ${children.join(', ')}`;
  });
  if (lines.length === 0) {
    return renderSection('DERIVED', '(none)');
  }
  return renderSection('DERIVED', lines.join('\n'));
}

function renderSourceSection(sourceByClass: Readonly<Record<string, SourceLocationSummary>>): string {
  const entries = Object.entries(sourceByClass)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([className, source]) => {
      const summaryPath = formatSummaryPath(source.filePath, source.startLine, source.endLine);
      return [`type ${className}`, `preview: ${source.preview}`, `path: ${summaryPath}`].join('\n');
    });
  if (entries.length === 0) {
    return renderSection('SOURCE', '(none)');
  }
  return renderSection('SOURCE', entries.join('\n---\n'));
}

export async function runTypeHierarchyTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const filePathInput = readString(input, 'filePath');
    const { uri } = resolveInputFilePath(filePathInput);
    const position = readPositionFromInput(input, 'position');
    const maxSuperDepth = readOptionalNonNegativeInteger(input, 'maxSuperDepth', 3);
    const maxSubDepth = readOptionalNonNegativeInteger(input, 'maxSubDepth', 2);
    const maxSubBreadth = readOptionalNonNegativeInteger(input, 'maxSubBreadth', 10);

    const result = await sendRequestWithAutoStart<unknown>(TYPE_HIERARCHY_METHOD, {
      textDocument: { uri },
      position,
      resolve: 0,
      direction: normalizeDirection(undefined, 2),
    });
    const rootItem = extractRootItem(result);
    if (!rootItem) {
      const structured = {
        ok: true,
        root: 'none',
        supers: [] as string[],
        derivedByParent: {} as Record<string, string[]>,
        sourceByClass: {} as Record<
          string,
          { filePath: string; startLine: number; endLine: number; summaryPath: string; preview: string }
        >,
        limits: {
          maxSuperDepth,
          maxSubDepth,
          maxSubBreadth,
        },
        truncated: {
          supers: false,
          derivedDepth: false,
          derivedBreadthByClass: {} as Record<string, number>,
        },
      };
      const text = renderSummaryText(
        {
          total: 0,
          shown: 0,
          truncated: false,
          kind: 'typeHierarchy',
          extras: {
            root: 'none',
          },
        },
        [],
        [renderSection('ROOT', '(none)'), renderSection('NOTE', 'No type hierarchy item found at the requested position.')],
      );
      return successTextResult(text, structured);
    }

    const sourceByClass: Record<string, SourceLocationSummary> = {};
    const lineCache = new Map<string, string[] | null>();
    const symbolRangeCache = new Map<string, TypeSymbolRange[] | null>();
    const addSource = async (item: RawTypeHierarchyItem): Promise<void> => {
      const className = getItemName(item);
      if (!className || sourceByClass[className]) {
        return;
      }
      const location = await toSourceLocation(item, lineCache, symbolRangeCache, className);
      if (location) {
        sourceByClass[className] = location;
      }
    };

    await addSource(rootItem);
    const rootName = getItemName(rootItem) ?? 'Unknown';

    const supers: string[] = [];
    const seenSupers = new Set<string>();
    let supersTruncated = false;
    let superFrontier: RawTypeHierarchyItem[] = [rootItem];

    if (maxSuperDepth === 0) {
      const moreParents = await resolveOneLevel(rootItem, 1);
      supersTruncated = moreParents.length > 0;
    }

    for (let depth = 1; depth <= maxSuperDepth; depth += 1) {
      const nextLevel: RawTypeHierarchyItem[] = [];
      for (const node of superFrontier) {
        const parents = await resolveOneLevel(node, 1);
        for (const parent of parents) {
          await addSource(parent);
          const parentName = getItemName(parent);
          if (parentName && !seenSupers.has(parentName)) {
            seenSupers.add(parentName);
            supers.push(parentName);
          }
          nextLevel.push(parent);
        }
      }
      if (nextLevel.length === 0) {
        break;
      }
      superFrontier = nextLevel;
      if (depth === maxSuperDepth) {
        for (const node of superFrontier) {
          const moreParents = await resolveOneLevel(node, 1);
          if (moreParents.length > 0) {
            supersTruncated = true;
            break;
          }
        }
      }
    }

    const derivedByParent: Record<string, string[]> = {};
    const derivedBreadthByClass: Record<string, number> = {};
    let derivedDepthTruncated = false;
    let subFrontier: RawTypeHierarchyItem[] = [rootItem];

    if (maxSubDepth === 0) {
      const moreChildren = await resolveOneLevel(rootItem, 0);
      derivedDepthTruncated = moreChildren.length > 0;
    }

    for (let depth = 1; depth <= maxSubDepth; depth += 1) {
      const nextLevel: RawTypeHierarchyItem[] = [];
      for (const node of subFrontier) {
        const parentName = getItemName(node);
        if (!parentName) {
          continue;
        }
        const children = await resolveOneLevel(node, 0);
        const keptChildren = maxSubBreadth >= children.length ? children : children.slice(0, maxSubBreadth);
        const omittedCount = children.length - keptChildren.length;
        if (omittedCount > 0) {
          derivedBreadthByClass[parentName] = omittedCount;
        }
        const childNames: string[] = [];
        for (const child of keptChildren) {
          await addSource(child);
          const childName = getItemName(child);
          if (!childName) {
            continue;
          }
          childNames.push(childName);
          nextLevel.push(child);
        }
        if (childNames.length > 0 || parentName === rootName) {
          derivedByParent[parentName] = childNames;
        }
      }
      if (nextLevel.length === 0) {
        break;
      }
      subFrontier = nextLevel;
      if (depth === maxSubDepth) {
        for (const node of subFrontier) {
          const moreChildren = await resolveOneLevel(node, 0);
          if (moreChildren.length > 0) {
            derivedDepthTruncated = true;
            break;
          }
        }
      }
    }
    if (!Object.prototype.hasOwnProperty.call(derivedByParent, rootName)) {
      derivedByParent[rootName] = [];
    }

    const sourceCount = Object.keys(sourceByClass).length;

    const truncated = supersTruncated || derivedDepthTruncated || Object.keys(derivedBreadthByClass).length > 0;
    const counts = {
      total: sourceCount,
      shown: sourceCount,
      truncated,
      kind: 'typeHierarchy',
      extras: {
        root: rootName,
        superCount: supers.length,
        derivedParents: Object.keys(derivedByParent).length,
        maxSuperDepth,
        maxSubDepth,
        maxSubBreadth,
      },
    };
    const text = renderSummaryText(
      counts,
      [],
      [
        renderSection('ROOT', rootName),
        renderSupersSection(supers),
        renderDerivedSection(derivedByParent),
        renderSourceSection(sourceByClass),
      ],
    );

    const structuredSourceByClass = Object.fromEntries(
      Object.entries(sourceByClass).map(([className, source]) => [
        className,
        {
          filePath: source.filePath,
          startLine: source.startLine,
          endLine: source.endLine,
          summaryPath: formatSummaryPath(source.filePath, source.startLine, source.endLine),
          preview: source.preview,
        },
      ]),
    );

    return successTextResult(text, {
      ok: true,
      kind: 'typeHierarchy',
      counts: {
        total: counts.total,
        shown: counts.shown,
        truncated: counts.truncated,
      },
      root: rootName,
      supers,
      derivedByParent,
      sourceByClass: structuredSourceByClass,
      limits: {
        maxSuperDepth,
        maxSubDepth,
        maxSubBreadth,
      },
      truncated: {
        supers: supersTruncated,
        derivedDepth: derivedDepthTruncated,
        derivedBreadthByClass,
      },
    });
  } catch (error) {
    return errorResult(error);
  }
}
