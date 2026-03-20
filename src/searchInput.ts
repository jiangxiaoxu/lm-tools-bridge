export type FindTextQuerySyntax = 'literal' | 'regex';
export type QgrepTextQuerySyntax = 'literal' | 'regex';
export type QgrepFilesQuerySyntax = 'glob' | 'regex';
type SupportedQuerySyntax = FindTextQuerySyntax | QgrepTextQuerySyntax | QgrepFilesQuerySyntax;

interface ParseQuerySyntaxOptions<TSyntax extends SupportedQuerySyntax> {
  input: Record<string, unknown>;
  toolName: string;
  allowed: readonly TSyntax[];
  defaultSyntax: TSyntax;
}

const LEGACY_IS_REGEXP_KEY = 'isRegexp';
const QUERY_SYNTAX_KEY = 'querySyntax';

export function parseQuerySyntax<TSyntax extends SupportedQuerySyntax>(
  options: ParseQuerySyntaxOptions<TSyntax>,
): TSyntax {
  const { input, toolName, allowed, defaultSyntax } = options;

  if (Object.prototype.hasOwnProperty.call(input, LEGACY_IS_REGEXP_KEY) && input[LEGACY_IS_REGEXP_KEY] !== undefined) {
    throw new Error(
      `isRegexp is no longer supported for ${toolName}. `
      + `Use querySyntax='regex' for regular expression mode, or omit querySyntax to keep ${defaultSyntax} mode.`,
    );
  }

  const value = input[QUERY_SYNTAX_KEY];
  if (value === undefined || value === null) {
    return defaultSyntax;
  }
  if (typeof value !== 'string') {
    throw new Error('querySyntax must be a string when provided.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('querySyntax must be a non-empty string when provided.');
  }
  if (!allowed.includes(trimmed as TSyntax)) {
    throw new Error(`querySyntax must be one of: ${formatQuerySyntaxValues(allowed)}.`);
  }
  return trimmed as TSyntax;
}

export function parseOptionalPathScope(input: Record<string, unknown>): string | undefined {
  const value = input.pathScope;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('pathScope must be a string when provided.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('pathScope must be a non-empty string when provided.');
  }
  ensureNoBarePipeAlternation(
    trimmed,
    "pathScope does not support '|' alternation. "
    + "Use '{A,B}' for glob alternatives, or move alternation into query with querySyntax='regex'.",
  );
  return trimmed;
}

export function ensureNoBarePipeAlternation(value: string, errorMessage: string): void {
  if (hasBarePipeAlternation(value)) {
    throw new Error(errorMessage);
  }
}

function formatQuerySyntaxValues(values: readonly SupportedQuerySyntax[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

function hasBarePipeAlternation(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '|') {
      continue;
    }
    let precedingBackslashes = 0;
    for (let scan = index - 1; scan >= 0 && value[scan] === '\\'; scan -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 0) {
      return true;
    }
  }
  return false;
}
