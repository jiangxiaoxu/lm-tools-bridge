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

type MockTextEditor = {
  document: MockTextDocument;
  viewColumn?: number;
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
    private content = '',
  ) {}

  getText(): string {
    return this.content;
  }

  setText(text: string): void {
    this.content = text;
    this.isDirty = true;
  }

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
  defaultFormatters: Map<string, string>;
  findFilesHandler: (include: MockRelativePattern) => Promise<MockUri[]>;
  saveFailures: Set<string>;
  savedPaths: string[];
  showTextDocumentPaths: string[];
  formatCommandCalls: Array<{ path: string; formatter: string | undefined }>;
  activeTextEditor: MockTextEditor | undefined;
  reset(): void;
};

const workspaceRoot = path.resolve('C:/repo');

const mockState: MockVscodeState = {
  workspaceFolders: [],
  searchExclude: {},
  filesExclude: {},
  documents: new Map(),
  defaultFormatters: new Map(),
  findFilesHandler: async () => [],
  saveFailures: new Set(),
  savedPaths: [],
  showTextDocumentPaths: [],
  formatCommandCalls: [],
  activeTextEditor: undefined,
  reset() {
    this.workspaceFolders = [{
      name: 'WorkspaceA',
      uri: createUri(workspaceRoot),
    }];
    this.searchExclude = {};
    this.filesExclude = {};
    this.documents = new Map();
    this.defaultFormatters = new Map();
    this.findFilesHandler = async () => [];
    this.saveFailures = new Set();
    this.savedPaths = [];
    this.showTextDocumentPaths = [];
    this.formatCommandCalls = [];
    this.activeTextEditor = undefined;
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
          getConfiguration: (section: string, resource?: MockUri) => ({
            get: (key: string, fallback: unknown) => {
              if (section === 'editor' && key === 'defaultFormatter' && resource) {
                return mockState.defaultFormatters.get(resource.fsPath) ?? fallback;
              }
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
          fs: {
            readFile: async () => new Uint8Array(),
          },
        },
        commands: {
          executeCommand: async (command: string) => {
            if (command !== 'editor.action.formatDocument') {
              throw new Error(`Unexpected command ${command}`);
            }
            const editor = mockState.activeTextEditor;
            if (!editor) {
              throw new Error('No active editor');
            }
            const filePath = editor.document.uri.fsPath;
            const formatter = mockState.defaultFormatters.get(filePath);
            mockState.formatCommandCalls.push({ path: filePath, formatter });
            if (filePath === path.join(workspaceRoot, 'src', 'formatted.ts')) {
              editor.document.setText('formatted content');
              return undefined;
            }
            if (filePath === path.join(workspaceRoot, 'src', 'unchanged.ts')) {
              return undefined;
            }
            if (filePath === path.join(workspaceRoot, 'src', 'failed.ts')) {
              throw new Error('Formatter crashed');
            }
            throw new Error(`Unexpected format target ${filePath}`);
          },
        },
        window: {
          get activeTextEditor() {
            return mockState.activeTextEditor;
          },
          showTextDocument: async (document: MockTextDocument, options?: { viewColumn?: number }) => {
            mockState.showTextDocumentPaths.push(document.uri.fsPath);
            mockState.activeTextEditor = {
              document,
              viewColumn: options?.viewColumn,
            };
            return mockState.activeTextEditor;
          },
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
  const previousPath = path.join(workspaceRoot, 'notes', 'current.ts');

  for (const filePath of [formattedPath, unchangedPath, failedPath, excludedPath, previousPath]) {
    mockState.documents.set(
      filePath,
      new MockTextDocument(
        createUri(filePath),
        mockState,
        filePath === formattedPath ? 'before formatting' : 'unchanged',
      ),
    );
  }
  mockState.defaultFormatters.set(previousPath, 'first.provider');
  mockState.defaultFormatters.set(formattedPath, 'configured.formatter');
  mockState.defaultFormatters.set(unchangedPath, 'configured.formatter');
  mockState.defaultFormatters.set(failedPath, 'configured.formatter');
  mockState.activeTextEditor = {
    document: mockState.documents.get(previousPath) as MockTextDocument,
    viewColumn: 1,
  };

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
  assert.deepEqual(mockState.savedPaths, [formattedPath]);
  assert.deepEqual(mockState.showTextDocumentPaths, [
    failedPath,
    previousPath,
    formattedPath,
    previousPath,
    unchangedPath,
    previousPath,
  ]);
  assert.deepEqual(mockState.formatCommandCalls, [
    { path: failedPath, formatter: 'configured.formatter' },
    { path: formattedPath, formatter: 'configured.formatter' },
    { path: unchangedPath, formatter: 'configured.formatter' },
  ]);
  assert.equal(mockState.activeTextEditor?.document.uri.fsPath, previousPath);
  assert.equal((mockState.documents.get(formattedPath) as MockTextDocument).getText(), 'formatted content');
  assert.equal((mockState.documents.get(unchangedPath) as MockTextDocument).getText(), 'unchanged');

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
