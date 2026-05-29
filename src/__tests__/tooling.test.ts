import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import type { ExposedTool } from '../tooling';

type ToolingModule = typeof import('../tooling');

const TOOL: ExposedTool = {
  name: 'lm_qgrepSearchText',
  description: 'Search indexed workspace text using qgrep.',
  tags: [],
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  isCustom: true,
} as ExposedTool;

const DIAGNOSTICS_TOOL: ExposedTool = {
  name: 'lm_getDiagnostics',
  description: 'Get diagnostics.',
  tags: [],
  inputSchema: {
    type: 'object',
    properties: {
      maxResults: { type: 'integer' },
    },
  },
  isCustom: true,
} as ExposedTool;

const TOOL_WITH_OUTPUT: ExposedTool = {
  name: 'lm_toolWithOutput',
  description: 'Tool with output schema.',
  tags: [],
  inputSchema: { type: 'object' },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
    },
  },
  isCustom: true,
} as ExposedTool;

let toolingModulePromise: Promise<ToolingModule> | undefined;

async function loadToolingModule(): Promise<ToolingModule> {
  if (toolingModulePromise) {
    return toolingModulePromise;
  }

  const moduleRecord = Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleRecord._load;

  moduleRecord._load = ((request: string, parent: NodeModule | null, isMain: boolean) => {
    if (request === 'vscode') {
      class LanguageModelTextPart {
        constructor(public readonly value: string) {}
      }
      class LanguageModelPromptTsxPart {
        constructor(public readonly value: string) {}
      }
      class LanguageModelDataPart {
        constructor(public readonly data: Uint8Array, public readonly mimeType: string) {}
      }
      class Disposable {
        constructor(private readonly onDispose: () => void = () => {}) {}

        dispose(): void {
          this.onDispose();
        }
      }

      return {
        workspace: {
          workspaceFolders: [],
          workspaceFile: undefined,
          getConfiguration: () => ({
            get: () => undefined,
            inspect: () => undefined,
            update: async () => undefined,
          }),
          getWorkspaceFolder: () => undefined,
          fs: {
            readFile: async () => new Uint8Array(),
          },
        },
        window: {
          activeTextEditor: undefined,
          showQuickPick: async () => undefined,
          showWarningMessage: async () => undefined,
          showInformationMessage: async () => undefined,
        },
        Uri: {
          file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => filePath,
          }),
        },
        LanguageModelTextPart,
        LanguageModelPromptTsxPart,
        LanguageModelDataPart,
        Disposable,
        RelativePattern: class RelativePattern {},
        ConfigurationTarget: {
          Global: 1,
          Workspace: 2,
          WorkspaceFolder: 3,
        },
      };
    }

    return originalLoad.call(moduleRecord, request, parent, isMain);
  }) as typeof moduleRecord._load;

  toolingModulePromise = import('../tooling').finally(() => {
    moduleRecord._load = originalLoad;
  });

  return toolingModulePromise;
}

test('toolInfoPayload omits helper metadata from full tool definitions', async () => {
  const { toolInfoPayload } = await loadToolingModule();
  const payload = toolInfoPayload(TOOL, 'full') as Record<string, unknown>;

  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'toolUri'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'usageHint'), false);
  assert.deepEqual(Object.keys(payload).sort(), ['description', 'inputSchema', 'name', 'tags']);
});

test('formatToolInfoText omits toolUri and usageHint lines', async () => {
  const { formatToolInfoText, toolInfoPayload } = await loadToolingModule();
  const text = formatToolInfoText({
    ...toolInfoPayload(TOOL, 'full'),
    toolUri: 'lm-tools://tool/lm_qgrepSearchText',
    usageHint: {
      mode: 'direct',
      reason: 'test-only field',
    },
  });

  assert.match(text, /^name: lm_qgrepSearchText/mu);
  assert.match(text, /^description: Search indexed workspace text using qgrep\./mu);
  assert.match(text, /^inputSchema:/mu);
  assert.doesNotMatch(text, /^toolUri:/mu);
  assert.doesNotMatch(text, /^usageHint:/mu);
});

test('lm_formatFiles is exposed with required shared pathScope schema', async () => {
  const { getExposedToolsSnapshot } = await loadToolingModule();
  const tool = getExposedToolsSnapshot().find((entry) => entry.name === 'lm_formatFiles');

  assert.ok(tool);
  const schema = tool.inputSchema as {
    required?: unknown;
    properties?: { pathScope?: { description?: string; ['x-lm-tools-bridge-sharedSyntax']?: { uri?: string } } };
  };
  assert.deepEqual(schema.required, ['pathScope']);
  assert.match(schema.properties?.pathScope?.description ?? '', /lm-tools:\/\/guide/u);
  assert.equal(Object.prototype.hasOwnProperty.call(schema.properties?.pathScope?.['x-lm-tools-bridge-sharedSyntax'] ?? {}, 'uri'), false);
});

test('lm_formatFiles is exposed by default but not enabled by default', async () => {
  const { getEnabledExposedToolsSnapshot } = await loadToolingModule();
  const tool = getEnabledExposedToolsSnapshot().find((entry) => entry.name === 'lm_formatFiles');

  assert.equal(tool, undefined);
});

test('lm_getToolDefinitions is no longer exposed as a bridged workspace tool', async () => {
  const { getEnabledExposedToolsSnapshot } = await loadToolingModule();
  const tool = getEnabledExposedToolsSnapshot().find((entry) => entry.name === 'lm_getToolDefinitions');

  assert.equal(tool, undefined);
});

test('local tool definition lookup contract uses bridge helper name and schemas', async () => {
  const { getToolDefinitionsLookupDefinition } = await import('../toolDefinitionsContract');
  const tool = getToolDefinitionsLookupDefinition();

  assert.equal(tool.name, 'lmToolsBridge_getToolDefinitions');
  assert.match(tool.description, /Read ToolDefinitions for bound bridged workspace tools/u);
  assert.match(tool.description, /using this helper once when no valid cached ToolDefinition exists/u);
  assert.match(tool.description, /Do not request the same tool again while its cached definition is valid/u);
  assert.match(tool.description, /Request multiple tool names in one call when possible/u);
  assert.match(tool.description, /prefetching likely-needed future ToolDefinitions/u);
  assert.match(
    String((tool.inputSchema.properties as { names?: { description?: unknown } }).names?.description ?? ''),
    /Include multiple names in one request when possible/u,
  );
  assert.match(
    String((tool.inputSchema.properties as { names?: { description?: unknown } }).names?.description ?? ''),
    /cache each returned ToolDefinition before invocation/u,
  );
  assert.deepEqual(tool.inputSchema.required, ['names']);
  assert.deepEqual(tool.outputSchema.required, ['requested', 'tools', 'missing', 'count', 'missingCount']);
});

test('tool definitions payload includes outputSchema when a tool defines it', async () => {
  const { buildToolDefinitionsPayload } = await loadToolingModule();
  const payload = buildToolDefinitionsPayload([TOOL_WITH_OUTPUT], ['lm_toolWithOutput']);
  const definition = payload.tools[0] as { outputSchema?: unknown };

  assert.equal(payload.count, 1);
  assert.ok(definition.outputSchema);
});

test('tool definitions payload returns requested tools and missing names', async () => {
  const { buildToolDefinitionsPayload, formatToolDefinitionsSummary } = await loadToolingModule();
  const payload = buildToolDefinitionsPayload(
    [TOOL, DIAGNOSTICS_TOOL],
    ['lm_getDiagnostics', 'lm_missingTool', 'lm_qgrepSearchText'],
  );

  assert.deepEqual(payload.requested, ['lm_getDiagnostics', 'lm_missingTool', 'lm_qgrepSearchText']);
  assert.deepEqual(payload.missing, ['lm_missingTool']);
  assert.equal(payload.count, 2);
  assert.equal(payload.missingCount, 1);
  assert.deepEqual(payload.tools.map((tool) => tool.name), ['lm_getDiagnostics', 'lm_qgrepSearchText']);
  assert.match(formatToolDefinitionsSummary(payload), /^returned: 2$/mu);
  assert.match(formatToolDefinitionsSummary(payload), /^  - lm_missingTool$/mu);
});

test('tool definition names parser trims and rejects invalid entries', async () => {
  const { parseRequiredToolDefinitionNames } = await loadToolingModule();

  assert.deepEqual(
    parseRequiredToolDefinitionNames({ names: [' lm_getDiagnostics ', 'lm_getDiagnostics', 'lm_qgrepSearchText'] }),
    ['lm_getDiagnostics', 'lm_qgrepSearchText'],
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ names: [] }),
    /names must be a non-empty array of tool name strings/u,
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ names: ['lm_getDiagnostics', ''] }),
    /names\[1\] must be a non-empty string/u,
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ names: ['lm_getDiagnostics', 12] }),
    /names\[1\] must be a string/u,
  );
});

test('mapQgrepToolErrorToMcpError maps qgrep invalid input errors to InvalidParams', async () => {
  const { mapQgrepToolErrorToMcpError } = await loadToolingModule();
  const error = mapQgrepToolErrorToMcpError('lm_qgrepSearchText', new Error('query must be a non-empty string.'));

  assert.ok(error);
  assert.equal(error?.code, -32602);
  assert.equal(error?.message, 'MCP error -32602: Invalid qgrep query: query must be a non-empty string.');
});

test('mapQgrepToolErrorToMcpError maps unavailable qgrep errors to InternalError', async () => {
  const { mapQgrepToolErrorToMcpError } = await loadToolingModule();
  const unavailable = new Error('Qgrep is unavailable because the binary is missing at C:/bin/qgrep.exe.');
  Object.defineProperty(unavailable, 'name', {
    value: 'QgrepUnavailableError',
  });
  const error = mapQgrepToolErrorToMcpError('lm_qgrepSearchFiles', unavailable);

  assert.ok(error);
  assert.equal(error?.code, -32603);
  assert.equal(error?.message, 'MCP error -32603: Qgrep unavailable: the binary is missing at C:/bin/qgrep.exe.');
});

test('mapQgrepToolErrorToMcpError maps qgrep indexing timeouts to InternalError', async () => {
  const { mapQgrepToolErrorToMcpError } = await loadToolingModule();
  const timeout = new Error("timed out after 110s while waiting for workspace 'Foo' to finish indexing (indexing; progress 87%).");
  const error = mapQgrepToolErrorToMcpError('lm_qgrepSearchText', timeout);

  assert.ok(error);
  assert.equal(error?.code, -32603);
  assert.equal(
    error?.message,
    "MCP error -32603: Qgrep indexing timeout: timed out after 110s while waiting for workspace 'Foo' to finish indexing (indexing; progress 87%).",
  );
});

test('mapQgrepToolErrorToMcpError ignores non-qgrep tools', async () => {
  const { mapQgrepToolErrorToMcpError } = await loadToolingModule();
  const error = mapQgrepToolErrorToMcpError('lm_getDiagnostics', new Error('query must be a non-empty string.'));

  assert.equal(error, undefined);
});

test('formatQgrepGetStatusSummary keeps ready workspaces concise', async () => {
  const { formatQgrepGetStatusSummary } = await loadToolingModule();
  const text = formatQgrepGetStatusSummary({
    binaryAvailable: true,
    binaryPath: 'C:/bin/qgrep.exe',
    totalWorkspaces: 1,
    initializedWorkspaces: 1,
    watchingWorkspaces: 1,
    aggregate: {
      filesKnown: true,
      indexedFiles: 10,
      totalFiles: 10,
      remainingFiles: 0,
      percent: 100,
    },
    autoInitialization: {
      hintActive: false,
    },
    workspaceStatuses: [
      {
        workspaceName: 'WorkspaceA',
        initialized: true,
        watching: true,
        ready: true,
        progressKnown: true,
        indexing: false,
        indexedFiles: 10,
        totalFiles: 10,
        progressPercent: 100,
      },
    ],
  });

  assert.match(text, /WorkspaceA: ready, watching=true/u);
  assert.doesNotMatch(text, /detail: recoveryPhase=/u);
  assert.doesNotMatch(text, /detail: error=/u);
});

test('formatQgrepGetStatusSummary expands non-ready workspaces with recovery details only', async () => {
  const { formatQgrepGetStatusSummary } = await loadToolingModule();
  const text = formatQgrepGetStatusSummary({
    binaryAvailable: true,
    binaryPath: 'C:/bin/qgrep.exe',
    totalWorkspaces: 2,
    initializedWorkspaces: 2,
    watchingWorkspaces: 1,
    aggregate: {
      filesKnown: false,
      percent: 88,
    },
    autoInitialization: {
      hintActive: false,
    },
    workspaceStatuses: [
      {
        workspaceName: 'Healthy',
        initialized: true,
        watching: true,
        ready: true,
        progressKnown: true,
        indexing: false,
        indexedFiles: 10,
        totalFiles: 10,
        progressPercent: 100,
      },
      {
        workspaceName: 'Recovering',
        initialized: true,
        watching: false,
        ready: false,
        progressKnown: true,
        indexing: false,
        indexedFiles: 8,
        totalFiles: 10,
        progressPercent: 80,
        recoveryPhase: 'retry-update',
        recoveryAttemptCount: 1,
        fallbackRebuildPending: false,
        degraded: false,
        lastRecoverableError: 'Update failed for workspace',
      },
    ],
  });

  assert.match(text, /Healthy: ready, watching=true/u);
  assert.match(text, /Recovering: retrying update, watching=false/u);
  assert.match(text, /detail: progress=8\/10 \(80%\)/u);
  assert.match(text, /detail: recoveryPhase=retry-update, attempts=1\/2, fallbackRebuildPending=false, degraded=false/u);
  assert.match(text, /detail: error=Update failed for workspace/u);
});
