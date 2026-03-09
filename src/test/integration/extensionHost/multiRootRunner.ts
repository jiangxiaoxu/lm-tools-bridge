import assert from 'node:assert/strict';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { executeFindFilesSearch } from '../../../searchTools';
import {
  executeQgrepFilesSearch,
  getQgrepStatusSummary,
  runQgrepInitAllWorkspacesCommand,
  runQgrepStopAndClearCommand,
} from '../../../qgrep';
import {
  activateExtension,
  runIntegrationTests,
  waitForWorkspaceFolderNames,
} from './testHarness';

const QGREP_READY_TIMEOUT_MS = 30_000;
const QGREP_READY_POLL_INTERVAL_MS = 100;

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

const privateCppFixturePaths = [
  'Game/Source/GameEditor/Private/Customizations/CharacterPanelCustomization.cpp',
  'Game/Source/GameEditor/Private/GameEditorModule.cpp',
  'Game/Source/GameRuntime/Private/AvatarCharacter.cpp',
  'Game/Source/GameRuntime/Private/AvatarExtensionComponent.cpp',
  'Game/Source/GameRuntime/Private/AvatarHealthComponent.cpp',
  'Game/Source/GameRuntime/Private/VisibilityByTagsComponent.cpp',
];

const buildCsFixturePaths = [
  'Game/Source/GameEditor/GameEditor.Build.cs',
  'Game/Source/GameRuntime/GameRuntime.Build.cs',
];

const targetAndBuildCsFixturePaths = [
  'Game/Source/Game.Target.cs',
  'Game/Source/GameEditor.Target.cs',
  'Game/Source/GameEditor/GameEditor.Build.cs',
  'Game/Source/GameRuntime/GameRuntime.Build.cs',
];

const targetFixturePaths = [
  'Engine/Source/Engine.Target.cs',
  'Game/Source/Game.Target.cs',
  'Game/Source/GameEditor.Target.cs',
];

interface QgrepFileRecord {
  absolutePath: string;
  workspacePath: string;
  workspaceFolder: string;
}

interface ExpectedSummary {
  scope: string | null;
  querySemanticsApplied: string;
  count: number;
  totalAvailable: number;
  capped: boolean;
  totalAvailableCapped: boolean;
  hardLimitHit: boolean;
  maxResultsApplied: number;
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/');
}

function collectFileRecords(payload: Record<string, unknown>): QgrepFileRecord[] {
  assert.ok(Array.isArray(payload.files), 'Expected payload.files to be an array.');
  return payload.files.map((entry, index) => {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `Expected files[${String(index)}] to be an object.`);
    const record = entry as {
      absolutePath?: unknown;
      workspacePath?: unknown;
      workspaceFolder?: unknown;
    };
    assert.equal(typeof record.absolutePath, 'string', `Expected files[${String(index)}].absolutePath to be a string.`);
    assert.equal(typeof record.workspacePath, 'string', `Expected files[${String(index)}].workspacePath to be a string.`);
    assert.equal(typeof record.workspaceFolder, 'string', `Expected files[${String(index)}].workspaceFolder to be a string.`);
    return {
      absolutePath: normalizePath(record.absolutePath as string),
      workspacePath: record.workspacePath as string,
      workspaceFolder: record.workspaceFolder as string,
    };
  });
}

function getWorkspaceRootMap(): Map<string, string> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return new Map(folders.map((folder) => [folder.name, normalizePath(path.resolve(folder.uri.fsPath))]));
}

function assertSummary(payload: Record<string, unknown>, expected: ExpectedSummary): void {
  assert.equal(payload.scope ?? null, expected.scope);
  assert.equal(payload.querySemanticsApplied, expected.querySemanticsApplied);
  assert.equal(payload.count, expected.count);
  assert.equal(payload.totalAvailable, expected.totalAvailable);
  assert.equal(payload.capped === true, expected.capped);
  assert.equal(payload.totalAvailableCapped === true, expected.totalAvailableCapped);
  assert.equal(payload.hardLimitHit === true, expected.hardLimitHit);
  assert.equal(payload.maxResultsApplied, expected.maxResultsApplied);
  assert.equal(payload.sort, 'qgrep-native');
}

function assertFileRecordsMatch(payload: Record<string, unknown>, expectedWorkspacePaths: readonly string[]): void {
  const records = collectFileRecords(payload);
  const roots = getWorkspaceRootMap();
  const actualPaths = records.map((record) => record.workspacePath).sort();
  assert.deepEqual(actualPaths, [...expectedWorkspacePaths].sort());

  const uniquePaths = new Set(actualPaths);
  assert.equal(uniquePaths.size, records.length, 'Expected qgrep file results to be unique by workspacePath.');

  const recordsByWorkspacePath = new Map(records.map((record) => [record.workspacePath, record]));
  for (const expectedWorkspacePath of expectedWorkspacePaths) {
    const record = recordsByWorkspacePath.get(expectedWorkspacePath);
    assert.ok(record, `Expected file result '${expectedWorkspacePath}' to be present.`);

    const [workspaceFolder, ...relativeSegments] = expectedWorkspacePath.split('/');
    assert.equal(record.workspaceFolder, workspaceFolder);

    const workspaceRoot = roots.get(workspaceFolder);
    assert.ok(workspaceRoot, `Expected workspace root for '${workspaceFolder}'.`);

    const expectedAbsolutePath = normalizePath(path.join(workspaceRoot, ...relativeSegments));
    assert.equal(record.absolutePath, expectedAbsolutePath);
    assert.ok(
      record.absolutePath.startsWith(`${workspaceRoot}/`) || record.absolutePath === workspaceRoot,
      `Expected '${record.absolutePath}' to stay inside workspace '${workspaceFolder}'.`,
    );
  }
}

function assertFileRecordsSubset(payload: Record<string, unknown>, allowedWorkspacePaths: readonly string[]): void {
  const allowed = new Set(allowedWorkspacePaths);
  const records = collectFileRecords(payload);
  for (const record of records) {
    assert.ok(allowed.has(record.workspacePath), `Unexpected capped result '${record.workspacePath}'.`);
  }
}

async function ensureQgrepReady(): Promise<void> {
  const clearSummary = await runQgrepStopAndClearCommand();
  assert.equal(clearSummary.failed, 0, `Expected qgrep clear to succeed: ${clearSummary.message}`);

  const initSummary = await runQgrepInitAllWorkspacesCommand();
  assert.equal(initSummary.failed, 0, `Expected qgrep init to succeed: ${initSummary.message}`);
  assert.equal(initSummary.processed, 2);

  let status = getQgrepStatusSummary();
  const deadline = Date.now() + QGREP_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    status = getQgrepStatusSummary();
    if (
      status.initializedWorkspaces === 2
      && status.workspaceStatuses.length === 2
      && status.workspaceStatuses.every((workspaceStatus) => workspaceStatus.initialized && workspaceStatus.indexing === false)
    ) {
      return;
    }
    await delay(QGREP_READY_POLL_INTERVAL_MS);
  }

  assert.equal(status.initializedWorkspaces, 2, 'Expected qgrep to initialize both workspace indexes.');
  assert.equal(
    status.workspaceStatuses.every((workspaceStatus) => workspaceStatus.initialized && workspaceStatus.indexing === false),
    true,
    `Expected qgrep indexes to become ready. Last status: ${JSON.stringify(status.workspaceStatuses)}`,
  );
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
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/*.{Target.cs,Build.cs,h,cpp,cs}',
          maxResults: 50,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'glob-vscode',
          count: scopedFixturePaths.length,
          totalAvailable: scopedFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 50,
        });
        assertFileRecordsMatch(payload, scopedFixturePaths);

        const status = getQgrepStatusSummary();
        assert.equal(status.initializedWorkspaces, 2);
      },
    },
    {
      name: 'matches deep Private cpp files inside the scoped workspace only',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/Private/**/*.cpp',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'glob-vscode',
          count: privateCppFixturePaths.length,
          totalAvailable: privateCppFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assertFileRecordsMatch(payload, privateCppFixturePaths);
      },
    },
    {
      name: 'matches Build.cs files within the scoped workspace root',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/*.Build.cs',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'glob-vscode',
          count: buildCsFixturePaths.length,
          totalAvailable: buildCsFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assertFileRecordsMatch(payload, buildCsFixturePaths);
      },
    },
    {
      name: 'matches Target.cs and Build.cs files within the scoped workspace using regex',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/.+\\.(Target|Build)\\.cs$',
          querySyntax: 'regex',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'regex',
          count: targetAndBuildCsFixturePaths.length,
          totalAvailable: targetAndBuildCsFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assertFileRecordsMatch(payload, targetAndBuildCsFixturePaths);
      },
    },
    {
      name: 'matches scoped Private cpp files using regex',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/.+/Private/.+\\.cpp$',
          querySyntax: 'regex',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'regex',
          count: privateCppFixturePaths.length,
          totalAvailable: privateCppFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assertFileRecordsMatch(payload, privateCppFixturePaths);
      },
    },
    {
      name: 'keeps non-scoped target globs aggregated across workspaces',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: '**/*.Target.cs',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: null,
          querySemanticsApplied: 'glob-vscode',
          count: targetFixturePaths.length,
          totalAvailable: targetFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assertFileRecordsMatch(payload, targetFixturePaths);
      },
    },
    {
      name: 'keeps non-scoped Target regex queries aggregated across workspaces',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Source/.+Target\\.cs$',
          querySyntax: 'regex',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: null,
          querySemanticsApplied: 'regex',
          count: targetFixturePaths.length,
          totalAvailable: targetFixturePaths.length,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assertFileRecordsMatch(payload, targetFixturePaths);
      },
    },
    {
      name: 'returns no files with a consistent summary when nothing matches',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/*.missing',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'glob-vscode',
          count: 0,
          totalAvailable: 0,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assert.deepEqual(collectFileRecords(payload), []);
      },
    },
    {
      name: 'returns no files with a consistent summary when scoped regex finds nothing',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/.+\\.missing$',
          querySyntax: 'regex',
          maxResults: 20,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'regex',
          count: 0,
          totalAvailable: 0,
          capped: false,
          totalAvailableCapped: false,
          hardLimitHit: false,
          maxResultsApplied: 20,
        });
        assert.deepEqual(collectFileRecords(payload), []);
      },
    },
    {
      name: 'marks capped summaries when maxResults truncates a scoped search',
      run: async () => {
        await activateExtension();
        await ensureQgrepReady();

        const payload = await executeQgrepFilesSearch({
          query: 'Game/Source/**/*.{Target.cs,Build.cs,h,cpp,cs}',
          maxResults: 5,
        });

        assertSummary(payload, {
          scope: 'Game',
          querySemanticsApplied: 'glob-vscode',
          count: 5,
          totalAvailable: 5,
          capped: true,
          totalAvailableCapped: true,
          hardLimitHit: true,
          maxResultsApplied: 5,
        });
        assert.equal(collectFileRecords(payload).length, 5);
        assertFileRecordsSubset(payload, scopedFixturePaths);
      },
    },
    {
      name: 'keeps lm_findFiles glob queries fail-fast on bare pipe alternation',
      run: async () => {
        await activateExtension();
        await assert.rejects(
          () => executeFindFilesSearch({
            query: 'Game/Source/**/*.cs|Game/Source/**/*.cpp',
            maxResults: 20,
          }),
          /query does not support '\|' alternation in glob mode/u,
        );
      },
    },
    {
      name: 'keeps invalid legacy mode params fail-fast inside the extension host',
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
    {
      name: 'keeps invalid legacy searchPath params fail-fast inside the extension host',
      run: async () => {
        await activateExtension();
        await assert.rejects(
          () => executeQgrepFilesSearch({
            query: 'Game/Source/**/*.cs',
            searchPath: 'Game/Source',
          }),
          /searchPath is no longer supported for lm_qgrepSearchFiles/u,
        );
      },
    },
    {
      name: 'keeps qgrep file glob queries fail-fast on bare pipe alternation',
      run: async () => {
        await activateExtension();
        await assert.rejects(
          () => executeQgrepFilesSearch({
            query: 'Game/Source/**/*.cs|Game/Source/**/*.cpp',
            maxResults: 20,
          }),
          /query does not support '\|' alternation when querySyntax='glob'/u,
        );
      },
    },
  ]);
}
