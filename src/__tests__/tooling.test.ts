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
  assert.match(schema.properties?.pathScope?.description ?? '', /lm-tools:\/\/spec\/pathScope/u);
  assert.equal(schema.properties?.pathScope?.['x-lm-tools-bridge-sharedSyntax']?.uri, 'lm-tools://spec/pathScope');
});

test('lm_formatFiles is enabled by default', async () => {
  const { getEnabledExposedToolsSnapshot } = await loadToolingModule();
  const tool = getEnabledExposedToolsSnapshot().find((entry) => entry.name === 'lm_formatFiles');

  assert.ok(tool);
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
