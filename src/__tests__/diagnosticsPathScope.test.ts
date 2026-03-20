import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  createDiagnosticsPathScopeMatcher,
  resolveDiagnosticsWorkspaceFile,
  type DiagnosticsWorkspaceFolder,
} from '../diagnosticsPathScope';

function toPortablePath(...segments: string[]): string {
  return path.resolve(path.join(...segments)).replace(/\\/gu, '/');
}

function getWorkspaceFolders(): DiagnosticsWorkspaceFolder[] {
  if (process.platform === 'win32') {
    return [
      { name: 'Game', rootPath: toPortablePath('C:/repo/Game') },
      { name: 'Engine', rootPath: toPortablePath('C:/repo/Engine') },
    ];
  }
  return [
    { name: 'Game', rootPath: toPortablePath('/repo/Game') },
    { name: 'Engine', rootPath: toPortablePath('/repo/Engine') },
  ];
}

function getWorkspaceFile(
  folders: readonly DiagnosticsWorkspaceFolder[],
  absolutePath: string,
) {
  const resolved = resolveDiagnosticsWorkspaceFile(absolutePath, folders);
  assert.ok(resolved, `Expected workspace file for '${absolutePath}'.`);
  return resolved;
}

test('workspace-relative diagnostics pathScope matches across all workspaces', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsPathScopeMatcher('src/**/*.ts', folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/core/engine.ts`);
  const nonMatch = getWorkspaceFile(folders, `${folders[0].rootPath}/assets/logo.png`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), true);
  assert.equal(matcher.matches(nonMatch), false);
});

test('WorkspaceName-prefixed diagnostics pathScope scopes to a single workspace', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsPathScopeMatcher('Game/src/**/*.ts', folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/app/main.ts`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), false);
});

test('brace-scoped diagnostics pathScope scopes to the selected workspaces', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsPathScopeMatcher('{Game,Engine}/src/**/*.{ts,tsx}', folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/view/main.tsx`);
  const nonMatch = getWorkspaceFile(folders, `${folders[1].rootPath}/src/view/main.js`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), true);
  assert.equal(matcher.matches(nonMatch), false);
});

test('absolute diagnostics pathScope matches files inside current workspaces', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsPathScopeMatcher(`${folders[0].rootPath}/src/**/*.ts`, folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/app/main.ts`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), false);
});

test('absolute diagnostics pathScope outside current workspaces is rejected', () => {
  const folders = getWorkspaceFolders();
  const outsidePattern = process.platform === 'win32'
    ? 'D:/outside/**/*.ts'
    : '/outside/**/*.ts';

  assert.throws(
    () => createDiagnosticsPathScopeMatcher(outsidePattern, folders),
    /pathScope is outside current workspaces/u,
  );
});

test('resolveDiagnosticsWorkspaceFile excludes files outside current workspaces', () => {
  const folders = getWorkspaceFolders();
  const outsidePath = process.platform === 'win32'
    ? toPortablePath('D:/outside/app.ts')
    : toPortablePath('/outside/app.ts');

  assert.equal(resolveDiagnosticsWorkspaceFile(outsidePath, folders), undefined);
});
