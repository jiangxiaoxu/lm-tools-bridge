import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFilesQueryDraft, ensureFilesLegacyParamsUnsupported } from '../qgrepFilesQuery';

test('glob draft scopes WorkspaceName-prefixed patterns to a single workspace', () => {
  const draft = buildFilesQueryDraft(
    'Game/Source/**/*.{Target.cs,Build.cs,h,cpp,cs}',
    'glob',
    ['Game', 'Engine'],
  );

  assert.deepEqual(draft, {
    targets: [{
      workspaceName: 'Game',
      kind: 'glob-relative',
      pattern: 'Source/**/*.{Target.cs,Build.cs,h,cpp,cs}',
    }],
    scope: 'Game',
    semantics: 'glob-vscode',
  });
});

test('glob draft keeps unscoped relative patterns on all workspaces', () => {
  const draft = buildFilesQueryDraft('src/**/*.ts', 'glob', ['App', 'Docs']);

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'App',
        kind: 'glob-relative',
        pattern: 'src/**/*.ts',
      },
      {
        workspaceName: 'Docs',
        kind: 'glob-relative',
        pattern: 'src/**/*.ts',
      },
    ],
    scope: null,
    semantics: 'glob-vscode',
  });
});

test('glob draft keeps absolute patterns absolute for all workspaces', () => {
  const draft = buildFilesQueryDraft('g:/workspace/game-project/Source/**/*.cs', 'glob', ['Game', 'Engine']);

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'Game',
        kind: 'glob-absolute',
        pattern: 'g:/workspace/game-project/Source/**/*.cs',
      },
      {
        workspaceName: 'Engine',
        kind: 'glob-absolute',
        pattern: 'g:/workspace/game-project/Source/**/*.cs',
      },
    ],
    scope: null,
    semantics: 'glob-vscode',
  });
});

test('glob draft normalizes Windows separators in WorkspaceName-prefixed patterns', () => {
  const draft = buildFilesQueryDraft('Game\\Source\\**\\*.cs', 'glob', ['Game', 'Engine']);

  assert.deepEqual(draft, {
    targets: [{
      workspaceName: 'Game',
      kind: 'glob-relative',
      pattern: 'Source\\**\\*.cs',
    }],
    scope: 'Game',
    semantics: 'glob-vscode',
  });
});

test('glob draft expands brace-scoped multi-workspace patterns', () => {
  const draft = buildFilesQueryDraft(
    '{ProjectGame,UE5}/**/*.{h,cpp,cs,as}',
    'glob',
    ['ProjectGame', 'UE5', 'Tools'],
  );

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'ProjectGame',
        kind: 'glob-relative',
        pattern: '**/*.{h,cpp,cs,as}',
      },
      {
        workspaceName: 'UE5',
        kind: 'glob-relative',
        pattern: '**/*.{h,cpp,cs,as}',
      },
    ],
    scope: '{ProjectGame,UE5}',
    semantics: 'glob-vscode',
  });
});

test('glob draft normalizes top-level brace alternation with one workspace prefix', () => {
  const draft = buildFilesQueryDraft(
    '{ProjectGame/Source/ProjectGame/**/*.{h,cpp,cs},ProjectGame/Script/**/*.as}',
    'glob',
    ['ProjectGame', 'UE5'],
  );

  assert.deepEqual(draft, {
    targets: [{
      workspaceName: 'ProjectGame',
      kind: 'glob-relative',
      pattern: '{Source/ProjectGame/**/*.{h,cpp,cs},Script/**/*.as}',
    }],
    scope: 'ProjectGame',
    semantics: 'glob-vscode',
  });
});

test('glob draft groups mixed-workspace top-level brace alternation branches by workspace', () => {
  const draft = buildFilesQueryDraft(
    '{WorkspaceNameA/Source/ProjectGame/**/*.{h,cpp,cs},WorkspaceNameB/Script/**/*.as,WorkspaceNameA/Script/**/*.as}',
    'glob',
    ['WorkspaceNameA', 'WorkspaceNameB', 'WorkspaceNameC'],
  );

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'WorkspaceNameA',
        kind: 'glob-relative',
        pattern: '{Source/ProjectGame/**/*.{h,cpp,cs},Script/**/*.as}',
      },
      {
        workspaceName: 'WorkspaceNameB',
        kind: 'glob-relative',
        pattern: 'Script/**/*.as',
      },
    ],
    scope: '{WorkspaceNameA,WorkspaceNameB}',
    semantics: 'glob-vscode',
  });
});

test('glob draft applies mixed scoped and unscoped top-level brace alternation branches to all workspaces', () => {
  const draft = buildFilesQueryDraft(
    '{WorkspaceA/foo/**/*.h,bar/**/*.as}',
    'glob',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        kind: 'glob-relative',
        pattern: '{foo/**/*.h,bar/**/*.as}',
      },
      {
        workspaceName: 'WorkspaceB',
        kind: 'glob-relative',
        pattern: 'bar/**/*.as',
      },
    ],
    scope: null,
    semantics: 'glob-vscode',
  });
});

test('glob draft applies shared unscoped branches to every workspace in mixed alternation', () => {
  const draft = buildFilesQueryDraft(
    '{WorkspaceA/foo,WorkspaceB/bar,baz}',
    'glob',
    ['WorkspaceA', 'WorkspaceB', 'WorkspaceC'],
  );

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        kind: 'glob-relative',
        pattern: '{foo,baz}',
      },
      {
        workspaceName: 'WorkspaceB',
        kind: 'glob-relative',
        pattern: '{bar,baz}',
      },
      {
        workspaceName: 'WorkspaceC',
        kind: 'glob-relative',
        pattern: 'baz',
      },
    ],
    scope: null,
    semantics: 'glob-vscode',
  });
});

test('glob draft de-duplicates repeated scoped and unscoped branches per workspace', () => {
  const draft = buildFilesQueryDraft(
    '{WorkspaceA/foo,foo,WorkspaceA/foo,foo}',
    'glob',
    ['WorkspaceA', 'WorkspaceB'],
  );

  assert.deepEqual(draft, {
    targets: [
      {
        workspaceName: 'WorkspaceA',
        kind: 'glob-relative',
        pattern: 'foo',
      },
      {
        workspaceName: 'WorkspaceB',
        kind: 'glob-relative',
        pattern: 'foo',
      },
    ],
    scope: null,
    semantics: 'glob-vscode',
  });
});

test('regex draft scopes WorkspaceName-prefixed queries to a single workspace', () => {
  const draft = buildFilesQueryDraft('Game/Source/.+\\.cs$', 'regex', ['Game', 'Engine']);

  assert.deepEqual(draft, {
    targets: [{
      workspaceName: 'Game',
      kind: 'regex',
      queryRegex: 'Source/.+\\.cs$',
    }],
    scope: 'Game',
    semantics: 'regex',
  });
});

test('invalid glob throws before workspace initialization is relevant', () => {
  assert.throws(
    () => buildFilesQueryDraft('Game/[abc', 'glob', ['Game']),
    /Invalid query glob pattern:/u,
  );
});

test('workspace-prefixed regex requires a non-empty remainder', () => {
  assert.throws(
    () => buildFilesQueryDraft('Game/', 'regex', ['Game']),
    /query regex is empty after workspace prefix 'Game\/'\./u,
  );
});

test('glob draft rejects empty patterns before any workspace binding', () => {
  assert.throws(
    () => buildFilesQueryDraft('   ', 'glob', ['Game']),
    /query must be a non-empty glob string when querySyntax is 'glob'\./u,
  );
});

test('glob draft rejects bare pipe alternation before any workspace binding', () => {
  assert.throws(
    () => buildFilesQueryDraft('Game/Source/**/*.cs|Game/Source/**/*.cpp', 'glob', ['Game', 'Engine']),
    /query does not support '\|' alternation when querySyntax='glob'/u,
  );
});

test('legacy mode is rejected before ready wait becomes relevant', () => {
  assert.throws(
    () => ensureFilesLegacyParamsUnsupported({ mode: 'legacy' }),
    /mode is no longer supported for lm_qgrepSearchFiles/u,
  );
});

test('legacy searchPath is rejected before ready wait becomes relevant', () => {
  assert.throws(
    () => ensureFilesLegacyParamsUnsupported({ searchPath: 'src' }),
    /searchPath is no longer supported for lm_qgrepSearchFiles/u,
  );
});
