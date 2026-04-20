import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PATH_SCOPE_SPEC_URI,
  buildPathScopeSchema,
  getPathScopeSpecReadHint,
  getPathScopeSpecResourceDescription,
  getPathScopeSpecText,
} from '../pathScopeSpec';

test('pathScope resource description uses generic pathScope wording', () => {
  assert.equal(
    getPathScopeSpecResourceDescription(),
    'Read the shared pathScope syntax before using any tool argument named pathScope.',
  );
  assert.equal(
    getPathScopeSpecReadHint(),
    `Before using any tool argument named pathScope, you must read ${PATH_SCOPE_SPEC_URI} first.`,
  );
});

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

test('pathScope schema still exposes shared syntax metadata', () => {
  const schema = buildPathScopeSchema() as {
    ['x-lm-tools-bridge-sharedSyntax']?: { uri?: string; id?: string; kind?: string };
  };

  assert.equal(schema['x-lm-tools-bridge-sharedSyntax']?.uri, PATH_SCOPE_SPEC_URI);
  assert.equal(schema['x-lm-tools-bridge-sharedSyntax']?.id, 'lm-tools-bridge/pathScope/v1');
  assert.equal(schema['x-lm-tools-bridge-sharedSyntax']?.kind, 'workspace-path-or-glob-scope');
});
