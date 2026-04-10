import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

type ToolingModule = typeof import('../tooling');

type MockInspection<T> = {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
};

type MockUri = {
  fsPath: string;
  scheme: 'file';
  toString(): string;
};

type UpdateCall = {
  key: string;
  target: number;
  value: unknown;
};

type PanelResult =
  | { action: 'apply'; selected: string[] }
  | { action: 'reset' }
  | { action: 'cancel' };

type MockState = {
  workspaceFile: MockUri | undefined;
  workspaceFolders: Array<{ name: string; uri: MockUri }>;
  activeTextEditor: { document: { uri: MockUri } } | undefined;
  inspections: Map<string, MockInspection<unknown>>;
  updateCalls: UpdateCall[];
  failUpdateKeys: Set<string>;
  errorMessages: string[];
  infoMessages: string[];
  panelResult: PanelResult;
  reset(): void;
};

const workspaceRoot = path.resolve('C:/repo');

const mockState: MockState = {
  workspaceFile: undefined,
  workspaceFolders: [],
  activeTextEditor: undefined,
  inspections: new Map(),
  updateCalls: [],
  failUpdateKeys: new Set(),
  errorMessages: [],
  infoMessages: [],
  panelResult: { action: 'reset' },
  reset() {
    this.workspaceFile = undefined;
    this.workspaceFolders = [{
      name: 'WorkspaceA',
      uri: createUri(workspaceRoot),
    }];
    this.activeTextEditor = {
      document: {
        uri: createUri(path.join(workspaceRoot, 'src', 'index.ts')),
      },
    };
    this.inspections = new Map([
      ['useWorkspaceSettings', { workspaceFolderValue: true }],
    ]);
    this.updateCalls = [];
    this.failUpdateKeys = new Set();
    this.errorMessages = [];
    this.infoMessages = [];
    this.panelResult = { action: 'reset' };
  },
};

mockState.reset();

let toolingModulePromise: Promise<ToolingModule> | undefined;

function createUri(filePath: string): MockUri {
  return {
    fsPath: filePath,
    scheme: 'file',
    toString: () => `file://${filePath}`,
  };
}

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
        lm: {
          tools: [],
        },
        workspace: {
          get workspaceFolders() {
            return mockState.workspaceFolders;
          },
          get workspaceFile() {
            return mockState.workspaceFile;
          },
          getConfiguration: () => ({
            get: (_key: string, fallback: unknown) => fallback,
            inspect: (key: string) => mockState.inspections.get(key),
            update: async (key: string, value: unknown, target: number) => {
              mockState.updateCalls.push({ key, value, target });
              if (mockState.failUpdateKeys.has(key)) {
                throw new Error(`write failed for ${key}`);
              }
            },
          }),
          getWorkspaceFolder: (uri: MockUri) => {
            return mockState.workspaceFolders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath));
          },
          fs: {
            readFile: async () => new Uint8Array(),
          },
        },
        window: {
          get activeTextEditor() {
            return mockState.activeTextEditor;
          },
          showQuickPick: async () => undefined,
          showWarningMessage: async () => undefined,
          showInformationMessage: async (message: string) => {
            mockState.infoMessages.push(message);
            return undefined;
          },
          showErrorMessage: async (message: string) => {
            mockState.errorMessages.push(message);
            return undefined;
          },
        },
        Uri: {
          file: createUri,
        },
        LanguageModelTextPart,
        LanguageModelPromptTsxPart,
        LanguageModelDataPart,
        Disposable,
        RelativePattern: class RelativePattern {},
        WorkspaceEdit: class WorkspaceEdit {},
        ConfigurationTarget: {
          Global: 1,
          Workspace: 2,
          WorkspaceFolder: 3,
        },
      };
    }

    if (request === './toolConfigPanel') {
      return {
        showToolConfigPanel: async () => mockState.panelResult,
      };
    }

    return originalLoad.call(moduleRecord, request, parent, isMain);
  }) as typeof moduleRecord._load;

  toolingModulePromise = import('../tooling').finally(() => {
    moduleRecord._load = originalLoad;
  });

  return toolingModulePromise;
}

test('configureExposureTools writes WorkspaceFolder settings for single-folder workspaces', async () => {
  mockState.reset();

  const { configureExposureTools } = await loadToolingModule();
  await configureExposureTools();

  assert.deepEqual(
    mockState.updateCalls.map((entry) => entry.target),
    [3, 3],
  );
  assert.match(mockState.infoMessages.at(-1) ?? '', /Restored default exposed tools\./u);
});

test('configureExposureTools writes Workspace settings when a .code-workspace is open', async () => {
  mockState.reset();
  mockState.workspaceFile = createUri(path.join(workspaceRoot, 'repo.code-workspace'));
  mockState.inspections.set('useWorkspaceSettings', {
    workspaceValue: true,
  });

  const { configureExposureTools } = await loadToolingModule();
  await configureExposureTools();

  assert.deepEqual(
    mockState.updateCalls.map((entry) => entry.target),
    [2, 2],
  );
});

test('configureExposureTools writes Global settings when workspace settings are disabled', async () => {
  mockState.reset();
  mockState.inspections.set('useWorkspaceSettings', {
    globalValue: false,
  });

  const { configureExposureTools } = await loadToolingModule();
  await configureExposureTools();

  assert.deepEqual(
    mockState.updateCalls.map((entry) => entry.target),
    [1, 1],
  );
});

test('configureExposureTools surfaces config write failures with scope details', async () => {
  mockState.reset();
  mockState.failUpdateKeys.add('tools.exposedDelta');

  const { configureExposureTools } = await loadToolingModule();
  await assert.rejects(() => configureExposureTools(), /write failed for tools\.exposedDelta/u);

  assert.equal(mockState.errorMessages.length, 1);
  assert.match(
    mockState.errorMessages[0] ?? '',
    /Failed to update Workspace folder settings \([A-Z]:\\.*\.vscode\\settings\.json\) for lmToolsBridge\.tools\.exposedDelta: write failed for tools\.exposedDelta/u,
  );
});
