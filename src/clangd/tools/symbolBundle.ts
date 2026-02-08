import * as vscode from 'vscode';
import { renderSection, renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import { ClangdToolError } from '../errors';
import { readOptionalInteger, readPositionFromInput, readString, successTextResult, errorResult } from './shared';
import { resolveInputFilePath } from '../workspacePath';
import { runCallHierarchyTool } from './callHierarchy';
import { runSymbolImplementationsTool } from './symbolImplementations';
import { runSymbolInfoTool } from './symbolInfo';
import { runSymbolReferencesTool } from './symbolReferences';
import { runSymbolSearchTool } from './symbolSearch';

interface BundleTarget {
  filePath: string;
  line: number;
  character: number;
  label: string;
  path: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getStructuredContent(result: vscode.LanguageModelToolResult): Record<string, unknown> | undefined {
  const structured = (result as vscode.LanguageModelToolResult & { structuredContent?: unknown }).structuredContent;
  return asRecord(structured);
}

function getOptionalPositiveInteger(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maxValue: number,
): number {
  const value = readOptionalInteger(input, key);
  if (value === undefined) {
    return defaultValue;
  }
  if (value <= 0) {
    throw new ClangdToolError('INVALID_INPUT', `Expected '${key}' to be a positive integer when provided.`);
  }
  return Math.min(value, maxValue);
}

function parseMatchMode(input: Record<string, unknown>): 'exact' | 'regex' | undefined {
  const raw = input.matchMode;
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'exact' || raw === 'regex') {
    return raw;
  }
  throw new ClangdToolError('INVALID_INPUT', "Expected 'matchMode' to be 'exact' or 'regex'.");
}

function parseDirection(input: Record<string, unknown>): 'incoming' | 'outgoing' | 'both' {
  const raw = input.callDirection;
  if (raw === undefined) {
    return 'both';
  }
  if (raw === 'incoming' || raw === 'outgoing' || raw === 'both') {
    return raw;
  }
  throw new ClangdToolError('INVALID_INPUT', "Expected 'callDirection' to be incoming, outgoing, or both.");
}

function buildTargetFromPosition(input: Record<string, unknown>): BundleTarget | undefined {
  if (input.filePath === undefined || input.position === undefined) {
    return undefined;
  }
  const filePathInput = readString(input, 'filePath');
  const { absoluteFilePath } = resolveInputFilePath(filePathInput);
  const position = readPositionFromInput(input, 'position');
  const line = position.line + 1;
  const character = position.character + 1;
  return {
    filePath: absoluteFilePath,
    line,
    character,
    label: `${absoluteFilePath}:${line}:${character}`,
    path: `${absoluteFilePath}#${line}`,
  };
}

function buildTargetFromSearch(
  searchStructured: Record<string, unknown>,
  candidateIndexOneBased: number,
): { target: BundleTarget; candidates: Array<Record<string, unknown>> } {
  const entries = Array.isArray(searchStructured.entries) ? searchStructured.entries : [];
  const candidates = entries
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (candidates.length === 0) {
    throw new ClangdToolError('INVALID_INPUT', 'No symbols matched the query.');
  }
  const index = Math.min(Math.max(candidateIndexOneBased - 1, 0), candidates.length - 1);
  const selected = candidates[index];
  const location = asRecord(selected.location);
  if (!location) {
    throw new ClangdToolError('REQUEST_FAILED', 'Selected symbol has no location.');
  }
  const filePath = typeof location.filePath === 'string' ? location.filePath : undefined;
  const startLine = typeof location.startLine === 'number' ? location.startLine : undefined;
  const startCharacter = typeof location.startCharacter === 'number' ? location.startCharacter : undefined;
  const path = typeof location.path === 'string' ? location.path : undefined;
  if (!filePath || !startLine || !startCharacter) {
    throw new ClangdToolError('REQUEST_FAILED', 'Selected symbol has incomplete location.');
  }
  const name = typeof selected.name === 'string' ? selected.name : '(unknown)';
  return {
    target: {
      filePath,
      line: startLine,
      character: startCharacter,
      label: name,
      path: path ?? `${filePath}#${startLine}`,
    },
    candidates,
  };
}

function entryFromStructuredItem(item: Record<string, unknown>, prefix?: string): SummaryEntry | undefined {
  const location = asRecord(item.location);
  const path = location && typeof location.path === 'string' ? location.path : undefined;
  const summary = typeof item.summary === 'string' ? item.summary : undefined;
  if (!path || !summary) {
    return undefined;
  }
  return {
    location: path,
    summary: prefix ? `${prefix} ${summary}` : summary,
  };
}

function renderStructuredEntriesSection(
  title: string,
  entries: readonly Record<string, unknown>[],
): string {
  if (entries.length === 0) {
    return renderSection(title, '(none)');
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const summaryEntry = entryFromStructuredItem(entry);
    if (!summaryEntry) {
      continue;
    }
    lines.push(`${summaryEntry.location}\n${summaryEntry.summary}`);
  }
  return renderSection(title, lines.length > 0 ? lines.join('\n---\n') : '(none)');
}

export async function runSymbolBundleTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const query = typeof input.query === 'string' && input.query.trim().length > 0 ? input.query.trim() : undefined;
    const matchMode = parseMatchMode(input);
    const candidateLimit = getOptionalPositiveInteger(input, 'candidateLimit', 20, 100);
    const candidateIndex = getOptionalPositiveInteger(input, 'candidateIndex', 1, 100);
    const referencesLimit = getOptionalPositiveInteger(input, 'referencesLimit', 120, 500);
    const implementationsLimit = getOptionalPositiveInteger(input, 'implementationsLimit', 80, 300);
    const includeDeclaration = Boolean(input.includeDeclaration);
    const includeSnippet = input.includeSnippet === undefined ? true : Boolean(input.includeSnippet);
    const snippetMaxLines = getOptionalPositiveInteger(input, 'snippetMaxLines', 20, 120);
    const callDirection = parseDirection(input);
    const callMaxDepth = getOptionalPositiveInteger(input, 'callMaxDepth', 2, 6);
    const callMaxBreadth = getOptionalPositiveInteger(input, 'callMaxBreadth', 20, 80);

    const targetFromPosition = buildTargetFromPosition(input);
    let target: BundleTarget;
    let candidates: Array<Record<string, unknown>> = [];

    if (targetFromPosition) {
      target = targetFromPosition;
    } else if (query) {
      const searchInput: Record<string, unknown> = {
        query,
        limit: candidateLimit,
      };
      if (matchMode) {
        searchInput.matchMode = matchMode;
      }
      if (Array.isArray(input.kinds)) {
        searchInput.kinds = input.kinds;
      }
      if (typeof input.scopePath === 'string' && input.scopePath.trim().length > 0) {
        searchInput.scopePath = input.scopePath;
      }
      const searchResult = await runSymbolSearchTool(searchInput);
      const searchStructured = getStructuredContent(searchResult);
      if (!searchStructured) {
        throw new ClangdToolError('REQUEST_FAILED', 'Symbol search structured output is unavailable.');
      }
      const selected = buildTargetFromSearch(searchStructured, candidateIndex);
      target = selected.target;
      candidates = selected.candidates;
    } else {
      throw new ClangdToolError(
        'INVALID_INPUT',
        "Provide either 'query' (optionally with matchMode) or 'filePath' + 'position'.",
      );
    }

    const symbolInfoResult = await runSymbolInfoTool({
      filePath: target.filePath,
      position: { line: target.line, character: target.character },
      includeSnippet,
      snippetMaxLines,
    });
    const symbolInfoStructured = getStructuredContent(symbolInfoResult) ?? {};

    const referencesResult = await runSymbolReferencesTool({
      filePath: target.filePath,
      position: { line: target.line, character: target.character },
      includeDeclaration,
      limit: referencesLimit,
    });
    const referencesStructured = getStructuredContent(referencesResult) ?? {};
    const referenceEntries = Array.isArray(referencesStructured.entries)
      ? referencesStructured.entries.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];

    const implementationsResult = await runSymbolImplementationsTool({
      filePath: target.filePath,
      position: { line: target.line, character: target.character },
      limit: implementationsLimit,
    });
    const implementationsStructured = getStructuredContent(implementationsResult) ?? {};
    const implementationEntries = Array.isArray(implementationsStructured.entries)
      ? implementationsStructured.entries.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];

    const callHierarchyResult = await runCallHierarchyTool({
      filePath: target.filePath,
      position: { line: target.line, character: target.character },
      direction: callDirection,
      maxDepth: callMaxDepth,
      maxBreadth: callMaxBreadth,
    });
    const callHierarchyStructured = getStructuredContent(callHierarchyResult) ?? {};
    const incomingEntries = Array.isArray(callHierarchyStructured.incoming)
      ? callHierarchyStructured.incoming.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];
    const outgoingEntries = Array.isArray(callHierarchyStructured.outgoing)
      ? callHierarchyStructured.outgoing.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];

    const aggregateEntries: SummaryEntry[] = [];
    for (const entry of referenceEntries) {
      const summaryEntry = entryFromStructuredItem(entry, '[ref]');
      if (summaryEntry) {
        aggregateEntries.push(summaryEntry);
      }
    }
    for (const entry of implementationEntries) {
      const summaryEntry = entryFromStructuredItem(entry, '[impl]');
      if (summaryEntry) {
        aggregateEntries.push(summaryEntry);
      }
    }
    for (const entry of incomingEntries) {
      const path = typeof entry.path === 'string' ? entry.path : undefined;
      const summary = typeof entry.summary === 'string' ? entry.summary : undefined;
      if (path && summary) {
        aggregateEntries.push({ location: path, summary: `[in] ${summary}` });
      }
    }
    for (const entry of outgoingEntries) {
      const path = typeof entry.path === 'string' ? entry.path : undefined;
      const summary = typeof entry.summary === 'string' ? entry.summary : undefined;
      if (path && summary) {
        aggregateEntries.push({ location: path, summary: `[out] ${summary}` });
      }
    }

    const referenceCounts = asRecord(referencesStructured.counts) ?? {};
    const implementationCounts = asRecord(implementationsStructured.counts) ?? {};
    const callCounts = asRecord(callHierarchyStructured.counts) ?? {};

    const total = Number(referenceCounts.total ?? 0) + Number(implementationCounts.total ?? 0) + Number(callCounts.total ?? 0);
    const shown = Number(referenceCounts.shown ?? 0) + Number(implementationCounts.shown ?? 0) + Number(callCounts.shown ?? 0);
    const truncated = Boolean(referenceCounts.truncated) || Boolean(implementationCounts.truncated) || Boolean(callCounts.truncated);

    const infoEntries = Array.isArray(symbolInfoStructured.entries)
      ? symbolInfoStructured.entries.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== undefined)
      : [];

    const sections = [
      renderSection('TARGET', `${target.path}\n${target.label}`),
      renderSection('CANDIDATES', candidates.length > 0
        ? candidates
          .map((candidate, index) => {
            const location = asRecord(candidate.location);
            const path = location && typeof location.path === 'string' ? location.path : '(unknown)';
            const name = typeof candidate.name === 'string' ? candidate.name : '(unknown)';
            const kind = typeof candidate.kind === 'string' ? candidate.kind : 'symbol';
            const container = typeof candidate.containerName === 'string' ? candidate.containerName : '';
            const signature = typeof candidate.signature === 'string' ? candidate.signature : null;
            const signatureText = signature ?? '(none)';
            const base = container.length > 0 ? `${kind} ${name} (${container})` : `${kind} ${name}`;
            return `${index + 1}. ${path}\n${base} | signature: ${signatureText}`;
          })
          .join('\n---\n')
        : '(none)'),
      renderStructuredEntriesSection('SYMBOL_INFO', infoEntries),
      renderStructuredEntriesSection('REFERENCES_TOP', referenceEntries),
      renderStructuredEntriesSection('IMPLEMENTATIONS_TOP', implementationEntries),
      renderSection('CALLS_INCOMING', incomingEntries.length > 0
        ? incomingEntries.map((entry) => `${entry.path as string}\n${entry.summary as string}`).join('\n---\n')
        : '(none)'),
      renderSection('CALLS_OUTGOING', outgoingEntries.length > 0
        ? outgoingEntries.map((entry) => `${entry.path as string}\n${entry.summary as string}`).join('\n---\n')
        : '(none)'),
    ];

    const text = renderSummaryText(
      {
        total,
        shown,
        truncated,
        kind: 'symbolBundle',
        extras: {
          candidates: candidates.length,
          includeDeclaration,
          includeSnippet,
          callDirection,
        },
      },
      aggregateEntries,
      sections,
    );

    return successTextResult(text, {
      kind: 'symbolBundle',
      target,
      counts: {
        total,
        shown,
        truncated,
      },
      candidates,
      symbolInfo: symbolInfoStructured,
      references: referencesStructured,
      implementations: implementationsStructured,
      callHierarchy: callHierarchyStructured,
      options: {
        includeDeclaration,
        includeSnippet,
        snippetMaxLines,
        callDirection,
        callMaxDepth,
        callMaxBreadth,
      },
    });
  } catch (error) {
    return errorResult(error);
  }
}
