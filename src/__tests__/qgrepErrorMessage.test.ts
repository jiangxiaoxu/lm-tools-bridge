import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeFilesQueryGlobErrorMessage,
  normalizeQueryGlobErrorMessage,
} from '../qgrepGlob';

test('query glob error keeps existing prefix without Error wrapper', () => {
  const result = normalizeQueryGlobErrorMessage(new Error('Invalid query glob pattern: trailing escape (\\).'));
  assert.equal(result, 'Invalid query glob pattern: trailing escape (\\).');
});

test('query glob error wraps plain string input', () => {
  const result = normalizeQueryGlobErrorMessage('trailing escape (\\).');
  assert.equal(result, 'Invalid query glob pattern: trailing escape (\\).');
});

test('files glob error remaps includePattern prefix without Error wrapper', () => {
  const result = normalizeFilesQueryGlobErrorMessage(
    new Error('Invalid includePattern glob pattern: trailing escape (\\).'),
  );
  assert.equal(result, 'Invalid query glob pattern: trailing escape (\\).');
});
