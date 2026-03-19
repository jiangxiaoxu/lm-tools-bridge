import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileFilesQueryGlobToRegexSource,
  compileGlobToRegexSource,
  normalizeFilesQueryGlobPattern,
} from '../qgrepGlob';

function compileFilesGlobRegex(glob: string): RegExp {
  const normalized = normalizeFilesQueryGlobPattern(glob);
  const source = compileGlobToRegexSource(normalized, 'query glob pattern');
  return new RegExp(`^${source}$`, 'u');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function normalizePathForRegex(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '');
}

function compileWorkspaceAnchoredFilesGlobRegex(workspaceRoot: string, glob: string): RegExp {
  const source = compileFilesQueryGlobToRegexSource(glob);
  return new RegExp(`^${escapeRegex(normalizePathForRegex(workspaceRoot))}/${source}$`, 'iu');
}

function compileAbsoluteFilesGlobRegex(glob: string): RegExp {
  const source = compileFilesQueryGlobToRegexSource(glob);
  return new RegExp(`^${source}$`, 'iu');
}

test('files glob without slash matches any depth', () => {
  const regex = compileFilesGlobRegex('*.md');
  assert.equal(regex.test('README.md'), true);
  assert.equal(regex.test('src/README.md'), true);
  assert.equal(regex.test('docs/spec/README.md'), true);
});

test('files glob keeps VS Code segment semantics for * and **', () => {
  const singleSegment = compileFilesGlobRegex('src/*.ts');
  assert.equal(singleSegment.test('src/main.ts'), true);
  assert.equal(singleSegment.test('src/lib/main.ts'), false);

  const multiSegment = compileFilesGlobRegex('src/**/*.ts');
  assert.equal(multiSegment.test('src/main.ts'), true);
  assert.equal(multiSegment.test('src/lib/main.ts'), true);
});

test('files glob supports brace and negated char class', () => {
  const braceRegex = compileFilesGlobRegex('*.{ts,js}');
  assert.equal(braceRegex.test('src/main.ts'), true);
  assert.equal(braceRegex.test('src/main.js'), true);
  assert.equal(braceRegex.test('src/main.md'), false);

  const negatedClassRegex = compileFilesGlobRegex('[!a]*.ts');
  assert.equal(negatedClassRegex.test('a.ts'), false);
  assert.equal(negatedClassRegex.test('b.ts'), true);
  assert.equal(negatedClassRegex.test('src/b.ts'), true);
});

test('workspace-anchored files glob scopes nested paths to the selected workspace root', () => {
  const regex = compileWorkspaceAnchoredFilesGlobRegex(
    'g:/workspace/game-project',
    'Source/**/*.{Target.cs,Build.cs,h,cpp,cs}',
  );

  assert.equal(
    regex.test('g:/workspace/game-project/Source/GameProject.Target.cs'),
    true,
  );
  assert.equal(
    regex.test('g:/workspace/game-project/Source/GameEditor/GameEditor.Build.cs'),
    true,
  );
  assert.equal(
    regex.test('g:/workspace/engine-project/Source/GameProject.Target.cs'),
    false,
  );
});

test('workspace-anchored files glob keeps workspace-relative semantics for shared patterns', () => {
  const regex = compileWorkspaceAnchoredFilesGlobRegex('g:/repo/app', 'src/**/*.ts');

  assert.equal(regex.test('g:/repo/app/src/main.ts'), true);
  assert.equal(regex.test('g:/repo/app/src/lib/main.ts'), true);
  assert.equal(regex.test('g:/repo/other/src/main.ts'), false);
});

test('workspace-anchored files glob normalizes Windows separators in relative patterns', () => {
  const regex = compileWorkspaceAnchoredFilesGlobRegex('g:\\repo\\game', 'Source\\**\\*.cs');

  assert.equal(regex.test('g:/repo/game/Source/Game.cs'), true);
  assert.equal(regex.test('g:/repo/game/Source/Subdir/GameMode.cs'), true);
  assert.equal(regex.test('g:/repo/other/Source/Game.cs'), false);
});

test('absolute files glob remains absolute instead of rebasing to a workspace root', () => {
  const regex = compileAbsoluteFilesGlobRegex('g:/workspace/game-project/Source/**/*.{Target.cs,Build.cs,h,cpp,cs}');

  assert.equal(
    regex.test('g:/workspace/game-project/Source/GameProject.Target.cs'),
    true,
  );
  assert.equal(
    regex.test('g:/workspace/game-project/Source/GameEditor/GameEditor.Build.cs'),
    true,
  );
  assert.equal(
    regex.test('g:/workspace/engine-project/Source/GameProject.Target.cs'),
    false,
  );
});
