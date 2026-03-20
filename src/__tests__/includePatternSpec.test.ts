import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildIncludePatternSchema,
  getIncludePatternSpecText,
  INCLUDE_PATTERN_SHARED_SYNTAX_ID,
  INCLUDE_PATTERN_SPEC_URI,
} from '../includePatternSpec';

test('includePattern schema exposes shared syntax metadata', () => {
  const schema = buildIncludePatternSchema({ minLength: 1 }) as Record<string, unknown>;
  const metadata = schema['x-lm-tools-bridge-sharedSyntax'] as Record<string, unknown> | undefined;

  assert.equal(schema.type, 'string');
  assert.equal(schema.minLength, 1);
  assert.equal(typeof schema.description, 'string');
  assert.match(String(schema.description), /lm-tools:\/\/spec\/includePattern/u);
  assert.equal(metadata?.id, INCLUDE_PATTERN_SHARED_SYNTAX_ID);
  assert.equal(metadata?.uri, INCLUDE_PATTERN_SPEC_URI);
});

test('includePattern spec text documents shared examples and restrictions', () => {
  const text = getIncludePatternSpecText();

  assert.match(text, /^Shared includePattern syntax/mu);
  assert.match(text, /lm_findTextInFiles\.includePattern/u);
  assert.match(text, /\*\*\/\*\.as/u);
  assert.match(text, /\*\*\/\*\.\{h,cpp\}/u);
  assert.match(text, /\{Game,Engine\}\/\*\*\/\*\.\{h,cpp\}/u);
  assert.match(text, /Bare \| alternation is not supported/u);
});
