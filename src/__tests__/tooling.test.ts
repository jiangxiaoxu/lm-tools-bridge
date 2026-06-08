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

test('toolInfoPayload includes Apps metadata and omits helper-only fields from full tool definitions', async () => {
  const { toolInfoPayload } = await loadToolingModule();
  const payload = toolInfoPayload(TOOL, 'full') as Record<string, unknown>;
  const meta = payload._meta as Record<string, unknown>;
  const ui = meta.ui as Record<string, unknown>;

  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'toolUri'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'usageHint'), false);
  assert.equal(payload.title, 'Qgrep Search Text');
  assert.equal(ui.resourceUri, 'ui://lm-tools-bridge/tool-result-card.html');
  assert.equal(meta['ui/resourceUri'], 'ui://lm-tools-bridge/tool-result-card.html');
  assert.equal(meta['openai/outputTemplate'], 'ui://lm-tools-bridge/tool-result-card.html');
  assert.equal(meta['openai/toolInvocation/invoking'], 'Running tool...');
  assert.equal(meta['openai/toolInvocation/invoked'], 'Tool result ready');
  assert.deepEqual(Object.keys(payload).sort(), ['_meta', 'description', 'inputSchema', 'name', 'tags', 'title']);
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
  assert.match(text, /^title: Qgrep Search Text/mu);
  assert.match(text, /^description: Search indexed workspace text using qgrep\./mu);
  assert.match(text, /^inputSchema:/mu);
  assert.doesNotMatch(text, /^toolUri:/mu);
  assert.doesNotMatch(text, /^usageHint:/mu);
});

test('pathScope tools expose compact syntax guidance in parameter descriptions', async () => {
  const { getExposedToolsSnapshot } = await loadToolingModule();
  const tools = getExposedToolsSnapshot();
  const pathScopeToolNames = [
    'lm_findTextInFiles',
    'lm_getDiagnostics',
    'lm_formatFiles',
    'lm_qgrepSearchText',
  ];

  for (const toolName of pathScopeToolNames) {
    const tool = tools.find((entry) => entry.name === toolName);
    assert.ok(tool, `Expected ${toolName} to be exposed.`);
    const schema = tool.inputSchema as {
      required?: unknown;
      properties?: { pathScope?: Record<string, unknown> };
    };
    const pathScope = schema.properties?.pathScope;
    assert.ok(pathScope, `Expected ${toolName}.pathScope schema.`);
    assert.equal(Object.prototype.hasOwnProperty.call(pathScope, 'x-lm-tools-bridge-sharedSyntax'), false);
    assert.match(String(pathScope.description ?? ''), /Applies only to arguments named pathScope/u);
    assert.match(String(pathScope.description ?? ''), /WorkspaceA\/src\/\*\*/u);
    assert.match(String(pathScope.description ?? ''), /Full syntax is available in lm-tools:\/\/guide/u);
  }

  const formatFiles = tools.find((entry) => entry.name === 'lm_formatFiles');
  const formatFilesSchema = formatFiles?.inputSchema as {
    required?: unknown;
    properties?: { pathScope?: Record<string, unknown> };
  } | undefined;
  assert.deepEqual(formatFilesSchema?.required, ['pathScope']);
  assert.equal(Object.prototype.hasOwnProperty.call(formatFilesSchema?.properties?.pathScope ?? {}, 'minLength'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(formatFilesSchema?.properties?.pathScope ?? {}, 'pattern'), false);

  const diagnostics = tools.find((entry) => entry.name === 'lm_getDiagnostics');
  const diagnosticsSchema = diagnostics?.inputSchema as {
    required?: unknown;
    properties?: { pathScope?: Record<string, unknown> };
  } | undefined;
  assert.equal(Object.prototype.hasOwnProperty.call(diagnosticsSchema ?? {}, 'required'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnosticsSchema?.properties?.pathScope ?? {}, 'minLength'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnosticsSchema?.properties?.pathScope ?? {}, 'pattern'), false);
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
  assert.match(tool.description, /Set title to a short user-facing description/u);
  assert.match(tool.description, /definitions are unknown/u);
  assert.match(tool.description, /names contains only exact enabled bridged tool names whose full ToolDefinition is unknown/u);
  assert.match(tool.description, /reuse known ToolDefinitions instead/u);
  assert.match(tool.description, /never guess or infer a ToolDefinition or inputSchema/u);
  assert.match(
    String((tool.inputSchema.properties as { names?: { description?: unknown } }).names?.description ?? ''),
    /full ToolDefinitions are unknown/u,
  );
  assert.match(
    String((tool.inputSchema.properties as { names?: { description?: unknown } }).names?.description ?? ''),
    /remove names whose ToolDefinitions are already known/u,
  );
  assert.match(
    String((tool.inputSchema.properties as { names?: { description?: unknown } }).names?.description ?? ''),
    /Do not guess or infer ToolDefinitions/u,
  );
  assert.equal(
    (
      tool.inputSchema.properties as {
        title?: { description?: unknown; minLength?: unknown };
      }
    ).title?.description,
    'Required short user-facing description of this ToolDefinition lookup. Use it as a readable UI title for this helper call.',
  );
  assert.equal(
    (
      tool.inputSchema.properties as {
        title?: { minLength?: unknown };
      }
    ).title?.minLength,
    1,
  );
  assert.deepEqual(tool.inputSchema.required, ['title', 'names']);
  assert.deepEqual(tool.outputSchema.required, ['requested', 'tools', 'missing', 'count', 'missingCount']);
  const toolsSchema = (tool.outputSchema.properties as {
    tools?: {
      items?: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    };
  }).tools?.items;
  assert.equal(Object.prototype.hasOwnProperty.call(toolsSchema?.properties ?? {}, 'tags'), false);
  assert.deepEqual(toolsSchema?.required, ['name', 'title', 'description', 'inputSchema']);
});

test('tool definitions payload includes title and outputSchema when a tool defines it', async () => {
  const { buildToolDefinitionsPayload } = await loadToolingModule();
  const payload = buildToolDefinitionsPayload([TOOL_WITH_OUTPUT], ['lm_toolWithOutput']);
  const definition = payload.tools[0] as { title?: unknown; outputSchema?: unknown };

  assert.equal(payload.count, 1);
  assert.equal(definition.title, 'lm_toolWithOutput');
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
  assert.equal(payload.tools.some((tool) => Object.prototype.hasOwnProperty.call(tool, 'tags')), false);
  assert.match(formatToolDefinitionsSummary(payload), /^returned: 2$/mu);
  assert.match(formatToolDefinitionsSummary(payload), /^  - lm_missingTool$/mu);
});

test('tool definition names parser trims and rejects invalid entries', async () => {
  const { parseRequiredToolDefinitionNames } = await loadToolingModule();

  assert.deepEqual(
    parseRequiredToolDefinitionNames({
      title: 'Get tool definitions',
      names: [' lm_getDiagnostics ', 'lm_getDiagnostics', 'lm_qgrepSearchText'],
    }),
    ['lm_getDiagnostics', 'lm_qgrepSearchText'],
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ names: ['lm_getDiagnostics'] }),
    /title must be a non-empty string/u,
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ title: 'Get tool definitions', names: [] }),
    /names must be a non-empty array of tool name strings/u,
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ title: 'Get tool definitions', names: ['lm_getDiagnostics', ''] }),
    /names\[1\] must be a non-empty string/u,
  );
  assert.throws(
    () => parseRequiredToolDefinitionNames({ title: 'Get tool definitions', names: ['lm_getDiagnostics', 12] }),
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
