import assert from 'node:assert/strict';
import test from 'node:test';
import { tryResolveWorkspaceScopePattern } from '../qgrepWorkspaceScope';

test('resolves brace-scoped workspace globs with trailing glob braces intact', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{ProjectGame,UE5}/**/*.{h,cpp,cs,as}',
    ['ProjectGame', 'UE5', 'Tools'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'ProjectGame',
        pattern: '**/*.{h,cpp,cs,as}',
      },
      {
        workspaceName: 'UE5',
        pattern: '**/*.{h,cpp,cs,as}',
      },
    ],
    scopeLabel: '{ProjectGame,UE5}',
  });
});

test('normalizes whitespace and de-duplicates brace-scoped workspaces', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{ WorkspaceB , WorkspaceA , WorkspaceB }\\Source\\**\\*.{h,cpp,cs,as}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'WorkspaceB',
        pattern: 'Source\\**\\*.{h,cpp,cs,as}',
      },
      {
        workspaceName: 'WorkspaceA',
        pattern: 'Source\\**\\*.{h,cpp,cs,as}',
      },
    ],
    scopeLabel: '{WorkspaceB,WorkspaceA}',
  });
});

test('normalizes top-level brace alternation when all branches share one workspace prefix', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{ProjectGame/Source/ProjectGame/**/*.{h,cpp,cs},ProjectGame/Script/**/*.as}',
    ['ProjectGame', 'UE5'],
  );

  assert.deepEqual(resolved, {
    targets: [{
      workspaceName: 'ProjectGame',
      pattern: '{Source/ProjectGame/**/*.{h,cpp,cs},Script/**/*.as}',
    }],
    scopeLabel: 'ProjectGame',
  });
});

test('groups top-level brace alternation branches by workspace when mixed workspaces are present', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceNameA/Source/ProjectGame/**/*.{h,cpp,cs},WorkspaceNameB/Script/**/*.as,WorkspaceNameA/Script/**/*.as}',
    ['WorkspaceNameA', 'WorkspaceNameB', 'WorkspaceNameC'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'WorkspaceNameA',
        pattern: '{Source/ProjectGame/**/*.{h,cpp,cs},Script/**/*.as}',
      },
      {
        workspaceName: 'WorkspaceNameB',
        pattern: 'Script/**/*.as',
      },
    ],
    scopeLabel: '{WorkspaceNameA,WorkspaceNameB}',
  });
});

test('applies unscoped top-level brace alternation branches to all workspaces when mixed with scoped branches', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceA/foo/**/*.h,bar/**/*.as}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        pattern: '{foo/**/*.h,bar/**/*.as}',
      },
      {
        workspaceName: 'WorkspaceB',
        pattern: 'bar/**/*.as',
      },
    ],
    scopeLabel: null,
  });
});

test('applies mixed scoped and unscoped branches across all current workspaces', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceA/foo,WorkspaceB/bar,baz}',
    ['WorkspaceA', 'WorkspaceB', 'WorkspaceC'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        pattern: '{foo,baz}',
      },
      {
        workspaceName: 'WorkspaceB',
        pattern: '{bar,baz}',
      },
      {
        workspaceName: 'WorkspaceC',
        pattern: 'baz',
      },
    ],
    scopeLabel: null,
  });
});

test('de-duplicates repeated scoped and unscoped branches per workspace', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceA/foo,foo,WorkspaceA/foo,foo}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        pattern: 'foo',
      },
      {
        workspaceName: 'WorkspaceB',
        pattern: 'foo',
      },
    ],
    scopeLabel: null,
  });
});

test('treats root-only brace selectors as all files within the selected workspaces', () => {
  const resolved = tryResolveWorkspaceScopePattern(
    '{WorkspaceA,WorkspaceB}',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(resolved, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        pattern: '**/*',
      },
      {
        workspaceName: 'WorkspaceB',
        pattern: '**/*',
      },
    ],
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
