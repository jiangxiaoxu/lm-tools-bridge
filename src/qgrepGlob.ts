function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function escapeRegexCharClass(char: string): string {
  if (char === '\\' || char === ']' || char === '^') {
    return `\\${char}`;
  }
  return char;
}

interface GlobPatternParserState {
  pattern: string;
  index: number;
  contextLabel: string;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function normalizeQueryGlobErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.startsWith('Invalid query glob pattern')) {
    return message;
  }
  return `Invalid query glob pattern: ${message}`;
}

export function normalizeFilesQueryGlobErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  if (message.startsWith('Invalid query glob pattern')) {
    return message;
  }
  if (message.startsWith('Invalid includePattern glob pattern')) {
    return message.replace('Invalid includePattern glob pattern', 'Invalid query glob pattern');
  }
  return `Invalid query glob pattern: ${message}`;
}

export function isGlobMetaCharacter(char: string): boolean {
  return char === '*' || char === '?' || char === '[' || char === ']' || char === '{' || char === '}';
}

export function hasUnescapedGlobMeta(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      const next = pattern[index + 1];
      if (next && isGlobMetaCharacter(next)) {
        index += 1;
      }
      continue;
    }
    if (isGlobMetaCharacter(char)) {
      return true;
    }
  }
  return false;
}

function normalizeWorkspaceSearchGlobPatternWithContext(pattern: string, contextLabel: string): string {
  const trimmed = pattern.trim();
  let normalized = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '/') {
      normalized += '/';
      continue;
    }
    if (char !== '\\') {
      normalized += char;
      continue;
    }

    const next = trimmed[index + 1];
    if (next === undefined) {
      throw new Error(`Invalid ${contextLabel}: trailing escape (\\).`);
    }
    if (next === '/' || next === '\\') {
      normalized += '/';
      index += 1;
      continue;
    }
    if (isGlobMetaCharacter(next) || next === ',') {
      const previousNormalizedChar = normalized.length > 0 ? normalized[normalized.length - 1] : '';
      const treatAsEscape = previousNormalizedChar === '' || previousNormalizedChar === '/';
      if (treatAsEscape) {
        normalized += `\\${next}`;
        index += 1;
        continue;
      }
    }

    normalized += '/';
  }

  const hasUncPrefix = normalized.startsWith('//');
  const uncSafeNormalized = hasUncPrefix
    ? `//${normalized.slice(2).replace(/\/{2,}/g, '/')}`
    : normalized.replace(/\/{2,}/g, '/');

  return uncSafeNormalized.replace(/^\.\//u, '');
}

export function normalizeWorkspaceSearchGlobPattern(pattern: string): string {
  return normalizeWorkspaceSearchGlobPatternWithContext(pattern, 'includePattern glob pattern');
}

export function normalizeQueryGlobPattern(pattern: string): string {
  return normalizeWorkspaceSearchGlobPatternWithContext(pattern, 'query glob pattern');
}

export function normalizeFilesQueryGlobPattern(pattern: string): string {
  const normalized = normalizeQueryGlobPattern(pattern);
  const withoutLeadingSlash = normalized.replace(/^\/+/u, '');
  if (withoutLeadingSlash.length === 0) {
    return '**/*';
  }
  if (!withoutLeadingSlash.includes('/')) {
    return `**/${withoutLeadingSlash}`;
  }
  return withoutLeadingSlash;
}

export function compileGlobToRegexSource(glob: string, contextLabel: string): string {
  const state: GlobPatternParserState = {
    pattern: glob,
    index: 0,
    contextLabel,
  };
  const source = parseGlobSequence(state, '');
  if (state.index !== state.pattern.length) {
    throw new Error(`Invalid ${contextLabel} near index ${String(state.index)}.`);
  }
  return source;
}

function parseGlobSequence(state: GlobPatternParserState, stopChars: string): string {
  let result = '';
  while (state.index < state.pattern.length) {
    const char = state.pattern[state.index];
    if (stopChars.includes(char)) {
      break;
    }

    if (char === '\\') {
      state.index += 1;
      if (state.index >= state.pattern.length) {
        throw new Error(`Invalid ${state.contextLabel}: trailing escape (\\).`);
      }
      const escaped = state.pattern[state.index];
      result += escapeRegex(escaped);
      state.index += 1;
      continue;
    }

    if (char === '*') {
      if (state.pattern[state.index + 1] === '*') {
        let endIndex = state.index + 1;
        while (state.pattern[endIndex + 1] === '*') {
          endIndex += 1;
        }
        state.index = endIndex + 1;
        if (state.pattern[state.index] === '/') {
          state.index += 1;
          result += '(.*/)?';
        } else {
          result += '.*';
        }
        continue;
      }
      state.index += 1;
      result += '[^/]*';
      continue;
    }

    if (char === '?') {
      state.index += 1;
      result += '[^/]';
      continue;
    }

    if (char === '[') {
      result += parseGlobCharClass(state);
      continue;
    }

    if (char === '{') {
      result += parseGlobBraceGroup(state);
      continue;
    }

    if (char === '/') {
      result += '/';
      state.index += 1;
      while (state.pattern[state.index] === '/') {
        state.index += 1;
      }
      continue;
    }

    result += escapeRegex(char);
    state.index += 1;
  }
  return result;
}

function parseGlobCharClass(state: GlobPatternParserState): string {
  state.index += 1;
  if (state.index >= state.pattern.length) {
    throw new Error(`Invalid ${state.contextLabel}: unterminated character class.`);
  }

  let negated = false;
  const first = state.pattern[state.index];
  if (first === '!' || first === '^') {
    negated = true;
    state.index += 1;
  }

  let content = '';
  let hasContent = false;
  while (state.index < state.pattern.length) {
    const char = state.pattern[state.index];
    if (char === ']' && hasContent) {
      state.index += 1;
      return `[${negated ? '^' : ''}${content}]`;
    }

    if (char === '\\') {
      state.index += 1;
      if (state.index >= state.pattern.length) {
        throw new Error(`Invalid ${state.contextLabel}: unterminated escape in character class.`);
      }
      content += escapeRegexCharClass(state.pattern[state.index]);
      hasContent = true;
      state.index += 1;
      continue;
    }

    if (char === '/') {
      content += '\\/';
      hasContent = true;
      state.index += 1;
      continue;
    }

    content += escapeRegexCharClass(char);
    hasContent = true;
    state.index += 1;
  }

  throw new Error(`Invalid ${state.contextLabel}: unterminated character class.`);
}

function parseGlobBraceGroup(state: GlobPatternParserState): string {
  state.index += 1;
  const branches: string[] = [];
  while (true) {
    const branch = parseGlobSequence(state, ',}');
    branches.push(branch);
    if (state.index >= state.pattern.length) {
      throw new Error(`Invalid ${state.contextLabel}: unterminated brace expression.`);
    }
    const token = state.pattern[state.index];
    if (token === ',') {
      state.index += 1;
      continue;
    }
    if (token === '}') {
      state.index += 1;
      break;
    }
  }
  return `(${branches.join('|')})`;
}
