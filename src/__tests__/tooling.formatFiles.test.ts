import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

type ToolingModule = typeof import('../tooling');

type MockUri = {
  fsPath: string;
  scheme: 'file';
  toString(): string;
};

type MockFormattingEdit = {
  range: unknown;
  newText: string;
};

class MockTextDocument {
  public isDirty = false;
  public readonly options = {
    tabSize: 2,
    insertSpaces: true,
  };

  constructor(
    public readonly uri: MockUri,
    private readonly state: MockVscodeState,
  ) {}

  async save(): Promise<boolean> {
    this.state.savedPaths.push(this.uri.fsPath);
    if (this.state.saveFailures.has(this.uri.fsPath)) {
      return false;
    }
    this.isDirty = false;
    return true;
  }
}

class MockRelativePattern {
  constructor(
    public readonly base: { uri?: MockUri } | MockUri,
    public readonly pattern: string,
  ) {}
}

class MockWorkspaceEdit {
  public readonly entries: Array<{ uri: MockUri; range: unknown; newText: string }> = [];

  replace(uri: MockUri, range: unknown, newText: string): void {
    this.entries.push({ uri, range, newText });
  }
}

type MockVscodeState = {
  workspaceFolders: Array<{ name: string; uri: MockUri }>;
  searchExclude: Record<string, unknown>;
  filesExclude: Record<string, unknown>;
  documents: Map<string, MockTextDocument>;
  findFilesHandler: (include: MockRelativePattern) => Promise<MockUri[]>;
  formatHandler: (uri: MockUri) => Promise<MockFormattingEdit[] | undefined>;
  applyEditFailures: Set<string>;
  saveFailures: Set<string>;
  savedPaths: string[];
  appliedEditPaths: string[];
  reset(): void;
};

const workspaceRoot = path.resolve('C:/repo');

const mockState: MockVscodeState = {
  workspaceFolders: [],
  searchExclude: {},
  filesExclude: {},
  documents: new Map(),
  findFilesHandler: async () => [],
  formatHandler: async () => [],
  applyEditFailures: new Set(),
  saveFailures: new Set(),
  savedPaths: [],
  appliedEditPaths: [],
  reset() {
    this.workspaceFolders = [{
      name: 'WorkspaceA',
      uri: createUri(workspaceRoot),
    }];
    this.searchExclude = {};
    this.filesExclude = {};
    this.documents = new Map();
    this.findFilesHandler = async () => [];
    this.formatHandler = async () => [];
    this.applyEditFailures = new Set();
    this.saveFailures = new Set();
    this.savedPaths = [];
    this.appliedEditPaths = [];
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
        workspace: {
          get workspaceFolders() {
            return mockState.workspaceFolders;
          },
          workspaceFile: undefined,
          getConfiguration: (section: string) => ({
            get: (key: string, fallback: unknown) => {
              if (key !== 'exclude') {
                return fallback;
              }
              if (section === 'search') {
                return mockState.searchExclude;
              }
              if (section === 'files') {
                return mockState.filesExclude;
              }
              return fallback;
            },
            inspect: () => undefined,
            update: async () => undefined,
          }),
          getWorkspaceFolder: () => undefined,
          findFiles: async (include: MockRelativePattern) => mockState.findFilesHandler(include),
          openTextDocument: async (uri: MockUri) => {
            const document = mockState.documents.get(uri.fsPath);
            if (!document) {
              throw new Error(`Cannot open ${uri.fsPath}`);
            }
            return document;
          },
          applyEdit: async (edit: MockWorkspaceEdit) => {
            for (const entry of edit.entries) {
              if (mockState.applyEditFailures.has(entry.uri.fsPath)) {
                return false;
              }
            }
            for (const entry of edit.entries) {
              mockState.appliedEditPaths.push(entry.uri.fsPath);
              const document = mockState.documents.get(entry.uri.fsPath);
              if (document) {
                document.isDirty = true;
              }
            }
            return true;
          },
          fs: {
            readFile: async () => new Uint8Array(),
          },
        },
        commands: {
          executeCommand: async (command: string, uri: MockUri) => {
            if (command !== 'vscode.executeFormatDocumentProvider') {
              throw new Error(`Unexpected command ${command}`);
            }
            return mockState.formatHandler(uri);
          },
        },
        window: {
          activeTextEditor: undefined,
          showQuickPick: async () => undefined,
          showWarningMessage: async () => undefined,
          showInformationMessage: async () => undefined,
        },
        languages: {
          getDiagnostics: () => [],
        },
        Uri: {
          file: createUri,
        },
        LanguageModelTextPart,
        LanguageModelPromptTsxPart,
        LanguageModelDataPart,
        Disposable,
        RelativePattern: MockRelativePattern,
        WorkspaceEdit: MockWorkspaceEdit,
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

async function getFormatTool() {
  const { getExposedToolsSnapshot } = await loadToolingModule();
  const tool = getExposedToolsSnapshot().find((entry) => entry.name === 'lm_formatFiles') as {
    invoke?: (input: Record<string, unknown>) => Promise<{ content: Array<{ value?: string }>; structuredContent?: unknown }>;
  } | undefined;
  assert.ok(tool);
  assert.equal(typeof tool.invoke, 'function');
  return tool;
}

test('lm_formatFiles formats, skips, fails, and summarizes results', async () => {
  mockState.reset();
  mockState.searchExclude = {
    'ignored/**': true,
  };

  const formattedPath = path.join(workspaceRoot, 'src', 'formatted.ts');
  const unchangedPath = path.join(workspaceRoot, 'src', 'unchanged.ts');
  const skippedPath = path.join(workspaceRoot, 'src', 'binary.bin');
  const failedPath = path.join(workspaceRoot, 'src', 'failed.ts');
  const excludedPath = path.join(workspaceRoot, 'ignored', 'excluded.ts');

  for (const filePath of [formattedPath, unchangedPath, failedPath, excludedPath]) {
    mockState.documents.set(filePath, new MockTextDocument(createUri(filePath), mockState));
  }

  mockState.findFilesHandler = async (include) => {
    assert.equal(include.pattern, 'src/**/*');
    return [
      createUri(formattedPath),
      createUri(unchangedPath),
      createUri(skippedPath),
      createUri(failedPath),
      createUri(excludedPath),
    ];
  };
  mockState.formatHandler = async (uri) => {
    if (uri.fsPath === formattedPath) {
      return [{
        range: { start: 0, end: 1 },
        newText: 'formatted content',
      }];
    }
    if (uri.fsPath === unchangedPath) {
      return [];
    }
    if (uri.fsPath === failedPath) {
      throw new Error('Formatter crashed');
    }
    throw new Error(`Unexpected format target ${uri.fsPath}`);
  };

  const tool = await getFormatTool();
  const result = await tool.invoke?.({ pathScope: 'src/**/*' });
  assert.ok(result);

  const payload = result.structuredContent as {
    matched: number;
    formatted: number;
    unchanged: number;
    skipped: number;
    failed: number;
    failures: Array<{ path: string; reason: string }>;
    skippedEntries: Array<{ path: string; reason: string }>;
  };
  assert.equal(payload.matched, 4);
  assert.equal(payload.formatted, 1);
  assert.equal(payload.unchanged, 1);
  assert.equal(payload.skipped, 1);
  assert.equal(payload.failed, 1);
  assert.deepEqual(payload.failures, [{
    path: 'WorkspaceA/src/failed.ts',
    reason: 'Formatter crashed',
  }]);
  assert.deepEqual(payload.skippedEntries, [{
    path: 'WorkspaceA/src/binary.bin',
    reason: `Could not open text document: Cannot open ${skippedPath}`,
  }]);
  assert.deepEqual(mockState.appliedEditPaths, [formattedPath]);
  assert.deepEqual(mockState.savedPaths, [formattedPath]);

  const text = result.content[0]?.value ?? '';
  assert.match(text, /^Format files/mu);
  assert.match(text, /matched: 4/mu);
  assert.doesNotMatch(text, /\\n/mu);
});

test('lm_formatFiles returns a no-op payload when pathScope matches no files', async () => {
  mockState.reset();
  mockState.findFilesHandler = async (include) => {
    assert.equal(include.pattern, 'src/**/*.md');
    return [];
  };

  const tool = await getFormatTool();
  const result = await tool.invoke?.({ pathScope: 'src/**/*.md' });
  assert.ok(result);

  const payload = result.structuredContent as { matched: number; formatted: number; unchanged: number; skipped: number; failed: number };
  assert.deepEqual(payload, {
    pathScope: 'src/**/*.md',
    matched: 0,
    formatted: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    skippedEntries: [],
  });
  assert.match(result.content[0]?.value ?? '', /No files matched pathScope\./mu);
});

test('lm_formatFiles rejects pathScope outside current workspaces', async () => {
  mockState.reset();

  const tool = await getFormatTool();
  await assert.rejects(
    () => tool.invoke?.({ pathScope: 'D:/outside/**/*.ts' }) as Promise<unknown>,
    /pathScope is outside current workspaces/u,
  );
});
