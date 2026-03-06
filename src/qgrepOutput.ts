import { compileTextQueryGlobToRegexSource } from './qgrepGlob';

export const QGREP_SEARCH_CONTEXT_LINES_LIMIT = 20;

const QGREP_TEXT_ONLY_TOOL_NAMES = new Set<string>([
  'lm_qgrepSearchText',
  'lm_qgrepSearchFiles',
  'lm_qgrepGetStatus',
]);

export interface QgrepRenderedLine {
  lineNumber: number;
  isMatch: boolean;
  text: string;
}

export interface QgrepRenderedBlock {
  startLine: number;
  endLine: number;
  lines: QgrepRenderedLine[];
}

export interface QgrepLineWindow {
  startLine: number;
  endLine: number;
}

export type CustomToolResponseMode = 'text-only' | 'text-and-structured';
export type QgrepSearchLineMatcher = (lineText: string) => boolean;

/**
 * Parses optional context line counts for qgrep search preview rendering.
 *
 * @param value Raw tool input value.
 * @param key Input key name used in validation errors.
 * @returns Parsed non-negative integer, defaulting to 0 when omitted.
 */
export function parseOptionalContextLineCount(value: unknown, key: string): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number when provided.`);
  }
  const rounded = Math.floor(value);
  if (rounded !== value || rounded < 0 || rounded > QGREP_SEARCH_CONTEXT_LINES_LIMIT) {
    throw new Error(
      `${key} must be an integer between 0 and ${String(QGREP_SEARCH_CONTEXT_LINES_LIMIT)} when provided.`,
    );
  }
  return rounded;
}

export function resolveCustomToolResponseMode(toolName: string): CustomToolResponseMode {
  return QGREP_TEXT_ONLY_TOOL_NAMES.has(toolName) ? 'text-only' : 'text-and-structured';
}

export function requiresStructuredCustomToolResult(toolName: string): boolean {
  return resolveCustomToolResponseMode(toolName) === 'text-and-structured';
}

export function normalizeQgrepOutputPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

export function buildQgrepSearchLineMatcher(
  query: string,
  querySemanticsApplied: string,
  caseModeApplied: string,
): QgrepSearchLineMatcher | undefined {
  if (querySemanticsApplied !== 'glob' && querySemanticsApplied !== 'regex') {
    return undefined;
  }
  if (caseModeApplied !== 'sensitive' && caseModeApplied !== 'insensitive') {
    return undefined;
  }

  try {
    const flags = caseModeApplied === 'insensitive' ? 'iu' : 'u';
    const regexSource = querySemanticsApplied === 'glob'
      ? compileTextQueryGlobToRegexSource(query)
      : query;
    const matcher = new RegExp(regexSource, flags);
    return (lineText: string) => matcher.test(lineText);
  } catch {
    return undefined;
  }
}

export function buildMergedLineWindows(
  matchLines: readonly number[],
  beforeContextLines: number,
  afterContextLines: number,
  totalLines: number,
): QgrepLineWindow[] {
  if (totalLines <= 0) {
    return [];
  }
  const uniqueSorted = normalizeLineNumbers(matchLines, totalLines);
  if (uniqueSorted.length === 0) {
    return [];
  }

  const windows: QgrepLineWindow[] = [];
  for (const line of uniqueSorted) {
    const startLine = clampLineNumber(line - beforeContextLines, totalLines);
    const endLine = clampLineNumber(line + afterContextLines, totalLines);
    const previous = windows[windows.length - 1];
    if (!previous || startLine > previous.endLine + 1) {
      windows.push({ startLine, endLine });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, endLine);
  }
  return windows;
}

export function buildRenderedSearchBlocks(
  fileText: string,
  matchLines: readonly number[],
  beforeContextLines: number,
  afterContextLines: number,
  lineMatcher?: QgrepSearchLineMatcher,
): QgrepRenderedBlock[] {
  const normalizedText = fileText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const allLines = normalizedText.split('\n');
  const totalLines = allLines.length;
  if (totalLines <= 0) {
    return [];
  }
  const normalizedMatches = normalizeLineNumbers(matchLines, totalLines);
  if (normalizedMatches.length === 0) {
    return [];
  }
  const matchSet = new Set<number>(normalizedMatches);
  const windows = buildMergedLineWindows(
    normalizedMatches,
    beforeContextLines,
    afterContextLines,
    totalLines,
  );

  return windows.map((window) => {
    const lines: QgrepRenderedLine[] = [];
    for (let lineNumber = window.startLine; lineNumber <= window.endLine; lineNumber += 1) {
      const text = allLines[lineNumber - 1] ?? '';
      lines.push({
        lineNumber,
        isMatch: matchSet.has(lineNumber) || (lineMatcher?.(text) ?? false),
        text,
      });
    }
    return {
      startLine: window.startLine,
      endLine: window.endLine,
      lines,
    };
  });
}

export function formatQgrepSearchLine(lineNumber: number, isMatch: boolean, text: string): string {
  return `${String(lineNumber)}${isMatch ? ':' : '-'}    ${text}`;
}

export function collectQgrepFileOutputPaths(payload: Record<string, unknown>): string[] {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as { absolutePath?: unknown };
    if (typeof record.absolutePath !== 'string' || record.absolutePath.length === 0) {
      continue;
    }
    const normalized = normalizeQgrepOutputPath(record.absolutePath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function formatQgrepFilesSummary(payload: Record<string, unknown>): string {
  const count = typeof payload.count === 'number' ? payload.count : 0;
  const capped = payload.capped === true;
  const totalAvailable = typeof payload.totalAvailable === 'number' ? payload.totalAvailable : count;
  const totalAvailableCapped = payload.totalAvailableCapped === true;
  const hardLimitHit = payload.hardLimitHit === true;
  const scope = typeof payload.scope === 'string' ? payload.scope : null;
  const maxResultsApplied = typeof payload.maxResultsApplied === 'number'
    ? payload.maxResultsApplied
    : null;
  const maxResultsRequested = typeof payload.maxResultsRequested === 'number'
    ? payload.maxResultsRequested
    : null;
  const querySemanticsApplied = typeof payload.querySemanticsApplied === 'string'
    ? payload.querySemanticsApplied
    : null;
  const query = typeof payload.query === 'string' ? payload.query : '<unknown>';
  const files = collectQgrepFileOutputPaths(payload);
  const lines: string[] = [
    'Qgrep files',
    `query: ${query}`,
    ...(querySemanticsApplied ? [`querySemanticsApplied: ${querySemanticsApplied}`] : []),
    `scope: ${scope ?? 'all initialized workspaces'}`,
    `count: ${count}/${totalAvailable}${totalAvailableCapped ? '+' : ''}${capped ? ' (capped)' : ''}`,
    ...(hardLimitHit ? ['hardLimitHit: true'] : []),
    ...(maxResultsRequested !== null ? [`maxResultsRequested: ${maxResultsRequested}`] : []),
    ...(maxResultsApplied !== null ? [`maxResultsApplied: ${maxResultsApplied}`] : []),
  ];
  if (files.length === 0) {
    lines.push('No files found.');
    return lines.join('\n');
  }
  lines.push('====');
  for (const file of files) {
    lines.push(file);
  }
  return lines.join('\n');
}

function normalizeLineNumbers(values: readonly number[], totalLines: number): number[] {
  const normalized = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value)) {
      continue;
    }
    if (value < 1 || value > totalLines) {
      continue;
    }
    normalized.add(value);
  }
  return [...normalized].sort((left, right) => left - right);
}

function clampLineNumber(lineNumber: number, totalLines: number): number {
  return Math.max(1, Math.min(totalLines, lineNumber));
}
