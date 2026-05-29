import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPathScopeSchema,
  getPathScopeFieldDescription,
  getPathScopeSpecText,
} from '../pathScopeSpec';

test('pathScope spec text uses generic applicability wording instead of tool lists', () => {
  const text = getPathScopeSpecText();

  assert.match(text, /Applies to any tool argument named `pathScope`\./u);
  assert.match(text, /This spec applies only to `pathScope`, not file-search `query` fields\./u);
  assert.match(text, /\{WorkspaceA\/Script\/Foo\.as,WorkspaceA\/Script\/Bar\.as\}/u);
  assert.match(
    text,
    /MovieSceneTracks\/\*\*\/\*\.\{h,cpp\}\|MovieSceneTools\/\*\*\/\*\.cpp: invalid\./u,
  );
  assert.match(
    text,
    /\{MovieSceneTracks\/\*\*\/\*\.\{h,cpp\},MovieSceneTools\/\*\*\/\*\.cpp\}/u,
  );
  assert.doesNotMatch(text, /lm_findTextInFiles\.pathScope/u);
  assert.doesNotMatch(text, /lm_qgrepSearchText\.pathScope/u);
  assert.doesNotMatch(text, /lm_getDiagnostics\.pathScope/u);
  assert.doesNotMatch(text, /lm_formatFiles\.pathScope/u);
});

test('pathScope schema embeds compact syntax guidance in the field description', () => {
  const schema = buildPathScopeSchema();
  const description = getPathScopeFieldDescription();

  assert.equal(schema.description, description);
  assert.equal(Object.prototype.hasOwnProperty.call(schema, 'x-lm-tools-bridge-sharedSyntax'), false);
  assert.match(description, /Applies only to arguments named pathScope/u);
  assert.match(description, /WorkspaceA\/src\/\*\*/u);
  assert.match(description, /\{WorkspaceA,UE5\}\/\*\*\/\*\.\{ts,tsx\}/u);
  assert.match(description, /bare \| alternation/u);
  assert.match(description, /Full syntax is available in lm-tools:\/\/guide/u);
});
