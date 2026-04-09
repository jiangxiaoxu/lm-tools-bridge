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
