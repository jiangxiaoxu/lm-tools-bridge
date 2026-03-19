interface ParsedLiteralQueryBranch {
  term: string;
}

class LiteralTextQueryParseError extends Error {}

export const QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED
  = 'whitespace-only branches between pipe separators were discarded.';
export const QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK
  = 'empty literal branches forced raw literal fallback.';

export type ParsedLiteralTextQueryMode = 'union' | 'fallback-literal';

export interface ParsedLiteralTextQuery {
  terms: string[];
  regexSource: string;
  hasUppercaseLiteral: boolean;
  mode: ParsedLiteralTextQueryMode;
  queryHints: string[];
}

interface NormalizedLiteralQueryBranches {
  branches: string[];
  droppedWhitespaceOnlyIntermediateBranches: boolean;
}

export function parseLiteralTextQuery(query: string): ParsedLiteralTextQuery {
  if (query.trim().length === 0) {
    throw new Error('query must be a non-empty string.');
  }

  const normalizedBranches = normalizeLiteralQueryBranches(splitLiteralQueryBranches(query));
  const queryHints = normalizedBranches.droppedWhitespaceOnlyIntermediateBranches
    ? [QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED]
    : [];

  try {
    const parsedBranches = normalizedBranches.branches.map((branch) => parseLiteralQueryBranch(branch));
    return buildParsedLiteralTextQuery(
      parsedBranches.map((branch) => branch.term),
      'union',
      queryHints,
    );
  } catch (error) {
    if (!(error instanceof LiteralTextQueryParseError)) {
      throw error;
    }
    return buildRawLiteralTextQuery(query, [
      ...queryHints,
      QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK,
    ]);
  }
}

export function buildRawLiteralTextQuery(
  query: string,
  queryHints: readonly string[] = [],
): ParsedLiteralTextQuery {
  return buildParsedLiteralTextQuery([query], 'fallback-literal', queryHints);
}

function normalizeLiteralQueryBranches(branches: readonly string[]): NormalizedLiteralQueryBranches {
  let droppedWhitespaceOnlyIntermediateBranches = false;
  const normalizedBranches = branches.filter((branch, index) => {
    if (!/^\s+$/u.test(branch)) {
      return true;
    }
    const keepBranch = index === 0 || index === branches.length - 1;
    if (!keepBranch) {
      droppedWhitespaceOnlyIntermediateBranches = true;
    }
    return keepBranch;
  });
  return {
    branches: normalizedBranches,
    droppedWhitespaceOnlyIntermediateBranches,
  };
}

function splitLiteralQueryBranches(query: string): string[] {
  const branches: string[] = [];
  let current = '';

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (char === '"' && current.length === 0 && !hasEscapedPipeBoundary(query, index)) {
      const quotedBranch = tryConsumeQuotedBranch(query, index);
      if (quotedBranch) {
        current += quotedBranch.segment;
        index = quotedBranch.endIndex;
        continue;
      }
    }
    if (char === '|' && !hasEscapedPipeBoundary(query, index)) {
      branches.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  branches.push(current);
  return branches;
}

function parseLiteralQueryBranch(rawBranch: string): ParsedLiteralQueryBranch {
  if (rawBranch.length === 0) {
    throw new LiteralTextQueryParseError('query literal branches must not be empty.');
  }

  const quote = getWrappedBranchQuote(rawBranch);
  if (!quote) {
    return {
      term: decodeUnquotedLiteralBranch(rawBranch),
    };
  }

  const inner = rawBranch.slice(1, -1);
  if (inner.length === 0) {
    throw new LiteralTextQueryParseError('query literal branches must not be empty.');
  }
  return {
    term: decodeQuotedLiteralBranch(inner, quote),
  };
}

function getWrappedBranchQuote(branch: string): '"' | undefined {
  if (branch.length < 2) {
    return undefined;
  }
  const first = branch[0];
  const last = branch[branch.length - 1];
  if (first === '"' && last === '"') {
    return '"';
  }
  return undefined;
}

function decodeQuotedLiteralBranch(branch: string, quote: '"'): string {
  let result = '';
  for (let index = 0; index < branch.length; index += 1) {
    const char = branch[index];
    if (char === '\\') {
      const next = branch[index + 1];
      if (next === quote || next === '\\') {
        result += next;
        index += 1;
        continue;
      }
    }
    result += char;
  }
  return result;
}

function tryConsumeQuotedBranch(
  query: string,
  startIndex: number,
): { segment: string; endIndex: number } | undefined {
  let segment = '"';
  for (let index = startIndex + 1; index < query.length; index += 1) {
    const char = query[index];
    segment += char;
    if (char === '\\') {
      const next = query[index + 1];
      if (next === '"' || next === '\\') {
        segment += next;
        index += 1;
      }
      continue;
    }
    if (char !== '"') {
      continue;
    }
    const next = query[index + 1];
    if (next === undefined || (next === '|' && !hasEscapedPipeBoundary(query, index + 1))) {
      return {
        segment,
        endIndex: index,
      };
    }
    return undefined;
  }
  return undefined;
}

function decodeUnquotedLiteralBranch(branch: string): string {
  let result = '';
  for (let index = 0; index < branch.length; index += 1) {
    const char = branch[index];
    const next = branch[index + 1];
    if (char === '\\' && next === '|') {
      result += '|';
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function hasEscapedPipeBoundary(query: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let scan = index - 1; scan >= 0 && query[scan] === '\\'; scan -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function buildParsedLiteralTextQuery(
  terms: string[],
  mode: ParsedLiteralTextQueryMode,
  queryHints: readonly string[] = [],
): ParsedLiteralTextQuery {
  return {
    terms,
    regexSource: terms.map((term) => escapeRegex(term)).join('|'),
    hasUppercaseLiteral: terms.some((term) => /[A-Z]/u.test(term)),
    mode,
    queryHints: [...queryHints],
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
