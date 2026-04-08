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
        name: 'lmToolsBridge.callBridgedTool',
        description: 'Read lm-tools://guide before first use. Then call a bridged workspace tool after bind, read lm-tools://tool/{name} before the first call, pass arguments that match the target tool inputSchema, and read lm-tools://spec/pathScope before any pathScope argument. Input: { name: string, arguments?: object }.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
      bridgedTools: [
        { name: 'lm_findFiles' },
      ],
      resourceTemplates: [
        { name: 'Tool URI template', uriTemplate: 'lm-tools://tool/{name}' },
      ],
      partial: false,
      issues: [],
    },
    guidance: {
      nextSteps: [
        'read lm-tools://tool/{name} before the first tool call and build arguments that match its inputSchema.',
        'Before using any tool argument named pathScope, you must read lm-tools://spec/pathScope first.',
      ],
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
    Object.prototype.hasOwnProperty.call(payload.discovery.callTool, 'description'),
    true,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.discovery.bridgedTools[0] ?? {}, 'inputSchema'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.discovery.bridgedTools[0] ?? {}, 'description'),
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
        { name: 'lm_findFiles' },
        { name: 'lm_getDiagnostics' },
      ],
      issues: [],
    },
    guidance: {
      nextSteps: [
        'read lm-tools://tool/{name} before the first tool call and build arguments that match its inputSchema.',
        'Before using any tool argument named pathScope, you must read lm-tools://spec/pathScope first.',
      ],
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
