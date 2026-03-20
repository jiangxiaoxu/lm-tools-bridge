import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  createDiagnosticsIncludePatternMatcher,
  resolveDiagnosticsWorkspaceFile,
  type DiagnosticsWorkspaceFolder,
} from '../diagnosticsIncludePattern';

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

test('workspace-relative diagnostics includePattern matches across all workspaces', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsIncludePatternMatcher('src/**/*.ts', folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/core/engine.ts`);
  const nonMatch = getWorkspaceFile(folders, `${folders[0].rootPath}/assets/logo.png`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), true);
  assert.equal(matcher.matches(nonMatch), false);
});

test('WorkspaceName-prefixed diagnostics includePattern scopes to a single workspace', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsIncludePatternMatcher('Game/src/**/*.ts', folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/app/main.ts`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), false);
});

test('brace-scoped diagnostics includePattern scopes to the selected workspaces', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsIncludePatternMatcher('{Game,Engine}/src/**/*.{ts,tsx}', folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/view/main.tsx`);
  const nonMatch = getWorkspaceFile(folders, `${folders[1].rootPath}/src/view/main.js`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), true);
  assert.equal(matcher.matches(nonMatch), false);
});

test('absolute diagnostics includePattern matches files inside current workspaces', () => {
  const folders = getWorkspaceFolders();
  const matcher = createDiagnosticsIncludePatternMatcher(`${folders[0].rootPath}/src/**/*.ts`, folders);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/app/main.ts`);

  assert.equal(matcher.matches(gameFile), true);
  assert.equal(matcher.matches(engineFile), false);
});

test('absolute diagnostics includePattern outside current workspaces is rejected', () => {
  const folders = getWorkspaceFolders();
  const outsidePattern = process.platform === 'win32'
    ? 'D:/outside/**/*.ts'
    : '/outside/**/*.ts';

  assert.throws(
    () => createDiagnosticsIncludePatternMatcher(outsidePattern, folders),
    /includePattern is outside current workspaces/u,
  );
});

test('resolveDiagnosticsWorkspaceFile excludes files outside current workspaces', () => {
  const folders = getWorkspaceFolders();
  const outsidePath = process.platform === 'win32'
    ? toPortablePath('D:/outside/app.ts')
    : toPortablePath('/outside/app.ts');

  assert.equal(resolveDiagnosticsWorkspaceFile(outsidePath, folders), undefined);
});
