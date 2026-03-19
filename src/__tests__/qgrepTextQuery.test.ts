import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLiteralTextQuery,
  QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK,
  QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED,
} from '../qgrepTextQuery';

test('literal text query splits top-level pipe branches', () => {
  const parsed = parseLiteralTextQuery('A|B|C(');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A', 'B', 'C(']);
  assert.equal(parsed.regexSource, 'A|B|C\\(');
  assert.equal(parsed.hasUppercaseLiteral, true);
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query preserves whitespace around unquoted branches', () => {
  const parsed = parseLiteralTextQuery(' A | B | C( ');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, [' A ', ' B ', ' C( ']);
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query keeps only fully wrapped double-quoted branches intact', () => {
  const parsed = parseLiteralTextQuery('"A|B|C("|F');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A|B|C(', 'F']);
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query requires strict quote boundaries', () => {
  const parsed = parseLiteralTextQuery(' "A|B" ');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, [' "A', 'B" ']);
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query restores escaped pipe in unquoted branches', () => {
  const parsed = parseLiteralTextQuery('A\\|B');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A|B']);
  assert.equal(parsed.regexSource, 'A\\|B');
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query escapes regex metacharacters', () => {
  const parsed = parseLiteralTextQuery('*?[]{}()');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['*?[]{}()']);
  assert.equal(parsed.regexSource, '\\*\\?\\[\\]\\{\\}\\(\\)');
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query treats single quotes as ordinary characters', () => {
  const parsed = parseLiteralTextQuery('\'A|B\'');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['\'A', 'B\'']);
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query treats malformed double quotes as ordinary characters', () => {
  const parsed = parseLiteralTextQuery('"A|B');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['"A', 'B']);
  assert.deepEqual(parsed.queryHints, []);

  const partialQuoted = parseLiteralTextQuery('A|"B');
  assert.equal(partialQuoted.mode, 'union');
  assert.deepEqual(partialQuoted.terms, ['A', '"B']);
  assert.deepEqual(partialQuoted.queryHints, []);

  const extraSuffix = parseLiteralTextQuery('"A|B"C');
  assert.equal(extraSuffix.mode, 'union');
  assert.deepEqual(extraSuffix.terms, ['"A', 'B"C']);
  assert.deepEqual(extraSuffix.queryHints, []);
});

test('literal text query drops whitespace-only branches between pipes', () => {
  const parsed = parseLiteralTextQuery('A| |B');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A', 'B']);
  assert.equal(parsed.regexSource, 'A|B');
  assert.deepEqual(parsed.queryHints, [QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED]);
});

test('literal text query keeps whitespace-only branches at the edges', () => {
  const leading = parseLiteralTextQuery(' |A');
  assert.equal(leading.mode, 'union');
  assert.deepEqual(leading.terms, [' ', 'A']);
  assert.deepEqual(leading.queryHints, []);

  const trailing = parseLiteralTextQuery('A| ');
  assert.equal(trailing.mode, 'union');
  assert.deepEqual(trailing.terms, ['A', ' ']);
  assert.deepEqual(trailing.queryHints, []);
});

test('literal text query falls back to raw literal matching on truly empty branches', () => {
  const emptyBranch = parseLiteralTextQuery('A||B');
  assert.equal(emptyBranch.mode, 'fallback-literal');
  assert.deepEqual(emptyBranch.terms, ['A||B']);
  assert.equal(emptyBranch.regexSource, 'A\\|\\|B');
  assert.deepEqual(emptyBranch.queryHints, [QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK]);
});

test('literal text query keeps query hint order stable across rewrite and fallback', () => {
  const parsed = parseLiteralTextQuery('A|| |B');
  assert.equal(parsed.mode, 'fallback-literal');
  assert.deepEqual(parsed.terms, ['A|| |B']);
  assert.deepEqual(parsed.queryHints, [
    QGREP_QUERY_HINT_WHITESPACE_BRANCH_DISCARDED,
    QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK,
  ]);
});

test('literal text query falls back to raw literal matching on empty quoted branches', () => {
  const emptyQuoted = parseLiteralTextQuery('""');
  assert.equal(emptyQuoted.mode, 'fallback-literal');
  assert.deepEqual(emptyQuoted.terms, ['""']);
  assert.deepEqual(emptyQuoted.queryHints, [QGREP_QUERY_HINT_RAW_LITERAL_FALLBACK]);
});

test('literal text query treats spaced empty quoted text as a literal branch', () => {
  const spacedQuoted = parseLiteralTextQuery(' "" ');
  assert.equal(spacedQuoted.mode, 'union');
  assert.deepEqual(spacedQuoted.terms, [' "" ']);
  assert.deepEqual(spacedQuoted.queryHints, []);
});

test('literal text query allows non-empty queries made only of spaces around content', () => {
  const parsed = parseLiteralTextQuery(' A ');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, [' A ']);
  assert.deepEqual(parsed.queryHints, []);
});

test('literal text query still rejects empty queries', () => {
  assert.throws(
    () => parseLiteralTextQuery(''),
    /query must be a non-empty string\./u,
  );
  assert.throws(
    () => parseLiteralTextQuery('   '),
    /query must be a non-empty string\./u,
  );
});
