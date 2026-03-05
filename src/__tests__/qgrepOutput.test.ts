import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMergedLineWindows,
  buildRenderedSearchBlocks,
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

test('search line formatter uses fixed four-space separator', () => {
  assert.equal(formatQgrepSearchLine(42, true, 'match text'), '42:    match text');
  assert.equal(formatQgrepSearchLine(43, false, 'context text'), '43-    context text');
});

test('only qgrep custom tools are text-only', () => {
  assert.equal(requiresStructuredCustomToolResult('lm_qgrepSearchText'), false);
  assert.equal(requiresStructuredCustomToolResult('lm_qgrepSearchFiles'), false);
  assert.equal(requiresStructuredCustomToolResult('lm_qgrepGetStatus'), false);
  assert.equal(requiresStructuredCustomToolResult('lm_findFiles'), true);
});
