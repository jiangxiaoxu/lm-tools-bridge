import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLiteralTextQuery } from '../qgrepTextQuery';

test('literal text query splits top-level pipe branches', () => {
  const parsed = parseLiteralTextQuery('A|B|C(');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A', 'B', 'C(']);
  assert.equal(parsed.regexSource, 'A|B|C\\(');
  assert.equal(parsed.hasUppercaseLiteral, true);
});

test('literal text query trims unquoted branches', () => {
  const parsed = parseLiteralTextQuery(' A | B | C( ');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A', 'B', 'C(']);
});

test('literal text query keeps only fully wrapped double-quoted branches intact', () => {
  const parsed = parseLiteralTextQuery('"A|B|C("|F');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A|B|C(', 'F']);
});

test('literal text query restores escaped pipe in unquoted branches', () => {
  const parsed = parseLiteralTextQuery('A\\|B');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['A|B']);
  assert.equal(parsed.regexSource, 'A\\|B');
});

test('literal text query escapes regex metacharacters', () => {
  const parsed = parseLiteralTextQuery('*?[]{}()');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['*?[]{}()']);
  assert.equal(parsed.regexSource, '\\*\\?\\[\\]\\{\\}\\(\\)');
});

test('literal text query treats single quotes as ordinary characters', () => {
  const parsed = parseLiteralTextQuery('\'A|B\'');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['\'A', 'B\'']);
});

test('literal text query treats malformed double quotes as ordinary characters', () => {
  const parsed = parseLiteralTextQuery('"A|B');
  assert.equal(parsed.mode, 'union');
  assert.deepEqual(parsed.terms, ['"A', 'B']);

  const partialQuoted = parseLiteralTextQuery('A|"B');
  assert.equal(partialQuoted.mode, 'union');
  assert.deepEqual(partialQuoted.terms, ['A', '"B']);

  const extraSuffix = parseLiteralTextQuery('"A|B"C');
  assert.equal(extraSuffix.mode, 'union');
  assert.deepEqual(extraSuffix.terms, ['"A', 'B"C']);
});

test('literal text query falls back to raw literal matching on empty branches', () => {
  const emptyBranch = parseLiteralTextQuery('A||B');
  assert.equal(emptyBranch.mode, 'fallback-literal');
  assert.deepEqual(emptyBranch.terms, ['A||B']);
  assert.equal(emptyBranch.regexSource, 'A\\|\\|B');

  const whitespaceBranch = parseLiteralTextQuery('A| |B');
  assert.equal(whitespaceBranch.mode, 'fallback-literal');
  assert.deepEqual(whitespaceBranch.terms, ['A| |B']);
  assert.equal(whitespaceBranch.regexSource, 'A\\| \\|B');
});

test('literal text query falls back to raw literal matching on empty quoted branches', () => {
  const emptyQuoted = parseLiteralTextQuery('""');
  assert.equal(emptyQuoted.mode, 'fallback-literal');
  assert.deepEqual(emptyQuoted.terms, ['""']);

  const spacedQuoted = parseLiteralTextQuery(' "" ');
  assert.equal(spacedQuoted.mode, 'fallback-literal');
  assert.deepEqual(spacedQuoted.terms, [' "" ']);
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
