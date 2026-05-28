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
        name: 'lmToolsBridge_callBridgedTool',
        description: 'Read lm-tools://guide before first use. After bind, call a bridged workspace tool only after its ToolDefinition has been fetched with lmToolsBridge_getToolDefinitions; batch likely-needed future tool names when possible. Pass arguments that match the target tool inputSchema and use the pathScope syntax already included in lm-tools://guide when needed. Input: { name: string, arguments?: object }.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
      toolDefinitionsTool: {
        name: 'lmToolsBridge_getToolDefinitions',
        description: 'Read full definitions for multiple bound bridged workspace tools in one call after workspace bind.',
        inputSchema: {
          type: 'object',
          properties: { names: { type: 'array' } },
          required: ['names'],
        },
        outputSchema: {
          type: 'object',
          properties: { tools: { type: 'array' } },
          required: ['requested', 'tools', 'missing', 'count', 'missingCount'],
        },
      },
      bridgedTools: [
        { name: 'lm_findFiles' },
      ],
      resourceTemplates: [],
      partial: false,
      issues: [],
    },
    guidance: {
      nextSteps: [
        'call lmToolsBridge_getToolDefinitions before first use of any target bridged tool whose definition has not already been fetched, batching likely-needed future names when possible.',
        'For any tool argument named pathScope, use the shared pathScope syntax included in lm-tools://guide.',
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
  assert.equal(payload.discovery.resourceTemplates.length, 0);
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.discovery.callTool, 'description'),
    true,
  );
  assert.equal(payload.discovery.toolDefinitionsTool.name, 'lmToolsBridge_getToolDefinitions');
  assert.equal(
    Object.prototype.hasOwnProperty.call(payload.discovery.toolDefinitionsTool, 'outputSchema'),
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
      toolDefinitionsTool: {
        name: 'lmToolsBridge_getToolDefinitions',
        description: 'Read full definitions for multiple bound bridged workspace tools in one call after workspace bind.',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
      bridgedTools: [
        { name: 'lm_findFiles' },
        { name: 'lm_getDiagnostics' },
      ],
      issues: [],
    },
    guidance: {
      nextSteps: [
        'call lmToolsBridge_getToolDefinitions before first use of any target bridged tool whose definition has not already been fetched, batching likely-needed future names when possible.',
        'For any tool argument named pathScope, use the shared pathScope syntax included in lm-tools://guide.',
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
