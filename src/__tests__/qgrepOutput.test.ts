import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildQgrepSearchLineMatcher,
  buildMergedLineWindows,
  buildRenderedSearchBlocks,
  collectQgrepFileOutputPaths,
  formatQgrepFilesSummary,
  formatQgrepSearchLine,
  parseOptionalContextLineCount,
  requiresStructuredCustomToolResult,
} from '../qgrepOutput';

test('context line count parser applies default and validates bounds', () => {
  assert.equal(parseOptionalContextLineCount(undefined, 'beforeContextLines'), 0);
  assert.equal(parseOptionalContextLineCount(20, 'afterContextLines'), 20);
  assert.throws(
    () => parseOptionalContextLineCount(-1, 'beforeContextLines'),
    /beforeContextLines must be an integer between 0 and 20 when provided\./u,
  );
  assert.throws(
    () => parseOptionalContextLineCount(21, 'afterContextLines'),
    /afterContextLines must be an integer between 0 and 20 when provided\./u,
  );
});

test('merged windows collapse overlap and adjacency', () => {
  const merged = buildMergedLineWindows([2, 5], 1, 1, 10);
  assert.deepEqual(merged, [{ startLine: 1, endLine: 6 }]);

  const separated = buildMergedLineWindows([2, 6], 1, 1, 10);
  assert.deepEqual(separated, [
    { startLine: 1, endLine: 3 },
    { startLine: 5, endLine: 7 },
  ]);
});

test('rendered blocks include context and mark match lines', () => {
  const blocks = buildRenderedSearchBlocks('a\nb\nc\nd\ne', [2, 4], 1, 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 1);
  assert.equal(blocks[0].endLine, 5);
  assert.deepEqual(
    blocks[0].lines.map((entry) => `${entry.lineNumber}:${entry.isMatch ? 'M' : 'C'}:${entry.text}`),
    [
      '1:C:a',
      '2:M:b',
      '3:C:c',
      '4:M:d',
      '5:C:e',
    ],
  );
});

test('context rendering marks additional true matches inside the selected window', () => {
  const matcher = buildQgrepSearchLineMatcher('foo', 'glob', 'insensitive');
  assert.ok(matcher);

  const blocks = buildRenderedSearchBlocks('zero\nfoo\nFOO\nfour', [2], 1, 1, matcher);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 1);
  assert.equal(blocks[0].endLine, 3);
  assert.deepEqual(
    blocks[0].lines.map((entry) => `${entry.lineNumber}:${entry.isMatch ? 'M' : 'C'}:${entry.text}`),
    [
      '1:C:zero',
      '2:M:foo',
      '3:M:FOO',
    ],
  );
});

test('additional local matches do not expand context windows', () => {
  const matcher = buildQgrepSearchLineMatcher('foo', 'glob', 'insensitive');
  assert.ok(matcher);

  const blocks = buildRenderedSearchBlocks('zero\nfoo\ntwo\nFOO\nfour', [2], 1, 1, matcher);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 1);
  assert.equal(blocks[0].endLine, 3);
  assert.deepEqual(
    blocks[0].lines.map((entry) => `${entry.lineNumber}:${entry.isMatch ? 'M' : 'C'}:${entry.text}`),
    [
      '1:C:zero',
      '2:M:foo',
      '3:C:two',
    ],
  );
});

test('line matcher respects glob smart-case sensitive matching', () => {
  const matcher = buildQgrepSearchLineMatcher('Foo', 'glob', 'sensitive');
  assert.ok(matcher);
  assert.equal(matcher('prefix Foo suffix'), true);
  assert.equal(matcher('prefix foo suffix'), false);
});

test('line matcher supports regex queries', () => {
  const matcher = buildQgrepSearchLineMatcher('foo|bar', 'regex', 'insensitive');
  assert.ok(matcher);
  assert.equal(matcher('zzzBARzzz'), true);
  assert.equal(matcher('zzzbazzzz'), false);
});

test('invalid local regex matcher falls back to undefined', () => {
  assert.equal(buildQgrepSearchLineMatcher('(', 'regex', 'sensitive'), undefined);
});

test('search line formatter uses fixed four-space separator', () => {
  assert.equal(formatQgrepSearchLine(42, true, 'match text'), '42:    match text');
  assert.equal(formatQgrepSearchLine(43, false, 'context text'), '43-    context text');
});

test('file output path collector normalizes separators and removes duplicates', () => {
  const paths = collectQgrepFileOutputPaths({
    files: [
      { absolutePath: 'G:\\repo\\Game\\Source\\Game.Target.cs' },
      { absolutePath: 'G:/repo/Game/Source/Game.Target.cs' },
      { absolutePath: 'G:/repo/Game/Source/GameEditor.Target.cs' },
      { workspacePath: 'Game/Source/Game.Target.cs' },
      null,
    ],
  });

  assert.deepEqual(paths, [
    'G:/repo/Game/Source/Game.Target.cs',
    'G:/repo/Game/Source/GameEditor.Target.cs',
  ]);
});

test('qgrep files summary renders header, counts, flags, and file list', () => {
  const text = formatQgrepFilesSummary({
    query: 'Game/Source/**/*.Build.cs',
    querySemanticsApplied: 'glob-vscode',
    scope: 'Game',
    count: 2,
    totalAvailable: 2,
    capped: false,
    maxResultsApplied: 20,
    files: [
      { absolutePath: 'G:\\repo\\game\\Source\\GameEditor\\GameEditor.Build.cs' },
      { absolutePath: 'G:/repo/game/Source/GameRuntime/GameRuntime.Build.cs' },
    ],
  });

  assert.equal(
    text,
    [
      'Qgrep files',
      'query: Game/Source/**/*.Build.cs',
      'querySemanticsApplied: glob-vscode',
      'scope: Game',
      'count: 2/2',
      'maxResultsApplied: 20',
      '====',
      'G:/repo/game/Source/GameEditor/GameEditor.Build.cs',
      'G:/repo/game/Source/GameRuntime/GameRuntime.Build.cs',
    ].join('\n'),
  );
});

test('qgrep files summary renders no-result and capped output states', () => {
  const text = formatQgrepFilesSummary({
    query: 'Game/Source/**/*.missing',
    count: 0,
    totalAvailable: 0,
    capped: false,
    scope: 'Game',
    querySemanticsApplied: 'glob-vscode',
    hardLimitHit: true,
    totalAvailableCapped: true,
    maxResultsRequested: 5000,
    maxResultsApplied: 2000,
    files: [],
  });

  assert.equal(
    text,
    [
      'Qgrep files',
      'query: Game/Source/**/*.missing',
      'querySemanticsApplied: glob-vscode',
      'scope: Game',
      'count: 0/0+','hardLimitHit: true',
      'maxResultsRequested: 5000',
      'maxResultsApplied: 2000',
      'No files found.',
    ].join('\n'),
  );
});

test('only qgrep custom tools are text-only', () => {
  assert.equal(requiresStructuredCustomToolResult('lm_qgrepSearchText'), false);
  assert.equal(requiresStructuredCustomToolResult('lm_qgrepSearchFiles'), false);
  assert.equal(requiresStructuredCustomToolResult('lm_qgrepGetStatus'), false);
  assert.equal(requiresStructuredCustomToolResult('lm_findFiles'), true);
});
