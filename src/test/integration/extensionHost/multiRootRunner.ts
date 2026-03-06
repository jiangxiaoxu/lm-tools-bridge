import assert from 'node:assert/strict';
import {
  executeQgrepFilesSearch,
  getQgrepStatusSummary,
  runQgrepStopAndClearCommand,
} from '../../../qgrep';
import {
  activateExtension,
  runIntegrationTests,
  waitForWorkspaceFolderNames,
} from './testHarness';

const scopedFixturePaths = [
  'Game/Source/Game.Target.cs',
  'Game/Source/GameEditor.Target.cs',
  'Game/Source/GameEditor/GameEditor.Build.cs',
  'Game/Source/GameEditor/Private/Customizations/CharacterPanelCustomization.cpp',
  'Game/Source/GameEditor/Private/Customizations/CharacterPanelCustomization.h',
  'Game/Source/GameEditor/Private/GameEditorModule.cpp',
  'Game/Source/GameEditor/Private/GameEditorModule.h',
  'Game/Source/GameRuntime/GameRuntime.Build.cs',
  'Game/Source/GameRuntime/Private/AvatarCharacter.cpp',
  'Game/Source/GameRuntime/Private/AvatarExtensionComponent.cpp',
  'Game/Source/GameRuntime/Private/AvatarHealthComponent.cpp',
  'Game/Source/GameRuntime/Private/VisibilityByTagsComponent.cpp',
  'Game/Source/GameRuntime/Public/AvatarCharacter.h',
  'Game/Source/GameRuntime/Public/AvatarExtensionComponent.h',
  'Game/Source/GameRuntime/Public/AvatarHealthComponent.h',
  'Game/Source/GameRuntime/Public/VisibilityByTagsComponent.h',
  'Game/Source/Shared/Tools/GameFixtureReport.cs',
  'Game/Source/Shared/Tools/GameFixtureTool.cs',
];

function collectWorkspacePaths(payload: Record<string, unknown>): string[] {
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as { workspacePath?: unknown };
    return typeof record.workspacePath === 'string' ? [record.workspacePath] : [];
  });
}

function collectWorkspaceFolders(payload: Record<string, unknown>): string[] {
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as { workspaceFolder?: unknown };
    return typeof record.workspaceFolder === 'string' ? [record.workspaceFolder] : [];
  });
}

function assertWorkspacePaths(payload: Record<string, unknown>, expected: string[]): void {
  const workspacePaths = collectWorkspacePaths(payload);
  assert.deepEqual(workspacePaths.sort(), expected.slice().sort());
}

export async function run(): Promise<void> {
  await runIntegrationTests('multi-root', [
    {
      name: 'opens the fixture as a multi-root workspace',
      run: async () => {
        await activateExtension();
        await waitForWorkspaceFolderNames(['Game', 'Engine']);
      },
    },
    {
      name: 'scopes WorkspaceName-prefixed glob queries to the selected workspace root',
      run: async () => {
        await activateExtension();
        await runQgrepStopAndClearCommand();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/*.{Target.cs,Build.cs,h,cpp,cs}',
          maxResults: 50,
        });

        assert.equal(payload.scope, 'Game');
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, scopedFixturePaths.length);

        assertWorkspacePaths(payload, scopedFixturePaths);

        const workspaceFolders = collectWorkspaceFolders(payload);
        assert.deepEqual(
          workspaceFolders,
          Array.from({ length: scopedFixturePaths.length }, () => 'Game'),
        );

        const status = getQgrepStatusSummary();
        assert.equal(status.initializedWorkspaces, 2);
      },
    },
    {
      name: 'matches deep Private cpp files inside the scoped workspace only',
      run: async () => {
        await activateExtension();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/Private/**/*.cpp',
          maxResults: 20,
        });

        assert.equal(payload.scope, 'Game');
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, 6);
        assertWorkspacePaths(payload, [
          'Game/Source/GameEditor/Private/Customizations/CharacterPanelCustomization.cpp',
          'Game/Source/GameEditor/Private/GameEditorModule.cpp',
          'Game/Source/GameRuntime/Private/AvatarCharacter.cpp',
          'Game/Source/GameRuntime/Private/AvatarExtensionComponent.cpp',
          'Game/Source/GameRuntime/Private/AvatarHealthComponent.cpp',
          'Game/Source/GameRuntime/Private/VisibilityByTagsComponent.cpp',
        ]);
      },
    },
    {
      name: 'matches Build.cs files within the scoped workspace root',
      run: async () => {
        await activateExtension();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/*.Build.cs',
          maxResults: 20,
        });

        assert.equal(payload.scope, 'Game');
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, 2);
        assertWorkspacePaths(payload, [
          'Game/Source/GameEditor/GameEditor.Build.cs',
          'Game/Source/GameRuntime/GameRuntime.Build.cs',
        ]);
      },
    },
    {
      name: 'keeps non-scoped target globs aggregated across workspaces',
      run: async () => {
        await activateExtension();

        const payload = await executeQgrepFilesSearch({
          query: '**/*.Target.cs',
          maxResults: 20,
        });

        assert.equal(payload.scope ?? null, null);
        assert.equal(payload.querySemanticsApplied, 'glob-vscode');
        assert.equal(payload.count, 3);
        assertWorkspacePaths(payload, [
          'Engine/Source/Engine.Target.cs',
          'Game/Source/Game.Target.cs',
          'Game/Source/GameEditor.Target.cs',
        ]);
      },
    },
    {
      name: 'keeps invalid legacy params fail-fast inside the extension host',
      run: async () => {
        await activateExtension();
        await assert.rejects(
          () => executeQgrepFilesSearch({
            query: 'Game/Source/**/*.cs',
            mode: 'legacy',
          }),
          /mode is no longer supported for lm_qgrepSearchFiles/u,
        );
      },
    },
  ]);
}
