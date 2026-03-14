import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertWorkspaceConfigPathLine } from '../qgrepConfig';

test('upsertWorkspaceConfigPathLine replaces stale workspace root path', () => {
  const input = [
    'path g:/UE_Folder/vscode-lm-tools-bridge',
    '',
    '# C/C++',
    'include \\.(cpp|h)$',
    '',
  ].join('\n');

  const result = upsertWorkspaceConfigPathLine(input, 'G:\\Project\\vscode-lm-tools-bridge');

  assert.equal(
    result,
    [
      'path G:/Project/vscode-lm-tools-bridge',
      '',
      '# C/C++',
      'include \\.(cpp|h)$',
      '',
    ].join('\n'),
  );
});

test('upsertWorkspaceConfigPathLine inserts path line at file start and removes duplicates', () => {
  const input = [
    '# generated config',
    'include \\.(ts)$',
    'path g:/old-root',
  ].join('\n');

  const result = upsertWorkspaceConfigPathLine(input, 'G:\\Project\\vscode-lm-tools-bridge');

  assert.equal(
    result,
    [
      'path G:/Project/vscode-lm-tools-bridge',
      '# generated config',
      'include \\.(ts)$',
    ].join('\n'),
  );
});
