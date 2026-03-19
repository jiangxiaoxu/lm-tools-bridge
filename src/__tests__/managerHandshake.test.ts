import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceHandshakePayload,
  formatWorkspaceHandshakeSummary,
} from '../managerHandshake';

test('handshake payload omits redundant online and health fields', () => {
  const payload = buildWorkspaceHandshakePayload({
    cwd: 'G:/Project/vscode-lm-tools-bridge',
    target: {
      workspaceFolders: [
        'G:/Project/vscode-lm-tools-bridge',
        'G:/Project/shared',
      ],
      workspaceFile: null,
    },
    discovery: {
      callTool: {
        name: 'lmToolsBridge.callTool',
        description: 'Directly call an exposed tool by name after workspace handshake.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
      bridgedTools: [
        { name: 'lm_findFiles', description: 'Find files in the workspace.' },
      ],
      resourceTemplates: [
        { name: 'Tool URI template', uriTemplate: 'lm-tools://tool/{name}' },
      ],
      partial: false,
      issues: [],
    },
    guidance: {
      nextSteps: ['read lm-tools://schema/{name} before the first tool call.'],
    },
  });

  assert.equal(payload.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'mcpSessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'online'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'health'), false);
  assert.deepEqual(payload.target.workspaceFolders, [
    'G:/Project/vscode-lm-tools-bridge',
    'G:/Project/shared',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.target, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.target, 'host'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.target, 'port'), false);
  assert.equal(payload.discovery.resourceTemplates.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.discovery.bridgedTools[0] ?? {}, 'inputSchema'),
    false,
  );
});

test('handshake summary keeps useful fields and omits online line', () => {
  const summary = formatWorkspaceHandshakeSummary({
    ok: true,
    cwd: 'G:/Project/vscode-lm-tools-bridge',
    target: {
      workspaceFolders: ['G:/Project/vscode-lm-tools-bridge'],
      workspaceFile: 'G:/Project/vscode-lm-tools-bridge/app.code-workspace',
    },
    discovery: {
      partial: false,
      bridgedTools: [
        { name: 'lm_findFiles', description: 'Find files in the workspace.' },
        { name: 'lm_getDiagnostics', description: 'Get diagnostics.' },
      ],
      issues: [],
    },
    guidance: {
      nextSteps: ['read lm-tools://schema/{name} before the first tool call.'],
    },
  });

  assert.match(summary, /workspaceFolders: 1/u);
  assert.match(summary, /workspaceFile: G:\/Project\/vscode-lm-tools-bridge\/app\.code-workspace/u);
  assert.match(summary, /bridgedTools: 2/u);
  assert.match(summary, /Issues: none/u);
  assert.doesNotMatch(summary, /recoveryOnError:/u);
  assert.doesNotMatch(summary, /^online:/mu);
  assert.doesNotMatch(summary, /127\.0\.0\.1:47123/u);
});
