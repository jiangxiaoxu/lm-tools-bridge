import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureNoBarePipeAlternation, parseOptionalIncludePattern, parseQuerySyntax } from '../searchInput';

test('findText querySyntax defaults to literal', () => {
  const syntax = parseQuerySyntax({
    input: {},
    toolName: 'lm_findTextInFiles',
    allowed: ['literal', 'regex'],
    defaultSyntax: 'literal',
  });

  assert.equal(syntax, 'literal');
});

test('qgrep text querySyntax defaults to literal', () => {
  const syntax = parseQuerySyntax({
    input: {},
    toolName: 'lm_qgrepSearchText',
    allowed: ['literal', 'regex'],
    defaultSyntax: 'literal',
  });

  assert.equal(syntax, 'literal');
});

test('qgrep text querySyntax accepts regex', () => {
  const syntax = parseQuerySyntax({
    input: { querySyntax: 'regex' },
    toolName: 'lm_qgrepSearchText',
    allowed: ['literal', 'regex'],
    defaultSyntax: 'literal',
  });

  assert.equal(syntax, 'regex');
});

test('legacy isRegexp is rejected with a migration hint', () => {
  assert.throws(
    () => parseQuerySyntax({
      input: { isRegexp: true },
      toolName: 'lm_qgrepSearchText',
      allowed: ['literal', 'regex'],
      defaultSyntax: 'literal',
    }),
    /isRegexp is no longer supported for lm_qgrepSearchText/u,
  );
});

test('invalid qgrep text querySyntax values are rejected', () => {
  assert.throws(
    () => parseQuerySyntax({
      input: { querySyntax: 'glob' },
      toolName: 'lm_qgrepSearchText',
      allowed: ['literal', 'regex'],
      defaultSyntax: 'literal',
    }),
    /querySyntax must be one of: 'literal', 'regex'\./u,
  );
});

test('invalid qgrep files querySyntax values are rejected', () => {
  assert.throws(
    () => parseQuerySyntax({
      input: { querySyntax: 'literal' },
      toolName: 'lm_qgrepSearchFiles',
      allowed: ['glob', 'regex'],
      defaultSyntax: 'glob',
    }),
    /querySyntax must be one of: 'glob', 'regex'\./u,
  );
});

test('includePattern rejects bare pipe alternation', () => {
  assert.throws(
    () => parseOptionalIncludePattern({ includePattern: 'UE5/One/**/*.{h,cpp}|UE5/Two/**/*.{h,cpp}' }),
    /includePattern does not support '\|' alternation/u,
  );
});

test('includePattern keeps escaped pipe literals', () => {
  const includePattern = parseOptionalIncludePattern({ includePattern: 'Source/Docs/Version\\|History.txt' });
  assert.equal(includePattern, 'Source/Docs/Version\\|History.txt');
});

test('shared glob/path validation rejects bare pipe alternation', () => {
  assert.throws(
    () => ensureNoBarePipeAlternation(
      'Game/Source/**/*.cs|Game/Source/**/*.cpp',
      "query does not support '|' alternation in glob mode. Use '{A,B}' for glob alternatives.",
    ),
    /query does not support '\|' alternation in glob mode/u,
  );
});
