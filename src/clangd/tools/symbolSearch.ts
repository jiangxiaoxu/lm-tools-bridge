import * as vscode from 'vscode';
import { WORKSPACE_SYMBOL_METHOD } from '../methods';
import { sendRequestWithAutoStart } from '../transport';
import { renderSummaryText, type SummaryEntry } from '../format/aiSummary';
import { resolveInputFilePath } from '../workspacePath';
import { ClangdToolError } from '../errors';
import { errorResult, readString, successTextResult } from './shared';
import {
  extractLocations,
  locationToSummaryPath,
  parseLimit,
  parseStringArray,
  resolveSymbolSignature,
  type FlatLocation,
} from './aiCommon';

const SYMBOL_KIND_LABELS: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enumMember',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'typeParameter',
};

function normalizeMatchMode(value: unknown): 'exact' | 'regex' {
  if (value === undefined) {
    return 'exact';
  }
  if (value === 'exact' || value === 'regex') {
    return value;
  }
  throw new ClangdToolError('INVALID_INPUT', "Expected 'matchMode' to be either 'exact' or 'regex'.");
}

function buildRegex(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch (error) {
    throw new ClangdToolError('INVALID_INPUT', `Invalid regex query: ${String(error)}`);
  }
}

function deriveWorkspaceSymbolSeed(query: string): string {
  const tokens = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (tokens.length === 0) {
    return '';
  }
  return tokens.sort((left, right) => right.length - left.length)[0] ?? '';
}

function normalizeKindFilterKinds(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function matchesScope(filePath: string, scopePath: string | undefined): boolean {
  if (!scopePath) {
    return true;
  }
  const normalizedFilePath = vscode.Uri.file(filePath).fsPath.toLowerCase();
  const normalizedScope = vscode.Uri.file(scopePath).fsPath.toLowerCase();
  if (normalizedFilePath === normalizedScope) {
    return true;
  }
  return normalizedFilePath.startsWith(`${normalizedScope}\\`) || normalizedFilePath.startsWith(`${normalizedScope}/`);
}

interface SymbolSearchCandidate {
  name: string;
  kind: string;
  containerName?: string;
  location: FlatLocation;
  summaryPath: string;
}

export async function runSymbolSearchTool(input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
  try {
    const query = readString(input, 'query');
    const matchMode = normalizeMatchMode(input.matchMode);
    const limit = parseLimit(input, 'limit', 50, 200);
    const kindFilter = normalizeKindFilterKinds(parseStringArray(input, 'kinds'));

    let scopePath: string | undefined;
    if (typeof input.scopePath === 'string' && input.scopePath.trim().length > 0) {
      scopePath = resolveInputFilePath(input.scopePath).absoluteFilePath;
    }

    const regex = matchMode === 'regex' ? buildRegex(query) : undefined;
    const seedQuery = matchMode === 'exact' ? query : deriveWorkspaceSymbolSeed(query);
    const raw = await sendRequestWithAutoStart<unknown>(WORKSPACE_SYMBOL_METHOD, { query: seedQuery });
    const items = Array.isArray(raw) ? raw : [];

    const allCandidates: SymbolSearchCandidate[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : '';
      if (!name) {
        continue;
      }
      const matched = matchMode === 'exact' ? name === query : Boolean(regex?.test(name));
      if (!matched) {
        continue;
      }
      const kindNumber = typeof record.kind === 'number' ? record.kind : -1;
      const kindLabel = SYMBOL_KIND_LABELS[kindNumber] ?? 'symbol';
      if (kindFilter.size > 0 && !kindFilter.has(kindLabel)) {
        continue;
      }
      const locations = extractLocations(record.location);
      const location = locations[0];
      if (!location) {
        continue;
      }
      if (!matchesScope(location.filePath, scopePath)) {
        continue;
      }
      const containerName = typeof record.containerName === 'string' ? record.containerName : '';
      const summaryPath = locationToSummaryPath(location);
      allCandidates.push({
        name,
        kind: kindLabel,
        containerName: containerName || undefined,
        location,
        summaryPath,
      });
    }

    const shownCandidates = allCandidates.slice(0, limit);
    const lineCache = new Map<string, string[] | null>();
    const shownEntries: SummaryEntry[] = [];
    const shownStructuredEntries: Array<Record<string, unknown>> = [];
    for (const candidate of shownCandidates) {
      const signature = await resolveSymbolSignature(candidate.location, lineCache);
      const baseSummary = candidate.containerName
        ? `${candidate.kind} ${candidate.name} (${candidate.containerName})`
        : `${candidate.kind} ${candidate.name}`;
      const signatureText = signature.signature ?? '(none)';
      shownEntries.push({
        location: candidate.summaryPath,
        summary: `${baseSummary} | signature: ${signatureText}`,
      });
      shownStructuredEntries.push({
        name: candidate.name,
        kind: candidate.kind,
        containerName: candidate.containerName,
        location: {
          path: candidate.summaryPath,
          filePath: candidate.location.filePath,
          startLine: candidate.location.startLine,
          startCharacter: candidate.location.startCharacter,
          endLine: candidate.location.endLine,
          endCharacter: candidate.location.endCharacter,
        },
        signature: signature.signature,
        signatureSource: signature.source,
      });
    }
    const counts = {
      total: allCandidates.length,
      shown: shownEntries.length,
      truncated: allCandidates.length > shownEntries.length,
      kind: 'symbolSearch',
      extras: {
        matchMode,
      },
    };
    const text = renderSummaryText(
      counts,
      shownEntries,
    );
    return successTextResult(text, {
      kind: 'symbolSearch',
      query,
      matchMode,
      counts: {
        total: counts.total,
        shown: counts.shown,
        truncated: counts.truncated,
      },
      entries: shownStructuredEntries,
    });
  } catch (error) {
    return errorResult(error);
  }
}
