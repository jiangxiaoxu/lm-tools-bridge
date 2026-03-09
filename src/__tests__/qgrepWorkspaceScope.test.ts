import assert from 'node:assert/strict';
import test from 'node:test';
import { tryResolveWorkspaceScopePattern } from '../qgrepWorkspaceScope';

test('resolves brace-scoped workspace globs with trailing glob braces intact', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{CthulhuGame,UE5}/**/*.{h,cpp,cs,as}',
    ['CthulhuGame', 'UE5', 'Tools'],
  );

  assert.deepEqual(resolved, {
    workspaceNames: ['CthulhuGame', 'UE5'],
    pattern: '**/*.{h,cpp,cs,as}',
    scopeLabel: '{CthulhuGame,UE5}',
  });
});

test('normalizes whitespace and de-duplicates brace-scoped workspaces', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{ WorkspaceB , WorkspaceA , WorkspaceB }\\Source\\**\\*.{h,cpp,cs,as}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(resolved, {
    workspaceNames: ['WorkspaceB', 'WorkspaceA'],
    pattern: 'Source\\**\\*.{h,cpp,cs,as}',
    scopeLabel: '{WorkspaceB,WorkspaceA}',
  });
});

test('treats root-only brace selectors as all files within the selected workspaces', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceA,WorkspaceB}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(resolved, {
    workspaceNames: ['WorkspaceA', 'WorkspaceB'],
    pattern: '**/*',
    scopeLabel: '{WorkspaceA,WorkspaceB}',
  });
});

test('returns undefined when any brace-scoped workspace is unknown', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceA,Missing}/**/*.{h,cpp,cs,as}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.equal(resolved, undefined);
});
