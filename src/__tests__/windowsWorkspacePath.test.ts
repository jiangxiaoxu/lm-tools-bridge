import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSupportedWindowsWorkspacePath,
  resolveComparablePath,
} from '../windowsWorkspacePath';

const normalPath = 'G:\\SampleWorkspace\\DemoProject';
const ntPrefixedPath = '\\\\?\\G:\\SampleWorkspace\\DemoProject';
const normalUncPath = '\\\\fileserver\\public\\demo-app';
const ntPrefixedUncPath = '\\\\?\\UNC\\fileserver\\public\\demo-app';

test('supports both normal and nt-prefixed drive paths on Windows', () => {
  assert.equal(isSupportedWindowsWorkspacePath(normalPath, 'win32'), true);
  assert.equal(isSupportedWindowsWorkspacePath(ntPrefixedPath, 'win32'), true);
});

test('normal and nt-prefixed drive paths resolve to the same comparable path on Windows', () => {
  const comparableNormal = resolveComparablePath(normalPath, 'win32').toLowerCase();
  const comparablePrefixed = resolveComparablePath(ntPrefixedPath, 'win32').toLowerCase();
  assert.equal(comparablePrefixed, comparableNormal);
});

test('supports both normal and nt-prefixed UNC paths on Windows', () => {
  assert.equal(isSupportedWindowsWorkspacePath(normalUncPath, 'win32'), true);
  assert.equal(isSupportedWindowsWorkspacePath(ntPrefixedUncPath, 'win32'), true);
});

test('normal and nt-prefixed UNC paths resolve to the same comparable path on Windows', () => {
  const comparableNormalUnc = resolveComparablePath(normalUncPath, 'win32').toLowerCase();
  const comparablePrefixedUnc = resolveComparablePath(ntPrefixedUncPath, 'win32').toLowerCase();
  assert.equal(comparablePrefixedUnc, comparableNormalUnc);
});
