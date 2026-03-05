import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileGlobToRegexSource,
  normalizeFilesQueryGlobPattern,
} from '../qgrepGlob';

function compileFilesGlobRegex(glob: string): RegExp {
  const normalized = normalizeFilesQueryGlobPattern(glob);
  const source = compileGlobToRegexSource(normalized, 'query glob pattern');
  return new RegExp(`^${source}$`, 'u');
}

function compileTextGlobRegex(glob: string): RegExp {
  const source = compileGlobToRegexSource(glob, 'query glob pattern');
  return new RegExp(source, 'u');
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

test('text glob keeps substring matching and VS Code slash behavior', () => {
  const singleStar = compileTextGlobRegex('foo*bar');
  assert.equal(singleStar.test('prefix foo123bar suffix'), true);
  assert.equal(singleStar.test('prefix foo/bar suffix'), false);

  const doubleStar = compileTextGlobRegex('foo**bar');
  assert.equal(doubleStar.test('prefix foo/bar suffix'), true);
  assert.equal(doubleStar.test('prefix foo/a/b/bar suffix'), true);
});

test('text glob keeps ? and {} semantics with slash boundary', () => {
  const regex = compileTextGlobRegex('ab?{c,d}');
  assert.equal(regex.test('zzabXczz'), true);
  assert.equal(regex.test('zzabYdzz'), true);
  assert.equal(regex.test('zzab/czz'), false);
});
