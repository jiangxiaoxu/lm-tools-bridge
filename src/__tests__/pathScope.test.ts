import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
  createPathScopeSearchPlan,
  resolvePathScopeWorkspaceFile,
  type PathScopeWorkspaceFolder,
} from '../pathScope';

function toPortablePath(...segments: string[]): string {
  return path.resolve(path.join(...segments)).replace(/\\/gu, '/');
}

function getWorkspaceFolders(): PathScopeWorkspaceFolder[] {
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
  folders: readonly PathScopeWorkspaceFolder[],
  absolutePath: string,
) {
  const resolved = resolvePathScopeWorkspaceFile(absolutePath, folders);
  assert.ok(resolved, `Expected workspace file for '${absolutePath}'.`);
  return resolved;
}

test('mixed scoped and unscoped brace branches expand into per-workspace pathScope targets', () => {
  const folders = getWorkspaceFolders();
  const plan = createPathScopeSearchPlan(
    '{Game/src/**/*.ts,Engine/include/**/*.h,src/shared/**/*.ts}',
    folders,
  );

  assert.deepEqual(plan.targets, [
    { workspaceName: 'Game', relativePattern: '{src/**/*.ts,src/shared/**/*.ts}' },
    { workspaceName: 'Engine', relativePattern: '{include/**/*.h,src/shared/**/*.ts}' },
  ]);

  const gameSource = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const gameShared = getWorkspaceFile(folders, `${folders[0].rootPath}/src/shared/common.ts`);
  const engineHeader = getWorkspaceFile(folders, `${folders[1].rootPath}/include/core/main.h`);
  const engineShared = getWorkspaceFile(folders, `${folders[1].rootPath}/src/shared/common.ts`);
  const engineNonMatch = getWorkspaceFile(folders, `${folders[1].rootPath}/src/app/main.ts`);

  assert.equal(plan.matcher.matches(gameSource), true);
  assert.equal(plan.matcher.matches(gameShared), true);
  assert.equal(plan.matcher.matches(engineHeader), true);
  assert.equal(plan.matcher.matches(engineShared), true);
  assert.equal(plan.matcher.matches(engineNonMatch), false);
});

test('absolute pathScope targets only related workspaces and preserves match filtering', () => {
  const folders = getWorkspaceFolders();
  const plan = createPathScopeSearchPlan(`${folders[0].rootPath}/src/**/*.ts`, folders);

  assert.deepEqual(plan.targets, [
    { workspaceName: 'Game', relativePattern: 'src/**/*.ts' },
  ]);

  const gameFile = getWorkspaceFile(folders, `${folders[0].rootPath}/src/app/main.ts`);
  const engineFile = getWorkspaceFile(folders, `${folders[1].rootPath}/src/app/main.ts`);

  assert.equal(plan.matcher.matches(gameFile), true);
  assert.equal(plan.matcher.matches(engineFile), false);
});
