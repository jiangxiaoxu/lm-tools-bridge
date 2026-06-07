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
        description: "Read lm-tools://guide before first use. Before calling this bridged tool wrapper, this exact tool's full ToolDefinition must be known from lmToolsBridge_getToolDefinitions. Reuse a known ToolDefinition and do not request it again. For an unknown ToolDefinition, call lmToolsBridge_getToolDefinitions with names containing only tool names whose ToolDefinitions are unknown; never guess or infer the inputSchema. Set title to a short user-facing description of what this call is doing so the tool call is readable in the UI. Input: { name: string, title: string, arguments?: object }.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            title: { type: 'string' },
          },
          required: ['name', 'title'],
        },
      },
      toolDefinitionsTool: {
        name: 'lmToolsBridge_getToolDefinitions',
        description: 'Read ToolDefinitions for bound bridged workspace tools whose definitions are unknown.',
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
        'follow the ToolDefinition cache and lookup rules in lm-tools://guide.',
        'For any tool argument named pathScope, use its parameter description for the compact syntax summary and lm-tools://guide for the full syntax.',
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
        description: 'Read ToolDefinitions for bound bridged workspace tools whose definitions are unknown.',
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
        'follow the ToolDefinition cache and lookup rules in lm-tools://guide.',
        'For any tool argument named pathScope, use its parameter description for the compact syntax summary and lm-tools://guide for the full syntax.',
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
