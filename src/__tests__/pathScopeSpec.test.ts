import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPathScopeSchema,
  getPathScopeSpecText,
  PATH_SCOPE_SHARED_SYNTAX_ID,
  PATH_SCOPE_SPEC_URI,
} from '../pathScopeSpec';

test('pathScope schema exposes shared syntax metadata', () => {
  const schema = buildPathScopeSchema({ minLength: 1 }) as Record<string, unknown>;
  const metadata = schema['x-lm-tools-bridge-sharedSyntax'] as Record<string, unknown> | undefined;

  assert.equal(schema.type, 'string');
  assert.equal(schema.minLength, 1);
  assert.equal(typeof schema.description, 'string');
  assert.match(String(schema.description), /lm-tools:\/\/spec\/pathScope/u);
  assert.equal(metadata?.id, PATH_SCOPE_SHARED_SYNTAX_ID);
  assert.equal(metadata?.uri, PATH_SCOPE_SPEC_URI);
});

test('pathScope spec text documents shared examples and restrictions', () => {
  const text = getPathScopeSpecText();

  assert.match(text, /^Shared pathScope syntax/mu);
  assert.match(text, /lm_findTextInFiles\.pathScope/u);
  assert.match(text, /^What it is:/mu);
  assert.match(text, /^Accepted forms:/mu);
  assert.match(text, /^Important rules:/mu);
  assert.match(text, /^Common examples:/mu);
  assert.match(text, /^Mixed example:/mu);
  assert.match(text, /^Invalid or misleading examples:/mu);
  assert.match(text, /Script\/\*\*\/\*\.as/u);
  assert.match(text, /WorkspaceA\/Script\/\*\*\/\*\.as/u);
  assert.match(text, /\{WorkspaceA,UE5\}\/\*\*\/\*\.\{h,cpp,as\}/u);
  assert.match(text, /\{WorkspaceA\/Script\/\*\*\/\*\.as,UE5\/Engine\/\*\*\/Source\/\*\*\/\*\.h\}/u);
  assert.match(text, /Config\/\*\*\/\*\.ini/u);
  assert.match(text, /\*\*\/Source\/\*\*\/\*\.\{h,cpp\}/u);
  assert.match(text, /In mixed top-level brace branches, unscoped branches apply to all current workspaces\./u);
  assert.match(text, /the first two branches are scoped, while the last two are unscoped/u);
  assert.match(text, /matches from each workspace root/u);
  assert.match(text, /can also match deeper nested `Source` trees/u);
  assert.match(text, /WorkspaceA\|UE5\/\*\*\/\*\.as/u);
});
