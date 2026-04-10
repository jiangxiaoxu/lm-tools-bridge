import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';

type ConfigurationModule = typeof import('../configuration');

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

type MockState = {
  workspaceFile: MockUri | undefined;
  workspaceFolders: Array<{ name: string; uri: MockUri }>;
  activeTextEditor: { document: { uri: MockUri } } | undefined;
  inspections: Map<string, MockInspection<unknown>>;
  reset(): void;
};

const workspaceRoot = path.resolve('C:/repo');

const mockState: MockState = {
  workspaceFile: undefined,
  workspaceFolders: [],
  activeTextEditor: undefined,
  inspections: new Map(),
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
    this.inspections = new Map();
  },
};

mockState.reset();

let configurationModulePromise: Promise<ConfigurationModule> | undefined;

function createUri(filePath: string): MockUri {
  return {
    fsPath: filePath,
    scheme: 'file',
    toString: () => `file://${filePath}`,
  };
}

async function loadConfigurationModule(): Promise<ConfigurationModule> {
  if (configurationModulePromise) {
    return configurationModulePromise;
  }

  const moduleRecord = Module as unknown as {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleRecord._load;

  moduleRecord._load = ((request: string, parent: NodeModule | null, isMain: boolean) => {
    if (request === 'vscode') {
      return {
        workspace: {
          get workspaceFolders() {
            return mockState.workspaceFolders;
          },
          get workspaceFile() {
            return mockState.workspaceFile;
          },
          getConfiguration: () => ({
            inspect: (key: string) => mockState.inspections.get(key),
            update: async () => undefined,
          }),
          getWorkspaceFolder: (uri: MockUri) => {
            return mockState.workspaceFolders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath));
          },
        },
        window: {
          get activeTextEditor() {
            return mockState.activeTextEditor;
          },
        },
        ConfigurationTarget: {
          Global: 1,
          Workspace: 2,
          WorkspaceFolder: 3,
        },
      };
    }

    return originalLoad.call(moduleRecord, request, parent, isMain);
  }) as typeof moduleRecord._load;

  configurationModulePromise = import('../configuration').finally(() => {
    moduleRecord._load = originalLoad;
  });

  return configurationModulePromise;
}

test('resolveActiveConfigTarget returns Global when workspace settings are disabled', async () => {
  mockState.reset();
  mockState.inspections.set('useWorkspaceSettings', {
    globalValue: false,
  });

  const { resolveActiveConfigTarget } = await loadConfigurationModule();
  const resource = mockState.workspaceFolders[0]?.uri as unknown as Parameters<typeof resolveActiveConfigTarget>[0];
  const target = resolveActiveConfigTarget(resource);

  assert.equal(target, 1);
});

test('resolveActiveConfigTarget returns Workspace when a .code-workspace is open', async () => {
  mockState.reset();
  mockState.workspaceFile = createUri(path.join(workspaceRoot, 'repo.code-workspace'));
  mockState.inspections.set('useWorkspaceSettings', {
    workspaceValue: true,
  });

  const { resolveActiveConfigTarget } = await loadConfigurationModule();
  const resource = mockState.workspaceFolders[0]?.uri as unknown as Parameters<typeof resolveActiveConfigTarget>[0];
  const target = resolveActiveConfigTarget(resource);

  assert.equal(target, 2);
});

test('resolveActiveConfigTarget returns WorkspaceFolder for single-folder workspaces', async () => {
  mockState.reset();
  mockState.inspections.set('useWorkspaceSettings', {
    workspaceFolderValue: true,
  });

  const { resolveActiveConfigTarget } = await loadConfigurationModule();
  const resource = mockState.workspaceFolders[0]?.uri as unknown as Parameters<typeof resolveActiveConfigTarget>[0];
  const target = resolveActiveConfigTarget(resource);

  assert.equal(target, 3);
});

test('getConfigValue prefers WorkspaceFolder values and falls back to Workspace values', async () => {
  mockState.reset();
  mockState.inspections.set('useWorkspaceSettings', {
    workspaceFolderValue: true,
  });
  mockState.inspections.set('tools.enabledDelta', {
    workspaceFolderValue: ['folder-value'],
    workspaceValue: ['workspace-value'],
    defaultValue: ['default-value'],
  });

  const { getConfigValue } = await loadConfigurationModule();
  assert.deepEqual(getConfigValue('tools.enabledDelta', [] as string[]), ['folder-value']);

  mockState.inspections.set('tools.enabledDelta', {
    workspaceValue: ['workspace-value'],
    defaultValue: ['default-value'],
  });
  assert.deepEqual(getConfigValue('tools.enabledDelta', [] as string[]), ['workspace-value']);
});

test('getConfigValue reads Global values when workspace settings are disabled', async () => {
  mockState.reset();
  mockState.inspections.set('useWorkspaceSettings', {
    globalValue: false,
  });
  mockState.inspections.set('server.port', {
    globalValue: 49000,
    workspaceFolderValue: 48123,
    defaultValue: 48123,
  });

  const { getConfigValue } = await loadConfigurationModule();
  assert.equal(getConfigValue('server.port', 0), 49000);
});
